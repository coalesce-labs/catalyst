#!/usr/bin/env bash
# Shell tests for the catalystSessionId persistence step in the phase-agent
# preludes (CTL-496).
#
# The 8 phase SKILL.md files (_phase-agent-template + the 7 Claude-session
# phase skills) all include the same `jq` merge that writes
# .catalystSessionId into the per-phase signal file alongside .status = "running"
# and .updatedAt. orchestrate-roll-usage.sh --phase reads .catalystSessionId
# to mirror cost into the right session_metrics row.
#
# This test exercises that jq merge in isolation against a synthesized signal
# file, both with and without CATALYST_SESSION_ID set, to verify:
#   1. when CATALYST_SESSION_ID is non-empty, .catalystSessionId is written
#   2. when CATALYST_SESSION_ID is unset/empty, the signal is NOT mutated
#      with an empty catalystSessionId (which would later confuse the DB
#      fallback by appearing "set")
#
# We also assert every phase SKILL.md that calls catalyst-session.sh contains
# the catalystSessionId merge so future template clones don't drift.
#
# Run: bash plugins/dev/scripts/__tests__/phase-agent-template.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILLS_DIR="${REPO_ROOT}/plugins/dev/skills"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

# Apply the canonical jq merge that lives in every phase SKILL prelude.
# This must stay byte-identical to the body inside `jq --arg ts ...` in the
# phase SKILLs (only the surrounding bash variables differ).
apply_phase_prelude_jq() {
  local signal="$1" ts="$2" sid="$3"
  local tmp="${signal}.tmp.$$"
  jq --arg ts "$ts" --arg sid "$sid" '
    .status = "running"
    | .updatedAt = $ts
    | if $sid != "" then .catalystSessionId = $sid else . end
  ' "$signal" > "$tmp" && mv "$tmp" "$signal"
}

# ───────────────────────────────────────────────────────────────────────────────
echo "phase-agent-template catalystSessionId persistence tests"
echo ""

# ─── Test 1: CATALYST_SESSION_ID set → .catalystSessionId written ─────────────
SIGNAL="${SCRATCH}/signal-with-sid.json"
cat > "$SIGNAL" <<'EOF'
{
  "ticket": "CTL-T1",
  "phase": "research",
  "orchestrator": "orch-test",
  "status": "pending",
  "bg_job_id": "fake-bg-1",
  "startedAt": "2026-05-18T09:00:00Z",
  "updatedAt": "2026-05-18T09:00:00Z"
}
EOF
apply_phase_prelude_jq "$SIGNAL" "2026-05-18T09:30:00Z" "sess_test_abcd"
run "with SID: catalystSessionId set" \
  bash -c "[ \"\$(jq -r '.catalystSessionId' '$SIGNAL')\" = 'sess_test_abcd' ]"
run "with SID: status flipped to running" \
  bash -c "[ \"\$(jq -r '.status' '$SIGNAL')\" = 'running' ]"
run "with SID: updatedAt updated" \
  bash -c "[ \"\$(jq -r '.updatedAt' '$SIGNAL')\" = '2026-05-18T09:30:00Z' ]"
run "with SID: ticket preserved" \
  bash -c "[ \"\$(jq -r '.ticket' '$SIGNAL')\" = 'CTL-T1' ]"
run "with SID: bg_job_id preserved" \
  bash -c "[ \"\$(jq -r '.bg_job_id' '$SIGNAL')\" = 'fake-bg-1' ]"

# ─── Test 2: CATALYST_SESSION_ID empty → .catalystSessionId NOT written ───────
# The DB fallback in orchestrate-roll-usage treats catalystSessionId="" as
# "set but blank" if we naively write it, defeating the ticket+skill_name
# lookup. The `if $sid != "" then ... else . end` guard prevents this.
SIGNAL2="${SCRATCH}/signal-without-sid.json"
cat > "$SIGNAL2" <<'EOF'
{
  "ticket": "CTL-T2",
  "phase": "research",
  "orchestrator": "orch-test",
  "status": "pending",
  "bg_job_id": "fake-bg-2",
  "startedAt": "2026-05-18T09:00:00Z",
  "updatedAt": "2026-05-18T09:00:00Z"
}
EOF
apply_phase_prelude_jq "$SIGNAL2" "2026-05-18T09:30:00Z" ""
run "no SID: catalystSessionId absent (not added as empty string)" \
  bash -c "[ \"\$(jq 'has(\"catalystSessionId\")' '$SIGNAL2')\" = 'false' ]"
run "no SID: status still flipped to running" \
  bash -c "[ \"\$(jq -r '.status' '$SIGNAL2')\" = 'running' ]"
run "no SID: updatedAt still updated" \
  bash -c "[ \"\$(jq -r '.updatedAt' '$SIGNAL2')\" = '2026-05-18T09:30:00Z' ]"

# ─── Test 3: re-running with same SID is idempotent ───────────────────────────
SIGNAL3="${SCRATCH}/signal-rerun.json"
cat > "$SIGNAL3" <<'EOF'
{"ticket":"CTL-T3","phase":"plan","orchestrator":"orch-test","status":"pending","bg_job_id":"bg-3","startedAt":"2026-05-18T09:00:00Z","updatedAt":"2026-05-18T09:00:00Z"}
EOF
apply_phase_prelude_jq "$SIGNAL3" "2026-05-18T09:30:00Z" "sess_idempotent"
apply_phase_prelude_jq "$SIGNAL3" "2026-05-18T09:30:00Z" "sess_idempotent"
run "rerun: catalystSessionId still set correctly" \
  bash -c "[ \"\$(jq -r '.catalystSessionId' '$SIGNAL3')\" = 'sess_idempotent' ]"

# ─── Test 4: every phase SKILL that starts a catalyst-session has the merge ───
# Drift guard: if someone clones the template into a new phase skill and
# forgets to copy the catalystSessionId line, this test catches it.
for skill in _phase-agent-template phase-research phase-plan phase-implement \
             phase-verify phase-review phase-pr phase-monitor-merge; do
  skill_file="${SKILLS_DIR}/${skill}/SKILL.md"
  run "drift: ${skill}/SKILL.md contains catalystSessionId merge" \
    bash -c "grep -q '\.catalystSessionId = \\\$sid' '$skill_file'"
done

# ─── Test 5: phase-triage and phase-monitor-deploy are shell-only and
#             intentionally do NOT call catalyst-session.sh ─────────────────────
# These two phases are deterministic shell programs; no Claude turns, no
# session_metrics row, no catalystSessionId to persist. Document the
# expectation so a future contributor doesn't add a bogus session-start to
# them just for symmetry.
for shell_only in phase-triage phase-monitor-deploy; do
  skill_file="${SKILLS_DIR}/${shell_only}/SKILL.md"
  run "shell-only: ${shell_only}/SKILL.md does NOT start a catalyst-session" \
    bash -c "! grep -q 'SESSION_SCRIPT.*start' '$skill_file'"
done

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
