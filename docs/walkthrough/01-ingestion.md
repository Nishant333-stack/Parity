# Walkthrough 01 — Ingestion

What happens between Stripe sending a webhook and the event sitting on the
ordered queue. Read alongside `src/handlers/webhook.ts`.

## The path

```
Stripe sandbox
  │  POST, signed with whsec_…
  ▼
API Gateway HTTP API          throttled 100 rps / 50 burst
  │  event.body (+ isBase64Encoded)
  ▼
parity-webhook-ingress (Lambda, ARM64, Node 22)
  │  1. reconstruct raw bytes
  │  2. verify signature      → 400 and stop, if forged
  │  3. refuse livemode       → 400 and stop
  │  4. resolve group id
  │  5. claim event id        → 200 duplicate, if already held
  │  6. enqueue               → release claim + 500, if this fails
  │  7. mark enqueued
  ▼
parity-events.fifo            grouped by payment intent
  │  3 failures
  ▼
parity-events-dlq.fifo        14-day retention
```

## Step 1 — the raw bytes, and why this is step one

```ts
const rawBody = event.isBase64Encoded
  ? Buffer.from(event.body ?? '', 'base64')
  : Buffer.from(event.body ?? '', 'utf8');
```

Stripe's signature covers the **exact bytes** it transmitted. The signature is
an HMAC over `timestamp + "." + payload`, so any transformation of the payload
invalidates it — including a round-trip through `JSON.parse` and
`JSON.stringify`, which is semantically identical JSON but different bytes
(key order, whitespace, number formatting).

API Gateway may hand the body over base64-encoded depending on content type and
headers, so the flag must be honoured rather than assumed.

This is the most common way a Stripe integration fails, and the failure is
maximally misleading: you get `No signatures found matching the expected
signature`, which reads like a wrong secret, so people rotate keys for an hour.
If verification ever fails on a body you believe is correct, suspect the bytes
before the key.

## Step 2 — verification before anything else

```ts
stripeEvent = client.webhooks.constructEvent(rawBody, signature, secret);
```

`constructEvent` checks the HMAC and the timestamp — the latter bounds replay
attacks, since a captured request stops verifying after the tolerance window.

Nothing before this line touches state. No claim, no queue write, no log of
event contents. A forged request costs one HMAC computation and gets a 400. The
Week 7 forged-signature injector asserts precisely this, and the ordering of
these steps is what makes the assertion meaningful: if we claimed the event id
first, an attacker could poison the dedupe table with ids they invented and
cause us to *reject real events* as duplicates.

## Step 3 — refusing livemode

Parity is a test-mode project. A live event reaching this ledger would mean
real money in a system built for a portfolio, so `livemode: true` is refused
outright rather than handled. Controlled by `ALLOW_LIVEMODE`, default off.

## Step 4 — the group id

`resolveGroupId` decides which events must stay ordered relative to each other.
Short version: group by the payment intent, not the object's own id, so a
charge and its refunds share a group. Full reasoning in
[ADR 0001](../adr/0001-fifo-grouped-by-object-id.md).

## Steps 5–7 — claim, enqueue, compensate

```ts
claim = await claimEvent({...});
if (claim === 'duplicate') return json(200, { duplicate: true });

try   { messageId = await enqueueEvent({...}); }
catch { await releaseClaim(id); return json(500, ...); }

await markEnqueued(id, messageId);
```

`claimEvent` is a conditional put — `ConditionExpression:
'attribute_not_exists(pk)'`. DynamoDB adjudicates concurrency, so fifty
simultaneous deliveries produce one `claimed` and forty-nine `duplicate`. There
is no read-then-write race because there is no read.

A duplicate returns **200**. It is tempting to return 409, but Stripe treats
non-2xx as failure and retries — so an error response would make it hammer an
event we already hold.

`releaseClaim` on enqueue failure is the load-bearing line. Without it, a
transient SQS error leaves the event marked as handled but never queued;
Stripe's retry sees a duplicate and gives up, and the event is gone with no
error anywhere. Full reasoning, including the residual crash window and why the
reconciler closes it, in
[ADR 0003](../adr/0003-where-exactly-once-lives.md).

## Response codes, and what each one asks Stripe to do

| Code | When | Stripe's reaction |
|---|---|---|
| 200 | verified and enqueued | done |
| 200 | duplicate | done — stop retrying |
| 400 | missing or invalid signature | permanent failure, no retry |
| 400 | livemode refused | permanent failure |
| 500 | SSM unreadable, dedupe or queue down | retry, up to 3 days |

The 400/500 split is the whole retry contract. 400 says *this request is
broken, never send it again*. 500 says *we are broken, please come back*.
Getting these backwards means either hammering on a forged request forever, or
permanently dropping an event because of a five-second DynamoDB blip.

## Cost and blast-radius choices

- **Bundled AWS SDK** (`externalModules: []`) rather than the runtime's copy.
  Which `@aws-sdk/*` packages ship in a given Lambda runtime moves over time,
  and `Cannot find module '@aws-sdk/lib-dynamodb'` in production is a worse
  trade than ~750 KB of bundle.
- **IAM is exactly four actions**: `PutItem`, `UpdateItem`, `DeleteItem`,
  `SendMessage` — plus `ssm:GetParameter` on two named paths and `kms:Decrypt`
  on one alias. No `Scan`, no `GetItem`, no wildcards. The ingress cannot read
  the dedupe table back, because it has no reason to.
- **Secrets cached in module scope** after a successful read only. A failed
  read caches nothing, so setting the SSM parameters needs no redeploy.
  Rotating a secret does require a cold start.
- **7-day log retention** forced by a CDK Aspect onto every log group. Logs
  ingest at ~$0.50/GB and a load test will quietly eat $20.

## Try it

```bash
npm run verify              # asserts both directions
npm run logs                # tail
stripe trigger charge.succeeded
```

To see the dedupe path, replay one event id twice — the second returns
`{"duplicate": true}` and the queue depth does not move.
