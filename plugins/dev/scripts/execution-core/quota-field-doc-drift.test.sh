#!/usr/bin/env bash
# quota-field-doc-drift.test.sh — CTL-1187. Asserts the canonical reference page
# documents EXACTLY the quota field names emitted by ratelimit-event.mjs, and
# carries the config-mirror contract + corrected bot-OAuth classification.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SRC="${SCRIPT_DIR}/ratelimit-event.mjs"
DOC="${REPO_ROOT}/website/src/content/docs/reference/cluster-config-mirror.md"
PASSES=0; FAILURES=0
pass(){ echo "  PASS: $1"; (( PASSES++ )) || true; }
fail(){ echo "  FAIL: $1"; (( FAILURES++ )) || true; }

# (a) page exists
[[ -f "$DOC" ]] && pass "reference page exists" || fail "reference page missing: $DOC"

# (b) every dotted ratelimit.* / subscription.type / rate_limit.tier key emitted by the
#     source is present verbatim in the doc (drift guard — derive list FROM source).
KEYS="$(grep -oE 'put\("(ratelimit|subscription|rate_limit)[a-z_.]*"' "$SRC" \
        | sed -E 's/put\("//; s/"$//')"
for k in $KEYS; do
  grep -qF "$k" "$DOC" && pass "doc lists emitted key $k" || fail "doc missing emitted key $k"
done

# (c) doc lists no INVENTED ratelimit.* key absent from source (reverse-drift).
# Exclude ratelimit.sampled — it appears as a suffix of the event NAME
# "account.ratelimit.sampled", not as an emitted attribute key.
for d in $(grep -oE 'ratelimit\.[a-z_]+' "$DOC" | grep -v '^ratelimit\.sampled$' | sort -u); do
  grep -qxF "$d" <<<"$KEYS" && pass "doc key $d backed by source" || fail "doc invents key $d"
done

# (d) event name + binding-limit + camelCase-internal note documented
grep -qF "account.ratelimit.sampled" "$DOC" && pass "event name present" || fail "event name missing"
grep -qiE "seven_day_opus_pct.*(binding|Max 20x)|Max 20x.*seven_day_opus_pct" "$DOC" \
  && pass "binding-limit note present" || fail "binding-limit note missing"
grep -qiE "camelCase|internal[- ]only|ratelimit-poller" "$DOC" \
  && pass "internal-only camelCase note present" || fail "internal-only note missing"

# (e) config-mirror contract: both classes + corrected bot-OAuth placement
grep -qE "\bSHARED\b" "$DOC" && grep -qE "\bPER-NODE\b" "$DOC" \
  && pass "SHARED and PER-NODE classes present" || fail "contract classes missing"
# bot OAuth must be SHARED and in machine-global config.json (NOT config-<key>.json)
grep -qE "catalyst\.linear\.bot" "$DOC" && pass "bot OAuth row present" || fail "bot OAuth row missing"
grep -qE "config-<key>\.json.*bot|bot.*config-<key>\.json" "$DOC" \
  && fail "bot OAuth wrongly tied to per-project config-<key>.json" \
  || pass "bot OAuth not tied to per-project secrets"

echo "── ${PASSES} passed, ${FAILURES} failed ──"
[[ "$FAILURES" -eq 0 ]]
