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

export LEDGER_CLUSTER_ARN_PARAM="/parity/ledger/cluster-arn"
export LEDGER_SECRET_ARN_PARAM="/parity/ledger/secret-arn"
export LEDGER_DATABASE_PARAM="/parity/ledger/database-name"
export ARCHIVE_BUCKET
export AWS_PROFILE="$PROFILE"
export AWS_REGION="$REGION"

aws ssm get-parameter --name "$LEDGER_CLUSTER_ARN_PARAM" \
  --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1 \
  || { echo "no cluster recorded at $LEDGER_CLUSTER_ARN_PARAM — run: npm run create-ledger-cluster" >&2; exit 1; }

ARCHIVE_BUCKET="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ArchiveBucketName'].OutputValue" --output text)"

if [[ -z "$ARCHIVE_BUCKET" || "$ARCHIVE_BUCKET" == "None" ]]; then
  echo "could not read ArchiveBucketName from stack $STACK — is it deployed?" >&2
  exit 1
fi

npx ts-node --prefer-ts-exts scripts/rebuild-ledger.ts "$@"
