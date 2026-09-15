# Walkthrough 02 — The ledger

What happens between an event landing on the ordered queue and it becoming
balanced rows in Postgres — or, for some event types, nothing at all. Read
alongside `src/handlers/projector.ts` and `src/lib/apply-event.ts`.

## The path

```
parity-events.fifo            grouped by payment intent (ADR 0001)
  │  batch of up to 10 messages
  ▼
parity-ledger-projector (Lambda, ARM64, Node 22)
  │  1. archive the whole batch's raw bodies to S3, one object
  │  2. per message: parse, then applyEvent()
  │       a. claim the event id in processed_events  → no-op, if already claimed
  │       b. project() the event to entries            → [] for payment_intent.*
  │       c. insert transaction + entries, in one Data API transaction
  │       d. COMMIT                                     → rejected, if unbalanced
  │  3. report per-message failures (FIFO: one bad message blocks only its group)
  ▼
Aurora Serverless v2 (Postgres, Express Configuration — ADR 0002)
  reached only via the RDS Data API, never a VPC network path
```

## Step 1 — archive first

```ts
await archiveBatch(event.Records.map((r) => r.body));
```

One S3 object per invocation, newline-delimited, exactly the raw bodies
already verified at ingress — no re-verification here, the trust boundary
was crossed once, at the webhook. This happens *before* any projection, so
even if every record in the batch fails to project, the raw events are
still durable and `rebuild-ledger` can recover from them regardless.
Archiving twice on a retried batch costs nothing: rebuild keys off event id,
same as everything else here.

Firehose would normally own this job; it's unsubscribed on the free plan
(`SubscriptionRequiredException`), so it's a direct batched write instead.

## Step 2 — applyEvent(), the one function three callers share

```ts
export async function applyEvent(event: Stripe.Event): Promise<ApplyOutcome> {
  const entries = project(event);
  return withTransaction(async (txId) => {
    const claim = await execute(
      'INSERT INTO processed_events (event_id, event_type) VALUES (:eventId, :eventType) ' +
        'ON CONFLICT (event_id) DO NOTHING', ...);
    if (claim.numberOfRecordsUpdated === 0) return 'already_processed';
    if (entries.length === 0) return 'no_entries';
    // insert transaction, insert entries, mark processed_events.txn_id, COMMIT
  });
}
```

This function is called from exactly two places: the live projector
(`src/handlers/projector.ts`) and `scripts/rebuild-ledger.ts`. That's
deliberate — "rebuild replays through the same projection logic" is true
because it's the same function, not a claim about two implementations that
happen to agree today.

The claim is `INSERT ... ON CONFLICT (event_id) DO NOTHING`, inside the same
transaction as everything else this event produces. `numberOfRecordsUpdated
=== 0` means another call already claimed this event id — replaying it is a
no-op, and idempotency doesn't depend on the caller checking anything first.
See [ADR 0003](../adr/0003-where-exactly-once-lives.md): this is what that
ADR's ingress design assumes exists.

## Step 3 — project(), and the no-op that isn't a bug

```ts
case 'charge.succeeded':
  return offsettingPair(cents(object.amount), 'stripe:cash', 'merchants:payable');
case 'charge.refunded':
  return offsettingPair(cents(object.amount_refunded), 'merchants:payable', 'stripe:cash');
case 'charge.dispute.created':
  return offsettingPair(cents(object.amount), 'disputes:held', 'stripe:cash');
default:
  return [];
```

`charge.succeeded` and `charge.refunded` are treated as the money-moving
events. A PaymentIntent is an orchestration object — Stripe fires
`payment_intent.succeeded` and `charge.succeeded` for the same payment, and
booking both would book the same money twice. So `payment_intent.*` events
fall through to `default: []`: recorded in `processed_events` (for
idempotency — a replayed `payment_intent.succeeded` is still a no-op, not
just an unhandled one) but they book nothing. `entries.length === 0` isn't
an error path, it's the documented shape of half this switch statement.

Every non-empty branch returns an *offsetting pair* — one account +amount,
the other -amount — so every event that books anything is balanced on its
own terms before it ever reaches the database. The database doesn't trust
that, though; see below.

## Step 4 — commit is where "balanced" is actually enforced

```ts
try {
  await client.send(new CommitTransactionCommand({ resourceArn, secretArn, transactionId }));
} catch (err) {
  await rollback(resourceArn, secretArn, transactionId);
  throw err;
}
```

The `entries_balanced` constraint trigger is `DEFERRABLE INITIALLY
DEFERRED` — it fires at commit, not at the `INSERT` that would naively seem
to violate it. So a bug in `project()` that produced an unbalanced pair
would fail *here*, at `CommitTransactionCommand`, not at any individual
`ExecuteStatement` call. Full reasoning, including why an immediate
(non-deferred) trigger can't do this job, in
[ADR 0004](../adr/0004-balanced-entries-in-the-database.md).

One thing this project's schema needed that a plain-Postgres tutorial
wouldn't mention: Data API sends string parameters typed as `text`, and
Postgres will not implicitly cast that to the `uuid` type of `entries.txn_id`
— every parameter binding against that column needs an explicit `::uuid`
cast (`:txnId::uuid`), or `ExecuteStatement` fails with `column "txn_id" is
of type uuid but expression is of type text`. Found by running
`test-balance-constraint.ts` against the real cluster, not by reading the
schema.

## Why the cluster isn't a CDK resource

Short version: this account's free plan only allows Aurora clusters created
`WithExpressConfiguration`, which CloudFormation has no property for.
`scripts/create-ledger-cluster.sh` provisions it — idempotently, the same
pattern as the webhook endpoint — and records its identity in SSM
(`/parity/ledger/*`) rather than as CDK outputs. `src/lib/data-api.ts`
resolves those paths at cold start through the same `getSecret()` helper
already used for the Stripe credentials. Full story, including why the
Data API needs a second, bootstrapped credential because Express
Configuration's master user is IAM-auth-only, in
[ADR 0002](../adr/0002-data-api-instead-of-vpc.md).

## Cost and blast-radius choices

- **`serverlessV2MinCapacity: 0` is moot** — Express Configuration clusters
  aren't CDK-managed, so this is set on the RDS side by
  `create-ledger-cluster.sh`'s defaults, not this repo's CDK code.
- **The S3 archive bucket is `RemovalPolicy.DESTROY` +
  `autoDeleteObjects: true`**, same reasoning as the dedupe table: this is a
  projection of Stripe's event stream, not the copy of record, so nothing
  about it should outlive the stack by accident.
- **IAM for the projector is five `rds-data:*` actions on one cluster ARN**,
  `secretsmanager:GetSecretValue` on the `parity-ledger-data-api-user-*`
  prefix specifically, and `ssm:GetParameter` on three named paths. No
  wildcards wider than that.
- **7-day log retention**, same CDK Aspect as every other log group in this
  project.

## Try it

```bash
npm run verify:template       # no VPC, no NAT gateway, no CDK-owned DB cluster
npm run create-ledger-cluster # idempotent: provisions the cluster if it doesn't exist
npm run migrate                # applies db/schema.sql
npm run test:ledger            # the central claim: unbalanced entries are rejected
stripe trigger charge.succeeded
npm run logs:projector
```

To see the archive and rebuild path:

```bash
npm run rebuild-ledger                # dry run — reports what would replay
npm run rebuild-ledger -- --yes       # truncates the ledger and replays from S3
```
