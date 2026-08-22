#!/usr/bin/env bash
# Cross-site guard: model-invoked skills and templates use worktree-safe merge (CTL-56).
# Asserts no live gh pr merge call carries --delete-branch, and that each file contains
# the checkout-free remote-ref delete pattern (git/refs/heads/ + --method DELETE).
# Run: bash plugins/dev/scripts/__tests__/merge-delete-branch-worktree-guard.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

assert_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" == *"$substr"* ]]; then pass "$label"
  else fail "$label — '$substr' not found"; fi
}

assert_not_contains() {
  local body="$1" substr="$2" label="$3"
  if [[ "$body" != *"$substr"* ]]; then pass "$label"
  else fail "$label — forbidden '$substr' present"; fi
}

# Files to check — add new call sites here as a one-line addition.
# CTL-2141: recovery-pass/SKILL.md removed (its judgment layer was deleted).
CHECKED_FILES=(
  "plugins/dev/skills/merge-pr/SKILL.md"
  "plugins/dev/skills/triage-aging-prs/SKILL.md"
  "plugins/dev/templates/followup-prompt.md"
  "plugins/dev/templates/fixup-prompt.md"
)

echo "CTL-56: model-invoked skills and templates — worktree-safe merge (cross-site)"
echo ""

for REL_FILE in "${CHECKED_FILES[@]}"; do
  FILE="${REPO_ROOT}/${REL_FILE}"
  LABEL="$(basename "$(dirname "$FILE")")/$(basename "$FILE")"
  echo "  ── ${LABEL}"
  if [[ -f "$FILE" ]]; then
    BODY="$(cat "$FILE")"
    assert_not_contains "$BODY" "--delete-branch" \
      "CTL-56: ${LABEL} drops --delete-branch (worktree-safe)"
    assert_contains "$BODY" "git/refs/heads/" \
      "CTL-56: ${LABEL} contains checkout-free remote-ref delete path"
    assert_contains "$BODY" "--method DELETE" \
      "CTL-56: ${LABEL} uses gh api --method DELETE for remote-ref cleanup"
  else
    fail "file missing: ${FILE}"
  fi
  echo ""
done

echo "CTL-56: merge-pr Step 11 — linked-worktree guard on local git checkout"
MERGE_PR="${REPO_ROOT}/plugins/dev/skills/merge-pr/SKILL.md"
if [[ -f "$MERGE_PR" ]]; then
  BODY="$(cat "$MERGE_PR")"
  assert_contains "$BODY" "git-common-dir" \
    "merge-pr Step 11 has linked-worktree guard (git-common-dir divergence check)"
  # CTL-56 remediation: both sides of the divergence check MUST be absolute, else the
  # guard misfires in the primary clone (--git-common-dir returns a RELATIVE .git there).
  # Pin the normalization so the fix cannot silently regress.
  assert_contains "$BODY" "path-format=absolute" \
    "merge-pr Step 11 normalizes git-common-dir to absolute (--path-format=absolute) before comparing"
else
  fail "merge-pr/SKILL.md missing: $MERGE_PR"
fi

echo ""
echo "CTL-56: automated merge sites gate branch delete on an executable REST .merged confirm"
# The presence checks above are false-green for a delete-BEFORE-confirm regression: a site that
# merges then unconditionally deletes still contains git/refs/heads/ + --method DELETE. The old
# atomic `--delete-branch` deleted ONLY on a successful merge; the split rewrite must preserve
# that with an EXECUTABLE `.merged` confirm (not a prose comment) before the delete, or a
# failed/unconfirmed merge orphans the PR's head ref. Assert the confirm token exists at each
# merge+delete site. (CTL-56 Codex round-1 P1: merge-pr was previously excluded as "interactive and
# human-gated", but human-gating gates the merge DECISION, not the merge-queue race — with a queue,
# `gh pr merge` enqueues and returns success and the next line would delete a still-open PR's head
# ref. So merge-pr now carries the executable `.merged` gate too.)
CONFIRM_GATED_FILES=(
  "plugins/dev/skills/merge-pr/SKILL.md"
  "plugins/dev/skills/triage-aging-prs/SKILL.md"
  "plugins/dev/templates/fixup-prompt.md"
  "plugins/dev/templates/followup-prompt.md"
)
for REL_FILE in "${CONFIRM_GATED_FILES[@]}"; do
  FILE="${REPO_ROOT}/${REL_FILE}"
  LABEL="$(basename "$(dirname "$FILE")")/$(basename "$FILE")"
  if [[ -f "$FILE" ]]; then
    BODY="$(cat "$FILE")"
    assert_contains "$BODY" ".merged" \
      "CTL-56: ${LABEL} gates branch delete on an executable REST .merged confirm (not a comment)"
  else
    fail "file missing: ${FILE}"
  fi
done

echo ""
echo "CTL-56: repo-wide invariant — no live gh pr merge call carries --delete-branch"

# Scan plugins/ for any 'gh pr merge' line that includes '--delete-branch'.
# Exclude: JSON schema description strings, HTML mockups, bash comments (#),
# test files (themselves may reference the flag for assertion labels), and
# generated CHANGELOGs.
#
# Why CHANGELOGs are excluded, and why the exclusion is this narrow: a release
# note DESCRIBING the removal ("The fix drops `--delete-branch` from all `gh pr
# merge` calls") carries both tokens in prose and was scanned as if it were a
# call site — a guard that cannot tell the thing from a description of the thing.
# Release-please generates these files and nothing ever executes them.
#
# The exclusion is by CHANGELOG filename, NOT by `.md`, deliberately: 32 live
# `gh pr merge` call sites in this repo live in `.md` files (SKILL.md bodies and
# prompt templates that agents execute verbatim). Excluding `*.md` would trade
# this false positive for a silent false negative across every one of them.
_scan_live_violators() {
  # $1 — root to scan. Kept a function so the positive control below runs the
  # SAME filter chain against a known-violating fixture.
  grep -rn -- '--delete-branch' "$1" 2>/dev/null \
    | grep 'gh pr merge' \
    | grep -v '\.json:' \
    | grep -v '\.html:' \
    | grep -v '\.test\.sh:' \
    | grep -v '/CHANGELOG\.md:' \
    | grep -v '^[^:]*:[[:space:]]*#' \
    || true
}
# NOTE the leading `/` on the CHANGELOG filter: it anchors the match to a path
# boundary so the exclusion covers ONLY a file whose basename is exactly
# `CHANGELOG.md`. Unanchored, the same filter would also drop a live instruction
# file named e.g. `NOT_CHANGELOG.md` or `PLUGIN_CHANGELOG.md`, and a real
# violation inside one would make this guard pass silently — reintroducing the
# false negative the narrow exclusion exists to avoid. The positive control below
# covers the prefixed-basename case explicitly.

REPO_ROOT_GUARD="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIVE_VIOLATORS="$(_scan_live_violators "${REPO_ROOT_GUARD}/plugins/")"
if [[ -z "$LIVE_VIOLATORS" ]]; then
  pass "no live gh pr merge call carries --delete-branch (repo-wide)"
else
  fail "live gh pr merge --delete-branch found (CTL-56 violation):
${LIVE_VIOLATORS}"
fi

# POSITIVE CONTROL (CTL-1801). The check above concludes from an EMPTY result,
# so it passes identically whether the repo is clean or the scan is broken —
# exactly the failure mode that let a too-broad exclusion disable a guard
# silently. Prove the instrument can still see a true positive: build a fixture
# that genuinely violates the invariant and assert the same filter chain flags
# it. If a future edit over-excludes (e.g. dropping all `*.md`), this fails.
CONTROL_DIR="$(mktemp -d)"
trap 'rm -rf "${CONTROL_DIR}"' EXIT
mkdir -p "${CONTROL_DIR}/skills/fixture"
cat >"${CONTROL_DIR}/skills/fixture/SKILL.md" <<'CONTROL_EOF'
Merge the pull request:

```bash
gh pr merge "$PR_NUMBER" --squash --delete-branch
```
CONTROL_EOF
# ...a CHANGELOG that only DESCRIBES the flag, which must NOT be flagged...
cat >"${CONTROL_DIR}/CHANGELOG.md" <<'CONTROL_EOF'
### Worktree-Safe PR Merge

The fix drops `--delete-branch` from all `gh pr merge` calls.
CONTROL_EOF
# ...and a live instruction file whose basename merely ENDS WITH the excluded
# one. An unanchored `CHANGELOG.md:` filter would drop this too, letting a real
# violation through silently.
cat >"${CONTROL_DIR}/skills/fixture/NOT_CHANGELOG.md" <<'CONTROL_EOF'
Merge it:

```bash
gh pr merge "$PR_NUMBER" --squash --delete-branch
```
CONTROL_EOF

CONTROL_HITS="$(_scan_live_violators "${CONTROL_DIR}")"
if grep -q 'SKILL\.md' <<<"${CONTROL_HITS}"; then
  pass "positive control: the scan still detects a real .md call site"
else
  fail "positive control FAILED — the scan no longer detects a known violation, so its
clean result above is not evidence. Filter chain output was:
${CONTROL_HITS}"
fi
if grep -q 'NOT_CHANGELOG\.md' <<<"${CONTROL_HITS}"; then
  pass "positive control: the CHANGELOG exclusion is anchored to the exact basename"
else
  fail "positive control FAILED — a violation in NOT_CHANGELOG.md was swallowed by an
unanchored CHANGELOG filter. Filter chain output was:
${CONTROL_HITS}"
fi
if grep -qE '(^|/)CHANGELOG\.md' <<<"${CONTROL_HITS}"; then
  fail "negative control FAILED — prose in a CHANGELOG was scanned as a call site:
${CONTROL_HITS}"
else
  pass "negative control: CHANGELOG prose is not scanned as a call site"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "merge-delete-branch-worktree-guard: ${PASSES} passed, ${FAILURES} failed"
echo "─────────────────────────────────────────────"
[[ $FAILURES -eq 0 ]]
