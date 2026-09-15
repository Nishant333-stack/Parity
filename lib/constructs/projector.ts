import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { LEDGER_SSM_PATHS } from './ledger';

export interface ProjectorProps {
  /** Ordered queue of verified Stripe events (see EventPipeline). */
  readonly queue: sqs.Queue;
  /** Raw-event archive; the projector writes to it, rebuild reads from it. */
  readonly archiveBucket: s3.Bucket;
  /** DB cluster identifier of the externally-provisioned ledger cluster. */
  readonly ledgerClusterId: string;
}

/**
 * Consumes the ordered event queue and turns each Stripe event into balanced
 * ledger entries (or a documented no-op), archiving the raw event to S3 on
 * the way through so the ledger stays rebuildable from Stripe's stream.
 *
 * Idempotent by construction, keyed by Stripe event id — see
 * src/lib/data-api.ts and docs/adr/0004-balanced-entries-in-the-database.md.
 * This is not defence-in-depth: ADR 0003's ingress design assumes it.
 *
 * The ledger cluster isn't a CDK object here (see lib/constructs/ledger.ts
 * for why); the handler resolves its ARN, its Data API secret, and the
 * database name from SSM at cold start, the same way it already resolves
 * the Stripe credentials.
 */
export class Projector extends Construct {
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: ProjectorProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const FUNCTION_NAME = 'parity-ledger-projector';

    const logGroup = new logs.LogGroup(this, 'HandlerLogs', {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new NodejsFunction(this, 'Handler', {
      functionName: FUNCTION_NAME,
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'projector.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Generous relative to the ingress: a cold Data API connection plus a
      // multi-statement transaction is slower than the ingress's single
      // signature check, and this must comfortably clear the queue's
      // visibility timeout or messages redeliver mid-flight.
      timeout: Duration.seconds(60),
      logGroup,
      environment: {
        LEDGER_CLUSTER_ARN_PARAM: LEDGER_SSM_PATHS.clusterArn,
        LEDGER_SECRET_ARN_PARAM: LEDGER_SSM_PATHS.secretArn,
        LEDGER_DATABASE_PARAM: LEDGER_SSM_PATHS.databaseName,
        ARCHIVE_BUCKET: props.archiveBucket.bucketName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: [],
      },
    });

    // FIFO ordering means a poison message only blocks its own group (ADR
    // 0001). Reporting partial batch failures preserves that: one bad
    // message in a batch doesn't force-redeliver the others.
    this.handler.addEventSource(
      new SqsEventSource(props.queue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: Object.values(LEDGER_SSM_PATHS).map(
          (p) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${p}`,
        ),
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BatchExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [`arn:aws:rds:${stack.region}:${stack.account}:cluster:${props.ledgerClusterId}`],
      }),
    );

    // The Data API authenticates to Postgres with this secret on the
    // caller's behalf. It's a secret scripts/create-ledger-cluster.sh
    // creates (not an RDS-managed one — the cluster's master user is
    // IAM-auth-only, so Data API uses a separately bootstrapped DB role
    // instead); Secrets Manager always appends a random suffix to the ARN,
    // which CDK has no way to know since the secret isn't a CDK resource.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:parity-ledger-data-api-user-*`],
      }),
    );

    props.archiveBucket.grantWrite(this.handler);

    // PutMetricData has no resource-level permissions; the namespace
    // condition is the actual scope (same pattern as the reconciler's).
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'Parity/Projector' } },
      }),
    );
  }
}
