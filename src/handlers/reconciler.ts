import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { reconcile } from '../lib/reconcile';

const cloudwatch = new CloudWatchClient({});

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

async function publishDrift(driftCents: number): Promise<void> {
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: 'Parity/Reconciler',
      MetricData: [{ MetricName: 'DriftCents', Value: driftCents, Unit: 'None', Timestamp: new Date() }],
    }),
  );
}

export const handler = async (): Promise<void> => {
  const result = await reconcile();
  await publishDrift(result.driftCents);

  log({
    msg: result.driftCents === 0 ? 'reconciled_clean' : 'drift_detected',
    stripeCashCents: result.stripeCashCents,
    ledgerCashCents: result.ledgerCashCents,
    driftCents: result.driftCents,
    strandedClaims: result.strandedClaims,
    backfilled: result.backfilled,
    backfillFailed: result.backfillFailed,
  });
};
