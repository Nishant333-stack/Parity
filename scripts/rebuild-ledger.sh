#!/usr/bin/env bash
#
# Rebuilds the ledger from the S3 archive. Destructive: truncates the ledger
# tables before replaying. Dry-run by default — pass --yes to actually do it.
#
#   npm run rebuild-ledger              # dry run: reports what would replay
#   npm run rebuild-ledger -- --yes     # actually truncates and replays
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
export ARCHIVE_BUCKET
export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"

LEDGER_CLUSTER_ARN="$(output LedgerClusterArn)"
LEDGER_SECRET_ARN="$(output LedgerSecretArn)"
LEDGER_DATABASE="$(output LedgerDatabaseName)"
ARCHIVE_BUCKET="$(output ArchiveBucketName)"

if [[ -z "$LEDGER_CLUSTER_ARN" || "$LEDGER_CLUSTER_ARN" == "None" ]]; then
  echo "could not read LedgerClusterArn from stack $STACK — is it deployed?" >&2
  exit 1
fi

npx ts-node --prefer-ts-exts scripts/rebuild-ledger.ts "$@"
