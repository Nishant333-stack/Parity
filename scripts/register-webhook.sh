#!/usr/bin/env bash
#
# Creates the Stripe webhook endpoint against the deployed URL and stores its
# signing secret in SSM — without the secret ever reaching your screen, your
# shell history, or a process argument list.
#
#   ./scripts/register-webhook.sh
#
# Running `stripe webhook_endpoints create` by hand prints the secret in the
# response JSON, which is how it ends up pasted into a chat window or a
# screenshot. Stripe shows it exactly once, so the only safe handling is to
# never render it.
set -euo pipefail

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
STACK="${PARITY_STACK:-ParityStack}"
PARAM="${PARITY_WHSEC_PARAM:-/parity/stripe/webhook-secret}"

# The events the ledger projects. Extend as later weeks add surface area;
# an endpoint only delivers what it subscribes to.
EVENTS=(
  payment_intent.succeeded
  payment_intent.payment_failed
  charge.succeeded
  charge.refunded
  charge.dispute.created
)

URL="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" \
  --output text 2>/dev/null)"

if [[ -z "$URL" || "$URL" == "None" ]]; then
  echo "could not read WebhookUrl from stack $STACK — is it deployed?" >&2
  exit 1
fi

echo "url:      $URL" >&2
echo "sandbox:  $(stripe config --list 2>/dev/null | awk -F"'" '/account_id/{print $2}')" >&2

args=(--url "$URL")
for e in "${EVENTS[@]}"; do args+=(--enabled-events "$e"); done

TMP="$(mktemp)"
RESP="$(mktemp)"
chmod 600 "$TMP" "$RESP"
trap 'rm -f "$TMP" "$RESP"' EXIT INT TERM

# Response goes to a 0600 file, never to the terminal.
stripe webhook_endpoints create "${args[@]}" >"$RESP" 2>/dev/null

META="$(P_PARAM="$PARAM" P_TMP="$TMP" P_RESP="$RESP" python3 -c '
import json, os, re, sys

raw = open(os.environ["P_RESP"]).read()
raw = re.sub(r"\x1b\[[0-9;]*m", "", raw)          # strip any colour codes
brace = raw.find("{")
if brace < 0:
    sys.exit("stripe returned no JSON. First 400 chars:\n" + raw[:400])

obj = json.loads(raw[brace:])
secret = obj.get("secret")
if not secret:
    sys.exit("response carried no secret (endpoint id %s). Stripe only "
             "returns it at creation." % obj.get("id"))

json.dump(
    {
        "Name": os.environ["P_PARAM"],
        "Type": "SecureString",
        "Value": secret,
        "Overwrite": True,
    },
    open(os.environ["P_TMP"], "w"),
)

# Only non-sensitive facts are printed: id, length, and the shared prefix.
print(obj["id"], len(secret), secret[:6], sep="\t")
')"

IFS=$'\t' read -r EP_ID LEN PREFIX <<<"$META"

aws ssm put-parameter \
  --cli-input-json "file://$TMP" \
  --profile "$PROFILE" --region "$REGION" >/dev/null

echo "endpoint: $EP_ID" >&2
echo "stored:   $PARAM — $LEN chars, starts '$PREFIX'" >&2
echo >&2
echo "The secret was not displayed. Stripe will not show it again, and it" >&2
echo "does not need to be: the Lambda reads it from SSM at cold start." >&2
