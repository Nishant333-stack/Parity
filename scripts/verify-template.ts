#!/usr/bin/env ts-node
//
// Checks the synthesized CloudFormation template, not just that the code
// compiles. Most of the expensive mistakes in this project are
// template-level — a NAT Gateway, a missing EnableHttpEndpoint — and neither
// shows up in `tsc --noEmit` or `cdk synth` succeeding.
//
//   npm run verify:template
//
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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

console.log('Data API is enabled and the engine version is pinned');
try {
  template.hasResourceProperties('AWS::RDS::DBCluster', { EnableHttpEndpoint: true });
  pass('EnableHttpEndpoint: true');
} catch (err) {
  fail(`EnableHttpEndpoint is not true — ${firstLine(err)}`);
}
try {
  template.hasResourceProperties('AWS::RDS::DBCluster', { EngineVersion: '17.10' });
  pass('EngineVersion: 17.10');
} catch (err) {
  fail(`EngineVersion is not pinned to 17.10 — ${firstLine(err)}`);
}

console.log('\nNo NAT gateways, no internet gateway');
try {
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  pass('AWS::EC2::NatGateway count is 0');
} catch (err) {
  fail(`NAT gateway count is not 0 — ${firstLine(err)}`);
}
try {
  template.resourceCountIs('AWS::EC2::InternetGateway', 0);
  pass('AWS::EC2::InternetGateway count is 0');
} catch (err) {
  fail(`internet gateway count is not 0 — ${firstLine(err)}`);
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

function firstLine(err: unknown): string {
  return ((err as Error).message ?? String(err)).split('\n')[0];
}

console.log();
if (failed) {
  console.log('Template verification FAILED.');
  process.exit(1);
}
console.log('Template verification passed.');
