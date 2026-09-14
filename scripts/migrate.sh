#!/usr/bin/env bash
#
# Applies db/schema.sql to the deployed ledger cluster.
#
#   npm run migrate
#
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
STACK="${PARITY_STACK:-ParityStack}"

output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

export LEDGER_CLUSTER_ARN
export LEDGER_SECRET_ARN
export LEDGER_DATABASE
export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"

LEDGER_CLUSTER_ARN="$(output LedgerClusterArn)"
LEDGER_SECRET_ARN="$(output LedgerSecretArn)"
LEDGER_DATABASE="$(output LedgerDatabaseName)"

if [[ -z "$LEDGER_CLUSTER_ARN" || "$LEDGER_CLUSTER_ARN" == "None" ]]; then
  echo "could not read LedgerClusterArn from stack $STACK — is it deployed?" >&2
  exit 1
fi

npx ts-node --prefer-ts-exts scripts/migrate.ts
