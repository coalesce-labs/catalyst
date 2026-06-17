#!/usr/bin/env bash
# Tests for audit-thoughts-pollution.sh (CTL-1246, Phase 1).
# Hermetic — builds fixture thoughts checkouts with mktemp -d + `git init`, no
# network, no real `gh`. Asserts the path-prefix classification (MOVE / LEAVE /
# REVERSE) and the JSONL manifest schema. The discriminator under test is the
# `repos/<subdir>/` PATH PREFIX, never content keywords (CTL- / catalyst / ADV-).
#
# Run: bash plugins/dev/scripts/__tests__/audit-thoughts-pollution.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
AUDIT="${SCRIPTS_DIR}/audit-thoughts-pollution.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASSES=$((PASSES + 1)); echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $label"
    echo "    expected: $expected"; echo "    actual:   $actual"
  fi
}
assert_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    PASSES=$((PASSES + 1)); echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $label"
    echo "    expected substring: $pattern"
    echo "$output" | head -40 | sed 's/^/      /'
  fi
}
assert_not_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $label (unexpected pattern found)"
    echo "    unexpected substring: $pattern"
  else
    PASSES=$((PASSES + 1)); echo "  PASS: $label"
  fi
}

# Local git that never touches the user's config / signing / hooks.
git_q() { git -c init.defaultBranch=main -c user.email=t@t -c user.name=t \
            -c commit.gpgsign=false "$@"; }

# Build a thoughts checkout at $1 with a set of "path<TAB>content" rows (stdin),
# then commit. Returns the repo dir.
build_repo() {
  local dir="$1"; shift
  mkdir -p "$dir"
  git_q -C "$dir" init -q
  while IFS=$'\t' read -r relpath content; do
    [[ -z "$relpath" ]] && continue
    mkdir -p "$dir/$(dirname "$relpath")"
    printf '%s\n' "$content" > "$dir/$relpath"
  done
  git_q -C "$dir" add -A
  git_q -C "$dir" commit -q -m "seed"
}

echo "=== audit-thoughts-pollution.sh hermetic tests ==="
echo "SCRIPT: $AUDIT"
echo "SCRATCH: $SCRATCH"
echo ""

# ─── Fixture A — a rightsite-cloud (NON coalesce-labs) thoughts checkout ──────
echo "=== Fixture A: rightsite-cloud checkout — catalyst subdirs are MOVE ==="
REPO_A="$SCRATCH/rightsite-cloud/thoughts"
build_repo "$REPO_A" <<EOF
repos/Adva/shared/friction/ADV-1263.md	legit Adva work but mentions CTL-999 and catalyst in the body
repos/Adva/shared/handoffs/o-adv-1.md	legit Adva handoff
repos/catalyst-workspace/shared/plans/p.md	TRUE misroute — catalyst plan in the wrong repo
repos/catalyst/shared/research/r.md	TRUE misroute — catalyst research in the wrong repo
EOF

A_OUT="$("$AUDIT" --root "$REPO_A" --org rightsite-cloud 2>/dev/null)"
A_ERR="$("$AUDIT" --root "$REPO_A" --org rightsite-cloud 2>&1 >/dev/null)"

# Exactly the two repos/catalyst*/ files are MOVE.
A_MOVE_PATHS="$(jq -r 'select(.classification=="MOVE") | .path' <<<"$A_OUT" | sort | tr '\n' ' ')"
assert_eq "A: exactly the two catalyst-subdir files are MOVE" \
  "$A_MOVE_PATHS" \
  "repos/catalyst-workspace/shared/plans/p.md repos/catalyst/shared/research/r.md "

A_MOVE_COUNT="$(jq -rs '[.[] | select(.classification=="MOVE")] | length' <<<"$A_OUT")"
assert_eq "A: MOVE count is exactly 2" "$A_MOVE_COUNT" "2"

# Adva files (even with CTL-/catalyst content) are NEVER MOVE.
assert_not_grep "A: repos/Adva/.../ADV-1263.md never classified MOVE" \
  "$A_OUT" 'repos/Adva/shared/friction/ADV-1263.md","classification":"MOVE"'
A_ADVA_MOVE="$(jq -rs '[.[] | select(.classification=="MOVE") | select(.path|test("repos/Adva/"))] | length' <<<"$A_OUT")"
assert_eq "A: zero Adva files in the MOVE set despite CTL-/catalyst keywords" "$A_ADVA_MOVE" "0"

# JSONL schema: every record has {path, classification, repo, org, reason}.
A_SCHEMA_OK="$(jq -rs 'all(.[]; has("path") and has("classification") and has("repo") and has("org") and has("reason")) ' <<<"$A_OUT")"
assert_eq "A: every JSONL record has the full schema {path,classification,repo,org,reason}" \
  "$A_SCHEMA_OK" "true"
assert_eq "A: repo field is the repos/<subdir> segment" \
  "$(jq -r 'select(.path=="repos/catalyst-workspace/shared/plans/p.md") | .repo' <<<"$A_OUT")" \
  "catalyst-workspace"
assert_eq "A: org field echoes the audited org" \
  "$(jq -rs '.[0].org' <<<"$A_OUT")" "rightsite-cloud"

# Read-only on the source: git status stays clean, no manifest written into tree.
A_STATUS="$(git_q -C "$REPO_A" status --porcelain)"
assert_eq "A: audit is read-only — source git status stays clean" "$A_STATUS" ""

# ─── Fixture B — a coalesce-labs thoughts checkout — Adva subdir is REVERSE ────
echo ""
echo "=== Fixture B: coalesce-labs checkout — repos/Adva is REVERSE ==="
REPO_B="$SCRATCH/coalesce-labs/thoughts"
build_repo "$REPO_B" <<EOF
repos/catalyst-workspace/shared/plans/ok.md	correctly-homed catalyst plan
repos/Adva/x.md	Adva content sitting under coalesce-labs (reverse misroute)
shared/pm/adva/ADV-9.md	legit catalyst PM work ABOUT Adva, not under repos/
EOF

B_OUT="$("$AUDIT" --root "$REPO_B" --org coalesce-labs 2>/dev/null)"

assert_eq "B: repos/Adva/x.md classified REVERSE" \
  "$(jq -r 'select(.path=="repos/Adva/x.md") | .classification' <<<"$B_OUT")" \
  "REVERSE"
B_MOVE_COUNT="$(jq -rs '[.[] | select(.classification=="MOVE")] | length' <<<"$B_OUT")"
assert_eq "B: zero MOVE in the correct (coalesce-labs) repo" "$B_MOVE_COUNT" "0"
# correctly-homed catalyst content is NOT flagged.
assert_not_grep "B: correctly-homed repos/catalyst-workspace is not in the manifest as MOVE/REVERSE" \
  "$B_OUT" 'repos/catalyst-workspace/shared/plans/ok.md'
# shared/pm/adva path (ADV- keyword, NOT under repos/) is never flagged.
assert_not_grep "B: shared/pm/adva/ADV-9.md (not under repos/) is never flagged" \
  "$B_OUT" 'shared/pm/adva/ADV-9.md'

# ─── Empty / clean tree ───────────────────────────────────────────────────────
echo ""
echo "=== Empty/clean tree → zero MOVE, exit 0, summary says 0 true misroutes ==="
REPO_C="$SCRATCH/clean/thoughts"
build_repo "$REPO_C" <<EOF
global/notes.md	just a global note, no repos/ subtree
shared/learnings/x.md	a learning
EOF

C_OUT="$("$AUDIT" --root "$REPO_C" --org rightsite-cloud 2>/dev/null)"; C_RC=$?
C_ERR="$("$AUDIT" --root "$REPO_C" --org rightsite-cloud 2>&1 >/dev/null)"
assert_eq "clean: exit 0" "$C_RC" "0"
C_MOVE_COUNT="$(jq -rs '[.[] | select(.classification=="MOVE")] | length' <<<"$C_OUT" 2>/dev/null || echo 0)"
assert_eq "clean: zero MOVE records" "$C_MOVE_COUNT" "0"
assert_grep "clean: summary says 0 true misroutes" "$C_ERR" "0 true misroutes"

# ─── Auto org-derivation from the git remote ──────────────────────────────────
echo ""
echo "=== Auto org-derivation from git remote (groundworkapp → rightsite-cloud) ==="
REPO_D="$SCRATCH/auto/thoughts"
build_repo "$REPO_D" <<EOF
repos/catalyst/shared/plans/p.md	misroute discovered via auto-derived org
EOF
# groundworkapp remote must normalize to rightsite-cloud → catalyst subdir = MOVE.
git_q -C "$REPO_D" remote add origin "https://github.com/groundworkapp/thoughts.git"
D_OUT="$("$AUDIT" --root "$REPO_D" 2>/dev/null)"
assert_eq "auto: org derived + normalized to rightsite-cloud" \
  "$(jq -rs '.[0].org' <<<"$D_OUT")" "rightsite-cloud"
assert_eq "auto: catalyst subdir is MOVE under the derived non-coalesce-labs org" \
  "$(jq -r 'select(.path=="repos/catalyst/shared/plans/p.md") | .classification' <<<"$D_OUT")" \
  "MOVE"

# ─── Bad/missing --root → non-zero with a clear message ───────────────────────
echo ""
echo "=== Bad/missing --root → non-zero exit, clear message ==="
MISS_ERR="$("$AUDIT" --org rightsite-cloud 2>&1)"; MISS_RC=$?
assert_eq "missing --root: non-zero exit" "$([[ $MISS_RC -ne 0 ]] && echo nonzero || echo zero)" "nonzero"
assert_grep "missing --root: message mentions root" "$MISS_ERR" "root"

BAD_ERR="$("$AUDIT" --root "$SCRATCH/does-not-exist" --org rightsite-cloud 2>&1)"; BAD_RC=$?
assert_eq "nonexistent --root: non-zero exit" "$([[ $BAD_RC -ne 0 ]] && echo nonzero || echo zero)" "nonzero"

# ─── --help exits 0 ───────────────────────────────────────────────────────────
"$AUDIT" --help >/dev/null 2>&1
assert_eq "--help exits 0" "$?" "0"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results ==="
echo "PASS: $PASSES"
echo "FAIL: $FAILURES"
echo ""
echo "audit-thoughts-pollution.test.sh: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
