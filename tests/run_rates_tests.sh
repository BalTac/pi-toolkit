#!/bin/bash
# ============================================================================
# run_rates_tests.sh — period-aware DeepSeek cost tests (rates.ts)
#
# Runs tests/rates_tests.ts against the REAL rates.ts source. Node >= 23 runs
# the TypeScript directly via native type-stripping; otherwise esbuild compiles
# to CommonJS first.
#
# Uso:  bash run_rates_tests.sh
# ============================================================================
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
TEST="$DIR/rates_tests.ts"

if [ ! -f "$TEST" ]; then echo "test non trovato: $TEST"; exit 1; fi

node "$TEST" && exit 0

# Fallback: esbuild → node (older Node without type stripping)
ESB="$HOME/.pi/agent/npm/node_modules/.bin/esbuild"
TMP="${TMPDIR:-/tmp}/rates_tests.cjs"
if [ -x "$ESB" ]; then
  "$ESB" "$TEST" --bundle --format=cjs --platform=node --outfile="$TMP" > /dev/null 2>&1 \
    && node "$TMP" \
    && rm -f "$TMP"
  exit $?
fi
exit 1
