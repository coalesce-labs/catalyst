#!/usr/bin/env bash
# Tests for lib/ctl708-resolve.sh (CTL-708 bounded-LLM source-conflict resolver).
# Builds a REAL git fixture with a genuine source conflict, and a fake `claude`
# binary (no network/API calls) so the resolver's staging/verification logic is
# exercised deterministically.
#
# Run: bash plugins/dev/scripts/lib/__tests__/ctl708-resolve.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REBASE_LIB="$LIB_DIR/worktree-rebase.sh"
CTL708_LIB="$LIB_DIR/ctl708-resolve.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t ctl708-resolve-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export EVENTS_DIR="${SCRATCH}/events"

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

# shellcheck source=../worktree-rebase.sh
source "$REBASE_LIB"
# shellcheck source=../ctl708-resolve.sh
source "$CTL708_LIB"

last_event_line() {
  local month_file="${EVENTS_DIR}/$(date -u +%Y-%m).jsonl"
  tail -n1 "$month_file" 2>/dev/null || echo ""
}

echo "ctl708-resolve tests"

# ── 1. ctl708_wire_resolver is a no-op when CATALYST_CTL708_ENABLE unset ────
echo "1. wiring is inert by default"
unset CATALYST_CTL708_ENABLE
unset -f ctl708_escalate 2>/dev/null || true
ctl708_escalate() { return 1; }  # simulate worktree-rebase.sh's stub
ctl708_wire_resolver
ctl708_escalate some-file.txt
assert_eq "1" "$?" "stub behavior unchanged when disabled"

# ── 2. wiring installs the override when enabled ────────────────────────────
echo "2. wiring installs the override when enabled"
export CATALYST_CTL708_ENABLE=1
ctl708_escalate() { return 1; }  # reset to stub first
ctl708_wire_resolver
IMPL="$(type ctl708_escalate)"
if [[ "$IMPL" == *"_ctl708_llm_resolve"* ]]; then
  pass "ctl708_escalate now delegates to _ctl708_llm_resolve"
else
  fail "ctl708_escalate not overridden — got: $IMPL"
fi

# ── Fixture: a real repo with a real source conflict ────────────────────────
FIXTURE="$SCRATCH/repo"
mkdir -p "$FIXTURE"
git -C "$FIXTURE" init --quiet --initial-branch=main
echo "line one" > "$FIXTURE/f.txt"
git -C "$FIXTURE" add f.txt
git -C "$FIXTURE" commit --quiet -m base

git -C "$FIXTURE" checkout --quiet -b feature
echo "line one (feature change)" > "$FIXTURE/f.txt"
git -C "$FIXTURE" commit --quiet -am "feature edit"

git -C "$FIXTURE" checkout --quiet main
echo "line one (main change)" > "$FIXTURE/f.txt"
git -C "$FIXTURE" commit --quiet -am "main edit"

git -C "$FIXTURE" checkout --quiet feature
git -C "$FIXTURE" merge main --quiet 2>/dev/null || true  # create a real conflict

cd "$FIXTURE" || exit 1

# ── 3. bound: too many files declines without invoking the resolver ────────
echo "3. file-count bound declines without spawning claude"
export CATALYST_DISPATCH_CLAUDE_BIN="$SCRATCH/should-not-run.sh"
cat > "$CATALYST_DISPATCH_CLAUDE_BIN" <<'EOF'
#!/usr/bin/env bash
echo "SHOULD NOT HAVE RUN" >&2
exit 1
EOF
chmod +x "$CATALYST_DISPATCH_CLAUDE_BIN"
export CATALYST_CTL708_MAX_FILES=0
_ctl708_llm_resolve f.txt
assert_eq "1" "$?" "declines over file-count bound"
LINE="$(last_event_line)"
assert_eq "declined" "$(jq -r '.body.payload.outcome' <<<"$LINE")" "declined outcome emitted"

unset CATALYST_CTL708_MAX_FILES

# ── 4. successful resolution via a fake claude binary ───────────────────────
echo "4. successful resolution (fake claude resolves the conflict)"
cat > "$CATALYST_DISPATCH_CLAUDE_BIN" <<'EOF'
#!/usr/bin/env bash
# Fake resolver: just write a merged-looking result over the conflicted file.
echo "line one (resolved)" > f.txt
exit 0
EOF
chmod +x "$CATALYST_DISPATCH_CLAUDE_BIN"
ORCH_ID=T1 TICKET=T1 PHASE=implement _ctl708_llm_resolve f.txt
RC=$?
assert_eq "0" "$RC" "resolves cleanly"
assert_eq "line one (resolved)" "$(cat f.txt)" "file content reflects the fake resolution"
STAGED="$(git diff --cached --name-only)"
assert_eq "f.txt" "$STAGED" "resolved file is staged"
LINE="$(last_event_line)"
assert_eq "resolved" "$(jq -r '.body.payload.outcome' <<<"$LINE")" "resolved outcome emitted"

# ── 5. fake claude leaves markers → treated as unresolved ───────────────────
echo "5. markers-remained is treated as a failure, not accepted"
git reset --quiet
git checkout --quiet -- f.txt 2>/dev/null || true
git merge main --quiet 2>/dev/null || true
cat > "$CATALYST_DISPATCH_CLAUDE_BIN" <<'EOF'
#!/usr/bin/env bash
# Fake resolver that "gives up": leaves conflict markers untouched.
exit 0
EOF
chmod +x "$CATALYST_DISPATCH_CLAUDE_BIN"
ORCH_ID=T1 TICKET=T1 PHASE=implement _ctl708_llm_resolve f.txt
assert_eq "1" "$?" "declines when markers remain"
LINE="$(last_event_line)"
assert_eq "markers-remained" "$(jq -r '.body.payload.outcome' <<<"$LINE")" "markers-remained outcome emitted"

# ── 6. claude binary missing → fails closed ──────────────────────────────────
echo "6. missing claude binary fails closed"
export CATALYST_DISPATCH_CLAUDE_BIN="$SCRATCH/does-not-exist"
ORCH_ID=T1 TICKET=T1 PHASE=implement _ctl708_llm_resolve f.txt
assert_eq "1" "$?" "fails closed when claude_bin not found"
LINE="$(last_event_line)"
assert_eq "failed" "$(jq -r '.body.payload.outcome' <<<"$LINE")" "failed outcome emitted"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]
