# ADR 0002 — Data API instead of VPC, and what the free plan did to that plan

**Status:** accepted · **Date:** 2026-09-15

## Context

Aurora clusters live in a VPC. A Lambda that talks to one normally has two
options: join the VPC (an ENI per concurrent execution, a NAT gateway for any
egress that isn't to the cluster itself — Secrets Manager, SSM, S3), or reach
it over the RDS Data API, an HTTPS endpoint with IAM auth that needs no
network path into the VPC at all.

Against a $139 free-tier credit balance, this isn't a style preference. A NAT
gateway costs ~$32/month per AZ — two AZs is a third of the whole budget,
running whether or not a single event is being processed. The Data API was
the obvious choice before any code was written.

`SupportsHttpEndpoint` — the Data API — is gated by engine version
(`13.9`: false, `13.23`: true), so the version has to be pinned explicitly;
letting CDK default it risks landing before the gate flips. `17.10` is
confirmed Data-API-capable. That much matched the plan going in.

## What the plan didn't survive contact with

`cdk deploy` on the originally-designed stack — a VPC with `natGateways: 0`
and a standard `rds.DatabaseCluster` — failed outright:

```
Resource handler returned message: "To use Aurora clusters with free plan
accounts you need to set WithExpressConfiguration. To remove all
limitations, upgrade your account plan."
```

This account's free plan does not allow standard Aurora clusters at all.
The only path is **Express Configuration** — a newer RDS feature, reachable
only through the raw `CreateDBCluster` API parameter `WithExpressConfiguration`.
CloudFormation's `AWS::RDS::DBCluster` resource has no property for it (confirmed
against the CFN template reference), which means **CDK cannot create this
resource declaratively at all**, upgrading to a paid plan aside.

Express Configuration turned out to have its own chain of surprises, each
found by running the real API rather than reading one doc page front to back:

- **Cannot be associated with a VPC, at all.** Not "zero NAT gateways" —
  zero VPC. Stronger than what was asked for, in the direction that was
  asked for.
- **Cannot pin the engine version.** `create-db-cluster` accepts no
  `--engine-version` for an Express Configuration cluster. This is a real,
  AWS-side loss against the "pin to 17.10" requirement — not a choice made
  here, and not worked around.
- **Cannot set an initial database at creation.** `--database-name` is
  rejected; the database has to be created afterward, as its own step,
  against the default `postgres` database.
- **Cannot enable the Data API at creation.** `--enable-http-endpoint` at
  create time is rejected too; it's a separate `enable-http-endpoint` call
  after the cluster exists, and the cluster briefly cycles back through
  `modifying` while it applies.
- **The master user must be IAM-auth-only.** Express Configuration's
  "internet access gateway" (what makes the cluster reachable at all,
  since there's no VPC) requires it —
  `--master-user-authentication-type password` is flatly rejected:
  *"Amazon RDS requires IAM DB authentication for the master user when
  Internet Access Gateway is enabled."*

That last one is the one that actually costs engineering effort. The Data
API authenticates through a Secrets Manager secret — a username and
password — and the master user doesn't have a password. AWS's own
documentation for Express Configuration says as much: Data API "doesn't
support authentication with master username/password. You must create new
user credentials to access Data API." So reaching the Data API at all means
first reaching the database some *other* way to create the credential the
Data API will use — a chicken-and-egg step the standard CDK path never has
to think about, because `rds.Credentials.fromGeneratedSecret()` normally
just *is* the master credential.

## Decision

`scripts/create-ledger-cluster.sh` provisions the cluster outside CDK,
following the pattern this project already uses for the Stripe webhook
endpoint and its secret: an idempotent script, not a stack resource. It:

1. Creates the cluster (`--with-express-configuration`,
   `--master-user-authentication-type iam-db-auth`).
2. Enables the Data API as a separate call, and waits for the cluster to
   settle back to `available`.
3. Creates the `parity` database against the default `postgres` connection.
4. Connects once as the IAM-auth master user — via `psql`, using a
   short-lived token from `aws rds generate-db-auth-token` as the
   password — to create an ordinary password-auth role, `data_api_user`.
5. Stores that role's credentials in a **new** Secrets Manager secret (not
   an RDS-managed one; there isn't one, since the master user has no
   password) and smoke-tests the Data API against it.
6. Writes the cluster ARN, this secret's ARN, and the database name to SSM
   under `/parity/ledger/*` — paths, never values, matching how the Stripe
   secrets are already handled.

`lib/constructs/ledger.ts` owns only the S3 archive bucket. The projector
Lambda resolves the ledger's identity from those SSM paths at cold start,
through the same `getSecret()` helper already used for the Stripe
credentials (`src/lib/data-api.ts`). Its IAM policy is scoped to the
cluster's deterministic ARN (`arn:aws:rds:<region>:<account>:cluster:parity-ledger`)
and to the `parity-ledger-data-api-user-*` secret-name prefix — grants
against resources CDK doesn't own and can't reference as objects, only as
strings it constructs itself.

## Consequences

- **No NAT gateway and no VPC**, which is a strictly stronger result than
  the original "natGateways: 0" ask, arrived at for the wrong reason
  (there was no choice) rather than the right one.
- **The engine version is not pinned.** This is a genuine deviation from a
  stated non-negotiable, forced by the platform, not chosen. It's recorded
  here rather than quietly dropped.
- **The cluster's lifecycle lives outside CloudFormation.** `cdk destroy`
  will not delete it; nothing here will. Deleting or recreating it is a
  deliberate, separate, scripted action — appropriate for a resource this
  expensive to get wrong, but a real asymmetry with the rest of the stack.
- **A second credential exists purely so the Data API has something to
  authenticate with.** The master user is used exactly once, during
  bootstrap, and never again. Rotating the Data API credential later is a
  manual re-run of the bootstrap step, not an automatic Secrets Manager
  rotation.
- `scripts/verify-template.ts` can no longer assert `EnableHttpEndpoint` or
  the engine version from the synthesized template — there's no
  `AWS::RDS::DBCluster` in it to assert against. Those checks moved to
  where the cluster actually exists: `create-ledger-cluster.sh` asserts
  `HttpEndpointEnabled` live, against the real API response, before it will
  write anything to SSM.

## The interview answer

"We used the Data API to avoid a NAT gateway" is the answer that was true on
day one and stopped being the interesting part. The real story is that a
cost constraint on a free tier isn't cosmetic — it can force you off the
declarative, CDK-native path entirely, and the discipline that matters
isn't avoiding that, it's documenting exactly what got traded away and why.
Here, that trade was the engine-version pin, in exchange for zero
infrastructure cost and a VPC that doesn't exist rather than one that's
merely empty. The genuinely non-obvious part is narrower than "Aurora is
free-tier-gated": it's that Express Configuration's master user is
IAM-auth-only, which means Data API access requires bootstrapping a *second*
credential before Data API can be used for anything — a step with no
equivalent in the standard, paid-plan path, discovered only by running the
real API and reading its rejections, not by reading documentation front to
back in advance.
