#!/usr/bin/env bash
#
# Runs the replay-storm injector against the live webhook endpoint. Safe to
# run any time — see the comment at the top of chaos-replay-storm.ts for why
# it never touches the ledger balance.
#
#   npm run chaos:replay-storm
#   CHAOS_CONCURRENCY=100 npm run chaos:replay-storm   # louder storm
#
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export AWS_PROFILE="${PARITY_PROFILE:-parity}"
export AWS_REGION="${PARITY_REGION:-ap-south-1}"
export PARITY_STACK="${PARITY_STACK:-ParityStack}"
export DEDUPE_TABLE="parity-event-dedupe"
export STRIPE_WEBHOOK_SECRET_PARAM="/parity/stripe/webhook-secret"
export LEDGER_CLUSTER_ARN_PARAM="/parity/ledger/cluster-arn"
export LEDGER_SECRET_ARN_PARAM="/parity/ledger/secret-arn"
export LEDGER_DATABASE_PARAM="/parity/ledger/database-name"

aws ssm get-parameter --name "$LEDGER_CLUSTER_ARN_PARAM" \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" >/dev/null 2>&1 \
  || { echo "no cluster recorded at $LEDGER_CLUSTER_ARN_PARAM — run: npm run create-ledger-cluster" >&2; exit 1; }

npx ts-node --prefer-ts-exts scripts/chaos-replay-storm.ts
