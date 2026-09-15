# ADR 0006 — A public, read-only dashboard

**Status:** accepted · **Date:** 2026-09-15

## Context

Every check this project runs — `npm run verify`, `npm run test:ledger`,
`npm run reconcile` — answers a yes/no question from the terminal. None of
them answer "how is the system doing right now" for someone who isn't
sitting at this machine, which is a different, ordinary, legitimate need: a
frontend to actually look at.

A prototype of this already existed as a Claude Artifact (`docs/walkthrough`
doesn't cover it; it lived outside this repo). It worked, but depended on a
Claude Code session being open to push data into it on a schedule — take the
terminal away and the dashboard goes stale. That's fine for a demo; it isn't
"a proper frontend for this app," which is what was actually asked for: something
that lives on this project's own infrastructure and stays live without this
session's involvement.

## Decision

**One Lambda, a Function URL, no API Gateway, no S3, no CloudFront.** The
dashboard serves its own HTML page and its own JSON API
(`GET /api/snapshot`) from the same function, at the same origin — a
built-in HTTPS endpoint with no separate routing layer to configure. This is
the same instinct as ADR 0002's NAT-gateway avoidance applied to a different
kind of unnecessary infrastructure: API Gateway and CloudFront both exist to
solve problems — multi-route APIs, edge caching, custom domains — this
project doesn't have. Same-origin also means zero CORS configuration: the
page's own `fetch('/api/snapshot')` needs none, because there's no second
origin to be cross from.

**The data-gathering logic is shared, not duplicated.** `src/lib/system-snapshot.ts`
is the one implementation `npm run dashboard:snapshot` (a CLI script,
unchanged in purpose since it was first built) and the dashboard's
`/api/snapshot` route both call. A metric this project reports two different
ways from two different code paths is exactly the kind of drift ADR 0005
spent an entire ADR arguing against — the same principle applies here at
smaller stakes.

**Public, no authentication — deliberately, not by default.** Every value
this endpoint returns is either read-only AWS operational metadata (queue
depth, log counts, a cluster's status) or Stripe **test-mode** ledger data —
CLAUDE.md's opening line: "Everything runs in Stripe test mode." No secret,
credential, or real financial data ever reaches the response; the IAM policy
attached to this Lambda's role grants only `Describe*` / `Get*` / `List*` /
`rds-data:ExecuteStatement` actions, nothing that mutates anything (verified
in the synthesized template — `scripts/verify-template.ts` asserts the
Function URL's `AuthType` is `NONE` *and* separately asserts the dashboard's
own IAM policy contains none of `dynamodb:PutItem` / `UpdateItem` /
`DeleteItem`, `s3:PutObject` / `DeleteObject`, `sqs:SendMessage` /
`DeleteMessage`). Given that, the choice was offered directly rather than
assumed: public-no-auth, public-with-a-shared-key, or S3+CloudFront. Public,
no auth was chosen as the simplest option that fits data with this low a
sensitivity — not the default this project reaches for when the data behind
an endpoint is anything else.

## Amendment — the copy is product-voiced, not infrastructure-voiced, deliberately

The first version of this dashboard named its own implementation in the UI:
a tile literally read "engine: Aurora PostgreSQL, reached via: RDS Data API,
no VPC," another wore an "S3" badge. That's accurate and it's also exactly
backwards for who reads a dashboard — an operator checking whether the
ledger agrees with Stripe does not care which AWS service backs it, any
more than a Stripe user checking their balance cares that Stripe itself
runs on AWS. The service names belong in the ADRs, where the audience is a
developer deciding on an implementation; the dashboard's audience is
someone asking "is everything okay," and every technology name in that
context reads as the page explaining itself instead of answering the
question. The rewrite renamed tiles into what they mean operationally
("Projector" → "Processing", "Dedupe table" → "Duplicate protection") and
removed every AWS service name from visible copy — `docs/adr` and
`docs/walkthrough` remain exactly where that detail lives. Interactivity
(a real time-range control backed by `/api/snapshot?window=`, not a
decorative filter; transaction filtering; a session-lifetime trend
sparkline on the one number that matters most) was added at the same time,
for the same underlying reason: a dashboard that only auto-refreshes is a
display, not a tool, and it *reads* as generated exactly because nothing on
it responds to being touched.

## Consequences

- **Anyone with the URL can see this project's operational internals** —
  DLQ depth, ledger balances, recent transaction amounts. Acceptable for
  test-mode data on a portfolio project; would need real authentication
  (the Function URL's `AWS_IAM` auth type, or an authorizer in front of it)
  the moment any of this stopped being true.
- **Every page load and poll interval (20s) runs a real, non-trivial
  operation** — a CloudWatch Logs filter over two log groups, a DynamoDB
  `DescribeTable`, an RDS `DescribeDBClusters`, an S3 `ListObjectsV2`, two
  SQS `GetQueueAttributes` calls, and four Data API queries — all on every
  request, no caching. Fine at this project's traffic; a dashboard anyone
  could stumble onto and leave open in a tab is a real cost vector a
  higher-traffic version of this would need to address (server-side
  caching with a short TTL, most simply).
- **The Function URL's own concurrency is unprotected.** Nothing rate-limits
  requests to it the way `WebhookIngress`'s HTTP API stage is explicitly
  throttled to 100 rps / 50 burst. A public, uncached, no-auth endpoint with
  no throttle is the shape of thing worth revisiting before this pattern is
  reused for anything with higher stakes than a demo dashboard.

## The interview answer

The interesting decision here isn't "Lambda Function URL instead of API
Gateway" — that's a cost and complexity call with an obvious answer once
you notice this project doesn't need routing or edge caching. It's that
"public dashboard" and "public API with no authentication" sound alarming
together right up until you ask what specifically the endpoint can do: read
five AWS services, all `Describe`/`Get`/`List`, over data that's already
Stripe test-mode by the whole project's design (CLAUDE.md again). The
security question was never "should this require auth" as a blanket rule —
it's "what does a caller with the URL and nothing else actually get," and
answering that concretely is what makes "public, no auth" a decision rather
than an oversight.
