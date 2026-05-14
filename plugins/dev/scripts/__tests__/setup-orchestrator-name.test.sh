#!/usr/bin/env bash
# Tests for setup-orchestrator.sh — orch-id short-form generation (CTL-373).
# Run: bash plugins/dev/scripts/__tests__/setup-orchestrator-name.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/plugins/dev/scripts/setup-orchestrator.sh"

FAILURES=0
PASSES=0

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	[ $# -ge 2 ] && echo "    $2"
}

# Run setup-orchestrator.sh in --quiet mode against a throwaway git repo and
# parse the emitted ORCH_ID line. Returns the orch-id on stdout.
run_setup() {
	local out
	out=$(cd "$REPO_FAKE" && bash "$SETUP" "$@" --quiet 2>/dev/null) || return 1
	printf '%s' "$out" | grep '^ORCH_ID=' | head -1 | cut -d= -f2-
}

# ─── Fixture: minimal repo with .catalyst/config.json + worktree dir override ──

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

REPO_FAKE="${SCRATCH}/repo"
mkdir -p "${REPO_FAKE}/.catalyst"
(cd "$REPO_FAKE" && git init -q && git commit --allow-empty -q -m "init")

# Tell setup-orchestrator.sh where to place worktrees (avoid ~/catalyst/wt)
cat >"${REPO_FAKE}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test",
    "project": {"ticketPrefix": "CTL"},
    "orchestration": {"worktreeDir": "${SCRATCH}/wt"}
  }
}
EOF

# Use a private state dir so we don't pollute ~/catalyst/.
export CATALYST_DIR="${SCRATCH}/catalyst-state"
mkdir -p "$CATALYST_DIR"

# ─── Tests ───────────────────────────────────────────────────────────────────

echo "▶ single ticket"
ID=$(run_setup --tickets CTL-373)
[[ $ID == "o-ctl-373" ]] && pass "single CTL-373 → o-ctl-373" ||
	fail "single CTL-373 → o-ctl-373" "got: $ID"

echo "▶ multi-ticket same prefix"
ID=$(run_setup --tickets "ADV-931 ADV-932 ADV-933")
[[ $ID == "o-adv-931-932-933" ]] && pass "multi same-prefix → o-adv-931-932-933" ||
	fail "multi same-prefix → o-adv-931-932-933" "got: $ID"

echo "▶ multi-ticket mixed prefix"
ID=$(run_setup --tickets "CTL-1 ADV-2")
[[ $ID == "o-ctl-1-adv-2" ]] && pass "mixed prefix → o-ctl-1-adv-2" ||
	fail "mixed prefix → o-ctl-1-adv-2" "got: $ID"

echo "▶ project mode (no date)"
ID=$(run_setup --project cycle-1)
[[ $ID == "o-cycle-1" ]] && pass "project cycle-1 → o-cycle-1" ||
	fail "project cycle-1 → o-cycle-1" "got: $ID"

echo "▶ cycle mode (no date)"
ID=$(run_setup --cycle current)
[[ $ID == "o-cycle-current" ]] && pass "cycle current → o-cycle-current" ||
	fail "cycle current → o-cycle-current" "got: $ID"

echo "▶ auto mode (no date)"
ID=$(run_setup --auto 5)
[[ $ID == "o-auto-5" ]] && pass "auto 5 → o-auto-5" ||
	fail "auto 5 → o-auto-5" "got: $ID"

echo "▶ collision suffix"
# Pre-create a colliding worktree directory
mkdir -p "${SCRATCH}/wt/o-ctl-99"
ID=$(run_setup --tickets CTL-99)
[[ $ID == "o-ctl-99-2" ]] && pass "collision → o-ctl-99-2" ||
	fail "collision → o-ctl-99-2" "got: $ID"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "PASSES=$PASSES FAILURES=$FAILURES"
[[ $FAILURES -eq 0 ]] || exit 1
