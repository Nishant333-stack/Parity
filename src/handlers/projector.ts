import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type Stripe from 'stripe';
import { applyEvent } from '../lib/apply-event';
import { archiveBatch } from '../lib/archive';

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

async function projectOne(rawBody: string): Promise<void> {
  const event = JSON.parse(rawBody) as Stripe.Event;
  const outcome = await applyEvent(event);
  log({ msg: outcome, id: event.id, type: event.type });
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  // Archive before projecting: if the projection loop below fails partway,
  // the raw events are still safely durable and rebuild-from-archive can
  // recover the ledger state regardless. Archiving is itself idempotent at
  // rebuild time (replay keys off event id), so writing it more than once on
  // a retried batch costs nothing.
  await archiveBatch(event.Records.map((r) => r.body));

  const failures: SQSBatchItemFailure[] = [];
  for (const record of event.Records) {
    try {
      await projectOne(record.body);
    } catch (err) {
      log({ msg: 'project_failed', messageId: record.messageId, error: (err as Error).message });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  // Partial batch failure reporting matters specifically because this is a
  // FIFO queue: only the failed message's group is held up (ADR 0001), not
  // the whole batch.
  return { batchItemFailures: failures };
};
