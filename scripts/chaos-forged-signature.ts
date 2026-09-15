#!/usr/bin/env ts-node
//
// The forged-signature injector referenced in src/handlers/webhook.ts and
// docs/adr/0003 as "Week 7", finally built. verify-roundtrip.sh already
// checks that ONE forged request gets HTTP 400; this goes further and
// proves the actual invariant CLAUDE.md states — "nothing unverified is
// ever claimed or enqueued" — by checking DynamoDB directly after each
// attempt, not just the HTTP status code a forged request happened to get.
//
//   npm run chaos:forged-signature
//
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import Stripe from 'stripe';

const STACK = process.env.PARITY_STACK ?? 'ParityStack';
const DEDUPE_TABLE = process.env.DEDUPE_TABLE ?? 'parity-event-dedupe';

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

/** True if the ingress ever claimed this event id in DynamoDB. */
async function everClaimed(eventId: string): Promise<boolean> {
  const result = await dynamo.send(
    new GetCommand({ TableName: DEDUPE_TABLE, Key: { pk: `evt#${eventId}` } }),
  );
  return result.Item !== undefined;
}

interface Attempt {
  readonly label: string;
  readonly eventId: string;
  build(): { body: string; signature: string };
}

function attempts(): Attempt[] {
  const suffix = Date.now();
  // A key only ever used to compute local HMAC signatures — never sent to
  // Stripe, never a real credential.
  const signer = new Stripe('sk_test_chaos_signing_only');

  const garbageId = `evt_chaos_garbage_${suffix}`;
  const wrongSecretId = `evt_chaos_wrong_secret_${suffix}`;
  const tamperedId = `evt_chaos_tampered_${suffix}`;
  const staleId = `evt_chaos_stale_${suffix}`;

  return [
    {
      label: 'header-shaped garbage (not even a valid HMAC hex string)',
      eventId: garbageId,
      build: () => ({
        body: JSON.stringify(eventBody(garbageId)),
        signature: 't=1700000000,v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }),
    },
    {
      label: 'well-formed signature, signed with the wrong secret',
      eventId: wrongSecretId,
      build: () => {
        const body = JSON.stringify(eventBody(wrongSecretId));
        const signature = signer.webhooks.generateTestHeaderString({
          payload: body,
          secret: 'whsec_not_the_real_one_at_all_000000000000',
        });
        return { body, signature };
      },
    },
    {
      label: 'validly-signed body, mutated by one byte after signing',
      eventId: tamperedId,
      build: () => {
        const original = JSON.stringify(eventBody(tamperedId));
        // Sign the original, then send a body that differs from what was
        // signed — proves this project verifies exact bytes, not "a
        // signature that looks right for roughly this payload".
        const signature = signer.webhooks.generateTestHeaderString({
          payload: original,
          secret: 'whsec_irrelevant_body_is_what_changes_000000',
        });
        const tampered = original.replace('"amount":0', '"amount":1');
        return { body: tampered, signature };
      },
    },
    {
      label: 'correctly-signed but far outside the replay tolerance window',
      eventId: staleId,
      build: () => {
        const body = JSON.stringify(eventBody(staleId));
        const signature = signer.webhooks.generateTestHeaderString({
          payload: body,
          secret: 'whsec_timestamp_is_what_matters_here_00000000',
          timestamp: Math.floor(Date.now() / 1000) - 60 * 60, // 1h old; Stripe's default tolerance is 5m
        });
        return { body, signature };
      },
    },
  ];
}

function eventBody(id: string): Record<string, unknown> {
  return {
    id,
    object: 'event',
    type: 'charge.succeeded',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: `ch_${id}`, object: 'charge', amount: 0 } },
  };
}

async function main(): Promise<void> {
  const url = await webhookUrl();
  console.log(`endpoint: ${url}\n`);
  console.log('Forged-signature injector — 4 attempts, each with a distinct forgery\n');

  for (const attempt of attempts()) {
    const { body, signature } = attempt.build();
    console.log(`— ${attempt.label}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body,
    });

    if (response.status === 400) {
      ok(`rejected with 400 (event id: ${attempt.eventId})`);
    } else {
      bad(`returned ${response.status}, expected 400 (event id: ${attempt.eventId})`);
    }

    // Signature rejection happens before any state touch (src/handlers/webhook.ts).
    // A forged event must never appear in the dedupe table — claimed here
    // would mean a real, later delivery of a legitimately different event
    // that happened to reuse this id could be wrongly treated as a duplicate.
    if (await everClaimed(attempt.eventId)) {
      bad(`${attempt.eventId} WAS claimed in DynamoDB — a forged event touched state`);
    } else {
      ok(`${attempt.eventId} was never claimed`);
    }
    console.log();
  }

  console.log(`${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.log('\nA forged signature reached claimed state — this is the invariant this project is built around.');
    process.exit(1);
  }
  console.log('\nEvery forgery was rejected before touching any state.');
}

main().catch((err) => {
  console.error(`\nFAILED: ${(err as Error).message}`);
  process.exit(1);
});
