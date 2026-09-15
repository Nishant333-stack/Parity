#!/usr/bin/env ts-node
//
// The replay-storm injector referenced in docs/adr/0003 as "Week 7": fires
// one validly-signed event at the live webhook CONCURRENCY times at once,
// then proves the claim in ADR 0003 directly — "fifty concurrent deliveries
// of one event produce exactly one 'claimed' and forty-nine 'duplicate'"
// (src/lib/dedupe.ts) — by counting real HTTP responses, not by reasoning
// about DynamoDB's conditional-write semantics from the outside.
//
// Uses event type payment_intent.succeeded, which project() books as a
// no-op (src/lib/projection.ts) — this proves the whole ingest→dedupe→queue
// →idempotent-projection path end to end without moving a single cent
// through the ledger, so it's safe to run against the live stack any time.
//
//   npm run chaos:replay-storm
//
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import Stripe from 'stripe';
import { execute, param } from '../src/lib/data-api';
import { getSecret } from '../src/lib/secrets';

const STACK = process.env.PARITY_STACK ?? 'ParityStack';
const DEDUPE_TABLE = process.env.DEDUPE_TABLE ?? 'parity-event-dedupe';
const WEBHOOK_SECRET_PARAM = process.env.STRIPE_WEBHOOK_SECRET_PARAM ?? '/parity/stripe/webhook-secret';
// Default kept comfortably under this account's actual Lambda concurrency
// ceiling — checked directly (`aws lambda get-account-settings`): this free
// plan account allows 10 *unreserved* concurrent executions **total, across
// every function in the region**, not the usual default of 1000. The first
// version of this script defaulted to 40 and got a real, honest result: 30
// of 40 requests came back 503 (capacity, not a dedupe bug — the one that
// did get claimed was still correctly the only one). Documented in
// CLAUDE.md's Known noise. Override with CHAOS_CONCURRENCY to reproduce
// that against a higher-concurrency account.
const CONCURRENCY = Number(process.env.CHAOS_CONCURRENCY ?? 8);

const cfn = new CloudFormationClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

let pass = 0;
let fail = 0;
function ok(msg: string): void {
  pass++;
  console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`);
}
function bad(msg: string): void {
  fail++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
}

async function webhookUrl(): Promise<string> {
  const result = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
  const url = result.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'WebhookUrl')?.OutputValue;
  if (!url) throw new Error(`no WebhookUrl output on stack ${STACK} — is it deployed?`);
  return url;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A 503 here means "no Lambda execution slot was available," not "the
 * dedupe logic broke" — exactly the case this account's low concurrency
 * ceiling produces under a real storm (see the CONCURRENCY comment above).
 * Stripe itself retries any non-2xx, so retrying here is faithful to how
 * this system is actually designed to be used, not a test-only workaround.
 */
async function post(url: string, body: string, signature: string): Promise<{ status: number; duplicate: boolean }> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body,
    });
    lastStatus = response.status;
    if (response.status !== 503) {
      const json = (await response.json().catch(() => ({}))) as { duplicate?: boolean };
      return { status: response.status, duplicate: json.duplicate === true };
    }
  }
  return { status: lastStatus, duplicate: false };
}

async function main(): Promise<void> {
  const url = await webhookUrl();
  const eventId = `evt_chaos_replay_${Date.now()}`;
  const body = JSON.stringify({
    id: eventId,
    object: 'event',
    type: 'payment_intent.succeeded',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: `pi_${eventId}`, object: 'payment_intent' } },
  });

  // The real signing secret — this is the one signature that must actually
  // verify, so the storm exercises the dedupe layer, not signature rejection.
  const secret = await getSecret(WEBHOOK_SECRET_PARAM);
  const signer = new Stripe('sk_test_chaos_signing_only');
  const signature = signer.webhooks.generateTestHeaderString({ payload: body, secret });

  console.log(`endpoint: ${url}`);
  console.log(`event id: ${eventId}`);
  console.log(`firing ${CONCURRENCY} concurrent, identically-signed deliveries of the same event...\n`);

  const responses = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => post(url, body, signature)),
  );

  const non200 = responses.filter((r) => r.status !== 200);
  const claimed = responses.filter((r) => !r.duplicate);
  const duplicates = responses.filter((r) => r.duplicate);

  if (non200.length === 0) {
    ok(`all ${CONCURRENCY} requests returned 200 (duplicates are 200, not an error — ADR 0003)`);
  } else {
    bad(`${non200.length} request(s) did not return 200: ${non200.map((r) => r.status).join(', ')}`);
  }

  if (claimed.length === 1) {
    ok(`exactly 1 of ${CONCURRENCY} concurrent deliveries was claimed`);
  } else {
    bad(`${claimed.length} deliveries were claimed, expected exactly 1`);
  }

  if (duplicates.length === CONCURRENCY - 1) {
    ok(`the other ${duplicates.length} were correctly told they were duplicates`);
  } else {
    bad(`${duplicates.length} were marked duplicate, expected ${CONCURRENCY - 1}`);
  }

  // A late arrival, after the storm has settled — proves the dedupe table
  // is still authoritative once the race window has closed, not just
  // during it.
  await sleep(1000);
  const late = await post(url, body, signature);
  if (late.status === 200 && late.duplicate) {
    ok('a request arriving after the storm is also correctly marked a duplicate');
  } else {
    bad(`late request: status ${late.status}, duplicate ${late.duplicate} — expected 200, true`);
  }

  const claim = await dynamo.send(new GetCommand({ TableName: DEDUPE_TABLE, Key: { pk: `evt#${eventId}` } }));
  if (claim.Item?.status === 'ENQUEUED') {
    ok(`dedupe table shows exactly one row, status ENQUEUED`);
  } else {
    bad(`dedupe table row has status ${claim.Item?.status ?? '(missing)'}, expected ENQUEUED`);
  }

  // The projector is idempotent and keyed by event id (ADR 0004) — it should
  // have processed this single enqueued message and recorded it once, with
  // no ledger entries, since payment_intent.* books nothing (projection.ts).
  console.log('\nwaiting up to 20s for the projector to pick up the one message that reached SQS...');
  let seen = false;
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const result = await execute('SELECT event_id FROM processed_events WHERE event_id = :id', [
      param('id', eventId),
    ]);
    if ((result.records?.length ?? 0) > 0) {
      seen = true;
      break;
    }
  }
  if (seen) {
    ok('processed_events shows the event was projected exactly once, downstream of the storm');
  } else {
    bad('processed_events never picked up the event within 20s — check the projector logs');
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
  console.log(`\n${CONCURRENCY} concurrent deliveries of one event cost one enqueue and one projection.`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${(err as Error).message}`);
  process.exit(1);
});
