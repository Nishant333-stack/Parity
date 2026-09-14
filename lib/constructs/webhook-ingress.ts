import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface WebhookIngressProps {
  /** SSM SecureString path holding the Stripe secret API key. */
  readonly secretKeyParam: string;
  /** SSM SecureString path holding the Stripe webhook signing secret. */
  readonly webhookSecretParam: string;
  /** One row per Stripe event id; claimed before enqueue. */
  readonly dedupeTable: dynamodb.Table;
  /** Ordered queue the verified event is handed to. */
  readonly queue: sqs.Queue;
}

/**
 * The front door: an HTTP API that verifies Stripe signatures, claims the
 * event id, and hands the raw body to the ordered queue.
 *
 * Nothing unverified is ever claimed or enqueued — signature rejection
 * happens before any state is touched.
 */
export class WebhookIngress extends Construct {
  public readonly webhookUrl: string;
  public readonly handler: NodejsFunction;

  constructor(scope: Construct, id: string, props: WebhookIngressProps) {
    super(scope, id);

    const stack = Stack.of(this);

    // Explicit names. CDK's generated names are fine for machines and awful
    // for humans: every log tail, alarm and demo in the next seven weeks
    // refers to this function, so it gets a name you can type from memory.
    const FUNCTION_NAME = 'parity-webhook-ingress';

    const logGroup = new logs.LogGroup(this, 'HandlerLogs', {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new NodejsFunction(this, 'Handler', {
      functionName: FUNCTION_NAME,
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'webhook.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Generous enough for a cold start that fetches two SSM parameters,
      // tight enough that a hung call fails fast instead of billing.
      timeout: Duration.seconds(10),
      logGroup,
      environment: {
        STRIPE_SECRET_KEY_PARAM: props.secretKeyParam,
        STRIPE_WEBHOOK_SECRET_PARAM: props.webhookSecretParam,
        DEDUPE_TABLE: props.dedupeTable.tableName,
        EVENT_QUEUE_URL: props.queue.queueUrl,
        // Parity is a test-mode project. Live events are refused outright
        // rather than quietly written to a ledger that has no business
        // holding real money.
        ALLOW_LIVEMODE: 'false',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        // Bundle the AWS SDK rather than trusting the runtime's copy. Which
        // @aws-sdk/* packages ship in a given Lambda runtime is a moving
        // target, and `Cannot find module '@aws-sdk/lib-dynamodb'` at 2am is
        // a worse trade than a megabyte of bundle.
        externalModules: [],
      },
    });

    // Read only the two parameters this function needs, not the whole tree.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [props.secretKeyParam, props.webhookSecretParam].map(
          (p) => `arn:aws:ssm:${stack.region}:${stack.account}:parameter${p}`,
        ),
      }),
    );

    // SecureString values are encrypted with the AWS-managed SSM key, so
    // reading them needs an explicit decrypt grant.
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [`arn:aws:kms:${stack.region}:${stack.account}:alias/aws/ssm`],
      }),
    );

    // The ingress writes claims and releases them; it never reads the table
    // back, and it must not be able to scan it.
    props.dedupeTable.grant(
      this.handler,
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );

    props.queue.grantSendMessages(this.handler);

    const api = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'parity-ingress',
      description: 'Stripe webhook ingress for Parity',
    });

    api.addRoutes({
      path: '/webhooks/stripe',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('StripeWebhook', this.handler),
    });

    // Bound the cost of a runaway sender or a misaimed load test.
    const stage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = {
      throttlingRateLimit: 100,
      throttlingBurstLimit: 50,
      detailedMetricsEnabled: true,
    };

    this.webhookUrl = `${api.apiEndpoint}/webhooks/stripe`;
  }
}
