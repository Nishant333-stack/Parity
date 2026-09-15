import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { LEDGER_SSM_PATHS } from './ledger';

export interface DashboardProps {
  /** DB cluster identifier of the externally-provisioned ledger cluster. */
  readonly ledgerClusterId: string;
}

/**
 * The public dashboard: one Lambda behind a Function URL, serving both the
 * HTML page and its own JSON API (`/api/snapshot`) from the same origin —
 * no CORS, no separate API Gateway route, no S3/CloudFront. Public, no
 * auth, by deliberate choice (docs/adr/0006): everything it reads is
 * read-only operational metadata plus Stripe test-mode ledger data. No
 * secrets ever reach the response, and nothing here can mutate anything.
 */
export class Dashboard extends Construct {
  public readonly handler: NodejsFunction;
  public readonly url: string;

  constructor(scope: Construct, id: string, props: DashboardProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const FUNCTION_NAME = 'parity-dashboard';

    const logGroup = new logs.LogGroup(this, 'HandlerLogs', {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new NodejsFunction(this, 'Handler', {
      functionName: FUNCTION_NAME,
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'dashboard.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Gathers from five services in one request (logs, DynamoDB, RDS
      // control plane, S3, SQS, plus four Data API queries) — generous
      // relative to the other functions here for the same reason.
      timeout: Duration.seconds(15),
      logGroup,
      environment: {
        LEDGER_CLUSTER_ARN_PARAM: LEDGER_SSM_PATHS.clusterArn,
        LEDGER_SECRET_ARN_PARAM: LEDGER_SSM_PATHS.secretArn,
        LEDGER_DATABASE_PARAM: LEDGER_SSM_PATHS.databaseName,
        PARITY_ACCOUNT_ID: stack.account,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: [],
      },
    });

    const functionUrl = this.handler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    this.url = functionUrl.url;

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [LEDGER_SSM_PATHS.clusterArn, LEDGER_SSM_PATHS.secretArn, LEDGER_SSM_PATHS.databaseName].map(
          (p) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${p}`,
        ),
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds-data:ExecuteStatement'],
        resources: [`arn:aws:rds:${stack.region}:${stack.account}:cluster:${props.ledgerClusterId}`],
      }),
    );

    // Same reasoning as the projector's and reconciler's grants: this
    // secret isn't a CDK resource, and Secrets Manager always appends a
    // random suffix to its ARN.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:parity-ledger-data-api-user-*`],
      }),
    );

    // RDS control-plane read (cluster status) — distinct from rds-data
    // above, which is the Data API used to query rows.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:DescribeDBClusters'],
        resources: [`arn:aws:rds:${stack.region}:${stack.account}:cluster:${props.ledgerClusterId}`],
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DescribeTable'],
        resources: [`arn:aws:dynamodb:${stack.region}:${stack.account}:table/parity-event-dedupe`],
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:GetQueueAttributes'],
        resources: [
          `arn:aws:sqs:${stack.region}:${stack.account}:parity-events.fifo`,
          `arn:aws:sqs:${stack.region}:${stack.account}:parity-events-dlq.fifo`,
        ],
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::parity-event-archive-${stack.account}-${stack.region}`],
      }),
    );

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['logs:FilterLogEvents'],
        resources: [
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/parity-webhook-ingress:*`,
          `arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/lambda/parity-ledger-projector:*`,
        ],
      }),
    );
  }
}
