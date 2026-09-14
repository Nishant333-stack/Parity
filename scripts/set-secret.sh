#!/usr/bin/env bash
#
# Store a secret in SSM Parameter Store without it ever appearing in shell
# history or in the process argument list.
#
#   ./scripts/set-secret.sh /parity/stripe/secret-key
#
# Passing --value 'sk_test_...' on the command line writes the key into
# ~/.zsh_history permanently, and into `ps` output momentarily. This reads it
# from a hidden prompt and hands it to the CLI through a 0600 temp file, so it
# touches neither.
set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: $0 <ssm-parameter-name>" >&2
  echo "  e.g. $0 /parity/stripe/secret-key" >&2
  exit 64
fi

PROFILE="${PARITY_PROFILE:-parity}"
REGION="${PARITY_REGION:-ap-south-1}"

TMP="$(mktemp)"
chmod 600 "$TMP"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT INT TERM

printf 'Value for %s (input hidden): ' "$NAME" >&2
read -rs VALUE
printf '\n' >&2

if [[ -z "$VALUE" ]]; then
  echo "empty value, aborting" >&2
  exit 1
fi

# Value arrives over stdin; name and path travel as env vars. Neither the
# value nor anything derived from it is ever an argv element.
P_NAME="$NAME" P_TMP="$TMP" python3 -c '
import json, os, sys
json.dump(
    {
        "Name": os.environ["P_NAME"],
        "Type": "SecureString",
        # rstrip is load-bearing: the here-string below appends a newline, and
        # a Stripe key with a trailing \n fails auth in a way that looks
        # exactly like a wrong key.
        "Value": sys.stdin.read().rstrip("\r\n"),
        "Overwrite": True,
    },
    open(os.environ["P_TMP"], "w"),
)
' <<<"$VALUE"

unset VALUE

aws ssm put-parameter \
  --cli-input-json "file://$TMP" \
  --profile "$PROFILE" \
  --region "$REGION" >/dev/null

echo "stored $NAME (SecureString, $REGION)" >&2
