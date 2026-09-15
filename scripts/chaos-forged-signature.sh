#!/usr/bin/env bash
#
# Runs the forged-signature injector against the live webhook endpoint.
#
#   npm run chaos:forged-signature
#
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export AWS_PROFILE="${PARITY_PROFILE:-parity}"
export AWS_REGION="${PARITY_REGION:-ap-south-1}"
export PARITY_STACK="${PARITY_STACK:-ParityStack}"
export DEDUPE_TABLE="parity-event-dedupe"

npx ts-node --prefer-ts-exts scripts/chaos-forged-signature.ts
