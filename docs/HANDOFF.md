# Handoff — state of play and next step

Written 2026-09-14 for a Claude Code session taking over execution.
Read `CLAUDE.md` first; it holds the environment facts and hard constraints.

## What exists

Repo `~/Desktop/Parity`, git `main`, 24 files, clean tree. Stack `ParityStack`
deployed in `ap-south-1` — but **only the Week 1 resources**. The Week 2
additions are committed and validated, not deployed.

**Week 1 — foundations (deployed).** CDK v2 + TypeScript with the full modern
feature-flag set. Region hard-coded. `LogRetentionAspect` forces 7-day
retention on every log group. HTTP API throttled 100 rps / 50 burst. Function
and log group named `parity-webhook-ingress`.

```
WebhookUrl = https://ks0qsqztaa.execute-api.ap-south-1.amazonaws.com/webhooks/stripe
```

**Week 2 — exactly-once ingestion (committed, NOT deployed).** DynamoDB
`parity-event-dedupe` (on-demand, 35-day TTL, PITR). `parity-events.fifo`
grouped by payment intent, dedupe id = Stripe event id, redrive to DLQ after 3.
Handler: raw-byte signature verification → livemode refusal → group resolution
→ conditional-put claim → enqueue → compensating release on failure.

Validated by inspecting the synthesized template, not just the code: FIFO true,
redrive 3, TTL on, handler IAM exactly `PutItem`/`UpdateItem`/`DeleteItem`/
`SendMessage` plus two named SSM paths and one KMS alias. `tsc --noEmit` clean,
`cdk synth` clean.

**Scripts.** `npm run setup` (whole pipeline, idempotent), `verify`, `secret`,
`register-webhook`, `logs`.

**Docs.** `docs/adr/0001-fifo-grouped-by-object-id.md`,
`docs/adr/0003-where-exactly-once-lives.md`,
`docs/walkthrough/01-ingestion.md`.

## Immediate task — a red verification

`npm run verify` currently fails:

```
negative test — forged signature      PASS  rejected with 400
positive test — payment_intent.succeeded   FAIL  no event_received within 60s
```

CloudWatch shows **every** real event rejected with
`invalid_signature` — "No signatures found matching the expected signature for
payload."

Two hypotheses, in order of likelihood:

1. **More than one webhook endpoint on that URL.** Each signs with its own
   secret, so only deliveries from the endpoint whose secret is in SSM verify.
   `npm run setup` deletes every endpoint for the URL and creates one fresh, so
   running it should resolve this.
2. **A stray character in the stored signing secret.** A trailing space copied
   with the key is invisible and produces exactly this error, which misdirects
   you at raw-body handling. `scripts/set-secret.sh` now strips all whitespace
   and validates the prefix, and `register-webhook.sh` never renders the secret
   at all — so re-registering fixes it.

Start with:

```bash
npm run setup
```

It deploys Week 2, collapses to one endpoint, stores the fresh secret without
displaying it, and re-verifies.

**If it still fails**, the raw body is genuinely suspect. Log
`event.isBase64Encoded`, `Buffer.byteLength(rawBody)`, the first and last 20
bytes of `rawBody`, and the `stripe-signature` header's `t=` value — then
compare against Stripe's dashboard delivery attempt for the same event id.
Do not log the body's full contents or any secret.

Also confirm the active sandbox is `acct_1UEoNuE5wxVYB6eF` via
`stripe config --list`. A second sandbox exists and keys are per-sandbox.

## Next build step — Week 3, the ledger

Aurora Serverless v2, the schema with its balanced-entry constraint, the
projector consuming the FIFO queue, the S3 archive, and rebuild-from-archive.

Four constraints that are easy to get wrong and expensive to discover late:

**1. Pin the engine and assert the Data API.** `SupportsHttpEndpoint` *is* the
Data API and it is version-gated (`13.9` false, `13.23` true). Use `17.10`.

```ts
engine: rds.DatabaseClusterEngine.auroraPostgres({
  version: rds.AuroraPostgresEngineVersion.of('17.10', '17'),
}),
enableDataApi: true,
```

Verify `"EnableHttpEndpoint": true` in the synthesized template before
deploying. If it is absent, stop — the alternative is a VPC-attached Lambda and
a NAT Gateway.

**2. The VPC must have zero NAT Gateways.** Aurora requires a VPC; the Lambda
does not join it, because the Data API is HTTPS with IAM auth. CDK's `ec2.Vpc`
default creates one NAT Gateway per AZ at ~$32/month each — which against $139
of credits is the single most destructive default in this project.

```ts
new ec2.Vpc(this, 'Vpc', {
  natGateways: 0,
  subnetConfiguration: [
    { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
  ],
});
```

Assert `AWS::EC2::NatGateway` count is **0** in the template. No IGW either.

**3. Money is signed integer cents, and transactions sum to zero.** Never
floats, never a mutable balance column. A balance is always a sum over
immutable entries.

Enforce balance in the database, not the application. A row-level `CHECK`
cannot express "these rows sum to zero", so use a **deferrable constraint
trigger** that fires at commit:

```sql
CREATE TABLE entries (
  id           bigserial PRIMARY KEY,
  txn_id       uuid    NOT NULL REFERENCES transactions(id),
  account      text    NOT NULL,
  amount_cents bigint  NOT NULL CHECK (amount_cents <> 0),  -- signed
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_txn_balanced();
```

where `assert_txn_balanced()` raises unless
`SUM(amount_cents) = 0` for the affected `txn_id`. Deferring to commit is what
lets a multi-row journal entry be inserted at all. Signed amounts make
"balanced" a single `SUM(...) = 0`, which is far cleaner than paired
debit/credit columns.

Write a test that attempts an unbalanced insert and asserts it is **rejected by
the database**. That test is the project's central claim; without it the
"impossible rather than unlikely" framing is marketing.

**4. The projector must be idempotent, keyed by Stripe event id.** ADR 0003's
ingress design depends on this — it is not defence in depth. Record the event
id with the entries it produced, in the same transaction, and make replaying a
processed event a no-op.

Also: the archive is **projector → S3 (batched) → Athena**, not Firehose.
Firehose is blocked on the free plan.

When the ledger is in, write `docs/adr/0002-data-api-instead-of-vpc.md`
(covering the version gate and the NAT-Gateway avoidance) and
`docs/adr/0004-balanced-entries-in-the-database.md`, plus
`docs/walkthrough/02-ledger.md`. The ADRs are the study material and are part
of the deliverable, not an afterthought.

## Rules

- **Never print, echo, or log a secret value.** If one is displayed, rotate it.
  Use `npm run secret` and `npm run register-webhook`.
- **Never suggest creating an IAM user for the human.** Impossible on this
  account type; human IAM is AWS-managed.
- Credentials expire every 12 hours; `aws login --profile parity` renews them.
- Check the synthesized template, not just that the code compiles. Most of the
  expensive mistakes here are template-level: a NAT Gateway, a missing
  `EnableHttpEndpoint`, an unbounded log group.
- Commit before and after structural changes. Git history is shared with a
  Cowork session that also edits this repo.
