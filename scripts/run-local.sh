#!/usr/bin/env bash
# Run the built action against the BitGo test environment locally.
#
# @actions/core reads inputs from INPUT_* env vars (uppercased,
# hyphens → underscores). This script accepts plain --foo bar pairs
# and translates them. The access token and api url are pulled from
# BITGO_ACCESS_TOKEN / BITGO_API_URL by default so you don't have
# to retype them every invocation.
#
# Usage:
#   export BITGO_ACCESS_TOKEN=v2x_test_...
#   export BITGO_API_URL=https://app.bitgo-test.com/api/v2
#   ./scripts/run-local.sh list-wallets --coin tbtc
#   ./scripts/run-local.sh get-balance --coin tbtc --wallet-id <id>
#
# Pretty-prints the parsed result on success.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <command> [--input-name value ...]" >&2
  exit 2
fi

if [[ -z "${BITGO_ACCESS_TOKEN:-}" ]]; then
  echo "error: BITGO_ACCESS_TOKEN is not set" >&2
  exit 2
fi

COMMAND="$1"
shift

# @actions/core converts input names to env vars by uppercasing and
# replacing spaces with underscores — but it leaves hyphens alone, so
# `access-token` becomes `INPUT_ACCESS-TOKEN`. Bash refuses to export
# identifiers with hyphens, so we collect everything in an array and
# pass it via `env` directly to node.
env_args=(
  "INPUT_COMMAND=$COMMAND"
  "INPUT_ACCESS-TOKEN=$BITGO_ACCESS_TOKEN"
  "INPUT_API-URL=${BITGO_API_URL:-https://app.bitgo-test.com/api/v2}"
)

if [[ -n "${BITGO_ENTERPRISE_ID:-}" ]]; then
  env_args+=("INPUT_ENTERPRISE-ID=$BITGO_ENTERPRISE_ID")
fi
if [[ -n "${BITGO_WALLET_PASSPHRASE:-}" ]]; then
  env_args+=("INPUT_WALLET-PASSPHRASE=$BITGO_WALLET_PASSPHRASE")
fi

while [[ $# -gt 0 ]]; do
  key="${1#--}"
  if [[ $# -lt 2 ]]; then
    echo "error: missing value for --$key" >&2
    exit 2
  fi
  env_args+=("INPUT_${key^^}=$2")
  shift 2
done

# @actions/core writes outputs to GITHUB_OUTPUT if set; otherwise it
# falls back to ::set-output style stdout. Capture to a temp file so
# we can pretty-print the result.
GITHUB_OUTPUT_FILE="$(mktemp)"
env_args+=("GITHUB_OUTPUT=$GITHUB_OUTPUT_FILE")
trap 'rm -f "$GITHUB_OUTPUT_FILE"' EXIT

# Run the built bundle. Stream stderr/stdout so ::error and ::debug
# lines come through.
set +e
env "${env_args[@]}" node dist/index.js
exit_code=$?
set -e

if [[ -s "$GITHUB_OUTPUT_FILE" ]]; then
  echo
  echo "── result ──"
  # GitHub Output format is "name<<DELIM\nvalue\nDELIM" — extract
  # the value between the heredoc markers.
  awk '
    /^result<<ghadelimiter_/ { in_block=1; next }
    /^ghadelimiter_/ { in_block=0; next }
    in_block { print }
  ' "$GITHUB_OUTPUT_FILE" | (jq . 2>/dev/null || cat)
fi

exit $exit_code
