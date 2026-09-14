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
 */
export function project(event: Stripe.Event): readonly JournalEntry[] {
  const object = event.data.object as unknown as Record<string, unknown>;

  switch (event.type) {
    case 'charge.succeeded':
      return offsettingPair(cents(object.amount), 'stripe:cash', 'merchants:payable');
    case 'charge.refunded':
      return offsettingPair(cents(object.amount_refunded), 'merchants:payable', 'stripe:cash');
    case 'charge.dispute.created':
      return offsettingPair(cents(object.amount), 'disputes:held', 'stripe:cash');
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
