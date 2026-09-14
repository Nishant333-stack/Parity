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

**Week 1 — foundations.** The webhook round-trip: an HTTP API that verifies Stripe
signatures and rejects forgeries before doing any work.

Not built yet: dedupe and SQS FIFO (Week 2), the ledger (Week 3), v2 events (Week 4),
reconciliation (Week 5).

## Environment

| | |
|---|---|
| AWS project | 703091484164 |
| Region | `ap-south-1` — **locked**, derived from the account contact address |
| CLI profile | `parity` |
| Aurora engine | PostgreSQL `17.10` (pinned — see below) |

Credentials last 12 hours. Renew with `aws login --profile parity`.

### Two constraints worth knowing before you touch infrastructure

**The Region cannot change.** On the new AWS experience every project shares one Region.
`bin/parity.ts` hard-codes it rather than reading `AWS_REGION`, so a stray environment
variable can never silently relocate resources. Lambda@Edge, StackSets, and all
cross-Region work are unavailable.

**The RDS Data API is engine-version-gated.** Aurora PostgreSQL `13.9` reports
`SupportsHttpEndpoint: false`; `13.23` reports `true`. The Data API is what keeps Lambda
out of a VPC and avoids a ~$32/month NAT Gateway, so when the cluster arrives in Week 3 it
must pin its version explicitly and set `enableDataApi: true`. Never let CDK default it.

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

## Layout

```
bin/parity.ts                        app entry; Region lock and log-retention aspect
lib/parity-stack.ts                  stack composition, SSM parameter paths
lib/aspects/log-retention.ts         forces 7-day retention on every log group
lib/constructs/webhook-ingress.ts    HTTP API + verifying Lambda
src/handlers/webhook.ts              signature verification, livemode guard
src/lib/secrets.ts                   cached SSM SecureString reads
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

`stripe-node` is pinned to a major range. Week 4 introduces the v2 API surface
(`/v2/core/events`, thin events); run `npm outdated stripe` then, since v2 support tracks
recent majors. Also confirm `money_management/financial_accounts` is enabled on the
account — it may need explicit activation.
