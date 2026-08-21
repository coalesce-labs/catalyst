#!/usr/bin/env bash
# project-orchestrator-shape.test.sh — CTL-1974: the named skill exists, delegates
# to steward, encodes the four hard constraints, and stays within budget.
# Skill has NO references/ dir (single source of truth = steward), so skill-shape
# does not cover it — this suite is its gate. Wired in BOTH run-tests.sh (glob)
# and .github/workflows/skills-gate.yml (explicit step). Do BOTH or it runs nowhere.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SCRIPT_DIR}/../project-orchestrator/SKILL.md"
PASSES=0; FAILURES=0
pass(){ echo "  PASS: $1"; PASSES=$((PASSES+1)); }
fail(){ echo "  FAIL: $1"; FAILURES=$((FAILURES+1)); }

# 1. Exists and within the same budget the shape gate uses.
[[ -f "$SKILL" ]] && pass "SKILL.md exists" || fail "SKILL.md missing"
lines=$(wc -l < "$SKILL" 2>/dev/null | tr -d ' '); : "${lines:=9999}"
[[ "$lines" -le 80 ]] && pass "SKILL.md is ${lines} lines (<= 80)" || fail "SKILL.md ${lines} > 80"

# 2. Frontmatter: name matches dir, description carries trigger vocab, user-invocable.
/usr/bin/grep -qE '^name:[[:space:]]*project-orchestrator$' "$SKILL" \
  && pass "name: project-orchestrator" || fail "name frontmatter wrong/absent"
/usr/bin/grep -qiE 'project orchestrator' "$SKILL" \
  && pass "description/body carries 'project orchestrator' trigger vocab" || fail "no trigger vocab"
/usr/bin/grep -qE '^user-invocable:[[:space:]]*true$' "$SKILL" \
  && pass "user-invocable: true" || fail "user-invocable missing"

# 3. Delegates to the canonical engine.
/usr/bin/grep -qF 'catalyst-dev:steward' "$SKILL" \
  && pass "delegates to catalyst-dev:steward" || fail "no steward delegation"

# 4. Encodes the four hard constraints.
/usr/bin/grep -qiE 'Todo is (your|the) only dispatch verb|Todo[^.]*only dispatch' "$SKILL" \
  && pass "Todo-only dispatch verb stated" || fail "Todo-only invariant missing"
/usr/bin/grep -qiE 'claude -p|worktree|dispatch a worker|never a worker' "$SKILL" \
  && pass "forbids worker/worktree/claude -p" || fail "worker-dispatch prohibition missing"
/usr/bin/grep -qiE 'one level|one-level|parentId' "$SKILL" \
  && pass "one-level thread rule stated" || fail "threading rule missing"
/usr/bin/grep -qiE 'cloud proxy|proxy route' "$SKILL" \
  && pass "cloud-proxy write path stated" || fail "cloud-proxy write path missing"

# 5. States the 8-step shape (spot-check the load-bearing verbs).
for step in CLAIM SCOPE SELECT PLAN DISPATCH WATCH SPEAK CLOSE; do
  /usr/bin/grep -qF "$step" "$SKILL" && pass "shape step $step present" || fail "shape step $step absent"
done

# 6. No product code / no references dir (single source of truth = steward).
[[ ! -d "${SCRIPT_DIR}/../project-orchestrator/references" ]] \
  && pass "no references/ dir (delegates to steward's)" || fail "unexpected references/ dir"

# Phase 2: cross-links and budget assertions.
STEWARD="${SCRIPT_DIR}/../steward/SKILL.md"
CONCIERGE="${SCRIPT_DIR}/../concierge/SKILL.md"

# Cross-links exist.
/usr/bin/grep -qF 'project-orchestrator' "$STEWARD" \
  && pass "steward links project-orchestrator" || fail "steward missing project-orchestrator link"
/usr/bin/grep -qF 'project-orchestrator' "$CONCIERGE" \
  && pass "concierge links project-orchestrator" || fail "concierge missing project-orchestrator link"

# Budget preserved: steward stays within the shape gate's ceiling after the edit.
sl=$(wc -l < "$STEWARD" | tr -d ' ')
[[ "$sl" -le 80 ]] && pass "steward SKILL.md still <= 80 (${sl})" || fail "steward SKILL.md ${sl} > 80"

echo
echo "project-orchestrator-shape.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
