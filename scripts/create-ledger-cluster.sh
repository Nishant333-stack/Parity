#!/usr/bin/env bash
#
# Provisions the ledger's Aurora cluster OUTSIDE CDK, the same way this
# project already handles the webhook endpoint and secrets: a one-off,
# idempotent script rather than a stack resource.
#
# Why not CDK: this account's free plan only allows Aurora clusters created
# WithExpressConfiguration (confirmed by a failed `cdk deploy` — see
# docs/adr/0002-data-api-instead-of-vpc.md). CloudFormation's
# AWS::RDS::DBCluster resource has no property for that; it exists only as a
# raw RDS API parameter. So CDK cannot own this resource's lifecycle, and
# lib/constructs/ledger.ts references it by ARN instead of creating it.
#
#   npm run create-ledger-cluster
#
# Idempotent: if parity-ledger already exists, this reports its state and
# exits without trying to create it again.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
CLUSTER_ID="${PARITY_LEDGER_CLUSTER_ID:-parity-ledger}"

bold=$'\033[1m'; red=$'\033[31m'; dim=$'\033[2m'; off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$off"; }
die()  { printf '\n%sFAILED: %s%s\n' "$red" "$1" "$off" >&2; exit 1; }

step "Checking for an existing cluster"
existing="$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'DBClusters[0].Status' --output text 2>/dev/null)"

if [[ -n "$existing" && "$existing" != "None" ]]; then
  echo "cluster '$CLUSTER_ID' already exists — status: $existing"
  echo "nothing to do. To recreate it, delete it first (ask before doing that)."
  exit 0
fi

step "Creating $CLUSTER_ID (Express Configuration, Data API enabled)"
echo "${dim}this account's free plan only permits Aurora clusters created with"
echo "express configuration; the engine version cannot be pinned (AWS's"
echo "limitation, not a choice made here) — see docs/adr/0002.${off}"

create_output="$(aws rds create-db-cluster \
  --db-cluster-identifier "$CLUSTER_ID" \
  --engine aurora-postgresql \
  --database-name parity \
  --master-username parity_admin \
  --master-user-authentication-type password \
  --manage-master-user-password \
  --enable-http-endpoint \
  --with-express-configuration \
  --profile "$PROFILE" --region "$REGION" 2>&1)" \
  || die "create-db-cluster failed:
$create_output"

echo "$create_output"

step "Waiting for the cluster to become available"
aws rds wait db-cluster-available \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  || die "cluster did not reach 'available' — check the RDS console"

step "Verifying Data API and auth"
details="$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'DBClusters[0].{Arn:DBClusterArn,HttpEndpoint:HttpEndpointEnabled,SecretArn:MasterUserSecret.SecretArn,IamAuth:IAMDatabaseAuthenticationEnabled}' \
  --output json)"
echo "$details" | python3 -m json.tool

CLUSTER_ARN="$(echo "$details" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Arn",""))')"
HTTP_ENDPOINT="$(echo "$details" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("HttpEndpoint",""))')"
SECRET_ARN="$(echo "$details" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("SecretArn") or "")')"

if [[ "$HTTP_ENDPOINT" != "True" ]]; then
  die "HttpEndpointEnabled is not true — Data API did not come up. Inspect the cluster in the RDS console before continuing."
fi

if [[ -z "$SECRET_ARN" ]]; then
  die "no MasterUserSecret — the master user is IAM-auth-only despite --master-user-authentication-type password.
  Data API needs a password-based secret. This needs a second, non-master DB
  user bootstrapped via IAM auth before Data API can be used — stop and
  report this back rather than guessing further."
fi

step "Recording cluster identity in SSM (paths, not secret values)"
aws ssm put-parameter --name /parity/ledger/cluster-arn --type String \
  --value "$CLUSTER_ARN" --overwrite --profile "$PROFILE" --region "$REGION" >/dev/null
aws ssm put-parameter --name /parity/ledger/secret-arn --type String \
  --value "$SECRET_ARN" --overwrite --profile "$PROFILE" --region "$REGION" >/dev/null
aws ssm put-parameter --name /parity/ledger/database-name --type String \
  --value "parity" --overwrite --profile "$PROFILE" --region "$REGION" >/dev/null

echo
echo "stored: /parity/ledger/cluster-arn, /parity/ledger/secret-arn, /parity/ledger/database-name"
echo "the ledger CDK construct and scripts read these paths — never the raw values."
