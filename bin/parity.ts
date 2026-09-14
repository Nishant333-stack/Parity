#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ParityStack } from '../lib/parity-stack';
import { LogRetentionAspect } from '../lib/aspects/log-retention';

/**
 * The Region is locked by the AWS project (it is derived from the account's
 * contact address and cannot be changed). It is not a preference, so it is
 * hard-coded rather than read from the environment — a stray AWS_REGION
 * should never silently move resources.
 */
const REGION = 'ap-south-1';

const app = new cdk.App();

new ParityStack(app, 'ParityStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
  description:
    'Parity — Stripe event ingestion, double-entry ledger projection, and continuous reconciliation',
});

cdk.Tags.of(app).add('Project', 'Parity');

// Every log group gets 7-day retention, with no way to forget.
// CloudWatch Logs ingest is the quiet budget killer: ~$0.50/GB, and one
// chatty Lambda under load test will eat $20 without showing up anywhere
// you would think to look.
cdk.Aspects.of(app).add(new LogRetentionAspect(RetentionDays.ONE_WEEK));
