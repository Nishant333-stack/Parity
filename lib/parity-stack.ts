import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EventPipeline } from './constructs/event-pipeline';
import { Ledger } from './constructs/ledger';
import { Projector } from './constructs/projector';
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
      cluster: ledger.cluster,
      databaseName: ledger.databaseName,
      archiveBucket: ledger.archiveBucket,
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

    new cdk.CfnOutput(this, 'LedgerClusterArn', {
      value: ledger.cluster.clusterArn,
      description: 'RDS Data API resource ARN for the ledger cluster',
    });

    new cdk.CfnOutput(this, 'LedgerSecretArn', {
      value: ledger.cluster.secret!.secretArn,
      description: 'Secrets Manager ARN the Data API uses to authenticate',
    });

    new cdk.CfnOutput(this, 'LedgerDatabaseName', {
      value: ledger.databaseName,
    });

    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: ledger.archiveBucket.bucketName,
      description: 'Raw Stripe event archive — Athena and rebuild-from-archive read from here',
    });
  }
}
