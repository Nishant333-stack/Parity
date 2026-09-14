import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

const BUCKET = process.env.ARCHIVE_BUCKET!;

/**
 * Writes one S3 object per invocation batch: newline-delimited, exactly the
 * raw Stripe event bodies verified at ingress. This is the durable copy that
 * rebuild-from-archive replays, and what Athena reads.
 *
 * Firehose is unavailable on the free plan (SubscriptionRequiredException),
 * so this is a direct batched write rather than projector → Firehose → S3.
 */
export async function archiveBatch(rawBodies: readonly string[]): Promise<void> {
  if (rawBodies.length === 0) return;

  const date = new Date().toISOString().slice(0, 10);
  const key = `events/dt=${date}/${randomUUID()}.jsonl`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: rawBodies.join('\n'),
      ContentType: 'application/x-ndjson',
    }),
  );
}
