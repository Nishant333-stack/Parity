# ADR 0003 — Where exactly-once lives

**Status:** accepted · **Date:** 2026-09-14

## Context

Stripe delivers webhooks *at least once*. It retries on any non-2xx for up to
three days, and it will occasionally deliver a successful event twice for
reasons on its side. So the ingress must assume every event may arrive many
times, concurrently.

"Exactly-once delivery" is not available. Over an unreliable network, the
sender cannot know whether a lost acknowledgement means the receiver processed
the message or never saw it, so it must choose between risking a duplicate and
risking a loss. What *is* achievable is **exactly-once effect**: duplicates may
arrive, but the ledger changes once.

The question this ADR settles is not *whether* to dedupe but *where the
correctness boundary sits*, because that choice determines which failure is
possible.

## The naive design and why it loses events

The obvious flow is: check whether we have seen the event id, and if not,
enqueue it and record it.

```
if (seen(id)) return 200
enqueue(event)
record(id)
```

Two problems. First, `seen` then `record` is a read-then-write race: fifty
concurrent deliveries all read "not seen" and all enqueue. Second, and worse,
a crash between `enqueue` and `record` means Stripe retries, we see no record,
and we enqueue a second time.

Swapping the order is worse still:

```
if (claim(id) === 'duplicate') return 200   // atomic conditional write
enqueue(event)                              // ← crash here
```

Now a crash after the claim and before the enqueue leaves an event marked as
handled that never reached the queue. Stripe retries, the claim rejects it as a
duplicate, and **the event is lost permanently and silently**. Nothing errors.
Nothing alarms. The ledger is simply, quietly wrong.

That asymmetry is the whole decision. A duplicate is absorbed by an idempotent
consumer and costs nothing. A silent loss corrupts the ledger and, because it
leaves no trace, is undetectable by inspection.

## Decision

**Claim atomically, then enqueue, then compensate on failure — and make the
reconciler the backstop for the residual window.**

```
claim = conditionalPut(id)          // DynamoDB picks one winner
if (claim === 'duplicate') return 200
try   { messageId = enqueue(event) }
catch { releaseClaim(id); return 500 }   // Stripe will retry
markEnqueued(id, messageId)          // best effort
```

Three mechanisms, each covering a different window:

| Mechanism | Window | Covers |
|---|---|---|
| DynamoDB conditional put | forever (35-day TTL) | concurrent and late duplicates |
| SQS `MessageDeduplicationId` | 5 minutes | the concurrent replay storm |
| Idempotent projector (Week 3) | forever | anything the above let through |

The conditional put is the primitive that makes the race disappear. DynamoDB
adjudicates: fifty concurrent writers, one `claimed`, forty-nine
`ConditionalCheckFailedException`. No locks, no leader, no read-then-write.

`releaseClaim` is what converts the dangerous failure into a safe one. If the
enqueue fails, we no longer deserve the claim, so we delete it and return 500 —
Stripe retries and succeeds. A transient SQS error becomes a retry rather than
a lost payment.

## The residual window, and why it is acceptable

If the process is killed *between* the successful claim and the release — an
OOM kill, a Lambda timeout mid-catch — the row is stranded as `CLAIMED` and the
event never reaches the queue. We cannot close this with a transaction, because
DynamoDB and SQS are different services and there is no distributed commit
between them.

Instead we make it **detectable**. The claim row records `status: 'CLAIMED'`
with `claimedAt`. A row still `CLAIMED` minutes later, with no corresponding
ledger entry, is exactly the signature of this failure. The Week 5 reconciler
already walks Stripe's `balance_transactions` against our ledger and reports
drift in cents; a stranded claim shows up there as a real discrepancy, and the
recovery is a backfill from `/v2/core/events`.

This is why the reconciler is the project's headline feature rather than a
dashboard ornament. It is not *reporting* on correctness, it is *part of* the
correctness argument: the ingress achieves at-most-one-enqueue with a small
detectable hole, and the reconciler closes the hole. Neither is sufficient
alone.

## Consequences

- The projector **must** be idempotent, keyed by Stripe event id. This is not
  optional defence-in-depth; the design above assumes it.
- A duplicate returns **200, not an error**. Stripe did nothing wrong, and a
  non-2xx would make it retry an event we already hold.
- The dedupe table is an optimisation and an audit trail, not the ledger. It is
  destroyed with the stack; the ledger rebuilds from the S3 archive.
- The 5-minute SQS dedupe window overlaps the DynamoDB claim deliberately. The
  replay-storm injector (Week 7) mostly exercises SQS; a week-old replay
  exercises the table.

## The interview answer

If asked how exactly-once was achieved: it wasn't, and claiming otherwise is a
red flag. Delivery is at-least-once because that is all Stripe offers. The
*effect* is exactly-once, enforced at the projector, with an atomic claim at
the ingress to avoid paying for obvious duplicates and a reconciler to detect
the one window neither covers. The interesting part is not the dedupe — it is
knowing that losing an event is categorically worse than duplicating one, and
ordering the writes accordingly.
