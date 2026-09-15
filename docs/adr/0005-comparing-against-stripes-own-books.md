# ADR 0005 — Comparing against Stripe's own books

**Status:** accepted · **Date:** 2026-09-15

## Context

Every ADR so far has been about the ledger agreeing with *itself*: entries sum
to zero (ADR 0004), an event is applied at most once (ADR 0003). None of that
proves the ledger agrees with *Stripe*. A projector with a bug in
`project()` — the wrong field, a sign error, an event type silently mapped to
nothing when it should book something — produces a ledger that is perfectly
balanced and perfectly idempotent and still wrong, because balance and
idempotency are properties of the ledger's own arithmetic, not of whether
that arithmetic matches reality.

CLAUDE.md states the project's actual thesis plainly: *"does my view still
agree with Stripe's? It answers hourly, in cents, and alarms when the answer
is no."* This ADR is that answer.

## What "Week 4" turned out to be

The handoff notes named Week 4 "v2 events" and pointed at `/v2/core/events`
as the reconciler's backfill source for ADR 0003's stranded claims. Checked
directly against this account rather than assumed: `/v2/core/events` exists
and is reachable, but returned an empty list even after dozens of real
`charge.succeeded` / `payment_intent.succeeded` events had been triggered
through this project's own ingress. It is not a mirror of v1 activity — it is
a separate event stream for v2-native resources (Money Management, Issuing,
and similar), which this project doesn't use. `/v1/events`, checked the same
way, carries exactly the charge and payment_intent history this project
generates.

So the premise was wrong for this project's specific event types, and Week
4's real deliverable is narrower and more useful than "adopt the v2 API": the
Stripe API client layer the reconciler actually needs
(`src/lib/stripe-client.ts`), built against the v1 surface that has this
project's data, not the v2 surface that doesn't. No SDK major-version bump
was needed either — `stripe.balanceTransactions.list()` and
`stripe.events.retrieve()` are long-standing v1 methods already available in
the pinned `stripe-node` version. Bumping five majors to reach an API surface
that turns out not to apply here would have been risk taken on for nothing.

## Decision

**Compare cumulative totals, not time windows.** The ledger's `stripe:cash`
account is `SUM(entries.amount_cents) WHERE account = 'stripe:cash'` — a
running total with no natural window boundary. Stripe's balance transactions
have the same shape: a list, not a windowed report. Comparing "the last
hour's activity" on both sides invites drift from timing alone — a charge
whose webhook lands two minutes into the next hour's window looks like
disagreement when it's just delivery latency. Comparing the full cumulative
total on both sides makes timing irrelevant: whatever hasn't settled yet is
absent from *both* sides equally.

**Compare gross amounts, not net.** A Stripe balance transaction's `net`
field is `amount` minus Stripe's own processing fee. This project's ledger
doesn't model fees as an account — `project()` books a charge's gross
`amount` to `stripe:cash`. Comparing the ledger's gross total against
Stripe's `net` total would report "drift" every single run, in exactly the
amount of fees charged, for a reason that has nothing to do with a real bug.
The reconciler sums balance transactions' `amount` field, which is what
actually corresponds to what the ledger books.

**Recover before measuring.** The reconciler backfills before computing
drift, by fetching events from Stripe's v1 Events API and running them
through the exact same `applyEvent()` the live projector uses — not a second
implementation that can drift from the first. Something resolved earlier in
the same run already counts toward closing whatever drift it caused, rather
than being reported as an open problem the very same pass that fixed it.

**Two independent recovery passes, not one.** The first pass — stranded
DynamoDB claims, rows still `CLAIMED` more than 15 minutes after being
claimed — is exactly ADR 0003's residual crash window: an event that got
*past* signature verification and was claimed, then never resolved. It is
not, it turns out, the only way an event goes missing. Running this project
for real produced a second case ADR 0003 never named: two webhook endpoints
existed on the same URL for a period (CLAUDE.md's Known noise), each signing
with its own secret, so every delivery signed with the *other* secret failed
signature verification and was rejected *before* any claim — leaving no
DynamoDB row of any kind. The first pass is structurally blind to this: there
is nothing in DynamoDB to scan for. The second pass exists because of it —
every ledger-relevant event Stripe has ever sent, diffed directly against
`processed_events` rather than against DynamoDB's claim state. That table,
not the dedupe table, is what ADR 0004 already established as the actual
source of truth for "has this event been applied," so comparing against it
directly catches *any* reason an event never arrived, not only the one
originally anticipated. The two passes can safely find and backfill the same
event without coordinating: `applyEvent()`'s own idempotency (ADR 0004's `ON
CONFLICT DO NOTHING`, safe under concurrent transactions) makes the second
attempt a no-op regardless of which pass gets there first.

**Delete the stale claim, don't mark it resolved.** The DynamoDB row's only
job was ever to prevent a duplicate *enqueue* (ADR 0003: "an optimisation and
an audit trail, not the ledger"). Once `applyEvent()` has run directly, the
real, permanent idempotency guarantee is Postgres's own `processed_events`
table and its `ON CONFLICT (event_id) DO NOTHING` (ADR 0004's domain, not
this one). Deleting the stale row is safe precisely because that guarantee
doesn't live in DynamoDB — if the original webhook delivery eventually *does*
arrive after being recovered here, it re-claims cleanly, tries to enqueue,
the projector runs `applyEvent()` again, and Postgres's own conflict check —
not DynamoDB's — is what makes that a no-op.

**One alarm, via ABS().** CloudWatch has no "not equal to zero" comparison
operator. Two separate alarms (one for positive drift, one for negative)
would double the moving parts for a distinction the project doesn't care
about — Stripe having more than the ledger and the ledger having more than
Stripe are the same failure, "these two views disagree." A single Metric Math
expression, `ABS(drift)`, alarmed with `GreaterThanThreshold: 0`, catches
both directions with one alarm. Missing data points count as a breach, not as
fine: a reconciler that failed to run tells you nothing about whether the
ledger agrees with Stripe, which is the opposite of reassuring for a system
whose entire purpose is answering that question.

## Consequences

- **A known gap, stated rather than hidden:** `charge.dispute.created` books
  to `stripe:cash` in `project()`, but its balance-transaction counterpart
  (Stripe's `adjustment` type, whose exact shape under test-mode dispute
  simulation is unreliable) isn't included in the Stripe-side sum yet. A
  dispute will show up as drift until this is extended — which is arguably
  correct behavior for a first version: it's a real gap in what's compared,
  not a bug hidden by pretending the comparison is complete.
- **Unbounded per run.** `stripeCashTotal()` paginates the account's entire
  balance transaction history every hour, and the ledger-side query sums the
  full `entries` table. Fine at this project's volume. A real scale-up needs
  an incremental, checkpointed version — tracking the last reconciled
  balance-transaction id rather than re-walking from the beginning — which is
  a genuine limitation to fix before this design would hold up outside a
  portfolio project's traffic.
- **The recovery path and the measurement path share one function
  (`applyEvent`).** A bug in projection logic shows up identically whether
  the event arrived through the live queue or through reconciliation
  backfill — there is no separate, potentially-diverging "recovery" code path
  to audit.
- **This actually happened, and the fix actually worked.** The first real
  run against this project's live history reported $40.00 of drift — two
  real `charge.succeeded` events from the two-webhook-endpoint period,
  worth $20.00 each, that signature verification had correctly rejected at
  the time but that were never recovered afterward, because nothing had
  looked for them. Adding the second recovery pass and re-running closed it
  to exactly $0.00, and the balance constraint (ADR 0004) still held on the
  backfilled entries — this is not a hypothetical the ADR argues for in the
  abstract, it's a discrepancy this design found and fixed once already.

## The interview answer

The balance constraint (ADR 0004) proves the ledger can't lie to itself. This
ADR is what proves it isn't lying about the world — and the interesting part
isn't "call an API and diff two numbers," it's three corrections that came
from actually running the comparison rather than reasoning about it in the
abstract: gross vs. net would have manufactured fake drift out of ordinary
Stripe fees; `/v2/core/events` looked like the documented backfill path right
up until it was checked against this account and turned out to be empty for
exactly the data this project has; and a single DynamoDB-shaped notion of
"missing" turned out to be incomplete the first time this reconciler ran for
real, against real history, and found $40.00 that a narrower design would
never have looked for. All three are the same lesson ADR 0002 already
learned once with Aurora Express Configuration: verify the integration
against the real API before the design depends on it, because the cost of
being wrong here isn't a failed deploy — it's a reconciler that reports the
wrong answer to the one question this whole project exists to answer.
