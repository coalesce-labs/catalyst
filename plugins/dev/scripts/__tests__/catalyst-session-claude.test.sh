#!/usr/bin/env bash
# Tests for catalyst-session.sh Claude Code metadata binding (CTL-374):
#   - --claude-session-id flag on `start` (with CLAUDE_CODE_SESSION_ID env fallback)
#   - persistence in the sessions.claude_session_id SQLite column
#   - claude.session.id attribute propagated on subsequent session.* events
#   - new `emit-context` subcommand emitting session.context canonical events
#   - 70% threshold-crossing additionally emits attention.context_pressure
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-session-claude.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SESSION_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-session.sh"
DB_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-db.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-session-claude-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

export CATALYST_DIR="$SCRATCH"
export CATALYST_DB_FILE="$SCRATCH/catalyst.db"
export CATALYST_MIGRATIONS_DIR="$REPO_ROOT/plugins/dev/scripts/db-migrations"
EVENTS_DIR="$SCRATCH/events"
mkdir -p "$EVENTS_DIR"
export CATALYST_EVENTS_DIR="$EVENTS_DIR"

ok() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() {
  FAILURES=$((FAILURES + 1))
  echo "  FAIL: $1"
  [[ -n "${2:-}" ]] && echo "    $2"
}
expect_eq() {
  if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi
}
expect_not_empty() {
  if [[ -n "$2" ]]; then ok "$1"; else fail "$1" "value was empty"; fi
}

# Apply migrations
"$DB_SCRIPT" init >/dev/null 2>&1 || { echo "FATAL: db init failed"; exit 1; }

# Helper: find the active events JSONL file for this UTC month
events_file() {
  printf '%s/%s.jsonl' "$EVENTS_DIR" "$(date -u +%Y-%m)"
}

# ─── 1. --claude-session-id flag persists to SQLite ─────────────────────────
SID1="$(bash "$SESSION_SCRIPT" start --skill testskill1 \
        --claude-session-id "uuid-flag-1234")"
expect_not_empty "start returns a session id" "$SID1"

CLAUDE_SID_DB="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT claude_session_id FROM sessions WHERE session_id = '$SID1';")"
expect_eq "flag persists to sessions.claude_session_id" \
  "uuid-flag-1234" "$CLAUDE_SID_DB"

# ─── 2. CLAUDE_CODE_SESSION_ID env fallback ─────────────────────────────────
CLAUDE_CODE_SESSION_ID="uuid-env-9876" \
  SID2="$(bash -c "export CLAUDE_CODE_SESSION_ID='uuid-env-9876' && \
                   bash '$SESSION_SCRIPT' start --skill testskill2")"
expect_not_empty "start with env fallback returns id" "$SID2"

CLAUDE_SID_ENV="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT claude_session_id FROM sessions WHERE session_id = '$SID2';")"
expect_eq "CLAUDE_CODE_SESSION_ID env populates claude_session_id" \
  "uuid-env-9876" "$CLAUDE_SID_ENV"

# ─── 3. Flag overrides env when both set ────────────────────────────────────
SID3="$(bash -c "export CLAUDE_CODE_SESSION_ID='uuid-env-X' && \
                 bash '$SESSION_SCRIPT' start --skill testskill3 \
                   --claude-session-id 'uuid-flag-Y'")"
CLAUDE_SID_BOTH="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT claude_session_id FROM sessions WHERE session_id = '$SID3';")"
expect_eq "flag overrides env when both present" "uuid-flag-Y" "$CLAUDE_SID_BOTH"

# ─── 4. claude.session.id propagates on session.phase events ────────────────
bash "$SESSION_SCRIPT" phase "$SID1" "implementing" --phase 3 >/dev/null

EF="$(events_file)"
[[ -f "$EF" ]] || { fail "events file exists after phase" "$EF missing"; }

PHASE_LINE="$(grep '"session.phase"' "$EF" | grep "$SID1" | tail -n 1)"
expect_not_empty "session.phase event recorded for SID1" "$PHASE_LINE"

CLAUDE_SID_EVT="$(printf '%s' "$PHASE_LINE" | jq -r '.attributes."claude.session.id" // ""')"
expect_eq "session.phase event carries claude.session.id" \
  "uuid-flag-1234" "$CLAUDE_SID_EVT"

# ─── 5. emit-context: basic session.context emission ────────────────────────
# Sub-tests use a fresh session per scenario for cleaner assertions.
SID_CTX="$(bash "$SESSION_SCRIPT" start --skill ctxtest \
            --claude-session-id "uuid-ctx-1")"

bash "$SESSION_SCRIPT" emit-context "$SID_CTX" \
  --context-pct 24 --context-tokens 245000 --context-max 1000000 \
  --turn 5 --model "claude-opus-4-7" --cost-usd 1.23 >/dev/null

CTX_LINE="$(grep '"session.context"' "$EF" | grep "$SID_CTX" | tail -n 1)"
expect_not_empty "session.context event recorded" "$CTX_LINE"

CTX_PCT="$(printf '%s' "$CTX_LINE" | jq -r '.attributes."claude.context.used_pct"')"
expect_eq "session.context claude.context.used_pct" "24" "$CTX_PCT"

CTX_TOK="$(printf '%s' "$CTX_LINE" | jq -r '.attributes."claude.context.tokens"')"
expect_eq "session.context claude.context.tokens" "245000" "$CTX_TOK"

CTX_MODEL="$(printf '%s' "$CTX_LINE" | jq -r '.attributes."claude.model"')"
expect_eq "session.context claude.model" "claude-opus-4-7" "$CTX_MODEL"

CTX_TURN="$(printf '%s' "$CTX_LINE" | jq -r '.attributes."claude.turn"')"
expect_eq "session.context claude.turn" "5" "$CTX_TURN"

# Cost MUST be in body.payload (PII gate), NOT in typed attributes.
CTX_COST_PAYLOAD="$(printf '%s' "$CTX_LINE" | jq -r '.body.payload.cost_usd')"
expect_eq "cost lives in body.payload.cost_usd" "1.23" "$CTX_COST_PAYLOAD"

CTX_COST_ATTR_PRESENT="$(printf '%s' "$CTX_LINE" | jq -r '.attributes | has("claude.cost.usd")')"
expect_eq "cost is NOT a typed attribute" "false" "$CTX_COST_ATTR_PRESENT"

CTX_MAX_PAYLOAD="$(printf '%s' "$CTX_LINE" | jq -r '.body.payload.context_max')"
expect_eq "context_max lives in body.payload" "1000000" "$CTX_MAX_PAYLOAD"

# ─── 5b. CTL-760: rate-limit 5h/7d percentages + resets + resource.linear.key ─
# Start a session bound to a ticket so the session.context resource block
# carries linear.key (the per-worker join key for Grafana panels).
SID_RL="$(bash "$SESSION_SCRIPT" start --skill phase-implement \
            --ticket CTL-760 --claude-session-id "uuid-rl-1")"

bash "$SESSION_SCRIPT" emit-context "$SID_RL" \
  --context-pct 30 --turn 7 --model "claude-opus-4-7" \
  --ratelimit-5h-pct 26 --ratelimit-7d-pct 15 \
  --ratelimit-5h-reset "2026-06-03T05:00:00Z" \
  --ratelimit-7d-reset "2026-06-10T00:00:00Z" >/dev/null

RL_LINE="$(grep '"session.context"' "$EF" | grep "$SID_RL" | tail -n 1)"
expect_not_empty "session.context event recorded for rate-limit test" "$RL_LINE"

RL_5H="$(printf '%s' "$RL_LINE" | jq -r '.attributes."claude.ratelimit.five_hour_pct"')"
expect_eq "session.context claude.ratelimit.five_hour_pct" "26" "$RL_5H"

RL_5H_TYPE="$(printf '%s' "$RL_LINE" | jq -r '.attributes."claude.ratelimit.five_hour_pct" | type')"
expect_eq "five_hour_pct is a number" "number" "$RL_5H_TYPE"

RL_7D="$(printf '%s' "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_pct"')"
expect_eq "session.context claude.ratelimit.seven_day_pct" "15" "$RL_7D"

RL_7D_TYPE="$(printf '%s' "$RL_LINE" | jq -r '.attributes."claude.ratelimit.seven_day_pct" | type')"
expect_eq "seven_day_pct is a number" "number" "$RL_7D_TYPE"

# Reset timestamps travel in body.payload only (informational, no label cardinality).
RL_5H_RESET="$(printf '%s' "$RL_LINE" | jq -r '.body.payload.ratelimit_5h_reset')"
expect_eq "5h reset in body.payload" "2026-06-03T05:00:00Z" "$RL_5H_RESET"

RL_7D_RESET="$(printf '%s' "$RL_LINE" | jq -r '.body.payload.ratelimit_7d_reset')"
expect_eq "7d reset in body.payload" "2026-06-10T00:00:00Z" "$RL_7D_RESET"

# Resets MUST NOT be typed attributes (avoid label cardinality explosion).
RL_5H_RESET_ATTR="$(printf '%s' "$RL_LINE" | jq -r '.attributes | has("claude.ratelimit.five_hour_reset")')"
expect_eq "5h reset is NOT a typed attribute" "false" "$RL_5H_RESET_ATTR"

# CTL-760: per-worker linear.key lands in the resource block.
RL_LINEAR_KEY="$(printf '%s' "$RL_LINE" | jq -r '.resource."linear.key" // ""')"
expect_eq "session.context resource.linear.key populated from ticket" "CTL-760" "$RL_LINEAR_KEY"

# ─── 6. No threshold crossing below 70 — only session.context emitted ──────
SID_BELOW="$(bash "$SESSION_SCRIPT" start --skill below70 \
              --claude-session-id "uuid-below")"
bash "$SESSION_SCRIPT" emit-context "$SID_BELOW" \
  --context-pct 50 --context-tokens 500000 --turn 10 \
  --model "claude-opus-4-7" >/dev/null

BELOW_ATT="$(grep '"attention.context_pressure"' "$EF" 2>/dev/null | grep "$SID_BELOW" || true)"
expect_eq "no attention event below 70%" "" "$BELOW_ATT"

# ─── 7. 70% crossing emits attention.context_pressure ───────────────────────
SID_CROSS="$(bash "$SESSION_SCRIPT" start --skill cross70 \
              --claude-session-id "uuid-cross")"
bash "$SESSION_SCRIPT" emit-context "$SID_CROSS" \
  --context-pct 50 --context-tokens 500000 --turn 10 \
  --model "claude-opus-4-7" >/dev/null
bash "$SESSION_SCRIPT" emit-context "$SID_CROSS" \
  --context-pct 72 --context-tokens 720000 --turn 11 \
  --model "claude-opus-4-7" >/dev/null

CROSS_LINE="$(grep '"attention.context_pressure"' "$EF" | grep "$SID_CROSS" | tail -n 1)"
expect_not_empty "attention.context_pressure event on 70% crossing" "$CROSS_LINE"

CROSS_NEW="$(printf '%s' "$CROSS_LINE" | jq -r '.body.payload.new_pct')"
expect_eq "attention new_pct" "72" "$CROSS_NEW"

CROSS_PREV="$(printf '%s' "$CROSS_LINE" | jq -r '.body.payload.prev_pct')"
expect_eq "attention prev_pct" "50" "$CROSS_PREV"

CROSS_THRESH="$(printf '%s' "$CROSS_LINE" | jq -r '.body.payload.threshold')"
expect_eq "attention threshold" "70" "$CROSS_THRESH"

# Attention event must include claude.session.id for join keys.
CROSS_CLAUDE_SID="$(printf '%s' "$CROSS_LINE" | jq -r '.attributes."claude.session.id"')"
expect_eq "attention carries claude.session.id" "uuid-cross" "$CROSS_CLAUDE_SID"

# ─── 8. No re-trigger when already above threshold ──────────────────────────
bash "$SESSION_SCRIPT" emit-context "$SID_CROSS" \
  --context-pct 75 --context-tokens 750000 --turn 12 \
  --model "claude-opus-4-7" >/dev/null

CROSS_ALL="$(grep '"attention.context_pressure"' "$EF" | grep -c "$SID_CROSS" || true)"
expect_eq "still only one attention event after staying above 70" "1" "$CROSS_ALL"

# ─── 9. Drop below then re-cross re-fires attention ─────────────────────────
bash "$SESSION_SCRIPT" emit-context "$SID_CROSS" \
  --context-pct 65 --context-tokens 650000 --turn 13 \
  --model "claude-opus-4-7" >/dev/null
bash "$SESSION_SCRIPT" emit-context "$SID_CROSS" \
  --context-pct 80 --context-tokens 800000 --turn 14 \
  --model "claude-opus-4-7" >/dev/null

CROSS_ALL2="$(grep '"attention.context_pressure"' "$EF" | grep -c "$SID_CROSS" || true)"
expect_eq "re-cross fires a second attention event" "2" "$CROSS_ALL2"

# ─── 10. Unknown session id fails fast ──────────────────────────────────────
if bash "$SESSION_SCRIPT" emit-context "sess_doesnotexist" \
    --context-pct 50 --turn 1 --model "x" >/dev/null 2>&1; then
  fail "emit-context with unknown session id should fail" "exit 0 was unexpected"
else
  ok "emit-context errors on unknown session id"
fi

# ─── 11. $REPO env populates vcs.repository.name on session events (CTL-385) ─
SID_REPO="$(bash "$SESSION_SCRIPT" start --skill repotest \
            --claude-session-id "uuid-repo-1")"
expect_not_empty "start returns id for REPO test" "$SID_REPO"

REPO="coalesce-labs/catalyst" bash "$SESSION_SCRIPT" phase "$SID_REPO" \
  "implementing" --phase 3 >/dev/null

REPO_LINE="$(grep '"session.phase"' "$EF" | grep "$SID_REPO" | tail -n 1)"
expect_not_empty "session.phase event recorded for REPO test" "$REPO_LINE"

REPO_ATTR="$(printf '%s' "$REPO_LINE" | jq -r '.attributes."vcs.repository.name" // ""')"
expect_eq "session.phase carries vcs.repository.name from \$REPO env" \
  "coalesce-labs/catalyst" "$REPO_ATTR"

# ─── 12. Absent $REPO leaves vcs.repository.name unset (CTL-385) ────────────
SID_NOREPO="$(bash "$SESSION_SCRIPT" start --skill norepotest \
              --claude-session-id "uuid-norepo-1")"
expect_not_empty "start returns id for no-REPO test" "$SID_NOREPO"

# Explicitly unset REPO so the parent shell's env doesn't leak in.
(unset REPO && bash "$SESSION_SCRIPT" phase "$SID_NOREPO" \
  "implementing" --phase 3 >/dev/null)

NOREPO_LINE="$(grep '"session.phase"' "$EF" | grep "$SID_NOREPO" | tail -n 1)"
expect_not_empty "session.phase event recorded for no-REPO test" "$NOREPO_LINE"

NOREPO_HAS="$(printf '%s' "$NOREPO_LINE" | jq -r '.attributes | has("vcs.repository.name")')"
expect_eq "session.phase omits vcs.repository.name when \$REPO unset" \
  "false" "$NOREPO_HAS"

# ─── 13. CTL-748: metric --turns persists num_turns to session_metrics ───────
SID_TURNS="$(bash "$SESSION_SCRIPT" start --skill phase-research)"
expect_not_empty "start returns id for turns test" "$SID_TURNS"

bash "$SESSION_SCRIPT" metric "$SID_TURNS" \
  --cost 0.25 --input 1000 --output 500 \
  --cache-read 0 --cache-creation 0 --duration-ms 10000 --turns 12

STORED_TURNS="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT num_turns FROM session_metrics WHERE session_id = '${SID_TURNS}';")"
expect_eq "metric --turns writes num_turns to DB" "12" "$STORED_TURNS"

# ─── 14. CTL-752: workflow_id resolution (frozen-daemon leak guard) ──────────

# (a) A leaked daemon session id passed as --workflow is overridden by ORCH_ID.
WF_SID="$(CATALYST_ORCHESTRATOR_ID=CTL-752 bash "$SESSION_SCRIPT" start \
          --skill phase-plan --ticket CTL-752 \
          --workflow "sess_20260528T202656_16651cb1")"
WF_DB="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT workflow_id FROM sessions WHERE session_id = '$WF_SID';")"
expect_eq "leaked sess_* --workflow overridden by CATALYST_ORCHESTRATOR_ID" \
  "CTL-752" "$WF_DB"

# (b) An explicit, non-sess_* workflow id is preserved (legacy oneshot parent).
WF_SID2="$(CATALYST_ORCHESTRATOR_ID=CTL-752 bash "$SESSION_SCRIPT" start \
           --skill oneshot --ticket CTL-752 --workflow "wf-legacy-parent")"
WF_DB2="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT workflow_id FROM sessions WHERE session_id = '$WF_SID2';")"
expect_eq "explicit non-sess_* workflow id preserved" "wf-legacy-parent" "$WF_DB2"

# (c) Empty --workflow with ORCH_ID set populates workflow_id from ORCH_ID.
WF_SID3="$(CATALYST_ORCHESTRATOR_ID=CTL-752 bash "$SESSION_SCRIPT" start \
           --skill phase-research --ticket CTL-752 --workflow "")"
WF_DB3="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT workflow_id FROM sessions WHERE session_id = '$WF_SID3';")"
expect_eq "empty --workflow falls back to CATALYST_ORCHESTRATOR_ID" "CTL-752" "$WF_DB3"

# (d) No ORCH_ID + no --workflow → workflow_id stays empty (interactive, no regression).
WF_SID4="$(env -u CATALYST_ORCHESTRATOR_ID bash "$SESSION_SCRIPT" start --skill manual)"
WF_DB4="$(sqlite3 "$CATALYST_DB_FILE" \
  "SELECT COALESCE(workflow_id,'') FROM sessions WHERE session_id = '$WF_SID4';")"
expect_eq "no orch id + no workflow stays empty (no regression)" "" "$WF_DB4"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
