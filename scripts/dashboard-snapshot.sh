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

npx ts-node --prefer-ts-exts scripts/dashboard-snapshot.ts
