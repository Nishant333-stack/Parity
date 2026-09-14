#!/usr/bin/env ts-node
//
// Rebuilds the ledger from scratch by replaying the S3 archive: truncates
// transactions/entries/processed_events, then re-runs every archived raw
// Stripe event through applyEvent() — the same function the live projector
// uses (src/lib/apply-event.ts) — in Stripe's own event-time order.
//
// This is what "Postgres is a rebuildable projection" (CLAUDE.md) means in
// practice: the ledger has no state that isn't reconstructible from Stripe's
// event stream, and this script is the reconstruction.
//
// Destructive by design — it empties the ledger tables before replaying.
// Requires --yes; a dry run without it only reports what would be replayed.
//
// Requires LEDGER_CLUSTER_ARN, LEDGER_SECRET_ARN, LEDGER_DATABASE,
// ARCHIVE_BUCKET in the environment (scripts/rebuild-ledger.sh reads them
// from stack outputs).
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type Stripe from 'stripe';
import { applyEvent } from '../src/lib/apply-event';
import { execute } from '../src/lib/data-api';

const s3 = new S3Client({});
const BUCKET = process.env.ARCHIVE_BUCKET!;
const CONFIRM = process.argv.includes('--yes');

async function listArchiveKeys(): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'events/', ContinuationToken: continuationToken }),
    );
    for (const obj of result.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

async function loadEvents(keys: string[]): Promise<Stripe.Event[]> {
  const events: Stripe.Event[] = [];
  for (const key of keys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await obj.Body?.transformToString('utf8');
    if (!body) continue;
    for (const line of body.split('\n')) {
      if (line.trim().length === 0) continue;
      events.push(JSON.parse(line) as Stripe.Event);
    }
  }
  // Best-effort global order. The live projector's real guarantee is
  // per-payment-intent ordering via FIFO (ADR 0001); sorting by Stripe's
  // `created` timestamp approximates that across payments without needing to
  // reconstruct SQS's group semantics, which the archive doesn't preserve.
  events.sort((a, b) => a.created - b.created);
  return events;
}

async function main(): Promise<void> {
  console.log(`listing archive objects in s3://${BUCKET}/events/`);
  const keys = await listArchiveKeys();
  console.log(`found ${keys.length} archive object(s)`);

  const events = await loadEvents(keys);
  console.log(`${events.length} archived event(s) to replay`);

  if (!CONFIRM) {
    console.log('\nDry run (pass --yes to actually rebuild). No changes made.');
    return;
  }

  console.log('\nTruncating transactions, entries, processed_events...');
  await execute('TRUNCATE entries, transactions, processed_events RESTART IDENTITY CASCADE');

  let projected = 0;
  let skipped = 0;
  for (const event of events) {
    const outcome = await applyEvent(event);
    if (outcome === 'projected') projected++;
    else skipped++;
  }

  console.log(`\nrebuild complete: ${projected} transaction(s) projected, ${skipped} event(s) booked nothing`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${(err as Error).message}`);
  process.exit(1);
});
