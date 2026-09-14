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

# Strip every whitespace character. A trailing space or newline picked up
# while copying is invisible, survives the paste, and produces
# "No signatures found matching the expected signature" — an error that
# points at your raw-body handling rather than at the key.
VALUE="$(printf '%s' "$VALUE" | tr -d '[:space:]')"

# Refuse an obviously wrong value rather than storing it and failing at
# runtime. Pasting the quoted JSON ("whsec_...") or swapping the two
# parameters are the easy mistakes, and both are caught here.
case "$NAME" in
  */webhook-secret) EXPECT="whsec_" ;;
  */secret-key)     EXPECT="sk_" ;;
  *)                EXPECT="" ;;
esac

if [[ -n "$EXPECT" && "$VALUE" != "$EXPECT"* ]]; then
  echo "refusing to store: expected a value starting with '$EXPECT'," >&2
  echo "  got ${#VALUE} characters starting '${VALUE:0:3}'." >&2
  echo "  Check you copied the bare value, with no surrounding quotes." >&2
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

# Length and prefix are safe to echo and are exactly what you need to
# confirm the right thing landed. A whsec_ is 38 characters.
echo "stored $NAME — ${#VALUE} chars, starts '${VALUE:0:6}', SecureString, $REGION" >&2
