#!/usr/bin/env bash
# Tests for CTL-1490 Feature E: create-worktree.sh must root a rebuilt worktree
# on origin/<ticket> when that remote branch exists, instead of branching fresh
# from main. Models the existing create-worktree-base-ref.test.sh style.
#
# Run: bash plugins/dev/scripts/__tests__/create-worktree-reconstruct.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CREATE_WT="${REPO_ROOT}/plugins/dev/scripts/create-worktree.sh"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
assert_eq() {
  if [[ $1 == "$2" ]]; then pass "$3"; else fail "$3 — expected '$1', got '$2'"; fi
}
assert_contains() {
  if [[ $1 == *"$2"* ]]; then pass "$3"; else fail "$3 — '$2' not in output"; fi
}
assert_not_contains() {
  if [[ $1 != *"$2"* ]]; then pass "$3"; else fail "$3 — output unexpectedly contained '$2'"; fi
}

# build_scratch — bare origin with main + optional ticket branch.
# Sets SCRATCH, ORIGIN, SRC, WT, BIN, FAKEHOME, MAIN_TIP.
# If TICKET_BRANCH_COMMIT is set, pushes an extra commit on that branch to ORIGIN.
build_scratch() {
  local ticket="${1:-CTL-9876}"
  SCRATCH="$(mktemp -d -t cwt-reconstruct-XXXXXX)"
  ORIGIN="$SCRATCH/origin.git"
  SRC="$SCRATCH/src"
  WT="$SCRATCH/wt"
  BIN="$SCRATCH/bin"
  FAKEHOME="$SCRATCH/home"
  mkdir -p "$WT" "$BIN" "$FAKEHOME"

  git init -q --bare "$ORIGIN"

  local SEED="$SCRATCH/seed"
  git clone -q "$ORIGIN" "$SEED"
  git -C "$SEED" config user.email t@t.t
  git -C "$SEED" config user.name t
  git -C "$SEED" checkout -q -b main 2>/dev/null || git -C "$SEED" checkout -q main
  git -C "$SEED" commit -q --allow-empty -m "c1-main"
  git -C "$SEED" push -q -u origin main
  MAIN_TIP="$(git -C "$SEED" rev-parse HEAD)"

  # Optionally push a ticket branch with a distinct commit.
  TICKET_TIP=""
  if [[ "${PUSH_TICKET_BRANCH:-false}" == "true" ]]; then
    git -C "$SEED" checkout -q -b "$ticket"
    git -C "$SEED" commit -q --allow-empty -m "c2-unique-on-${ticket}"
    git -C "$SEED" push -q -u origin "$ticket"
    TICKET_TIP="$(git -C "$SEED" rev-parse HEAD)"
    git -C "$SEED" checkout -q main
  fi

  git clone -q "$ORIGIN" "$SRC"
  git -C "$SRC" config user.email t@t.t
  git -C "$SRC" config user.name t
  git -C "$SRC" checkout -q main

  mkdir -p "$SRC/.catalyst"
  # worktree.setup bypasses the auto-detected thoughts init path (CTL-1497
  # guard fails in test envs because FAKEHOME has no humanlayer.json).
  printf '{"catalyst":{"projectKey":"T","worktree":{"setup":["echo noop"]}}}\n' >"$SRC/.catalyst/config.json"

  # Fake humanlayer: exits 0 for all commands (intercepts thoughts sync, returns
  # empty profile so THOUGHTS_PROFILE stays unset).
  cat >"$BIN/humanlayer" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$BIN/humanlayer"

  # Provide a minimal humanlayer.json so worktree-thoughts-init.sh can
  # resolve thoughtsRepo and create the thoughts/shared symlink.
  local THOUGHTS_REPO="$SCRATCH/thoughts-repo"
  mkdir -p "$THOUGHTS_REPO"
  mkdir -p "$FAKEHOME/.config/humanlayer"
  printf '{"thoughts":{"thoughtsRepo":"%s","user":"testuser"}}\n' \
    "$THOUGHTS_REPO" >"$FAKEHOME/.config/humanlayer/humanlayer.json"
}

run_create() { # $1 = worktree name; $@ = extra args
  local NAME="$1"
  shift
  OUTPUT="$(cd "$SRC" && PATH="$BIN:$PATH" HOME="$FAKEHOME" \
    bash "$CREATE_WT" "$NAME" main --worktree-dir "$WT" "$@" 2>&1)"
  EXIT=$?
  WT_PATH="$WT/$NAME"
}

# ──────────────────────────────────────────────────────────────────────────────
# T1: origin has refs/heads/<ticket> with a unique commit, no local branch,
#     worktree dir absent → new worktree HEAD == origin/<ticket> tip (NOT main).
# ──────────────────────────────────────────────────────────────────────────────
echo "T1: origin has ticket branch → worktree rooted on origin/<ticket> tip"
PUSH_TICKET_BRANCH=true build_scratch "CTL-9876"
run_create "CTL-9876"
assert_eq "0" "$EXIT" "T1: exits 0"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$TICKET_TIP" "$HEAD_SHA" "T1: worktree HEAD == origin/CTL-9876 tip (not main)"
assert_not_contains "$OUTPUT" "Creating new branch" "T1: did not fall through to fresh-off-main path"
rm -rf "$SCRATCH"

# ──────────────────────────────────────────────────────────────────────────────
# T2: origin has NO <ticket> branch → falls through to fresh-off-main.
# ──────────────────────────────────────────────────────────────────────────────
echo "T2: no ticket branch on origin → falls through to fresh-off-main"
PUSH_TICKET_BRANCH=false build_scratch "CTL-9877"
run_create "CTL-9877"
assert_eq "0" "$EXIT" "T2: exits 0"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$MAIN_TIP" "$HEAD_SHA" "T2: worktree HEAD == main tip (fall-through)"
assert_contains "$OUTPUT" "Creating new branch" "T2: used the fresh-off-main path"
rm -rf "$SCRATCH"

# ──────────────────────────────────────────────────────────────────────────────
# T3: --skip-fetch → no fetch, fresh-off-main (existing behavior preserved).
# ──────────────────────────────────────────────────────────────────────────────
echo "T3: --skip-fetch → no fetch, fresh-off-main regardless of remote branch"
PUSH_TICKET_BRANCH=true build_scratch "CTL-9878"
LOCAL_MAIN="$(git -C "$SRC" rev-parse main)"
run_create "CTL-9878" --skip-fetch
assert_eq "0" "$EXIT" "T3: exits 0 with --skip-fetch"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || echo NA)"
assert_eq "$LOCAL_MAIN" "$HEAD_SHA" "T3: worktree HEAD == local main (skip-fetch, no remote lookup)"
rm -rf "$SCRATCH"

# ──────────────────────────────────────────────────────────────────────────────
# T4: after T1-style checkout, upstream is set to origin/<ticket>.
# ──────────────────────────────────────────────────────────────────────────────
echo "T4: upstream tracking set to origin/<ticket> after reconstruction checkout"
PUSH_TICKET_BRANCH=true build_scratch "CTL-9879"
run_create "CTL-9879"
assert_eq "0" "$EXIT" "T4: exits 0"
UPSTREAM="$(git -C "$WT_PATH" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo NONE)"
assert_eq "origin/CTL-9879" "$UPSTREAM" "T4: upstream tracking is origin/CTL-9879"
rm -rf "$SCRATCH"

# ──────────────────────────────────────────────────────────────────────────────
# T5 (divergence): recovery.mjs defaultRebuildWorktree passes expectedBranch: ticket
# to createWorktree (CTL-1490 Feature E, recovery.mjs wiring).
# ──────────────────────────────────────────────────────────────────────────────
echo "T5 (divergence): recovery.mjs defaultRebuildWorktree passes expectedBranch: ticket"
RECOVERY_MJS="${REPO_ROOT}/plugins/dev/scripts/execution-core/recovery.mjs"
if grep -qF "expectedBranch: ticket" "$RECOVERY_MJS"; then
  pass "T5: defaultRebuildWorktree passes expectedBranch: ticket to createWorktree"
else
  fail "T5: defaultRebuildWorktree does NOT pass expectedBranch: ticket to createWorktree"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "create-worktree-reconstruct: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
