#!/usr/bin/env bash
#
# One command, whole pipeline. Idempotent — safe to re-run after any failure.
#
#   npm run setup
#
#   1. checks prerequisites and that credentials are live
#   2. installs dependencies
#   3. deploys the stack
#   4. stores the Stripe API key (hidden prompt, only if not already stored)
#   5. deletes every stale webhook endpoint for this URL, creates one fresh
#      endpoint, and pipes its secret into SSM without displaying it
#   6. verifies the round-trip in both directions
#
# Stops at the first failure with a specific next action.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
STACK="${PARITY_STACK:-ParityStack}"
KEY_PARAM=/parity/stripe/secret-key

bold=$'\033[1m'; red=$'\033[31m'; dim=$'\033[2m'; off=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$off"; }
die()  { printf '\n%sFAILED: %s%s\n' "$red" "$1" "$off" >&2; exit 1; }

step "Prerequisites"
for c in aws stripe node npm; do
  command -v "$c" >/dev/null || die "$c is not installed"
done

aws sts get-caller-identity --profile "$PROFILE" >/dev/null 2>&1 \
  || die "credentials for profile '$PROFILE' are expired or missing.
  Fix: aws login --profile $PROFILE
  (they last 12 hours, renewable for 90 days without the browser)"

SANDBOX="$(stripe config --list 2>/dev/null | awk -F"'" '/account_id/{print $2; exit}')"
[[ -n "$SANDBOX" ]] || die "the Stripe CLI is not logged in.
  Fix: stripe login"

echo "${dim}aws:    $PROFILE / $REGION${off}"
echo "${dim}stripe: $SANDBOX${off}"

step "Dependencies"
npm install --no-audit --no-fund || die "npm install failed"

step "Deploying $STACK"
npx cdk deploy --profile "$PROFILE" --require-approval never \
  || die "cdk deploy failed — the output above has the CloudFormation reason"

URL="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" \
  --output text 2>/dev/null)"
[[ -n "$URL" && "$URL" != "None" ]] || die "stack has no WebhookUrl output"
echo "${dim}url:    $URL${off}"

step "Stripe API key"
if aws ssm get-parameter --name "$KEY_PARAM" \
     --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "already stored — to replace it: npm run secret $KEY_PARAM"
else
  bash scripts/set-secret.sh "$KEY_PARAM" || die "could not store the API key"
fi

step "Webhook endpoint"
# Every endpoint signs with its own secret. Two endpoints on one URL means
# half the deliveries fail verification, intermittently, and the symptom
# looks random. So collapse to exactly one.
STALE="$(stripe webhook_endpoints list --limit 100 2>/dev/null | python3 -c '
import json, re, sys
raw = re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read())
b = raw.find("{")
if b < 0:
    sys.exit(0)
try:
    doc = json.loads(raw[b:])
except Exception:
    sys.exit(0)
for e in doc.get("data", []):
    print(e.get("id", ""), e.get("url", ""), sep="\t")
')"

deleted=0
while IFS=$'\t' read -r id url; do
  [[ -z "${id:-}" ]] && continue
  if [[ "$url" == "$URL" ]]; then
    echo "removing existing endpoint $id"
    stripe webhook_endpoints delete "$id" >/dev/null 2>&1 && deleted=$((deleted + 1))
  fi
done <<<"$STALE"
[[ "$deleted" -gt 0 ]] && echo "${dim}removed $deleted stale endpoint(s)${off}"

bash scripts/register-webhook.sh || die "could not register the webhook endpoint"

step "Verifying round-trip"
bash scripts/verify-roundtrip.sh
