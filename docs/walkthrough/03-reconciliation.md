# Walkthrough 03 — Reconciliation

What the hourly job actually does, and how to run it yourself without
waiting for the schedule. Read alongside `src/lib/reconcile.ts`.

## The path

```
EventBridge (rate: 1 hour)
  ▼
parity-reconciler (Lambda, ARM64, Node 22)
  │  1a. scan the dedupe table for stranded CLAIMED rows (> 15 min old)   ─┐
  │  1b. list Stripe events (charge.*) missing from processed_events      ┴─ run in parallel
  │      → for each found by either pass: applyEvent() (idempotent — safe to overlap)
  │  2. sum Stripe's balance transactions (charge + refund, gross amount)
  │  3. sum the ledger's stripe:cash account
  │  4. drift = stripe total − ledger total
  │  5. publish DriftCents to CloudWatch (Parity/Reconciler namespace)
  ▼
CloudWatch Alarm (ABS(DriftCents) > 0)
  │  breaches on nonzero drift, or on the metric simply not showing up
  ▼
SNS topic parity-reconciler-drift        no subscribers by default — see below
```

## Step 1 — two recovery passes, not one

```ts
const [stranded, missing] = await Promise.all([recoverStrandedClaims(), recoverMissingLedgerEvents()]);
```

**Pass 1a**, `recoverStrandedClaims()`, is ADR 0003's residual crash window:
a DynamoDB row still `CLAIMED` more than fifteen minutes after being
claimed — the process died between claiming an event id and either
enqueuing it or releasing the claim. Fast and targeted, but it can only see
events that got *past* signature verification.

**Pass 1b**, `recoverMissingLedgerEvents()`, exists because pass 1a isn't
the whole story. Running this project for real found the gap: a period
existed where two webhook endpoints shared one URL, each signing with its
own secret, so deliveries signed with the *wrong* one failed signature
verification and were rejected before any DynamoDB claim ever happened
(CLAUDE.md's Known noise). No row, nothing for pass 1a to find. Pass 1b
instead lists every `charge.succeeded` / `charge.refunded` /
`charge.dispute.created` event Stripe has ever sent and diffs the ids
directly against `processed_events` — the table ADR 0004 already
established as the real source of truth for "has this been applied," not
DynamoDB's claim state.

Both passes call the same `applyEvent()` `src/handlers/projector.ts` uses
for live traffic — not a second implementation — and both can find and
backfill the same event without coordinating: `applyEvent()`'s own
idempotency (ADR 0004's `ON CONFLICT DO NOTHING`) makes a second attempt a
safe no-op. Full reasoning in
`docs/adr/0005-comparing-against-stripes-own-books.md`.

Recovery runs *before* the drift calculation, deliberately: anything
backfilled in this same pass already shows up in `ledgerCashTotal()` by the
time step 3 runs, so recovering it and reporting it as drift never both
happen in the same reconciliation.

## Steps 2–4 — the actual question

```ts
async function stripeCashTotal(): Promise<number> {
  let total = 0;
  for await (const bt of stripe.balanceTransactions.list({ limit: 100 })) {
    if (bt.type === 'charge' || bt.type === 'refund') total += bt.amount;
  }
  return total;
}

async function ledgerCashTotal(): Promise<number> {
  const result = await execute(
    "SELECT COALESCE(SUM(amount_cents), 0) FROM entries WHERE account = 'stripe:cash'"
  );
  return numeric(result.records?.[0]?.[0]);
}
```

Both are cumulative totals, not windowed ones — comparing "the last hour" on
each side would manufacture drift out of ordinary webhook latency alone. Both
use *gross* amounts: Stripe's balance transaction `net` field subtracts
Stripe's processing fee, which this ledger doesn't model as an account, so
comparing against `net` would report the fee itself as drift on every run.
Full reasoning in ADR 0005.

`numeric()` (`src/lib/data-api.ts`) is the same fix the dashboard needed:
`SUM(bigint)` in Postgres returns `numeric`, and the Data API serializes that
as `stringValue`, not `longValue`.

## Step 6 — one alarm, both directions

```ts
const absDrift = new cloudwatch.MathExpression({
  expression: 'ABS(drift)',
  usingMetrics: { drift: driftMetric },
});
new cloudwatch.Alarm(this, 'DriftAlarm', {
  metric: absDrift,
  threshold: 0,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.BREACHING,
});
```

CloudWatch has no "not equal to zero" operator, so this alarms on `|drift| >
0` via a Metric Math expression instead of running two separate alarms for
each direction. A missing data point — the function erroring before it
publishes — counts as a breach, not as "fine": for a system whose whole job
is answering "does my view agree with Stripe's," silence is not an
acceptable answer.

**The topic has no subscribers by default.** `ParityStack.ReconcilerDriftAlarmTopicArn`
is a stack output; to actually get notified, subscribe yourself:

```bash
aws sns subscribe \
  --topic-arn "$(aws cloudformation describe-stacks --stack-name ParityStack \
      --profile parity --region ap-south-1 \
      --query "Stacks[0].Outputs[?OutputKey=='ReconcilerDriftAlarmTopicArn'].OutputValue" --output text)" \
  --protocol email --notification-endpoint you@example.com \
  --profile parity --region ap-south-1
```

AWS will email a confirmation link once — click it, and drift alarms reach
your inbox from then on.

## Try it

```bash
npm run reconcile          # one pass, right now — no waiting for the schedule
npm run logs:reconciler    # tail the live Lambda's logs
```

`npm run reconcile` prints the same numbers the Lambda publishes:

```
Stripe balance transactions (charge + refund): $121.00
Ledger stripe:cash account:                    $121.00
Drift:                                          $0.00

Stranded claims found:   0
Missing events found:    0
Backfilled:              0
Backfill failures:       0

Ledger agrees with Stripe. Drift is $0.00.
```

**This already happened for real, not just as an illustration.** The first
run against this project's actual history reported `Drift: $40.00` — two
real `charge.succeeded` events from the two-webhook-endpoint period that
pass 1a couldn't see. `Missing events found: 2`, both backfilled, and the
second run landed at exactly `$0.00`. That's the incident pass 1b
(`recoverMissingLedgerEvents()`) exists to catch, found and closed on its
first real use.

To see the alarm fire on a bug rather than a historical gap, the honest way
is to break something on purpose: manually insert a balanced-but-wrong entry
via the Data API (an amount that doesn't match what Stripe actually
charged), run `npm run reconcile`, and watch `DriftCents` land nonzero in
CloudWatch. That's also the sharpest illustration of what this ADR's opening
paragraph means: a transaction like that passes the balance constraint (ADR
0004) perfectly — it's the reconciler, not the database, that catches it.

## Known gap

`charge.dispute.created` books to `stripe:cash` in `src/lib/projection.ts`
but isn't yet included in `stripeCashTotal()`'s balance-transaction filter
(disputes land under Stripe's `adjustment` type, whose shape under test-mode
simulation wasn't reliable enough to commit to on this pass). A live dispute
will show up as drift until this is extended — see ADR 0005's Consequences.
