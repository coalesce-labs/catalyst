#!/usr/bin/env bash
# Tests for check-marketplace-drift.sh.
# Run: bash plugins/dev/scripts/__tests__/check-marketplace-drift.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DRIFT="${REPO_ROOT}/plugins/dev/scripts/check-marketplace-drift.sh"

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

expect_contains() {
  local file="$1" needle="$2"
  grep -qF -- "$needle" "$file" || { echo "    missing: $needle"; return 1; }
}

expect_not_contains() {
  local file="$1" needle="$2"
  if grep -qF -- "$needle" "$file"; then
    echo "    unexpected: $needle"
    return 1
  fi
}

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  set -e
  if [ "$rc" = "$expected" ]; then
    return 0
  else
    echo "    expected rc=$expected got rc=$rc"
    sed 's/^/    /' "${SCRATCH}/out"
    return 1
  fi
}

# Build a tiny fake Catalyst checkout with its own `origin` remote.
#   make_catalyst_repo <path>          — catalyst checkout + origin bare repo
#   add_remote_commits <path> <count>  — push <count> new commits to origin/main
make_catalyst_repo() {
  local dir="$1"
  local origin="${dir}.origin.git"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email test@test
  git -C "$dir" config user.name test
  mkdir -p "$dir/.claude-plugin"
  echo '{"name":"catalyst"}' > "$dir/.claude-plugin/marketplace.json"
  git -C "$dir" add .
  git -C "$dir" -c commit.gpgsign=false commit -q -m "initial"
  git init -q --bare -b main "$origin"
  git -C "$dir" remote add origin "$origin"
  git -C "$dir" push -q origin main
}

add_remote_commits() {
  local dir="$1" count="$2"
  local origin="${dir}.origin.git"
  local tmp="${dir}.push"
  rm -rf "$tmp"
  git clone -q "$origin" "$tmp"
  git -C "$tmp" config user.email test@test
  git -C "$tmp" config user.name test
  local i
  for ((i = 1; i <= count; i++)); do
    echo "drift-$i" > "$tmp/drift-$i.txt"
    git -C "$tmp" add .
    git -C "$tmp" -c commit.gpgsign=false commit -q -m "drift $i"
  done
  git -C "$tmp" push -q origin main
  rm -rf "$tmp"
}

# Backdate the most recent commit on origin/main so age-based drift fires.
# Uses commit-tree to rewrite with a past committer/author date.
backdate_origin_head() {
  local dir="$1" seconds_ago="$2"
  local origin="${dir}.origin.git"
  local past_ts
  past_ts=$(( $(date +%s) - seconds_ago ))
  local past_iso
  past_iso=$(date -u -r "$past_ts" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "@$past_ts" +"%Y-%m-%dT%H:%M:%SZ")
  local tmp="${dir}.backdate"
  rm -rf "$tmp"
  git clone -q "$origin" "$tmp"
  git -C "$tmp" config user.email test@test
  git -C "$tmp" config user.name test
  echo "old" > "$tmp/old.txt"
  git -C "$tmp" add .
  GIT_AUTHOR_DATE="$past_iso" GIT_COMMITTER_DATE="$past_iso" \
    git -C "$tmp" -c commit.gpgsign=false commit -q -m "old drift"
  git -C "$tmp" push -q origin main
  rm -rf "$tmp"
}

write_registry() {
  local path="$1" entries="$2"
  cat > "$path" <<EOF
$entries
EOF
}

echo "check-marketplace-drift tests"

# ── 1. missing registry → exit 0, silent ───────────────────────────────────
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/missing.json"
rm -f "$KNOWN_MARKETPLACES_FILE"
run "missing registry exits 0" expect_exit 0 bash "$DRIFT"
run "missing registry is silent" bash -c "
  out=\$(bash '$DRIFT' 2>&1)
  [ -z \"\$out\" ]
"

# ── 2. empty registry → exit 0 ─────────────────────────────────────────────
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/empty.json"
write_registry "$KNOWN_MARKETPLACES_FILE" '{}'
run "empty registry exits 0" expect_exit 0 bash "$DRIFT"

# ── 3. only github entries → exit 0, no output ─────────────────────────────
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/github-only.json"
write_registry "$KNOWN_MARKETPLACES_FILE" '{
  "foo": {"source": {"source": "github", "repo": "x/y"}}
}'
run "only github entries exits 0" expect_exit 0 bash "$DRIFT"
run "only github entries produces no output" bash -c "
  out=\$(bash '$DRIFT' 2>&1)
  [ -z \"\$out\" ]
"

# ── 4. directory entry pointing at non-Catalyst dir → ignored ──────────────
NON_CAT="${SCRATCH}/not-catalyst"
mkdir -p "$NON_CAT"
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/non-cat.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$NON_CAT" '{foo: {source: {source: "directory", path: $p}}}')"
run "non-catalyst directory ignored" expect_exit 0 bash "$DRIFT"
run "non-catalyst directory produces no output" bash -c "
  out=\$(bash '$DRIFT' 2>&1)
  [ -z \"\$out\" ]
"

# ── 5. healthy catalyst checkout (0 behind) → exit 0, ✅ line ──────────────
HEALTHY="${SCRATCH}/healthy"
make_catalyst_repo "$HEALTHY"
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/healthy.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$HEALTHY" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "healthy exits 0" expect_exit 0 bash "$DRIFT"
run "healthy prints up-to-date" bash -c "
  bash '$DRIFT' 2>&1 | grep -qE '✅.*up.to.date|✅.*in sync|✅.*0 commits'
"

# ── 6. drifted by commits → exit 1, warn mentions count ────────────────────
DRIFTED="${SCRATCH}/drifted"
make_catalyst_repo "$DRIFTED"
add_remote_commits "$DRIFTED" 6
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/drifted.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$DRIFTED" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "commit-drifted exits 1" expect_exit 1 bash "$DRIFT"
run "commit-drifted mentions 6 commits" bash -c "
  out=\$(bash '$DRIFT' 2>&1)
  echo \"\$out\" | grep -q '⚠️' && echo \"\$out\" | grep -q '6 commit'
"

# ── 7. drifted by age but only 2 commits → exit 1, warns on age ────────────
AGED="${SCRATCH}/aged"
make_catalyst_repo "$AGED"
backdate_origin_head "$AGED" 172800  # 48h ago
add_remote_commits "$AGED" 1
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/aged.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$AGED" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "age-drifted exits 1" expect_exit 1 bash "$DRIFT"
run "age-drifted mentions hours" bash -c "
  out=\$(bash '$DRIFT' 2>&1)
  echo \"\$out\" | grep -q '⚠️' && echo \"\$out\" | grep -qE 'hour|stale'
"

# ── 8. linked worktree registration → warn ─────────────────────────────────
MAIN_CHK="${SCRATCH}/linked-main"
make_catalyst_repo "$MAIN_CHK"
LINKED_WT="${SCRATCH}/linked-wt"
git -C "$MAIN_CHK" worktree add -q -b feature "$LINKED_WT" 2>/dev/null
# Link-target also needs .claude-plugin/marketplace.json to count as catalyst checkout.
mkdir -p "$LINKED_WT/.claude-plugin"
echo '{"name":"catalyst"}' > "$LINKED_WT/.claude-plugin/marketplace.json"
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/linked.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$LINKED_WT" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "linked-worktree exits 1" expect_exit 1 bash "$DRIFT"
run "linked-worktree warns about worktree" bash -c "
  out=\$(bash '$DRIFT' 2>&1)
  echo \"\$out\" | grep -q '⚠️' && echo \"\$out\" | grep -qi 'worktree'
"

# ── 9. directory with marketplace.json but no .git → warn ──────────────────
NOGIT="${SCRATCH}/nogit"
mkdir -p "$NOGIT/.claude-plugin"
echo '{"name":"catalyst"}' > "$NOGIT/.claude-plugin/marketplace.json"
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/nogit.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$NOGIT" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "no-git-repo exits 1" expect_exit 1 bash "$DRIFT"
run "no-git-repo warns" bash -c "
  bash '$DRIFT' 2>&1 | grep -q '⚠️'
"

# ── 9b. catalyst checkout with no 'origin' remote → warn ───────────────────
NO_ORIGIN="${SCRATCH}/no-origin"
mkdir -p "$NO_ORIGIN"
git -C "$NO_ORIGIN" init -q -b main
git -C "$NO_ORIGIN" config user.email test@test
git -C "$NO_ORIGIN" config user.name test
mkdir -p "$NO_ORIGIN/.claude-plugin"
echo '{"name":"catalyst"}' > "$NO_ORIGIN/.claude-plugin/marketplace.json"
git -C "$NO_ORIGIN" add .
git -C "$NO_ORIGIN" -c commit.gpgsign=false commit -q -m "initial"
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/no-origin.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$NO_ORIGIN" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "no-origin exits 1" expect_exit 1 bash "$DRIFT"
run "no-origin warns" bash -c "
  bash '$DRIFT' 2>&1 | grep -q '⚠️' && bash '$DRIFT' 2>&1 | grep -qi 'origin'
"

# ── 9c. catalyst checkout whose origin is unreachable → warn, not silent ───
UNREACHABLE="${SCRATCH}/unreachable"
mkdir -p "$UNREACHABLE"
git -C "$UNREACHABLE" init -q -b main
git -C "$UNREACHABLE" config user.email test@test
git -C "$UNREACHABLE" config user.name test
mkdir -p "$UNREACHABLE/.claude-plugin"
echo '{"name":"catalyst"}' > "$UNREACHABLE/.claude-plugin/marketplace.json"
git -C "$UNREACHABLE" add .
git -C "$UNREACHABLE" -c commit.gpgsign=false commit -q -m "initial"
# Point origin at a non-existent local path so fetch deterministically fails offline.
git -C "$UNREACHABLE" remote add origin "$SCRATCH/nonexistent.git"
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/unreachable.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$UNREACHABLE" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "unreachable-origin exits 1" expect_exit 1 bash "$DRIFT"
run "unreachable-origin warns (not silent green)" bash -c "
  bash '$DRIFT' 2>&1 | grep -q '⚠️'
"

# ── 10. missing jq → exit 2 ────────────────────────────────────────────────
FAKE_PATH_DIR="$SCRATCH/nojq"
mkdir -p "$FAKE_PATH_DIR"
# Populate only the binaries we need, deliberately excluding jq.
for bin in bash sh git date mktemp grep sed awk cat cut head tail sort tr rm mkdir readlink dirname realpath env; do
  if command -v "$bin" >/dev/null 2>&1; then
    ln -sf "$(command -v "$bin")" "$FAKE_PATH_DIR/$bin"
  fi
done
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/empty.json"
run "missing jq exits 2" bash -c "PATH='$FAKE_PATH_DIR' bash '$DRIFT' >/dev/null 2>&1; [ \$? = 2 ]"

# ── 11. --quiet suppresses ✅ but still warns ──────────────────────────────
export KNOWN_MARKETPLACES_FILE="${SCRATCH}/healthy.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$HEALTHY" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "--quiet suppresses healthy line" bash -c "
  out=\$(bash '$DRIFT' --quiet 2>&1)
  [ -z \"\$out\" ]
"

export KNOWN_MARKETPLACES_FILE="${SCRATCH}/drifted.json"
write_registry "$KNOWN_MARKETPLACES_FILE" "$(jq -n --arg p "$DRIFTED" '{catalyst: {source: {source: "directory", path: $p}}}')"
run "--quiet still prints warnings" bash -c "
  bash '$DRIFT' --quiet 2>&1 | grep -q '⚠️'
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
