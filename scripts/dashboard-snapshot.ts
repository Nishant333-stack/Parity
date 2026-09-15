#!/usr/bin/env ts-node
//
// Gathers a point-in-time snapshot of the whole Parity system — ingress
// activity, queue depth, dedupe table, ledger balances, archive size,
// cluster health — and prints it as one JSON object on stdout.
//
// Read-only: every call here is a Describe/Get/List/SELECT. Nothing is
// mutated. Used both for ad-hoc inspection (`npm run dashboard:snapshot`)
// and as the data source for the live dashboard artifact, which a /loop
// re-runs this on a schedule to push into.
//
// Requires the same environment as the other ledger scripts:
// LEDGER_CLUSTER_ARN_PARAM, LEDGER_SECRET_ARN_PARAM, LEDGER_DATABASE_PARAM
// (scripts/dashboard-snapshot.sh sets these), plus AWS_PROFILE/AWS_REGION.
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DescribeDBClustersCommand, RDSClient } from '@aws-sdk/client-rds';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { execute, numeric } from '../src/lib/data-api';

const REGION = process.env.AWS_REGION ?? 'ap-south-1';
const WINDOW_MINUTES = 15;

const logs = new CloudWatchLogsClient({ region: REGION });
const dynamo = new DynamoDBClient({ region: REGION });
const rds = new RDSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });

async function countLogPattern(logGroup: string, pattern: string, sinceMs: number): Promise<number> {
  let count = 0;
  let nextToken: string | undefined;
  do {
    const result = await logs
      .send(
        new FilterLogEventsCommand({
          logGroupName: logGroup,
          filterPattern: pattern,
          startTime: sinceMs,
          nextToken,
        }),
      )
      .catch(() => undefined);
    if (!result) break;
    count += result.events?.length ?? 0;
    nextToken = result.nextToken;
  } while (nextToken);
  return count;
}

async function ingressActivity(sinceMs: number) {
  const logGroup = '/aws/lambda/parity-webhook-ingress';
  const [received, duplicate, rejectedSig, rejectedLive, errors500] = await Promise.all([
    countLogPattern(logGroup, '"event_received"', sinceMs),
    countLogPattern(logGroup, '"duplicate_ignored"', sinceMs),
    countLogPattern(logGroup, '"invalid_signature"', sinceMs),
    countLogPattern(logGroup, '"livemode_refused"', sinceMs),
    countLogPattern(logGroup, '?"claim_failed" ?"enqueue_failed" ?"init_failed"', sinceMs),
  ]);
  return { received, duplicate, rejectedSignature: rejectedSig, rejectedLivemode: rejectedLive, errors: errors500 };
}

async function projectorActivity(sinceMs: number) {
  const logGroup = '/aws/lambda/parity-ledger-projector';
  const [projected, alreadyProcessed, noEntries, failed] = await Promise.all([
    countLogPattern(logGroup, '"projected"', sinceMs),
    countLogPattern(logGroup, '"already_processed"', sinceMs),
    countLogPattern(logGroup, '"no_entries"', sinceMs),
    countLogPattern(logGroup, '"project_failed"', sinceMs),
  ]);
  return { projected, alreadyProcessed, noEntries, failed };
}

async function dedupeTable() {
  const result = await dynamo
    .send(new DescribeTableCommand({ TableName: 'parity-event-dedupe' }))
    .catch(() => undefined);
  return {
    approxItemCount: result?.Table?.ItemCount ?? 0,
    approxSizeBytes: result?.Table?.TableSizeBytes ?? 0,
    // DynamoDB only refreshes this a few times a day — labeled as such in the UI.
    stale: true,
  };
}

async function queueDepth(queueUrl: string) {
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  const attrs = result.Attributes ?? {};
  return {
    visible: Number(attrs.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(attrs.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(attrs.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

async function clusterStatus(clusterId: string) {
  const result = await rds
    .send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId }))
    .catch(() => undefined);
  const cluster = result?.DBClusters?.[0];
  return {
    status: cluster?.Status ?? 'unknown',
    httpEndpointEnabled: cluster?.HttpEndpointEnabled ?? false,
  };
}

async function ledgerState() {
  const [balances, txnCount, processedCount, recent] = await Promise.all([
    execute('SELECT account, SUM(amount_cents) AS total FROM entries GROUP BY account ORDER BY account'),
    execute('SELECT COUNT(*) AS n FROM transactions'),
    execute('SELECT COUNT(*) AS n FROM processed_events'),
    execute(
      `SELECT t.id, t.event_type, t.created_at, COALESCE(SUM(ABS(e.amount_cents)), 0) / 2 AS magnitude
       FROM transactions t
       LEFT JOIN entries e ON e.txn_id = t.id
       GROUP BY t.id, t.event_type, t.created_at
       ORDER BY t.created_at DESC
       LIMIT 10`,
    ),
  ]);

  const accountBalances = (balances.records ?? []).map((row) => ({
    account: row[0]?.stringValue ?? '',
    cents: numeric(row[1]),
  }));
  const globalDriftCents = accountBalances.reduce((sum, b) => sum + b.cents, 0);

  return {
    balances: accountBalances,
    globalDriftCents,
    totalTransactions: numeric(txnCount.records?.[0]?.[0]),
    totalProcessedEvents: numeric(processedCount.records?.[0]?.[0]),
    recentTransactions: (recent.records ?? []).map((row) => ({
      id: row[0]?.stringValue ?? '',
      eventType: row[1]?.stringValue ?? '',
      createdAt: row[2]?.stringValue ?? '',
      magnitudeCents: numeric(row[3]),
    })),
  };
}

async function archiveState(bucket: string) {
  let objectCount = 0;
  let totalBytes = 0;
  let latestKey: string | null = null;
  let latestModified = 0;
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'events/', ContinuationToken: continuationToken }),
    );
    for (const obj of result.Contents ?? []) {
      objectCount++;
      totalBytes += obj.Size ?? 0;
      const modified = obj.LastModified?.getTime() ?? 0;
      if (modified > latestModified) {
        latestModified = modified;
        latestKey = obj.Key ?? null;
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return { objectCount, totalBytes, latestKey };
}

async function main(): Promise<void> {
  const account = process.env.PARITY_ACCOUNT_ID ?? '703091484164';
  const queueUrl = `https://sqs.${REGION}.amazonaws.com/${account}/parity-events.fifo`;
  const dlqUrl = `https://sqs.${REGION}.amazonaws.com/${account}/parity-events-dlq.fifo`;
  const archiveBucket = `parity-event-archive-${account}-${REGION}`;
  const sinceMs = Date.now() - WINDOW_MINUTES * 60 * 1000;

  const [ingress, projector, dedupe, queue, dlq, cluster, ledger, archive] = await Promise.all([
    ingressActivity(sinceMs),
    projectorActivity(sinceMs),
    dedupeTable(),
    queueDepth(queueUrl),
    queueDepth(dlqUrl),
    clusterStatus('parity-ledger'),
    ledgerState(),
    archiveState(archiveBucket),
  ]);

  const snapshot = {
    updatedAt: new Date().toISOString(),
    windowMinutes: WINDOW_MINUTES,
    region: REGION,
    ingress,
    projector,
    dedupe,
    queue,
    dlq,
    cluster,
    ledger,
    archive,
  };

  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
}

main().catch((err) => {
  console.error(`FAILED: ${(err as Error).message}`);
  process.exit(1);
});
