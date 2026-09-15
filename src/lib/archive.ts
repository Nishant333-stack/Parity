import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

const BUCKET = process.env.ARCHIVE_BUCKET!;

/**
 * Writes one S3 object per invocation batch: newline-delimited, one
 * compact-JSON Stripe event per line. This is the durable copy that
 * rebuild-from-archive replays, and what Athena reads — both assume real
 * NDJSON, exactly one JSON value per line.
 *
 * Every raw body is re-serialized (`JSON.parse` then `JSON.stringify`)
 * before writing, not passed through as-is. Found the hard way: at least
 * one real Stripe delivery arrived pretty-printed (embedded newlines inside
 * the JSON itself), which silently broke `rawBodies.join('\n')` — a
 * "newline-delimited" file where an entry can itself contain a newline
 * isn't newline-delimited. Re-serializing guarantees one line per event
 * regardless of how Stripe formatted the original bytes; safe to do here
 * because signature verification (on the exact original bytes) already
 * happened upstream at the ingress — nothing downstream of that needs the
 * literal original formatting, only the same data.
 */
export async function archiveBatch(rawBodies: readonly string[]): Promise<void> {
  if (rawBodies.length === 0) return;

  const date = new Date().toISOString().slice(0, 10);
  const key = `events/dt=${date}/${randomUUID()}.jsonl`;
  const compact = rawBodies.map((body) => JSON.stringify(JSON.parse(body)));

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: compact.join('\n'),
      ContentType: 'application/x-ndjson',
    }),
  );
}
