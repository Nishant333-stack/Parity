# Parity — working context

Marketplace payments platform. Stripe's event stream is the source of truth;
Postgres is a rebuildable projection of it. An hourly reconciler compares the
two and publishes drift in cents, which should always read $0.00. Everything
runs in Stripe **test mode**.

Full plan and per-week schedule: `docs/`. Read the ADRs before changing
anything they cover — each one records a decision that looks arbitrary until
you know what it prevents.

## Environment

| | |
|---|---|
| AWS project | see `aws sts get-caller-identity --profile parity` (not committed — this repo is public) |
| Region | `ap-south-1` — **locked**, cannot be changed |
| CLI profile | `parity` |
| Principal | account root (see below) |
| Plan | FREE, $139 credits, expire 2027-01-16 |
| Stripe sandbox | `acct_1UEoNuE5wxVYB6eF` (StripeMesh) |

**Credentials expire every 12 hours.** `aws login --profile parity` renews them,
without a browser, for up to 90 days. If anything returns an auth error, check
this first.

**The Region is fixed by the AWS project** and derives from the account's
contact address. `bin/parity.ts` hard-codes it deliberately so a stray
`AWS_REGION` cannot relocate resources. Lambda@Edge, CloudFormation StackSets,
and all cross-Region work are unavailable. CloudFront is exempt as a global
service in `us-east-1`, provided Lambda and API Gateway stay in `ap-south-1`.

**You cannot create a scoped IAM user.** On the new AWS experience, human IAM
is AWS-managed and team members are invited by email. `aws login` therefore
yields root, governed by managed SCPs. Do not suggest creating an IAM user for
Nishu — it is not possible. IAM is still available for *service* roles.

**There is no spend limit to set** on the free plan. A $25 Budgets alarm exists;
it notifies but does not stop spend. The credit balance is the only hard
ceiling. Watch the run rate during load testing.

## Commands

```bash
npm run setup             # whole pipeline, idempotent: deploy + secrets + endpoint + verify
npm run verify            # assert forged→400 and real event→event_received; exits non-zero
npm run logs              # tail the ingress
npm run secret <ssm-path> # store a secret from hidden input
npm run register-webhook  # recreate the Stripe endpoint, secret never displayed
npm run typecheck
npx cdk deploy --profile parity
```

## Secret handling — not negotiable

Stripe keys live in SSM Parameter Store as `SecureString`, read by Lambda at
cold start. They are never in the repo, never in CI, never in a command line.

- **Never** run `aws ssm put-parameter --value 'sk_test_...'`. That writes the
  key into `~/.zsh_history` permanently. Use `npm run secret`, which takes
  hidden input and passes it via a 0600 temp file.
- **Never** run `stripe webhook_endpoints create` by hand. Its response prints
  the signing secret, which Stripe shows exactly once and which then lives in
  scrollback forever. Use `npm run register-webhook`, which pipes it straight
  into SSM.
- If a secret is ever displayed, rotate it. This has already happened once.

## Free-plan service availability — tested, not assumed

AWS's published free-plan list is wrong in both directions here. Trust the API.

| Service | Reality |
|---|---|
| Aurora Serverless v2 (Postgres) | **available** and orderable, despite docs saying paid-only |
| DynamoDB, Lambda, API Gateway, SQS, S3, Athena, Step Functions, EventBridge, CloudWatch, SNS, CloudFront, Cognito | available |
| Kinesis Data Firehose | **blocked** — `SubscriptionRequiredException` |

`SubscriptionRequiredException` is the signature of a genuinely unsubscribed
service. A normal empty response means it works.

Because Firehose is blocked, the event archive is a direct batched write from
the projector to S3, not Firehose → S3. Athena reads the same layout.

## The Data API version trap — read before touching Aurora

`SupportsHttpEndpoint` **is** the RDS Data API, and it is gated by engine
version:

```
aurora-postgresql 13.9   → SupportsHttpEndpoint: false
aurora-postgresql 13.23  → SupportsHttpEndpoint: true
```

The Data API is what keeps Lambda out of a VPC and avoids a ~$32/month NAT
Gateway — a third of the remaining credits. **Pin the engine version explicitly
and assert `enableDataApi: true`.** Never let CDK default it.

Use `17.10`. Data-API-capable versions in this Region span 13.23–18.4; avoid
every `-limitless` variant, which is a different product.

## Design decisions

**Exactly-once effect, not delivery** (`docs/adr/0003`). Claim the event id with
a DynamoDB conditional put → enqueue → *release the claim if the enqueue
fails*. The ordering is the decision: claiming without the compensating release
turns a transient SQS error into a permanently and silently dropped payment.
A duplicate is cheap against an idempotent projector; a silent loss corrupts
the ledger undetectably. The residual crash window strands a `CLAIMED` row,
which the reconciler detects as drift and backfills from `/v2/core/events` —
so the reconciler is part of the correctness argument, not a dashboard feature.

The projector **must** be idempotent, keyed by Stripe event id. The ingress
design assumes it.

**FIFO group = payment intent, not object id** (`docs/adr/0001`). A charge, its
refunds and its disputes are separate objects describing one payment. Grouped
by their own ids they can interleave and project a refund before its charge.
A single global group would serialise all throughput for a guarantee nobody
needs.

**Signature verification strictly before any state touch.** If the claim came
first, an attacker could poison the dedupe table with invented event ids and
cause real events to be rejected as duplicates.

**Duplicates return 200, not 409.** Stripe retries any non-2xx, so an error
response makes it hammer an event already held.

**Money is integer cents, never floats.** Balances are always a sum over
immutable entries; no row stores a mutable balance. Equal debits and credits
are enforced as a database constraint, so an unbalanced write is impossible
rather than unlikely.

**7-day log retention is forced by a CDK Aspect** onto every log group,
overriding per-construct settings. CloudWatch ingest at ~$0.50/GB is the quiet
budget killer. Do not exempt a log group without a reason written down.

**The AWS SDK is bundled** (`externalModules: []`) rather than taken from the
Lambda runtime, whose bundled package set varies by version.

## Known noise

- Deploys log `current credentials could not be used to assume
  'arn:aws:iam::…:role/cdk-hnb659fds-*', but are for the right account.
  Proceeding anyway.` The SCP blocks `sts:AssumeRole` for root; CDK falls back
  to root's admin rights and succeeds. Cosmetic **now**, but it means the
  bootstrap roles are not in the deploy path — verify properly before adding CI.
- `npm audit` reports one moderate finding in `esbuild`, a build-time-only
  dependency, for an advisory about `esbuild serve`'s dev server that CDK never
  invokes. Do not `audit fix --force`; it would move CDK's bundler major.
- A second unused Stripe sandbox exists (`acct_1UEoRpELc3gtcGuX`). Keys and
  endpoints are per-sandbox, so mixing them produces signature failures that
  read like a raw-body bug. Confirm with `stripe config --list`.
- Two webhook endpoints on one URL each sign with their own secret, so half the
  deliveries fail verification, intermittently. `npm run setup` collapses to one.
- zsh mangles multi-line pastes containing `#` comments. Prefer single-line
  commands or a script.
- A corrupted or truncated Stripe *secret key* in SSM (`/parity/stripe/secret-key`)
  produces no symptom in `npm run verify` — signature verification only needs
  the webhook *signing* secret and never calls Stripe's API. It only breaks
  the first thing that actually calls the API with it, which for this
  project was Week 5's reconciler (`Invalid API Key provided: <3 chars>`).
  Re-store with `npm run secret /parity/stripe/secret-key`.
- `/v2/core/events` is not a mirror of v1 activity. Checked directly against
  this account: it returned an empty list even after real `charge.succeeded`
  traffic. It's a separate stream for v2-native resources (Money Management,
  Issuing). The reconciler's backfill uses `/v1/events` instead — see
  `docs/adr/0005`.
- This account's Lambda concurrency ceiling is **10**, account-and-region-wide
  (`aws lambda get-account-settings` → `UnreservedConcurrentExecutions: 10`),
  not AWS's usual default of 1000. Found by `scripts/chaos-replay-storm.ts`
  at its original default of 40 concurrent requests: 30 came back 503
  (capacity, not a dedupe bug — the dedupe invariant itself held throughout).
  The script's default is now 8, comfortably under the ceiling; a real
  production account would need a concurrency limit increase before this
  pipeline could handle real traffic bursts.
- `parity-cfn-exec-role` (the CloudFormation execution role, not the OIDC
  trigger role) needs its own read access to the CDK bootstrap asset bucket
  (`cdk-hnb659fds-assets-*`) — the trigger role's read+write access there
  does not cover it. CloudFormation, assumed as the exec role, is what
  actually calls `Lambda:UpdateFunctionCode`, which fetches the code zip
  using the exec role's own permissions, not the trigger role's. Missed
  originally because early CI deploys never changed Lambda code; the first
  one that did failed with `s3:GetObject AccessDenied` and pushed the stack
  to `UPDATE_ROLLBACK_FAILED`. Recovered with
  `aws cloudformation continue-update-rollback --stack-name ParityStack`.
  See README's CI/CD section.

## Division of labour

Work also happens in a Cowork session that holds the architecture, writes the
ADRs and walkthroughs, and verifies `tsc --noEmit` and the synthesized
CloudFormation template before code reaches this machine. It **cannot** run
commands here: macOS grants agents click-only access to terminals, and its
sandboxed shell has no network route to AWS or Stripe.

So the terminal side owns the execution loop — deploys, log tailing, live
resource inspection, debugging a red `npm run verify`. Git history is the
shared source of truth; commit before and after structural changes.
