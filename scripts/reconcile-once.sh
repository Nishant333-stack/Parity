#!/usr/bin/env bash
#
# Runs one reconciliation pass against the live ledger and Stripe sandbox.
#
#   npm run reconcile
#
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export LEDGER_CLUSTER_ARN_PARAM="/parity/ledger/cluster-arn"
export LEDGER_SECRET_ARN_PARAM="/parity/ledger/secret-arn"
export LEDGER_DATABASE_PARAM="/parity/ledger/database-name"
export STRIPE_SECRET_KEY_PARAM="/parity/stripe/secret-key"
export DEDUPE_TABLE="parity-event-dedupe"
export AWS_PROFILE="${PARITY_PROFILE:-parity}"
export AWS_REGION="${PARITY_REGION:-ap-south-1}"

aws ssm get-parameter --name "$LEDGER_CLUSTER_ARN_PARAM" \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" >/dev/null 2>&1 \
  || { echo "no cluster recorded at $LEDGER_CLUSTER_ARN_PARAM — run: npm run create-ledger-cluster" >&2; exit 1; }

npx ts-node --prefer-ts-exts scripts/reconcile-once.ts
