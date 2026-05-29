#!/usr/bin/env bash
# Tests for the phase-pr skill — CTL-714 already-merged detection guard.
#
# These tests verify:
#   Suite A — SKILL.md contract: the detection section + fence + skip block
#             are present with the correct strings.
#   Suite B — Detection fence behavior: extracted fence executes correctly
#             against scratch git repos in ancestor/non-ancestor states,
#             plus the gh-stubbed merged-PR recovery path.
#
# Run: bash plugins/dev/scripts/__tests__/phase-pr-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL="${REPO_ROOT}/plugins/dev/skills/phase-pr/SKILL.md"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t phase-pr-e2e-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

assert_eq()          { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 — expected '$1', got '$2'"; }
assert_contains()    { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 — '$2' not found"; }
assert_not_contains(){ [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 — '$2' unexpectedly present"; }
assert_file_exists() { [[ -f "$1" ]] && pass "$2" || fail "$2 — file missing: $1"; }

# Extract a uniquely-named bash fence from a SKILL.md.
# $1 = fence label (e.g. phase-pr-already-merged-detect), $2 = skill file
extract_fence() {
  awk -v label="$1" '
    $0 ~ "^```bash[ \t]+" label "[ \t]*$" {grab=1; next}
    grab && /^```[ \t]*$/ {grab=0}
    grab {print}
  ' "$2"
}

# ─── Suite A: SKILL.md contract ──────────────────────────────────────────────
echo "Suite A: phase-pr SKILL.md contract (CTL-714 already-merged detection)"

assert_file_exists "$SKILL" "SKILL.md exists at plugins/dev/skills/phase-pr/SKILL.md"

if [[ -f "$SKILL" ]]; then
  BODY="$(cat "$SKILL")"

  assert_contains "$BODY" "Already-merged detection" \
    "SKILL.md has the already-merged detection section (CTL-714)"
  assert_contains "$BODY" "phase-pr-already-merged-detect" \
    "SKILL.md has the uniquely-named detection fence"
  assert_contains "$BODY" "merge-base --is-ancestor" \
    "detection uses git merge-base --is-ancestor HEAD origin/main"
  assert_contains "$BODY" "git fetch origin main" \
    "detection fetches origin/main first (worktree ref can lag)"
  assert_contains "$BODY" "--state merged" \
    "detection checks gh pr list --state merged (open-only gotcha — research §3)"
  assert_contains "$BODY" "already-merged-to-main" \
    "skip path writes attentionReason=already-merged-to-main"
  assert_contains "$BODY" "ALREADY_MERGED" \
    "detection sets the ALREADY_MERGED flag the skip block gates on"
  assert_contains "$BODY" ".pr = {number:" \
    "skip path writes .pr = {number, url} into the signal file (work-done-probes.mjs:171)"
  assert_contains "$BODY" "--status complete" \
    "skip path emits --status complete (code is in main — research §7)"
fi

# ─── Suite B: detection fence behavior ───────────────────────────────────────
echo ""
echo "Suite B: phase-pr-already-merged-detect fence behavior"

FENCE_FILE="${SCRATCH}/detect-fence.sh"
extract_fence "phase-pr-already-merged-detect" "$SKILL" > "$FENCE_FILE"

if [[ -s "$FENCE_FILE" ]]; then
  pass "detection fence extractable from SKILL.md"
else
  fail "detection fence extractable — no phase-pr-already-merged-detect fence found in SKILL.md"
fi

if [[ -f "$FENCE_FILE" ]]; then
  FENCE_BODY="$(cat "$FENCE_FILE")"
  assert_not_contains "$FENCE_BODY" "exit " \
    "detection fence has no 'exit' (must be side-effect-free for sourcing)"
  assert_not_contains "$FENCE_BODY" "emit-complete" \
    "detection fence has no 'emit-complete' (side-effect-free)"
fi

# ─── Scratch repo builders ────────────────────────────────────────────────────

# Creates a repo where HEAD == origin/main (already merged scenario).
build_merged_repo() {
  local repo_dir="$1"
  local bare_dir="${repo_dir}-bare.git"
  mkdir -p "$repo_dir"
  git init --quiet "$bare_dir" --bare
  (
    cd "$repo_dir" || exit 1
    git init --quiet
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "base" > base.txt
    git add base.txt
    git commit --quiet -m "base commit"
    git remote add origin "$bare_dir"
    git push --quiet origin HEAD:main
  )
}

# Creates a repo where HEAD is ahead of origin/main (not merged yet).
build_ahead_repo() {
  local repo_dir="$1"
  local bare_dir="${repo_dir}-bare.git"
  mkdir -p "$repo_dir"
  git init --quiet "$bare_dir" --bare
  (
    cd "$repo_dir" || exit 1
    git init --quiet
    git config user.email "test@example.com"
    git config user.name "Test"
    echo "base" > base.txt
    git add base.txt
    git commit --quiet -m "base commit"
    git remote add origin "$bare_dir"
    git push --quiet origin HEAD:main
    echo "change" > change.txt
    git add change.txt
    git commit --quiet -m "feat: additional commit"
  )
}

# Installs a gh stub that returns pr_list_json for `gh pr list` calls.
# Uses unquoted heredoc so ${pr_list_json} expands at install time.
install_gh_stub() {
  local bin_dir="$1"
  local pr_list_json="${2:-[]}"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/gh" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == "pr" && "\$2" == "list" ]]; then
  printf '%s\n' '${pr_list_json}'
else
  printf '%s\n' '[]'
fi
STUB
  chmod +x "$bin_dir/gh"
}

# Sources the detection fence in the given repo with the gh stub on PATH.
# Writes "ALREADY_MERGED=<val>" and "MERGED_PR_NUMBER=<val>" lines to output_file.
run_detection_fence() {
  local repo_dir="$1"
  local stub_bin="$2"
  local output_file="$3"
  (
    cd "$repo_dir" || exit 1
    export PATH="${stub_bin}:${PATH}"
    set +e
    # shellcheck disable=SC1090
    source "$FENCE_FILE" 2>/dev/null
    echo "ALREADY_MERGED=${ALREADY_MERGED:-0}"
    echo "MERGED_PR_NUMBER=${MERGED_PR_NUMBER:-}"
  ) > "$output_file" 2>/dev/null
}

# ─── Test B1: HEAD in origin/main → ALREADY_MERGED=1 ────────────────────────
echo ""
echo "Test B1: branch already contained in origin/main → ALREADY_MERGED=1"

if [[ -s "$FENCE_FILE" ]]; then
  B1_REPO="${SCRATCH}/b1-repo"
  B1_BIN="${SCRATCH}/b1-bin"
  B1_OUT="${SCRATCH}/b1-out.txt"

  build_merged_repo "$B1_REPO"
  install_gh_stub "$B1_BIN" "[]"
  run_detection_fence "$B1_REPO" "$B1_BIN" "$B1_OUT"

  B1_AM="$(grep '^ALREADY_MERGED=' "$B1_OUT" 2>/dev/null | cut -d= -f2)"
  assert_eq "1" "${B1_AM:-}" "HEAD in origin/main (rescue) ⇒ ALREADY_MERGED=1"
else
  fail "B1 skipped — fence not extractable"
fi

# ─── Test B2: HEAD ahead of origin/main → ALREADY_MERGED=0 ──────────────────
echo ""
echo "Test B2: HEAD ahead of origin/main → ALREADY_MERGED=0"

if [[ -s "$FENCE_FILE" ]]; then
  B2_REPO="${SCRATCH}/b2-repo"
  B2_BIN="${SCRATCH}/b2-bin"
  B2_OUT="${SCRATCH}/b2-out.txt"

  build_ahead_repo "$B2_REPO"
  install_gh_stub "$B2_BIN" "[]"
  run_detection_fence "$B2_REPO" "$B2_BIN" "$B2_OUT"

  B2_AM="$(grep '^ALREADY_MERGED=' "$B2_OUT" 2>/dev/null | cut -d= -f2)"
  assert_eq "0" "${B2_AM:-}" "HEAD ahead of origin/main ⇒ ALREADY_MERGED=0"
else
  fail "B2 skipped — fence not extractable"
fi

# ─── Test B3: merged PR found via gh → ALREADY_MERGED=1, MERGED_PR_NUMBER set ─
echo ""
echo "Test B3: merged PR returned by gh → ALREADY_MERGED=1, MERGED_PR_NUMBER=1170"

if [[ -s "$FENCE_FILE" ]]; then
  B3_REPO="${SCRATCH}/b3-repo"
  B3_BIN="${SCRATCH}/b3-bin"
  B3_OUT="${SCRATCH}/b3-out.txt"

  build_ahead_repo "$B3_REPO"
  install_gh_stub "$B3_BIN" '[{"number":1170,"url":"https://github.com/x/y/pull/1170"}]'
  run_detection_fence "$B3_REPO" "$B3_BIN" "$B3_OUT"

  B3_AM="$(grep '^ALREADY_MERGED=' "$B3_OUT" 2>/dev/null | cut -d= -f2)"
  B3_NUM="$(grep '^MERGED_PR_NUMBER=' "$B3_OUT" 2>/dev/null | cut -d= -f2)"
  assert_eq "1" "${B3_AM:-}" "merged PR in gh ⇒ ALREADY_MERGED=1"
  assert_eq "1170" "${B3_NUM:-}" "merged PR in gh ⇒ MERGED_PR_NUMBER=1170"
else
  fail "B3 skipped — fence not extractable"
fi

# ─── CTL-709 Suite A: existing-PR detection fence contract ───────────────────
echo ""
echo "CTL-709 Suite A: phase-pr-existing-pr-detect fence contract"

if [[ -f "$SKILL" ]]; then
  BODY="$(cat "$SKILL")"

  assert_contains "$BODY" "phase-pr-existing-pr-detect" \
    "CTL-709 A1: SKILL.md has uniquely-named phase-pr-existing-pr-detect fence"
  assert_contains "$BODY" "EXISTING_PR_NUMBER" \
    "CTL-709 A2: detection fence sets EXISTING_PR_NUMBER"
  assert_contains "$BODY" "EXISTING_PR_IS_DRAFT" \
    "CTL-709 A3: detection fence sets EXISTING_PR_IS_DRAFT"
  # Detection fence must be side-effect-free (no exit, no emit-complete).
  DETECT_FENCE_CTL709="${SCRATCH}/ctl709-detect-fence.sh"
  extract_fence "phase-pr-existing-pr-detect" "$SKILL" > "$DETECT_FENCE_CTL709"
  if [[ -s "$DETECT_FENCE_CTL709" ]]; then
    pass "CTL-709 A4: detection fence extractable from SKILL.md"
    DETECT_FENCE_BODY="$(cat "$DETECT_FENCE_CTL709")"
    assert_not_contains "$DETECT_FENCE_BODY" "exit " \
      "CTL-709 A5: detection fence is side-effect-free (no 'exit')"
    assert_not_contains "$DETECT_FENCE_BODY" "emit-complete" \
      "CTL-709 A6: detection fence has no emit-complete"
  else
    fail "CTL-709 A4: detection fence extractable — no phase-pr-existing-pr-detect fence found"
  fi

  # The detection fence must appear AFTER already-merged-detect and BEFORE phase-specific work.
  LINE_MERGED=$(grep -n 'phase-pr-already-merged-detect' "$SKILL" | head -1 | cut -d: -f1)
  LINE_DETECT=$(grep -n 'phase-pr-existing-pr-detect' "$SKILL" | head -1 | cut -d: -f1)
  LINE_PHASE_WORK=$(grep -n '## Phase-specific work' "$SKILL" | head -1 | cut -d: -f1)
  if [[ -n "$LINE_MERGED" && -n "$LINE_DETECT" && -n "$LINE_PHASE_WORK" ]]; then
    if [[ "$LINE_DETECT" -gt "$LINE_MERGED" ]]; then
      pass "CTL-709 A7: existing-PR detect is AFTER already-merged detect ($LINE_DETECT > $LINE_MERGED)"
    else
      fail "CTL-709 A7: existing-PR detect must be AFTER already-merged ($LINE_DETECT <= $LINE_MERGED)"
    fi
    if [[ "$LINE_DETECT" -lt "$LINE_PHASE_WORK" ]]; then
      pass "CTL-709 A8: existing-PR detect is BEFORE ## Phase-specific work ($LINE_DETECT < $LINE_PHASE_WORK)"
    else
      fail "CTL-709 A8: existing-PR detect must be BEFORE Phase-specific work ($LINE_DETECT >= $LINE_PHASE_WORK)"
    fi
  else
    fail "CTL-709 A7/A8: anchors missing (merged=$LINE_MERGED detect=$LINE_DETECT work=$LINE_PHASE_WORK)"
  fi

  # Promote path: SKILL.md must call draft_pr_promote or gh pr ready.
  if echo "$BODY" | grep -qE 'draft_pr_promote|gh pr ready'; then
    pass "CTL-709 A9: promote path calls draft_pr_promote or gh pr ready"
  else
    fail "CTL-709 A9: promote path must call draft_pr_promote or gh pr ready"
  fi

  # The create-pr delegation must be conditional (only when no existing PR).
  assert_contains "$BODY" "EXISTING_PR_NUMBER" \
    "CTL-709 A10: create-pr delegation is gated on EXISTING_PR_NUMBER"
fi

# ─── CTL-709 Suite B: detection fence behavior ────────────────────────────────
echo ""
echo "CTL-709 Suite B: phase-pr-existing-pr-detect fence behavior"

DETECT_FENCE_FILE="${SCRATCH}/ctl709-detect-b.sh"
extract_fence "phase-pr-existing-pr-detect" "$SKILL" > "$DETECT_FENCE_FILE"

if [[ ! -s "$DETECT_FENCE_FILE" ]]; then
  fail "CTL-709 B: skipped — detection fence not yet extractable"
else
  pass "CTL-709 B0: detection fence extractable for behavior tests"

  # Install a gh stub that controls pr view behavior.
  # $1 = bin_dir, $2 = log_file, $3 = pr_view_json (empty → exit 1)
  install_gh_detect_stub() {
    local bin_dir="$1" log_file="$2" pr_json="${3:-}"
    mkdir -p "$bin_dir"
    cat > "${bin_dir}/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "${log_file}"
if [[ "\$1" == "pr" && "\$2" == "view" ]]; then
  [[ -z '${pr_json}' ]] && exit 1
  printf '%s\n' '${pr_json}'
  exit 0
fi
exit 0
STUB
    chmod +x "${bin_dir}/gh"
  }

  # B1: open draft PR exists → EXISTING_PR_NUMBER set, EXISTING_PR_IS_DRAFT=true
  echo ""
  echo "CTL-709 B1: open draft PR exists → EXISTING_PR_NUMBER set, EXISTING_PR_IS_DRAFT=true"
  B1_BIN="${SCRATCH}/ctl709-b1-bin"
  B1_LOG="${SCRATCH}/ctl709-b1.log"
  B1_OUT="${SCRATCH}/ctl709-b1-out.txt"
  install_gh_detect_stub "$B1_BIN" "$B1_LOG" '{"number":77,"url":"https://github.com/t/r/pull/77","state":"OPEN","isDraft":true}'
  (
    cd "${SCRATCH}" || exit 1
    PATH="${B1_BIN}:${PATH}"
    set +e
    source "$DETECT_FENCE_FILE" 2>/dev/null
    echo "EXISTING_PR_NUMBER=${EXISTING_PR_NUMBER:-}"
    echo "EXISTING_PR_IS_DRAFT=${EXISTING_PR_IS_DRAFT:-}"
  ) > "$B1_OUT" 2>/dev/null
  B1_NUM="$(grep '^EXISTING_PR_NUMBER=' "$B1_OUT" | cut -d= -f2)"
  B1_DRAFT="$(grep '^EXISTING_PR_IS_DRAFT=' "$B1_OUT" | cut -d= -f2)"
  assert_eq "77" "$B1_NUM" "CTL-709 B1: open draft PR → EXISTING_PR_NUMBER=77"
  assert_eq "true" "$B1_DRAFT" "CTL-709 B1: open draft PR → EXISTING_PR_IS_DRAFT=true"

  # B2: open non-draft PR exists → number set, draft=false
  echo "CTL-709 B2: open non-draft PR exists → number set, isDraft=false"
  B2_BIN="${SCRATCH}/ctl709-b2-bin"
  B2_LOG="${SCRATCH}/ctl709-b2.log"
  B2_OUT="${SCRATCH}/ctl709-b2-out.txt"
  install_gh_detect_stub "$B2_BIN" "$B2_LOG" '{"number":88,"url":"https://github.com/t/r/pull/88","state":"OPEN","isDraft":false}'
  (
    cd "${SCRATCH}" || exit 1
    PATH="${B2_BIN}:${PATH}"
    set +e
    source "$DETECT_FENCE_FILE" 2>/dev/null
    echo "EXISTING_PR_NUMBER=${EXISTING_PR_NUMBER:-}"
    echo "EXISTING_PR_IS_DRAFT=${EXISTING_PR_IS_DRAFT:-}"
  ) > "$B2_OUT" 2>/dev/null
  B2_NUM="$(grep '^EXISTING_PR_NUMBER=' "$B2_OUT" | cut -d= -f2)"
  B2_DRAFT="$(grep '^EXISTING_PR_IS_DRAFT=' "$B2_OUT" | cut -d= -f2)"
  assert_eq "88" "$B2_NUM" "CTL-709 B2: open non-draft PR → EXISTING_PR_NUMBER=88"
  assert_eq "false" "$B2_DRAFT" "CTL-709 B2: open non-draft PR → EXISTING_PR_IS_DRAFT=false"

  # B3: no open PR → EXISTING_PR_NUMBER empty (falls through to create-pr)
  echo "CTL-709 B3: no open PR → EXISTING_PR_NUMBER empty"
  B3_BIN="${SCRATCH}/ctl709-b3-bin"
  B3_LOG="${SCRATCH}/ctl709-b3.log"
  B3_OUT="${SCRATCH}/ctl709-b3-out.txt"
  install_gh_detect_stub "$B3_BIN" "$B3_LOG" ""
  (
    cd "${SCRATCH}" || exit 1
    PATH="${B3_BIN}:${PATH}"
    set +e
    source "$DETECT_FENCE_FILE" 2>/dev/null
    echo "EXISTING_PR_NUMBER=${EXISTING_PR_NUMBER:-}"
  ) > "$B3_OUT" 2>/dev/null
  B3_NUM="$(grep '^EXISTING_PR_NUMBER=' "$B3_OUT" | cut -d= -f2)"
  if [[ -z "$B3_NUM" ]]; then
    pass "CTL-709 B3: no open PR → EXISTING_PR_NUMBER empty"
  else
    fail "CTL-709 B3: no open PR → EXISTING_PR_NUMBER should be empty (got '$B3_NUM')"
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "phase-pr-e2e: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -gt 0 ]] && exit 1
exit 0
