import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { LEDGER_SSM_PATHS } from './ledger';

export interface ReconcilerProps {
  /** Checked for stranded CLAIMED rows and backfilled from there. */
  readonly dedupeTable: dynamodb.Table;
  /** DB cluster identifier of the externally-provisioned ledger cluster. */
  readonly ledgerClusterId: string;
  readonly stripeSecretKeyParam: string;
}

/**
 * Hourly: sums Stripe's own balance transactions and the ledger's
 * `stripe:cash` account, publishes the difference as `Parity/Reconciler:
 * DriftCents`, and alarms on it — "does my view still agree with Stripe's?"
 * (CLAUDE.md) is the question this construct exists to keep asking. Also
 * recovers stranded DynamoDB claims (ADR 0003's residual crash window) by
 * backfilling from Stripe's v1 Events API before measuring drift, so a
 * self-healed claim in this run already counts toward closing it.
 *
 * See src/lib/reconcile.ts and docs/walkthrough/03-reconciliation.md.
 */
export class Reconciler extends Construct {
  public readonly handler: NodejsFunction;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: ReconcilerProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const FUNCTION_NAME = 'parity-reconciler';

    const logGroup = new logs.LogGroup(this, 'HandlerLogs', {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new NodejsFunction(this, 'Handler', {
      functionName: FUNCTION_NAME,
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'reconciler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Paginating the full balance-transaction history plus a table scan —
      // generous relative to the other functions here, still well inside an
      // hourly cadence's own timeout budget.
      timeout: Duration.minutes(2),
      logGroup,
      environment: {
        STRIPE_SECRET_KEY_PARAM: props.stripeSecretKeyParam,
        LEDGER_CLUSTER_ARN_PARAM: LEDGER_SSM_PATHS.clusterArn,
        LEDGER_SECRET_ARN_PARAM: LEDGER_SSM_PATHS.secretArn,
        LEDGER_DATABASE_PARAM: LEDGER_SSM_PATHS.databaseName,
        DEDUPE_TABLE: props.dedupeTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: [],
      },
    });

    new events.Rule(this, 'HourlySchedule', {
      ruleName: 'parity-reconciler-hourly',
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new targets.LambdaFunction(this.handler)],
    });

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          props.stripeSecretKeyParam,
          LEDGER_SSM_PATHS.clusterArn,
          LEDGER_SSM_PATHS.secretArn,
          LEDGER_SSM_PATHS.databaseName,
        ].map((p) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${p}`),
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${stack.region}:${stack.account}:alias/aws/ssm`],
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:ExecuteStatement',
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
        ],
        resources: [`arn:aws:rds:${stack.region}:${stack.account}:cluster:${props.ledgerClusterId}`],
      }),
    );

    // Same reasoning as the projector's grant (lib/constructs/projector.ts):
    // this secret isn't a CDK resource, and Secrets Manager always appends a
    // random suffix to its ARN.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:parity-ledger-data-api-user-*`],
      }),
    );

    // Scan (there's no index on status/claimedAt — table volume is small
    // enough that a filtered scan is fine) and DeleteItem to clear a
    // successfully backfilled claim. Never PutItem/UpdateItem: the
    // reconciler recovers claims, it doesn't create them.
    props.dedupeTable.grant(this.handler, 'dynamodb:Scan', 'dynamodb:DeleteItem');

    // PutMetricData has no resource-level permissions; the namespace
    // condition is the actual scope.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': 'Parity/Reconciler' } },
      }),
    );

    this.alarmTopic = new sns.Topic(this, 'DriftAlarmTopic', {
      topicName: 'parity-reconciler-drift',
      displayName: 'Parity ledger drift',
    });

    const driftMetric = new cloudwatch.Metric({
      namespace: 'Parity/Reconciler',
      metricName: 'DriftCents',
      period: Duration.hours(1),
      statistic: 'Maximum',
    });
    // CloudWatch alarms have no "not equal" comparison; ABS() of the signed
    // drift lets one alarm catch drift in either direction against a single
    // GreaterThanThreshold(0) — the metric this project's central claim
    // ("does my view still agree with Stripe's?") actually gets alarmed on.
    const absDrift = new cloudwatch.MathExpression({
      expression: 'ABS(drift)',
      usingMetrics: { drift: driftMetric },
      period: Duration.hours(1),
    });

    new cloudwatch.Alarm(this, 'DriftAlarm', {
      alarmName: 'parity-ledger-drift',
      alarmDescription:
        "Parity's ledger no longer agrees with Stripe's own balance transactions. " +
        'Check /aws/lambda/parity-reconciler logs for stripeCashCents vs ledgerCashCents.',
      metric: absDrift,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // A missing data point (e.g. the function errored before publishing)
      // is itself suspicious for a system whose whole point is knowing when
      // it disagrees with Stripe — treat it as a breach, not as fine.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
  }
}
