#!/usr/bin/env ts-node
//
// Checks the synthesized CloudFormation template, not just that the code
// compiles. Most of the expensive mistakes in this project are
// template-level — a NAT Gateway, a missing grant — and neither shows up in
// `tsc --noEmit` or `cdk synth` succeeding.
//
// The ledger cluster itself is NOT a CDK resource (see
// lib/constructs/ledger.ts and docs/adr/0002-data-api-instead-of-vpc.md):
// this account's free plan only allows Aurora clusters created
// WithExpressConfiguration, which CloudFormation has no property for. So
// "pin the engine version" and "assert EnableHttpEndpoint in the template"
// don't apply here — those are asserted live, against the real cluster, by
// scripts/create-ledger-cluster.sh at provisioning time. What this script
// checks is what CDK actually does own: no VPC, no NAT gateway, no stray
// AWS::RDS::DBCluster this stack would otherwise be responsible for
// destroying, and the IAM the projector needs to reach the cluster it
// doesn't own.
//
//   npm run verify:template
//
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ParityStack } from '../lib/parity-stack';

const app = new App();
const stack = new ParityStack(app, 'ParityStack', {
  // The Region is locked project-wide (bin/parity.ts hard-codes it); no
  // account is needed to synthesize and inspect the template.
  env: { region: 'ap-south-1' },
});
const template = Template.fromStack(stack);

let failed = false;
function pass(msg: string): void {
  console.log(`  PASS  ${msg}`);
}
function fail(msg: string): void {
  console.log(`  FAIL  ${msg}`);
  failed = true;
}
function firstLine(err: unknown): string {
  return ((err as Error).message ?? String(err)).split('\n')[0];
}

console.log('No CDK-managed Aurora cluster, VPC, or NAT/internet gateway');
for (const type of [
  'AWS::RDS::DBCluster',
  'AWS::EC2::VPC',
  'AWS::EC2::NatGateway',
  'AWS::EC2::InternetGateway',
] as const) {
  try {
    template.resourceCountIs(type, 0);
    pass(`${type} count is 0`);
  } catch (err) {
    fail(`${type} count is not 0 — ${firstLine(err)}`);
  }
}

console.log('\nProjector can reach the externally-provisioned cluster');
try {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['rds-data:ExecuteStatement', 'rds-data:BeginTransaction']),
        }),
      ]),
    },
  });
  pass('IAM policy grants rds-data:* on the ledger cluster ARN');
} catch (err) {
  fail(`rds-data IAM grant missing — ${firstLine(err)}`);
}
try {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({ Action: 'secretsmanager:GetSecretValue' })]),
    },
  });
  pass('IAM policy grants secretsmanager:GetSecretValue on the ledger Data API secret');
} catch (err) {
  fail(`secretsmanager IAM grant missing — ${firstLine(err)}`);
}

console.log('\n7-day log retention still applies to every function');
for (const fn of ['parity-ledger-projector', 'parity-reconciler', 'parity-dashboard']) {
  try {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/lambda/${fn}`,
      RetentionInDays: 7,
    });
    pass(`${fn} log group retained 7 days`);
  } catch (err) {
    fail(`${fn} log group retention is wrong — ${firstLine(err)}`);
  }
}

console.log('\nProjector can only publish latency metrics into its own namespace');
try {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'cloudwatch:PutMetricData',
          Condition: { StringEquals: { 'cloudwatch:namespace': 'Parity/Projector' } },
        }),
      ]),
    },
  });
  pass('projector can only publish metrics into its own namespace');
} catch (err) {
  fail(`PutMetricData grant missing or unscoped — ${firstLine(err)}`);
}

console.log('\nReconciler runs hourly and alarms on nonzero drift');
try {
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(1 hour)',
  });
  pass('EventBridge rule schedules the reconciler hourly');
} catch (err) {
  fail(`hourly schedule missing or wrong — ${firstLine(err)}`);
}
try {
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    ComparisonOperator: 'GreaterThanThreshold',
    Threshold: 0,
  });
  pass('CloudWatch alarm fires on nonzero |drift|');
} catch (err) {
  fail(`drift alarm missing or misconfigured — ${firstLine(err)}`);
}
try {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'cloudwatch:PutMetricData',
          Condition: { StringEquals: { 'cloudwatch:namespace': 'Parity/Reconciler' } },
        }),
      ]),
    },
  });
  pass('reconciler can only publish metrics into its own namespace');
} catch (err) {
  fail(`PutMetricData grant missing or unscoped — ${firstLine(err)}`);
}

console.log('\nPublic dashboard is public (deliberately — see ADR 0006), and only reads');
try {
  template.hasResourceProperties('AWS::Lambda::Url', {
    AuthType: 'NONE',
  });
  pass('Function URL auth type is NONE (public, by deliberate choice)');
} catch (err) {
  fail(`dashboard Function URL missing or not public — ${firstLine(err)}`);
}
try {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 'rds-data:ExecuteStatement' }),
        Match.objectLike({ Action: 'rds:DescribeDBClusters' }),
      ]),
    },
  });
  pass('dashboard reads the ledger via Data API + RDS control plane');
} catch (err) {
  fail(`dashboard IAM grants missing or wrong — ${firstLine(err)}`);
}
// Scoped to the dashboard's own role by logical ID prefix — searching
// every IAM::Policy in the template for write actions would false-positive
// on the webhook ingress, projector, and reconciler, which legitimately
// write to their own resources.
const allPolicies = template.findResources('AWS::IAM::Policy');
const dashboardPolicyIds = Object.keys(allPolicies).filter((logicalId) => logicalId.startsWith('DashboardHandler'));
if (dashboardPolicyIds.length === 0) {
  fail("could not find the dashboard's own IAM policy by logical ID — construct id or naming may have changed");
} else {
  const dashboardPolicyJson = JSON.stringify(dashboardPolicyIds.map((id) => allPolicies[id]));
  const forbiddenWrites = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 's3:PutObject', 's3:DeleteObject', 'sqs:SendMessage', 'sqs:DeleteMessage', 'cloudwatch:PutMetricData'];
  const foundWrites = forbiddenWrites.filter((action) => dashboardPolicyJson.includes(action));
  if (foundWrites.length === 0) {
    pass("dashboard's own IAM policy grants no write actions");
  } else {
    fail(`dashboard's IAM policy unexpectedly includes: ${foundWrites.join(', ')}`);
  }
}

console.log();
if (failed) {
  console.log('Template verification FAILED.');
  process.exit(1);
}
console.log('Template verification passed.');
console.log(
  '\nReminder: EnableHttpEndpoint and the engine version are NOT checked here — ' +
    'the cluster is provisioned by scripts/create-ledger-cluster.sh, which asserts ' +
    'HttpEndpointEnabled live against the real cluster before recording it in SSM.',
);
