import type Stripe from 'stripe';

export interface JournalEntry {
  readonly account: string;
  readonly amountCents: bigint;
}

/**
 * Maps a verified Stripe event to the ledger entries it produces. Entries
 * always come in offsetting pairs, so every event that books anything is
 * balanced on its own — the database constraint (docs/adr/0004) is the
 * actual enforcement, this function only decides the amounts.
 *
 * `charge.succeeded` and `charge.refunded` are treated as the money-moving
 * events. A PaymentIntent is an orchestration object, not itself a movement
 * of funds; booking both it and its Charge would double-count the same
 * money, so `payment_intent.*` events are recorded as processed (for
 * idempotency) but book nothing.
 *
 * `payout.paid` is the other side of the same balance: cash Parity holds
 * inside Stripe leaving for its external bank account. Booked on `.paid`
 * only, the terminal success state, the same convention as `charge.succeeded`
 * — Stripe's own lifecycle never sends `.paid` after a `.failed` for one
 * payout (they're alternate outcomes of the same attempt, not a sequence),
 * so `payout.failed` books nothing: no cash actually left in that case, and
 * there is nothing to reverse. See docs/adr/0008-payouts-the-other-side-of-cash.md.
 *
 * `charge.dispute.created` books NOTHING — deliberately, and only after
 * getting this wrong once against this account. `created` means a dispute
 * record exists, not that funds were withdrawn: triggering one directly
 * against this account produced a dispute with `status: "warning_needs_response"`
 * and `balance_transaction: null` — an early-fraud-warning-style inquiry
 * dispute Stripe never actually debited. Booking a fund hold on `.created`
 * would have meant the ledger held money Stripe's own balance never moved,
 * exactly the kind of drift ADR 0005 exists to catch — except this drift
 * would have hidden itself, since it's the *ledger* that would have been
 * wrong, not the comparison. The precise signal for money actually leaving
 * `stripe:cash` is `charge.dispute.funds_withdrawn`, and its mirror,
 * `charge.dispute.funds_reinstated`, is the precise signal for it coming
 * back — see docs/adr/0005's amendment.
 */
export function project(event: Stripe.Event): readonly JournalEntry[] {
  const object = event.data.object as unknown as Record<string, unknown>;

  switch (event.type) {
    case 'charge.succeeded':
      return offsettingPair(cents(object.amount), 'stripe:cash', 'merchants:payable');
    case 'charge.refunded':
      return offsettingPair(cents(object.amount_refunded), 'merchants:payable', 'stripe:cash');
    case 'charge.dispute.funds_withdrawn':
      return offsettingPair(cents(object.amount), 'disputes:held', 'stripe:cash');
    case 'charge.dispute.funds_reinstated':
      return offsettingPair(cents(object.amount), 'stripe:cash', 'disputes:held');
    case 'payout.paid':
      return offsettingPair(cents(object.amount), 'bank:external', 'stripe:cash');
    default:
      return [];
  }
}

function cents(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`expected an integer cents amount, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function offsettingPair(
  amount: bigint,
  increases: string,
  decreases: string,
): readonly JournalEntry[] {
  // A zero-amount event books nothing rather than two zero-magnitude
  // entries, which would fail the entries table's own CHECK (amount_cents
  // <> 0) — filtering here keeps that a non-issue instead of a projector bug.
  if (amount === 0n) return [];
  return [
    { account: increases, amountCents: amount },
    { account: decreases, amountCents: -amount },
  ];
}
