import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Dashboard } from './constructs/dashboard';
import { EventPipeline } from './constructs/event-pipeline';
import { Ledger } from './constructs/ledger';
import { Projector } from './constructs/projector';
import { Reconciler } from './constructs/reconciler';
import { WebhookIngress } from './constructs/webhook-ingress';

/**
 * Parameter Store paths for the Stripe credentials.
 *
 * The values are never in this repo, never in CI, and never pass through a
 * chat window — they are written once with `npm run secret <path>` and read
 * by the ingress Lambda at cold start.
 */
export const SSM_PATHS = {
  stripeSecretKey: '/parity/stripe/secret-key',
  stripeWebhookSecret: '/parity/stripe/webhook-secret',
} as const;

/** DB cluster identifier scripts/create-ledger-cluster.sh provisions. */
export const LEDGER_CLUSTER_ID = 'parity-ledger';

export class ParityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pipeline = new EventPipeline(this, 'EventPipeline');

    const ingress = new WebhookIngress(this, 'WebhookIngress', {
      secretKeyParam: SSM_PATHS.stripeSecretKey,
      webhookSecretParam: SSM_PATHS.stripeWebhookSecret,
      dedupeTable: pipeline.dedupeTable,
      queue: pipeline.queue,
    });

    const ledger = new Ledger(this, 'Ledger');

    new Projector(this, 'Projector', {
      queue: pipeline.queue,
      archiveBucket: ledger.archiveBucket,
      ledgerClusterId: LEDGER_CLUSTER_ID,
    });

    const reconciler = new Reconciler(this, 'Reconciler', {
      dedupeTable: pipeline.dedupeTable,
      ledgerClusterId: LEDGER_CLUSTER_ID,
      stripeSecretKeyParam: SSM_PATHS.stripeSecretKey,
    });

    const dashboard = new Dashboard(this, 'Dashboard', {
      ledgerClusterId: LEDGER_CLUSTER_ID,
    });

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: ingress.webhookUrl,
      description: 'Point the Stripe webhook endpoint at this URL',
    });

    new cdk.CfnOutput(this, 'EventQueueUrl', {
      value: pipeline.queue.queueUrl,
      description: 'Ordered FIFO queue of verified Stripe events',
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: pipeline.deadLetterQueue.queueUrl,
      description: 'Events that failed projection three times',
    });

    new cdk.CfnOutput(this, 'DedupeTableName', {
      value: pipeline.dedupeTable.tableName,
      description: 'One row per Stripe event id',
    });

    new cdk.CfnOutput(this, 'LedgerClusterId', {
      value: LEDGER_CLUSTER_ID,
      description:
        'Provisioned by scripts/create-ledger-cluster.sh, not this stack — see docs/adr/0002. ' +
        'Its ARN, Data API secret, and database name live in SSM under /parity/ledger/*',
    });

    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: ledger.archiveBucket.bucketName,
      description: 'Raw Stripe event archive — Athena and rebuild-from-archive read from here',
    });

    new cdk.CfnOutput(this, 'ReconcilerDriftAlarmTopicArn', {
      value: reconciler.alarmTopic.topicArn,
      description: 'Subscribe an email/endpoint to get notified when the ledger drifts from Stripe',
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: dashboard.url,
      description: 'Public, no-auth live dashboard — see docs/adr/0006',
    });
  }
}
