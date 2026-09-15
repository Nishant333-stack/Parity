# Walkthrough 03 — Reconciliation

What the hourly job actually does, and how to run it yourself without
waiting for the schedule. Read alongside `src/lib/reconcile.ts`.

## The path

```
EventBridge (rate: 1 hour)
  ▼
parity-reconciler (Lambda, ARM64, Node 22)
  │  1. scan the dedupe table for stranded CLAIMED rows (> 15 min old)
  │  2. for each: fetch from Stripe's v1 Events API, applyEvent(), delete the row
  │  3. sum Stripe's balance transactions (charge + refund, gross amount)
  │  4. sum the ledger's stripe:cash account
  │  5. drift = stripe total − ledger total
  │  6. publish DriftCents to CloudWatch (Parity/Reconciler namespace)
  ▼
CloudWatch Alarm (ABS(DriftCents) > 0)
  │  breaches on nonzero drift, or on the metric simply not showing up
  ▼
SNS topic parity-reconciler-drift        no subscribers by default — see below
```

## Step 1–2 — recover before you measure

```ts
const stranded = await findStrandedClaims();
for (const claim of stranded) {
  const event = await stripe.events.retrieve(claim.eventId);
  await applyEvent(event);
  await dynamo.send(new DeleteCommand({ ... }));
}
```

A stranded claim is a DynamoDB row still `CLAIMED` more than fifteen minutes
after it was claimed — the signature of the residual crash window ADR 0003
accepts rather than closes: the process died between claiming an event id and
either enqueuing it or releasing the claim. `applyEvent()` here is the exact
same function `src/handlers/projector.ts` calls for live traffic, not a
second implementation — see `docs/adr/0005-comparing-against-stripes-own-books.md`
for why that sharing matters, and why the row is deleted rather than marked
resolved once it's recovered.

This runs *before* the drift calculation, deliberately: a claim backfilled in
this same pass already shows up in `ledgerCashTotal()` by the time step 4
runs, so recovering it and reporting it as drift never both happen in the
same reconciliation.

## Steps 3–5 — the actual question

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
Stripe balance transactions (charge + refund): $41.00
Ledger stripe:cash account:                    $41.00
Drift:                                          $0.00

Stranded claims found:  0
Backfilled:              0
Backfill failures:       0

Ledger agrees with Stripe. Drift is $0.00.
```

To see the alarm actually fire, the honest way is to break something on
purpose: manually insert a balanced-but-wrong entry via the Data API (an
amount that doesn't match what Stripe actually charged), run
`npm run reconcile`, and watch `DriftCents` land nonzero in CloudWatch. That's
also the sharpest illustration of what this ADR's opening paragraph means: a
transaction like that passes the balance constraint (ADR 0004) perfectly —
it's the reconciler, not the database, that catches it.

## Known gap

`charge.dispute.created` books to `stripe:cash` in `src/lib/projection.ts`
but isn't yet included in `stripeCashTotal()`'s balance-transaction filter
(disputes land under Stripe's `adjustment` type, whose shape under test-mode
simulation wasn't reliable enough to commit to on this pass). A live dispute
will show up as drift until this is extended — see ADR 0005's Consequences.
