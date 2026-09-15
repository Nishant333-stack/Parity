# Parity

A marketplace payments platform that proves its own correctness — every Stripe event
ingested exactly once, projected into a double-entry ledger, and continuously reconciled
against Stripe's own books.

Stripe is the source of truth. This database is a projection of Stripe's event stream,
rebuildable from scratch at any time. Which means Parity can answer a question most
payments projects cannot: **does my view still agree with Stripe's?** It answers hourly,
in cents, and alarms when the answer is no.

Everything runs against Stripe **test mode**. Real API calls, real signed webhooks, no
real money. Live-mode events are refused at the ingress by design.

## Status

**Weeks 1–5 — the whole loop.** The webhook round-trip, exactly-once ingestion onto an
ordered queue, a double-entry ledger projected from it (balanced by a database constraint,
idempotent by Stripe event id, rebuildable from an S3 archive), and an hourly reconciler
that sums Stripe's own balance transactions, compares them against the ledger's
`stripe:cash` account, and alarms on nonzero drift. CI/CD via GitHub Actions, OIDC-deployed,
no stored AWS credentials. A public, read-only dashboard (one Lambda Function URL, no
separate hosting) shows all of it live — see Dashboard below.

"Week 4" turned out not to be adopting Stripe's v2 events API as originally planned —
checked directly against this account, `/v2/core/events` doesn't carry this project's event
types at all. See `docs/adr/0005-comparing-against-stripes-own-books.md`.

## Environment

| | |
|---|---|
| AWS project | 703091484164 |
| Region | `ap-south-1` — **locked**, derived from the account contact address |
| CLI profile | `parity` |
| Aurora engine | PostgreSQL, Express Configuration (version not pinnable — see ADR 0002) |
| Ledger cluster | `parity-ledger` — provisioned by `scripts/create-ledger-cluster.sh`, **not** CDK |

Credentials last 12 hours. Renew with `aws login --profile parity`.

### Constraints worth knowing before you touch infrastructure

**The Region cannot change.** On the new AWS experience every project shares one Region.
`bin/parity.ts` hard-codes it rather than reading `AWS_REGION`, so a stray environment
variable can never silently relocate resources. Lambda@Edge, StackSets, and all
cross-Region work are unavailable.

**This account's free plan blocks standard Aurora clusters.** `cdk deploy` against a
CDK-managed `rds.DatabaseCluster` fails outright — only clusters created
`WithExpressConfiguration` are allowed, and CloudFormation has no property for that. The
ledger cluster is provisioned out of band by `scripts/create-ledger-cluster.sh`, which also
means the engine version can't be pinned (Express Configuration doesn't support choosing
one) and there's no VPC at all, rather than an empty one. Full story in
[ADR 0002](docs/adr/0002-data-api-instead-of-vpc.md).

Firehose is not subscribed on the free plan (`SubscriptionRequiredException`), so the
event archive is a direct batched write from the projector to S3 rather than
Firehose → S3.

## Setup

```bash
npm install
npx cdk bootstrap --profile parity
```

### Stripe credentials

Secrets live in SSM Parameter Store as `SecureString`. They are never committed, never in
CI, and never pasted into a chat. Set the API key now:

```bash
aws ssm put-parameter \
  --name /parity/stripe/secret-key \
  --type SecureString \
  --value 'sk_test_REPLACE_ME' \
  --profile parity --region ap-south-1
```

The webhook signing secret comes after the first deploy, because Stripe cannot issue one
until there is a URL to point at.

## Deploy

```bash
npm run deploy -- --profile parity
```

The stack outputs `WebhookUrl`. Current deployed endpoint:

```
https://ks0qsqztaa.execute-api.ap-south-1.amazonaws.com/webhooks/stripe
```

Register it with Stripe and capture the signing secret — it is shown **once**, at
creation:

```bash
stripe webhook_endpoints create \
  --url "https://ks0qsqztaa.execute-api.ap-south-1.amazonaws.com/webhooks/stripe" \
  --enabled-events payment_intent.succeeded \
  --enabled-events charge.succeeded \
  --enabled-events charge.refunded
```

```bash
aws ssm put-parameter \
  --name /parity/stripe/webhook-secret \
  --type SecureString \
  --value 'whsec_REPLACE_ME' \
  --profile parity --region ap-south-1 --overwrite
```

The secret is cached for the life of the Lambda execution environment, so after
changing it force a cold start (`npm run deploy` or a config update).

## Prove the round-trip

```bash
stripe trigger payment_intent.succeeded
aws logs tail /aws/lambda/parity-webhook-ingress --follow \
  --profile parity --region ap-south-1
```

You want an `event_received` line with the event id and type.

Then the negative test, which is the one that matters:

```bash
curl -i -X POST <WebhookUrl> \
  -H 'stripe-signature: t=1,v1=deadbeef' \
  -d '{"id":"evt_forged"}'
```

Expect `400 invalid signature`. A forged event must never reach the ledger.

## Dashboard

A public, read-only dashboard is deployed as part of this stack — one Lambda Function URL
serving both the page and its own JSON API (`/api/snapshot`), polling itself every 20
seconds, no separate hosting, no auth (a deliberate choice — see `docs/adr/0006`):

```bash
aws cloudformation describe-stacks --stack-name ParityStack --profile parity --region ap-south-1 \
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" --output text
```

It shows ledger integrity (the global drift a healthy system always reads $0.00 on),
per-account balances, recent transactions, queue/DLQ depth, projector activity, and cluster
health — genuinely live, not dependent on this session or any external push.

## Putting data in, and watching it land in the ledger

There's no form or API to post transactions directly — the ledger only ever moves in
response to real (test-mode) Stripe events, which is the whole point (`docs/adr/0004`).
To generate one:

```bash
stripe trigger charge.succeeded          # books +amount to stripe:cash, -amount to merchants:payable
stripe trigger charge.refunded           # reverses a prior charge
stripe trigger charge.dispute.created    # moves funds from stripe:cash to disputes:held
```

`payment_intent.*` events are also accepted but book nothing — see `src/lib/projection.ts`.
Every trigger takes 10-20 seconds to land: ingress → FIFO queue → projector → Postgres.

**To watch it land**, pick whichever fits what you're doing:

```bash
npm run logs:projector                   # tail the projector — "projected"/"no_entries"/"already_processed"
npm run dashboard:snapshot               # one JSON snapshot: balances, recent txns, queue/DLQ depth, everything
npm run reconcile                        # does the ledger still agree with Stripe? (docs/adr/0005)
```

For the actual rows, the ledger is reachable only through the RDS Data API (there's no psql
access — see `docs/adr/0002`):

```bash
CLUSTER_ARN=$(aws ssm get-parameter --name /parity/ledger/cluster-arn --profile parity --region ap-south-1 --query Parameter.Value --output text)
SECRET_ARN=$(aws ssm get-parameter --name /parity/ledger/secret-arn --profile parity --region ap-south-1 --query Parameter.Value --output text)
aws rds-data execute-statement --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database parity \
  --sql "SELECT t.event_type, e.account, e.amount_cents, t.created_at FROM transactions t JOIN entries e ON e.txn_id = t.id ORDER BY t.created_at DESC LIMIT 20" \
  --profile parity --region ap-south-1
```

Or just open the dashboard (see above) — same data, no commands.

## Layout

```
bin/parity.ts                        app entry; Region lock and log-retention aspect
lib/parity-stack.ts                  stack composition, SSM parameter paths
lib/aspects/log-retention.ts         forces 7-day retention on every log group
lib/constructs/webhook-ingress.ts    HTTP API + verifying Lambda
lib/constructs/event-pipeline.ts     dedupe table + FIFO queue + DLQ
lib/constructs/ledger.ts             S3 event archive (the cluster is NOT here — see ADR 0002)
lib/constructs/projector.ts          SQS-triggered Lambda that projects into the ledger
lib/constructs/reconciler.ts         hourly Lambda + EventBridge rule + CloudWatch alarm
lib/constructs/dashboard.ts          Function URL Lambda serving the page + /api/snapshot
src/handlers/webhook.ts              signature verification, livemode guard
src/handlers/projector.ts            archive + apply each event, report partial batch failures
src/handlers/reconciler.ts           recover stranded claims, measure drift, publish the metric
src/handlers/dashboard.ts            routes / (HTML) and /api/snapshot (JSON) from one Lambda
src/lib/secrets.ts                   cached SSM SecureString/String reads
src/lib/data-api.ts                  RDS Data API client, resolves ledger identity from SSM
src/lib/stripe-client.ts             cached Stripe API client (v1 — see ADR 0005)
src/lib/projection.ts                Stripe event → journal entries
src/lib/apply-event.ts               idempotent apply, shared by the projector and reconciler
src/lib/reconcile.ts                 stranded-claim backfill + drift computation
src/lib/archive.ts                   batched raw-event writes to S3
src/lib/system-snapshot.ts           shared by the CLI script and the dashboard's own API
src/lib/dashboard-page.ts            the dashboard's HTML/CSS/JS, as a template string
db/schema.sql                        transactions/entries/processed_events + balance trigger
scripts/create-ledger-cluster.sh     provisions the Express Configuration cluster (not CDK)
scripts/migrate.ts                   applies db/schema.sql via the Data API
scripts/test-balance-constraint.ts   the central claim: unbalanced entries are rejected
scripts/reconcile-once.ts            run one reconciliation pass on demand
scripts/rebuild-ledger.ts            replays the S3 archive through apply-event.ts
scripts/dashboard-snapshot.ts        JSON snapshot of the whole system (CLI; same logic as the dashboard's API)
scripts/verify-template.ts           synthesized-template assertions (no VPC, no NAT gateway)
scripts/setup-github-oidc.sh         provisions the GitHub Actions OIDC provider + deploy roles
.github/workflows/ci.yml             typecheck + verify:template on every push/PR
.github/workflows/deploy.yml         auto-deploy on push to main, or manual (workflow_dispatch)
```

## CI/CD

`.github/workflows/ci.yml` runs on every push and PR: `typecheck` + `verify:template`. No
AWS credentials touch GitHub at all — it's a pure local check against the synthesized
template.

`.github/workflows/deploy.yml` runs automatically on every push to `main` (every merge), and
can also be triggered by hand (`workflow_dispatch`). It deploys via GitHub's OIDC token
exchanged for a short-lived AWS session — no stored access keys, and
**not** the CDK bootstrap's own execution role, which carries `AdministratorAccess` on this
account (confirmed, not assumed). `scripts/setup-github-oidc.sh` provisions two roles
instead:

- `parity-github-actions-deploy` — what GitHub's OIDC token assumes. Orchestrates the
  deploy (CloudFormation changeset calls, CDK asset upload, the bootstrap-version check)
  and can `PassRole` into the second role. Nothing more.
- `parity-cfn-exec-role` — trusted only by `cloudformation.amazonaws.com`, not by GitHub.
  This is what CloudFormation itself assumes to actually create or update resources, scoped
  to exactly what `ParityStack` manages.

`cdk deploy --role-arn <parity-cfn-exec-role>` is what wires the second role in — without
it, CDK defaults to the bootstrap role regardless of what the caller can or can't assume.
The two-role split is what keeps a compromised or misconfigured GitHub Actions run from
mattering more than its own narrow orchestration permissions.

```bash
npm run setup-github-oidc                                    # one-time, idempotent
gh variable set AWS_DEPLOY_ROLE_ARN --body "<trigger role arn>"
gh variable set AWS_CFN_EXEC_ROLE_ARN --body "<exec role arn>"
gh variable set AWS_REGION --body "ap-south-1"
gh workflow run deploy.yml
```

## Cost guardrails

7-day log retention is applied by a CDK Aspect to *every* log group, overriding any
per-construct setting. CloudWatch Logs ingest at ~$0.50/GB is the quiet budget killer; one
chatty Lambda under load test eats $20 without appearing anywhere obvious.

The HTTP API stage is throttled to 100 rps / 50 burst to bound a runaway sender.

A $25 budget alarm and a spend limit are set outside this repo. Note the failure mode: a
tripped spend limit *pauses the project*, which surfaces as sudden `AccessDenied` on calls
that worked yesterday. Check billing before debugging code.

## Notes

`stripe-node` stayed on its pinned major (17.x) through Week 5, not bumped as originally
planned — `/v2/core/events` turned out not to carry this project's event types at all
(confirmed empty against this account after real traffic; see `docs/adr/0005`), and the v1
methods the reconciler needs (`balanceTransactions.list`, `events.retrieve`) were already
available. `money_management/financial_accounts` activation is accordingly moot for this
project unless a future week actually adopts v2-native resources.

**The Stripe secret key (`/parity/stripe/secret-key`) can silently be wrong for a long
time.** Signature verification (`stripe.webhooks.constructEvent`) only needs the *webhook
signing secret* — it never calls Stripe's API, so a corrupted or truncated secret key won't
break `npm run verify`. It only surfaces the first time something calls the Stripe API for
real, which on this project was the reconciler. If `npm run reconcile` fails with
`Invalid API Key provided`, re-store it: `npm run secret /parity/stripe/secret-key`
(interactive, hidden input — never paste a key into a command's arguments or a chat).
