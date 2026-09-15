# ADR 0008 — Payouts: the other side of `stripe:cash`

**Status:** accepted · **Date:** 2026-09-16

## Context

Every event this project booked through Week 5 moves money *into* or *within*
Stripe: `charge.succeeded` brings cash in, `charge.refunded` and
`charge.dispute.created` move it back out to the customer or into a held
state. Nothing yet models cash actually *leaving* Stripe for the platform's
own bank account — the payout. Left unbooked, that isn't just an incomplete
story; it's a real, waiting correctness bug: the moment Stripe auto-pays out
this account's available balance, `stripeCashTotal()` in
`src/lib/reconcile.ts` already sums payout-type balance transactions as of
this ADR (see below), but until that landed, a completed payout would have
shown up as pure, unexplained drift — the exact failure mode ADR 0005 exists
to catch, in a place this project's own reconciler couldn't yet see.

Checked directly against this account before writing any code, per this
project's own standing rule (CLAUDE.md, and see the honesty precedent ADR
0005 already set with the dispute gap): `stripe payouts list` returns empty,
and `stripe balance retrieve` shows `$95.39` sitting entirely in `pending`,
`$0` in `available` — no payout has ever happened here, and none can yet:
`stripe trigger payout.created` fails outright with `"Sorry, you don't have
any external accounts in that currency (usd)"`. Attaching a payout bank
account to a plain (non-Connect) Stripe account is a Dashboard-only action —
Stripe doesn't expose it over the API for exactly the reason you'd guess:
money-out destinations get tighter controls than money-in ones.

## Decision

**Model it now, verify what's actually verifiable now, name the gap for
what it is.** `project()` gains one case:

```
payout.paid → bank:external +amount, stripe:cash -amount
```

`bank:external` is a new account name, added with zero schema or migration
work — `entries.account` is free text with no enum (`db/schema.sql`), which
is what "the ledger is generic over account names" actually cashes out to in
practice, not just a nice claim about the design.

**Booked on `.paid`, not `.created`.** Same convention as `charge.succeeded`:
book the event that means money definitely moved, not the one that means
Stripe merely started trying. A real payout's status walks
`pending → in_transit → (paid | failed)` — `.paid` and `.failed` are
alternate outcomes of one attempt, never a sequence, so unlike
`charge.refunded` there is nothing to reverse on `.failed`: no cash left in
that branch, so `payout.failed` books nothing, the same no-op treatment as
`payment_intent.*`.

**The reconciler's `stripeCashTotal()` sums `type === 'payout'` balance
transactions** alongside the existing charge/refund/dispute sum — already
signed negative by Stripe, so no special-casing, just one more type in the
filter (`src/lib/reconcile.ts`). This closes the gap described above before
it ever produces real drift, rather than after.

**What's actually verified, stated plainly.** Unit tests (`src/lib/projection.test.ts`)
cover `payout.paid` and `payout.failed` the same way every other case is
covered — the pure booking logic is proven. What is *not* yet verified is
the live, end-to-end path: a real `payout.paid` webhook, signed by Stripe,
landing on the deployed ingress and reconciling to `$0.00` drift, the same
proof ADR 0005 has for charges and (now) disputes. That needs a test bank
account attached in the Dashboard first — a one-time, five-minute, no-cost
manual step this project has deliberately not asked for, in the same spirit
CLAUDE.md already asks: don't claim something is checked when it hasn't been.
This ADR is that claim stated honestly instead of glossed over — precisely
what ADR 0005's dispute gap already modeled once, and what makes this
project's "drift reads $0.00" claim mean something: every claim of
correctness here says exactly what was checked and what wasn't.

## Consequences

- **A real payout, the moment one happens, will project correctly and
  reconcile to zero** — the code path is exercised by unit tests today and
  will be exercised for real the first time this sandbox has a bank account
  attached and Stripe actually pays out.
- **Until then, `payout.paid` simply never fires** against this account, so
  this addition is inert in production right now — closing a bug that would
  otherwise trigger silently, later, with no code change needed when it
  does.
- **`bank:external` is a new line in every ledger balance listing** (the
  dashboard's "Ledger database" tile, `npm run dashboard:snapshot`) the
  moment it has a nonzero balance — no dashboard code change was needed for
  it to show up, which is the same genericness argument as the schema one,
  one layer up.

## The interview answer

The interesting part isn't "add payouts" — it's that finishing the *money
in* half of a ledger without the *money out* half leaves a correctness gap
that's invisible until the day it isn't, and that this project's own
reconciler is what would have caught it, just later and more confusingly
than catching it now, in code review, before it ever happens. The other
half of the answer is admitting, in the same document, exactly how far
"done" actually goes: the logic is correct and tested; the live, signed,
end-to-end proof this project holds every other event type to is blocked on
one manual Dashboard step nobody has done yet. Both halves of that sentence
matter — the first would be incomplete engineering without the second.
