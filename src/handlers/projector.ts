import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type Stripe from 'stripe';
import { applyEvent } from '../lib/apply-event';
import { archiveBatch } from '../lib/archive';

const cloudwatch = new CloudWatchClient({});

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

/**
 * How long an event sat between Stripe creating it and this Lambda finishing
 * with it — includes Stripe's own delivery time, the ingress round-trip, and
 * however long the message waited on the queue, not just this function's own
 * execution. That's deliberate: it's the latency a person asking "how fresh
 * is the ledger" actually cares about, not a narrower one that looks better.
 * A single PutMetricData call per event is enough for CloudWatch to compute
 * percentiles later (GetMetricStatistics with ExtendedStatistics) — no
 * separate histogram bucketing needed.
 */
async function publishLatency(event: Stripe.Event): Promise<void> {
  const latencyMs = Date.now() - event.created * 1000;
  await cloudwatch
    .send(
      new PutMetricDataCommand({
        Namespace: 'Parity/Projector',
        MetricData: [{ MetricName: 'IngestToLedgerLatencyMs', Value: latencyMs, Unit: 'Milliseconds' }],
      }),
    )
    .catch((err) => log({ msg: 'latency_metric_failed', id: event.id, error: (err as Error).message }));
}

async function projectOne(rawBody: string): Promise<void> {
  const event = JSON.parse(rawBody) as Stripe.Event;
  const outcome = await applyEvent(event);
  log({ msg: outcome, id: event.id, type: event.type });
  await publishLatency(event);
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
