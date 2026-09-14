#!/usr/bin/env bash
#
# Proves the ingress works, in both directions:
#   1. a forged signature is rejected with 400 before any work happens
#   2. a real Stripe event is verified and logged
#
#   ./scripts/verify-roundtrip.sh
#
# Exits non-zero if either assertion fails, so it can be wired into CI later.
set -uo pipefail

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"
STACK="${PARITY_STACK:-ParityStack}"
LOG_GROUP="/aws/lambda/parity-webhook-ingress"
EVENT_TYPE="${1:-payment_intent.succeeded}"

fail=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=1; }

URL="$(aws cloudformation describe-stacks \
  --stack-name "$STACK" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" \
  --output text 2>/dev/null)"

if [[ -z "$URL" || "$URL" == "None" ]]; then
  echo "could not read WebhookUrl from stack $STACK — is it deployed?" >&2
  exit 1
fi

echo "endpoint: $URL"
echo

echo "negative test — forged signature"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" \
  -H 'stripe-signature: t=1,v1=deadbeefdeadbeefdeadbeefdeadbeef' \
  -H 'content-type: application/json' \
  --data '{"id":"evt_forged","type":"charge.succeeded"}')"
if [[ "$code" == "400" ]]; then
  pass "rejected with 400"
else
  bad "returned $code, expected 400 — a forged event must never be accepted"
fi
echo

echo "positive test — real $EVENT_TYPE"
since_ms="$(( $(date -u +%s) * 1000 ))"

if ! stripe trigger "$EVENT_TYPE" >/dev/null 2>&1; then
  bad "stripe trigger failed — check 'stripe config --list' and your active context"
  exit "$fail"
fi

found=""
for _ in $(seq 1 20); do
  sleep 3
  found="$(aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --start-time "$since_ms" \
    --filter-pattern '"event_received"' \
    --profile "$PROFILE" --region "$REGION" \
    --query 'events[].message' --output text 2>/dev/null)"
  [[ -n "$found" && "$found" != "None" ]] && break
done

if [[ -n "$found" && "$found" != "None" ]]; then
  pass "event_received"
  echo "$found" | tr '\t' '\n' | head -3 | sed 's/^/        /'
else
  bad "no event_received within 60s"
  echo
  echo "  recent log lines — a 500 here usually means the SSM parameters are unset;"
  echo "  an invalid_signature means the sandbox that issued whsec is not the one"
  echo "  that sent the event:"
  aws logs tail "$LOG_GROUP" --since 3m \
    --profile "$PROFILE" --region "$REGION" 2>/dev/null | tail -15 | sed 's/^/        /'
fi

echo
if [[ "$fail" == "0" ]]; then
  echo "Week 1 round-trip verified."
else
  echo "Round-trip NOT verified."
fi
exit "$fail"
