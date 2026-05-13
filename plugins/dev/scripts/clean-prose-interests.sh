#!/usr/bin/env bash
# CTL-350: one-time cleanup of prose-* test residue from production
# ~/catalyst/broker-interests.json. Safe to re-run; idempotent.
#
# Older versions of broker/index.test.mjs registered test-only interests with
# session_id matching /^sess-prose-\d+$/ through the production persistence
# path, so they accumulated in the live file and got included in every Groq
# classification batch.

set -euo pipefail

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
FILE="${CATALYST_DIR}/broker-interests.json"

if [[ ! -f "$FILE" ]]; then
  echo "no interests file at $FILE — nothing to clean"
  exit 0
fi

BEFORE=$(jq 'length' "$FILE")
TMP=$(mktemp)
jq 'map(select(.[1].session_id // "" | test("^sess-prose-\\d+$") | not))' "$FILE" > "$TMP"
AFTER=$(jq 'length' "$TMP")
mv "$TMP" "$FILE"

REMOVED=$((BEFORE - AFTER))
echo "removed $REMOVED prose-* entries (was $BEFORE, now $AFTER)"
if [[ "$REMOVED" -gt 0 ]]; then
  echo "restart the broker daemon to pick up the cleaned file"
fi
