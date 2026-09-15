#!/usr/bin/env bash
#
# Prints a JSON snapshot of the whole system to stdout. Read-only.
#
#   npm run dashboard:snapshot
#
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export LEDGER_CLUSTER_ARN_PARAM="/parity/ledger/cluster-arn"
export LEDGER_SECRET_ARN_PARAM="/parity/ledger/secret-arn"
export LEDGER_DATABASE_PARAM="/parity/ledger/database-name"
export AWS_PROFILE="${PARITY_PROFILE:-parity}"
export AWS_REGION="${PARITY_REGION:-ap-south-1}"

# Not hardcoded — this repo is public and used to carry the real account id
# as a fallback literal here (scrubbed; see CLAUDE.md's Environment table).
# The deployed dashboard Lambda gets this from stack.account at deploy time;
# this CLI script has no CDK context, so it asks AWS directly.
export PARITY_ACCOUNT_ID="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --region "$AWS_REGION" --query Account --output text)"

npx ts-node --prefer-ts-exts scripts/dashboard-snapshot.ts
