#!/usr/bin/env bash
#
# Provisions the ledger's Aurora cluster OUTSIDE CDK, the same way this
# project already handles the webhook endpoint and secrets: a one-off,
# idempotent script rather than a stack resource.
#
# Why not CDK: this account's free plan only allows Aurora clusters created
# WithExpressConfiguration (confirmed by a failed `cdk deploy`).
# CloudFormation's AWS::RDS::DBCluster has no property for that — it exists
# only as a raw RDS API parameter — so CDK cannot own this resource's
# lifecycle. See docs/adr/0002-data-api-instead-of-vpc.md.
#
# Why the bootstrap step below: Express Configuration's "internet access
# gateway" requires the master user to be IAM-auth-only (confirmed by a
# rejected create-db-cluster: "Amazon RDS requires IAM DB authentication for
# the master user when Internet Access Gateway is enabled"). The Data API
# needs a password-based Secrets Manager credential, which the master user
# can't provide — AWS's own docs for express configuration say as much: "it
# doesn't support authentication with master username/password. You must
# create new user credentials to access Data API." So this script connects
# once as the IAM-auth master user (via psql and a generated auth token) to
# create a second, ordinary password-auth role, stores its credentials in a
# new secret, and points Data API at that secret instead.
#
#   npm run create-ledger-cluster
#
# Idempotent: if parity-ledger already exists, this reports its state and
# exits without trying to create it, or the app role, again.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
CLUSTER_ID="${PARITY_LEDGER_CLUSTER_ID:-parity-ledger}"
DATABASE="parity"
APP_USER="data_api_user"
APP_SECRET_NAME="parity-ledger-data-api-user"

bold=$'\033[1m'; red=$'\033[31m'; dim=$'\033[2m'; off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$off"; }
die()  { printf '\n%sFAILED: %s%s\n' "$red" "$1" "$off" >&2; exit 1; }

command -v psql >/dev/null || die "psql is not installed — needed for the one-time role bootstrap"

step "Checking for an existing cluster"
existing_status="$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'DBClusters[0].Status' --output text 2>/dev/null)"

if [[ -n "$existing_status" && "$existing_status" != "None" ]]; then
  echo "cluster '$CLUSTER_ID' already exists — status: $existing_status"
  echo "skipping creation; continuing to make sure the Data API, database,"
  echo "and app role are all in place (each step below is idempotent)."
else
  step "Creating $CLUSTER_ID (Express Configuration, IAM-auth master)"
  echo "${dim}the master user is IAM-auth-only — required by Express Configuration's"
  echo "internet access gateway, not a choice made here. The engine version"
  echo "cannot be pinned either. See docs/adr/0002.${off}"

  create_output="$(aws rds create-db-cluster \
    --db-cluster-identifier "$CLUSTER_ID" \
    --engine aurora-postgresql \
    --master-username parity_admin \
    --master-user-authentication-type iam-db-auth \
    --with-express-configuration \
    --profile "$PROFILE" --region "$REGION" 2>&1)" \
    || die "create-db-cluster failed:
$create_output"
fi

step "Waiting for the cluster to become available"
aws rds wait db-cluster-available \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  || die "cluster did not reach 'available' — check the RDS console"

cluster_info="$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'DBClusters[0].{Arn:DBClusterArn,Endpoint:Endpoint,Port:Port,MasterUsername:MasterUsername}' \
  --output json)"
echo "$cluster_info" | python3 -m json.tool

CLUSTER_ARN="$(echo "$cluster_info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Arn"])')"
ENDPOINT="$(echo "$cluster_info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Endpoint"])')"
PORT="$(echo "$cluster_info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Port"])')"
MASTER_USER="$(echo "$cluster_info" | python3 -c 'import json,sys; print(json.load(sys.stdin)["MasterUsername"])')"

step "Enabling the Data API (a separate step for express configuration clusters)"
already_enabled="$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'DBClusters[0].HttpEndpointEnabled' --output text)"

if [[ "$already_enabled" != "True" ]]; then
  aws rds enable-http-endpoint --resource-arn "$CLUSTER_ARN" \
    --profile "$PROFILE" --region "$REGION" >/dev/null \
    || die "enable-http-endpoint failed"
fi

# The call above returns before the cluster settles — wait for it back to
# 'available', then confirm HttpEndpointEnabled stuck.
aws rds wait db-cluster-available \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  || die "cluster did not return to 'available' after enabling the Data API"

http_endpoint="$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_ID" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'DBClusters[0].HttpEndpointEnabled' --output text)"
if [[ "$http_endpoint" != "True" ]]; then
  die "HttpEndpointEnabled is not true after enable-http-endpoint — inspect the cluster in the RDS console."
fi

step "Creating the $DATABASE database"
echo "${dim}express configuration can't create an initial database at cluster"
echo "creation time — it has to be a separate step against the default"
echo "'postgres' database.${off}"
AUTH_TOKEN="$(aws rds generate-db-auth-token \
  --hostname "$ENDPOINT" --port "$PORT" --username "$MASTER_USER" \
  --profile "$PROFILE" --region "$REGION")" \
  || die "could not generate an IAM auth token for the master user"

db_exists="$(PGPASSWORD="$AUTH_TOKEN" psql \
  "host=$ENDPOINT port=$PORT dbname=postgres user=$MASTER_USER sslmode=require" \
  -v ON_ERROR_STOP=1 -tAc "SELECT 1 FROM pg_database WHERE datname = '$DATABASE'")"

if [[ "$db_exists" != "1" ]]; then
  PGPASSWORD="$AUTH_TOKEN" psql \
    "host=$ENDPOINT port=$PORT dbname=postgres user=$MASTER_USER sslmode=require" \
    -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DATABASE;" \
    || die "could not create the $DATABASE database"
else
  echo "database '$DATABASE' already exists"
fi

step "Bootstrapping a password-auth role for the Data API ($APP_USER)"
# A fresh auth token: the one above was minted for a connection to
# 'postgres' and IAM auth tokens are scoped per (host, port, username), not
# per database, so it's still valid — regenerating anyway is cheap and
# avoids relying on that.
AUTH_TOKEN="$(aws rds generate-db-auth-token \
  --hostname "$ENDPOINT" --port "$PORT" --username "$MASTER_USER" \
  --profile "$PROFILE" --region "$REGION")" \
  || die "could not generate an IAM auth token for the master user"

APP_PASSWORD="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-32)"

PGPASSWORD="$AUTH_TOKEN" psql \
  "host=$ENDPOINT port=$PORT dbname=$DATABASE user=$MASTER_USER sslmode=require" \
  -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$APP_USER') THEN
    CREATE ROLE $APP_USER WITH LOGIN PASSWORD '$APP_PASSWORD';
  ELSE
    ALTER ROLE $APP_USER WITH PASSWORD '$APP_PASSWORD';
  END IF;
END
\$\$;
GRANT ALL PRIVILEGES ON DATABASE $DATABASE TO $APP_USER;
GRANT ALL ON SCHEMA public TO $APP_USER;
SQL
[[ $? -eq 0 ]] || die "could not create/update the $APP_USER role over psql"

step "Storing $APP_USER credentials in a new Secrets Manager secret"
secret_json="$(python3 -c "
import json
print(json.dumps({
  'username': '$APP_USER',
  'password': '$APP_PASSWORD',
  'engine': 'postgres',
  'host': '$ENDPOINT',
  'port': int('$PORT'),
  'dbname': '$DATABASE',
  'dbClusterIdentifier': '$CLUSTER_ID',
}))
")"

existing_secret_arn="$(aws secretsmanager describe-secret --secret-id "$APP_SECRET_NAME" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'ARN' --output text 2>/dev/null)"

if [[ -n "$existing_secret_arn" && "$existing_secret_arn" != "None" ]]; then
  aws secretsmanager put-secret-value --secret-id "$APP_SECRET_NAME" \
    --secret-string "$secret_json" \
    --profile "$PROFILE" --region "$REGION" >/dev/null
  SECRET_ARN="$existing_secret_arn"
else
  SECRET_ARN="$(aws secretsmanager create-secret --name "$APP_SECRET_NAME" \
    --description "Data API credential for the Parity ledger cluster ($CLUSTER_ID)" \
    --secret-string "$secret_json" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'ARN' --output text)"
fi
[[ -n "${SECRET_ARN:-}" ]] || die "could not create or update the $APP_SECRET_NAME secret"

step "Verifying the Data API with the new credential"
verify_output="$(aws rds-data execute-statement \
  --resource-arn "$CLUSTER_ARN" --secret-arn "$SECRET_ARN" --database "$DATABASE" \
  --sql 'SELECT 1' \
  --profile "$PROFILE" --region "$REGION" 2>&1)" \
  || die "Data API smoke test failed:
$verify_output"
echo "Data API responds via the new credential."

step "Recording cluster identity in SSM (paths, not secret values)"
aws ssm put-parameter --name /parity/ledger/cluster-arn --type String \
  --value "$CLUSTER_ARN" --overwrite --profile "$PROFILE" --region "$REGION" >/dev/null
aws ssm put-parameter --name /parity/ledger/secret-arn --type String \
  --value "$SECRET_ARN" --overwrite --profile "$PROFILE" --region "$REGION" >/dev/null
aws ssm put-parameter --name /parity/ledger/database-name --type String \
  --value "$DATABASE" --overwrite --profile "$PROFILE" --region "$REGION" >/dev/null

echo
echo "stored: /parity/ledger/cluster-arn, /parity/ledger/secret-arn, /parity/ledger/database-name"
echo "the ledger CDK construct and scripts read these paths — never the raw values."
echo
echo "next: npm run migrate"
