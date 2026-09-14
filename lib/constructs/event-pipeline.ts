import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * The ordering and deduplication substrate between ingress and projection.
 *
 *   dedupe table  — one row per Stripe event id, claimed before enqueue
 *   FIFO queue    — per-object ordering, grouped by the Stripe object id
 *   DLQ           — three failures and the message is parked, not spun
 *
 * See docs/adr/0003-where-exactly-once-lives.md for why the claim happens
 * before the enqueue and what cleans up after a crash between them.
 */
export class EventPipeline extends Construct {
  public readonly dedupeTable: dynamodb.Table;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.dedupeTable = new dynamodb.Table(this, 'DedupeTable', {
      tableName: 'parity-event-dedupe',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Rows expire well past Stripe's 30-day retry window, so a replay of
      // a month-old event still finds its claim.
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Destroyed with the stack: this table is an optimisation and an audit
      // trail, not the ledger. The ledger is rebuildable from the S3 archive,
      // and leaving orphaned tables behind burns credits.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      queueName: 'parity-events-dlq.fifo',
      fifo: true,
      // Long enough to actually investigate before evidence evaporates.
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: 'parity-events.fifo',
      fifo: true,
      // We supply MessageDeduplicationId explicitly (the Stripe event id),
      // which is stronger than hashing the body: two deliveries of the same
      // event are identical by id even if Stripe re-serialises the payload.
      contentBasedDeduplication: false,
      // Must exceed the projector's timeout, or a slow projection gets
      // redelivered while still in flight and ordering breaks.
      visibilityTimeout: Duration.seconds(90),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });
  }
}
