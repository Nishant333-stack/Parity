# ADR 0001 — FIFO grouped by object id, not one global queue

**Status:** accepted · **Date:** 2026-09-14

## Context

Stripe events about one payment can arrive out of order. `charge.refunded` may
land before `payment_intent.succeeded`. A projector that applies them in
arrival order would refund a charge it has not yet recorded, and the ledger
would be wrong in a way that only reconciliation would catch.

So we need ordering. The question is *how much*.

## The two wrong answers

**A standard (non-FIFO) queue.** No ordering at all. We would have to detect
and repair out-of-order application in the projector — reordering buffers,
version checks, or re-fetching state on every event. Complexity moves into the
hardest place to reason about.

**One global FIFO queue.** Ordering is total, which sounds safer and is in fact
much worse. SQS FIFO guarantees order *within a message group*, and throughput
scales per group. One group means one consumer effectively processing one event
at a time: a single slow projection blocks every unrelated payment behind it,
and the whole system's throughput ceiling becomes one event's latency. You have
bought a guarantee nobody needs — nobody cares whether Alice's payment is
projected before Bob's — and paid for it with all your parallelism.

## Decision

**`MessageGroupId` = the Stripe object id of the money the event concerns.**

Ordering holds where it matters (events about the same payment) and nowhere
else (unrelated payments run fully in parallel). SQS FIFO scales throughput per
group, so the parallelism ceiling is the number of distinct in-flight payments,
which is exactly the right shape.

The non-obvious part is choosing *which* id. Naively grouping by
`event.data.object.id` is wrong: a charge, its refunds and its disputes are all
different objects with different ids, all describing one payment. Grouped
separately, `charge.refunded` could still be projected before the charge.

So the resolver walks up to the money:

```
object.payment_intent  →  use it   (charges, refunds, disputes, fees)
object.subscription    →  use it   (invoices, invoice items)
object.id              →  use it   (the object is itself the root)
event.id               →  fallback (nothing identifiable; cannot conflict)
```

See `src/lib/grouping.ts`.

## Consequences

- Per-payment ordering is guaranteed; cross-payment ordering is explicitly not,
  and the projector must never assume it.
- A poison message blocks only its own group. One payment stalls; the rest of
  the marketplace keeps settling. With a global queue it would stall everything.
- Group cardinality is high (one per payment), which is what makes FIFO fast
  here. A design where all events shared a handful of groups would perform like
  the global queue.
- The fallback to `event.id` degrades to per-event ordering rather than
  throwing. An unidentifiable event cannot conflict with anything, so ordering
  it alone is safe.

## The interview answer

"I used FIFO for ordering" is a weak answer. The real content is that ordering
is a *scoped* requirement: it must hold over one payment's lifecycle and must
not hold globally, because a total order costs all your throughput to buy a
guarantee with no consumer. Picking the group key is the actual design work —
and grouping by the payment intent rather than the object's own id is the part
that prevents a refund being projected before its charge.
