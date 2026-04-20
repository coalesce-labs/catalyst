#!/usr/bin/env bash
# Integration tests for CTL-111 — catalyst-comms wired into orchestrate.
# Simulates an orchestrator dispatching 3 workers that each emit the required
# baseline traffic (join + start info + ≥2 phase transitions + done).
#
# Also verifies the actual skill markdown files contain the required hook
# calls, to catch regressions where someone drops a hook line.
#
# Run: bash plugins/dev/scripts/__tests__/orchestrate-comms-integration.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
COMMS="${REPO_ROOT}/plugins/dev/scripts/catalyst-comms"
ORCH_SKILL="${REPO_ROOT}/plugins/dev/skills/orchestrate/SKILL.md"
ONESHOT_SKILL="${REPO_ROOT}/plugins/dev/skills/oneshot/SKILL.md"
COMMS_SKILL="${REPO_ROOT}/plugins/dev/skills/catalyst-comms/SKILL.md"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
export CATALYST_DIR="$SCRATCH"
export CATALYST_COMMS_DIR="$SCRATCH/comms"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; return 0; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; if [ -n "${2:-}" ]; then echo "    $2"; fi; return 0; }

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    pass "$name"
  else
    fail "$name" "command failed: $*"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

assert_eq() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    pass "$name"
  else
    fail "$name" "want=$want got=$got"
  fi
}

echo "CTL-111 orchestrate-comms integration tests"
echo "==========================================="

ORCH_ID="orch-test-$$"
CH="orch-${ORCH_ID}"
CH_FILE="$CATALYST_COMMS_DIR/channels/${CH}.jsonl"

# ── 1. Orchestrator join creates channel ──────────────────────────────────
"$COMMS" join "$CH" --as orchestrator --capabilities "coordinates workers" \
  --orch "$ORCH_ID" --ttl 7200 > "${SCRATCH}/orch-join.out" 2>&1
run "orchestrator join creates channel file" test -f "$CH_FILE"

# Verify participant registered
REG=$(jq -r --arg ch "$CH" '.[$ch].participants[] | select(.name == "orchestrator") | .status' \
  "$CATALYST_COMMS_DIR/channels.json")
assert_eq "orchestrator registered active" "active" "$REG"

# ── 2. Three workers each emit full baseline traffic (≥4 msgs each) ──────
for N in 1 2 3; do
  WORKER="CTL-10${N}"

  # Worker join
  "$COMMS" join "$CH" --as "$WORKER" --capabilities "oneshot: $WORKER" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 > /dev/null 2>&1

  # Start info
  "$COMMS" send "$CH" "started oneshot for $WORKER" --as "$WORKER" --type info > /dev/null 2>&1
  # Phase transitions (2+)
  "$COMMS" send "$CH" "researching → planning" --as "$WORKER" --type info > /dev/null 2>&1
  "$COMMS" send "$CH" "planning → implementing" --as "$WORKER" --type info > /dev/null 2>&1
  "$COMMS" send "$CH" "implementing → validating" --as "$WORKER" --type info > /dev/null 2>&1
  # Done
  "$COMMS" done "$CH" --as "$WORKER" > /dev/null 2>&1 || true
done

# ── 3. Channel file contains expected message volume ─────────────────────
# Orchestrator join (1 line) + each worker: join(0, not in jsonl) + 4 sends + done(1) = 5
# Total: 1 + 3×5 = 16 lines minimum (joins are not sends, so just the sends/done)
# Actually join DOES write a participant entry to registry but NOT to channel jsonl.
# Sends: 4 per worker + 1 done = 5. But wait — let's just count.
LINE_COUNT=$(wc -l < "$CH_FILE" | tr -d ' ')
if [ "$LINE_COUNT" -ge 12 ]; then
  pass "channel has ≥12 messages (got $LINE_COUNT)"
else
  fail "channel message count" "got $LINE_COUNT, want ≥12"
fi

# ── 4. Each worker produced ≥4 messages ───────────────────────────────────
for N in 1 2 3; do
  WORKER="CTL-10${N}"
  COUNT=$(grep -c "\"from\":\"$WORKER\"" "$CH_FILE" || echo 0)
  if [ "$COUNT" -ge 4 ]; then
    pass "worker $WORKER produced $COUNT msgs (≥4)"
  else
    fail "worker $WORKER msg count" "got $COUNT, want ≥4"
  fi
done

# ── 5. Each worker posted exactly one done ────────────────────────────────
for N in 1 2 3; do
  WORKER="CTL-10${N}"
  DONE_COUNT=$(grep "\"from\":\"$WORKER\"" "$CH_FILE" | grep -c '"type":"done"' || echo 0)
  assert_eq "worker $WORKER posted exactly 1 done" "1" "$DONE_COUNT"
done

# ── 6. Cross-worker question/answer flow ──────────────────────────────────
QUESTION_MSG=$("$COMMS" send "$CH" "does my filter conflict?" --as "CTL-101" --type question 2>/dev/null)
# CTL-102 polls and can read it
POLL_OUT=$("$COMMS" poll "$CH" 2>/dev/null | grep '"type":"question"' | grep "CTL-101" || echo "")
if [ -n "$POLL_OUT" ]; then
  pass "CTL-102 can read CTL-101's question via poll"
else
  fail "cross-worker question readability" "question not found in poll output"
fi

# ── 7. Attention messages readable by orchestrator ───────────────────────
"$COMMS" send "$CH" "blocked: can't resolve migration conflict" \
  --as "CTL-103" --type attention > /dev/null 2>&1
ATTN=$("$COMMS" poll "$CH" 2>/dev/null | grep '"type":"attention"' | grep "CTL-103" || echo "")
if [ -n "$ATTN" ]; then
  pass "orchestrator can read attention message via poll"
else
  fail "attention message readability" "attention not found in poll output"
fi

# ── 8. Orchestrator done + quorum check ──────────────────────────────────
# Orchestrator posts done; should succeed since all 3 workers already done.
# Exit 0 = quorum met.
set +e
"$COMMS" done "$CH" --as orchestrator > "${SCRATCH}/orch-done.out" 2>&1
ORCH_DONE_RC=$?
set -e
if [ "$ORCH_DONE_RC" = "0" ]; then
  pass "orchestrator done returns 0 (quorum met)"
else
  fail "orchestrator quorum" "rc=$ORCH_DONE_RC, output:"
  sed 's/^/      /' "${SCRATCH}/orch-done.out"
fi

# ── 9. status subcommand shows quorum ────────────────────────────────────
STATUS_OUT=$("$COMMS" status "$CH" 2>&1)
if echo "$STATUS_OUT" | grep -qi "done"; then
  pass "status shows done state"
else
  fail "status output missing done" "$STATUS_OUT"
fi

echo ""
echo "────────────────────────────────────────"
echo "Skill markdown hook verification"
echo "────────────────────────────────────────"

# ── 10. orchestrate/SKILL.md contains all 4 required hooks ───────────────
grep -q 'catalyst-comms join "orch-\${ORCH_NAME}"' "$ORCH_SKILL" \
  && pass "orchestrate: Phase 1 join hook present" \
  || fail "orchestrate: Phase 1 join hook missing"

grep -q 'CATALYST_COMMS_CHANNEL="orch-\${ORCH_NAME}"' "$ORCH_SKILL" \
  && pass "orchestrate: Phase 3 dispatch env hook present" \
  || fail "orchestrate: Phase 3 dispatch env hook missing"

grep -q 'catalyst-comms poll "orch-\${ORCH_NAME}"' "$ORCH_SKILL" \
  && pass "orchestrate: Phase 4 attention poll hook present" \
  || fail "orchestrate: Phase 4 attention poll hook missing"

grep -q 'catalyst-comms done "orch-\${ORCH_NAME}" --as orchestrator' "$ORCH_SKILL" \
  && pass "orchestrate: Phase 7 done hook present" \
  || fail "orchestrate: Phase 7 done hook missing"

# ── 11. oneshot/SKILL.md contains worker comms hooks ─────────────────────
grep -q 'comms_post' "$ONESHOT_SKILL" \
  && pass "oneshot: comms_post helper present" \
  || fail "oneshot: comms_post helper missing"

grep -q 'CATALYST_COMMS_CHANNEL' "$ONESHOT_SKILL" \
  && pass "oneshot: CATALYST_COMMS_CHANNEL reference present" \
  || fail "oneshot: CATALYST_COMMS_CHANNEL reference missing"

grep -q 'catalyst-comms join "\$CATALYST_COMMS_CHANNEL"' "$ONESHOT_SKILL" \
  && pass "oneshot: worker join hook present" \
  || fail "oneshot: worker join hook missing"

grep -q 'catalyst-comms done "\$CATALYST_COMMS_CHANNEL"' "$ONESHOT_SKILL" \
  && pass "oneshot: worker done hook present" \
  || fail "oneshot: worker done hook missing"

# ── 12. catalyst-comms/SKILL.md documents worker traffic contract ────────
grep -qi "Worker Traffic Contract\|minimum 4 messages\|baseline traffic" "$COMMS_SKILL" \
  && pass "catalyst-comms: worker traffic contract documented" \
  || fail "catalyst-comms: worker traffic contract missing"

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASSES} passed, ${FAILURES} failed"
echo "────────────────────────────────────────"

if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
