#!/usr/bin/env bash
#
# Applies db/schema.sql to the ledger cluster via the Data API.
#
#   npm run migrate
#
# Requires scripts/create-ledger-cluster.sh to have run first — this reads
# the cluster's identity from the fixed SSM paths that script writes to, not
# from CloudFormation outputs, because the cluster isn't a CDK resource
# (see docs/adr/0002-data-api-instead-of-vpc.md).
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export LEDGER_CLUSTER_ARN_PARAM="/parity/ledger/cluster-arn"
export LEDGER_SECRET_ARN_PARAM="/parity/ledger/secret-arn"
export LEDGER_DATABASE_PARAM="/parity/ledger/database-name"
export AWS_PROFILE="${PARITY_PROFILE:-parity}"
export AWS_REGION="${PARITY_REGION:-ap-south-1}"

aws ssm get-parameter --name "$LEDGER_CLUSTER_ARN_PARAM" \
  --profile "$AWS_PROFILE" --region "$AWS_REGION" >/dev/null 2>&1 \
  || { echo "no cluster recorded at $LEDGER_CLUSTER_ARN_PARAM — run: npm run create-ledger-cluster" >&2; exit 1; }

npx ts-node --prefer-ts-exts scripts/migrate.ts
