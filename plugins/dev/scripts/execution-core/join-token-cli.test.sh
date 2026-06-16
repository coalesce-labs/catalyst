#!/usr/bin/env bash
# join-token-cli.test.sh — catalyst-cluster join-token verb contract (CTL-1184).
# Run: bash plugins/dev/scripts/execution-core/join-token-cli.test.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${SCRIPT_DIR}/../catalyst-cluster"
fails=0
check() { if eval "$2"; then echo "ok - $1"; else echo "NOT ok - $1"; fails=$((fails+1)); fi; }

TMP="$(mktemp -d)"; export CATALYST_DIR="$TMP"
OUT="$("$CLI" join-token 2>/dev/null)"

check "prints CATALYST_JOIN_TOKEN=jt_ line" \
  'grep -qE "^CATALYST_JOIN_TOKEN=jt_[0-9a-f]{64}$" <<<"$OUT"'
check "prints a TTL / expiry line" \
  'grep -qiE "ttl|expires" <<<"$OUT"'
check "writes the 0600 store file" \
  '[[ -f "$TMP/cluster/join-token.json" ]] && [[ "$(stat -f %Lp "$TMP/cluster/join-token.json")" == "600" ]]'
check "stored token matches printed token" \
  '[[ "$(grep -oE "jt_[0-9a-f]{64}" <<<"$OUT" | head -1)" == "$(grep -oE "jt_[0-9a-f]{64}" "$TMP/cluster/join-token.json" | head -1)" ]]'

# re-mint re-arms with a fresh token
OUT2="$("$CLI" join-token 2>/dev/null)"
check "re-mint yields a different token" \
  '[[ "$(grep -oE "jt_[0-9a-f]{64}" <<<"$OUT")" != "$(grep -oE "jt_[0-9a-f]{64}" <<<"$OUT2")" ]]'

# unknown verb → nonzero + usage
"$CLI" bogus >/dev/null 2>&1; check "unknown verb exits nonzero" '[[ $? -ne 0 ]]'

rm -rf "$TMP"
[[ $fails -eq 0 ]] || { echo "FAILED: $fails"; exit 1; }
echo "ALL PASS"
