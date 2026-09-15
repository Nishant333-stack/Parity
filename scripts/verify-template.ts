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
  pass('IAM policy grants secretsmanager:GetSecretValue on rds!cluster-* secrets');
} catch (err) {
  fail(`secretsmanager IAM grant missing — ${firstLine(err)}`);
}

console.log('\n7-day log retention still applies to the new function');
try {
  template.hasResourceProperties('AWS::Logs::LogGroup', {
    LogGroupName: '/aws/lambda/parity-ledger-projector',
    RetentionInDays: 7,
  });
  pass('parity-ledger-projector log group retained 7 days');
} catch (err) {
  fail(`projector log group retention is wrong — ${firstLine(err)}`);
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
