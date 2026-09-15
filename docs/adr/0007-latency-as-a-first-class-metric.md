# ADR 0007 — Latency as a first-class metric, not just a log line

**Status:** accepted · **Date:** 2026-09-16

## Context

Every number this project has published so far answers "is the ledger
*correct*" — drift in cents (ADR 0005), a balanced-or-rejected transaction
(ADR 0004), an idempotent projection (ADR 0004 again). None of them answer a
different, equally real operational question: "how *fresh* is the ledger
right now" — how long does a dollar that moved in Stripe take to show up
here. A system can have zero drift and still be quietly hours behind; drift
alone can't see that, because it only compares two totals, not their timing.

`src/handlers/projector.ts` already logs a structured line
(`{ msg: outcome, id, type }`) per event, and CloudWatch Logs Insights could
answer a latency question from that after the fact, with a query. That's
fine for an investigation and useless for "what's it doing right now" — the
dashboard's actual job.

## Decision

**One number, computed the way a person would ask the question.** Latency is
measured from `event.created` (the Unix timestamp Stripe itself stamped the
event with) to the moment `applyEvent()` returns in the projector — not from
when this Lambda started running, which would hide queueing time, and not
from when the webhook ingress received it, which would hide Stripe's own
delivery time. The number that matters is "how long between the money moving
and the ledger knowing about it," end to end, including every hop.

**Percentiles from CloudWatch, not a second system.** Each successful
`applyEvent()` call emits one `PutMetricData` point
(`Parity/Projector.IngestToLedgerLatencyMs`, milliseconds). CloudWatch
computes p50/p99 natively from the raw points via `GetMetricStatistics`'s
`ExtendedStatistics` — no histogram bucketing to design, no percentile math
to get subtly wrong, no second store to keep in sync with the metric that's
already being written. `src/lib/system-snapshot.ts` fetches both over
whatever window the dashboard's viewer has selected, as one aggregated
datapoint (`Period` = the whole window), because the dashboard answers "how
fast is processing right now," not "show me a trend line" — a viewer who
wants the trend already has CloudWatch's own console for that.

**No alarm, on purpose — this round.** The reconciler's drift alarm exists
because "$0.00" is a correctness invariant with exactly one acceptable value;
alarming on it was the whole point of building it (ADR 0005). Latency has no
equivalent bright line for a Lambda-based pipeline processing a handful of
test-mode events — a threshold picked now would be a guess dressed up as an
SLO. The metric is real and load-bearing (the dashboard reads it on every
request); the alarm is left for whenever there's traffic history to set a
threshold from evidence instead of instinct.

## Consequences

- **A metric-publish failure is swallowed, deliberately.** `publishLatency()`
  catches and logs rather than throws — a CloudWatch hiccup must never fail
  the SQS batch item and cause a real event to redeliver over an
  observability write. Correctness (ADR 0003, ADR 0004) always outranks
  telemetry.
- **The number is delivery latency, not processing latency** — it includes
  however long Stripe took to send the webhook and however long the message
  waited on the FIFO queue behind others in its group (ADR 0001), not just
  this Lambda's own execution time. That's the right number for "how fresh
  is the ledger," and the wrong one if the question were instead "is this
  function slow" — X-Ray or a second, narrower metric would answer that one,
  and neither exists here because nothing has asked that question yet.
- **`GetMetricStatistics` is granted with `resources: ["*"]`** on the
  dashboard's role, same as its other `Describe*`/`Get*`/`List*` grants
  (ADR 0006) — the action has no resource-level permissions to scope
  further; the namespace itself (`Parity/Projector`) is what limits what it
  can read, same as the `PutMetricData` grants scope what a writer can
  write.

## The interview answer

The reflex on "add observability" is usually a dashboard full of green
numbers. The actual decision here was narrower and more specific: pick the
one latency question this system's own design raises — ADR 0005 proved
*correctness*, so the obvious next question is *freshness* — and answer it
with the metric CloudWatch already knows how to aggregate, rather than
standing up a second, narrower store just to own percentile math that
`GetMetricStatistics` does for free.
