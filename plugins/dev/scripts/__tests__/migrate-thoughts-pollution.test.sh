#!/usr/bin/env bash
# Tests for migrate-thoughts-pollution.sh (CTL-1246, Phase 2).
# Hermetic — `git init` a real repo with commit history per fixture, no network.
# The migration consumes a Phase-1 manifest, defaults to --dry-run, pre-checks
# collisions, and `git mv`s the MOVE set preserving history. Zero-loss + idempotent.
#
# Fixture model: source-root and target-root are two subtrees of ONE git repo so
# `git mv` preserves history and `git log --follow` resolves the rename (mirrors
# the same-repo move-and-rereference.sh template the migration is modeled on).
#
# Run: bash plugins/dev/scripts/__tests__/migrate-thoughts-pollution.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MIGRATE="${SCRIPTS_DIR}/migrate-thoughts-pollution.sh"
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
    echo "    expected substring: $pattern"; echo "$output" | head -30 | sed 's/^/      /'
  fi
}

git_q() { git -c init.defaultBranch=main -c user.email=t@t -c user.name=t \
            -c commit.gpgsign=false "$@"; }

# Build a one-repo fixture: $1/source/<tree> + an empty $1/target/. Commits the
# source tree so history exists. Rows are "relpath<TAB>content" on stdin, relpath
# is relative to source-root (i.e. repos/<subdir>/...).
build_fixture() {
  local repo="$1"; shift
  mkdir -p "$repo/source" "$repo/target"
  git_q -C "$repo" init -q
  # target/ needs to be inside the repo; seed a keep file so it is tracked terrain.
  printf 'keep\n' > "$repo/target/.keep"
  while IFS=$'\t' read -r relpath content; do
    [[ -z "$relpath" ]] && continue
    mkdir -p "$repo/source/$(dirname "$relpath")"
    printf '%s\n' "$content" > "$repo/source/$relpath"
  done
  git_q -C "$repo" add -A
  git_q -C "$repo" commit -q -m "seed"
}

# Count files present under <root> whose relative path is in the MOVE set list ($2..).
count_present() {
  local root="$1"; shift
  local n=0 p
  for p in "$@"; do [[ -e "$root/$p" ]] && n=$((n + 1)); done
  echo "$n"
}

echo "=== migrate-thoughts-pollution.sh hermetic tests ==="
echo "SCRIPT: $MIGRATE"
echo "SCRATCH: $SCRATCH"
echo ""

# ─── Main fixture: audit → migrate integration ────────────────────────────────
echo "=== --dry-run (default) changes nothing; --execute moves the MOVE set ==="
REPO="$SCRATCH/main"
build_fixture "$REPO" <<EOF
repos/catalyst-workspace/shared/plans/p.md	catalyst plan misrouted into rightsite-cloud
repos/catalyst/shared/research/r.md	catalyst research misrouted
repos/Adva/shared/friction/ADV-1.md	legit Adva — must be LEFT
EOF
SRC="$REPO/source"; TGT="$REPO/target"
MANIFEST="$SCRATCH/main-manifest.jsonl"
# Generate the manifest with the real Phase-1 audit (true integration).
"$AUDIT" --root "$SRC" --org rightsite-cloud --out "$MANIFEST" 2>/dev/null
MOVE_A="repos/catalyst-workspace/shared/plans/p.md"
MOVE_B="repos/catalyst/shared/research/r.md"
LEAVE_X="repos/Adva/shared/friction/ADV-1.md"
ORIG_MOVE=2

# --dry-run (default): prints "would", touches nothing.
DRY_OUT="$("$MIGRATE" --manifest "$MANIFEST" --source-root "$SRC" --target-root "$TGT" 2>&1)"; DRY_RC=$?
assert_eq "dry-run: exit 0" "$DRY_RC" "0"
assert_grep "dry-run: prints a 'would' line" "$DRY_OUT" "would"
assert_eq "dry-run: source git status stays clean" "$(git_q -C "$REPO" status --porcelain)" ""
assert_eq "dry-run: MOVE files still in source (2)" "$(count_present "$SRC" "$MOVE_A" "$MOVE_B")" "2"
assert_eq "dry-run: nothing copied into target (0)" "$(count_present "$TGT" "$MOVE_A" "$MOVE_B")" "0"

# --execute: moves the 2 MOVE files, leaves the Adva file.
EXEC_OUT="$("$MIGRATE" --manifest "$MANIFEST" --source-root "$SRC" --target-root "$TGT" --execute 2>&1)"; EXEC_RC=$?
assert_eq "execute: exit 0" "$EXEC_RC" "0"
assert_eq "execute: MOVE files now in target (2)" "$(count_present "$TGT" "$MOVE_A" "$MOVE_B")" "2"
assert_eq "execute: MOVE files gone from source (0)" "$(count_present "$SRC" "$MOVE_A" "$MOVE_B")" "0"
assert_eq "execute: LEAVE (Adva) file untouched in source" \
  "$([[ -e "$SRC/$LEAVE_X" ]] && echo present || echo gone)" "present"
assert_eq "execute: LEAVE (Adva) file NOT copied to target" \
  "$([[ -e "$TGT/$LEAVE_X" ]] && echo present || echo gone)" "gone"

# Zero-loss invariant: target + source MOVE counts == original, at this step.
assert_eq "zero-loss: target+source MOVE count equals original" \
  "$(( $(count_present "$TGT" "$MOVE_A" "$MOVE_B") + $(count_present "$SRC" "$MOVE_A" "$MOVE_B") ))" \
  "$ORIG_MOVE"

# History preserved: commit the staged move, then git log --follow shows the seed.
git_q -C "$REPO" commit -q -m "migrate moves"
FOLLOW="$(git_q -C "$REPO" log --follow --format=%s -- "target/$MOVE_A")"
assert_grep "history: git log --follow on the moved file shows the original seed commit" \
  "$FOLLOW" "seed"

# Idempotency: a second --execute (source drained) is a clean no-op.
IDEM_OUT="$("$MIGRATE" --manifest "$MANIFEST" --source-root "$SRC" --target-root "$TGT" --execute 2>&1)"; IDEM_RC=$?
assert_eq "idempotent: second --execute exits 0" "$IDEM_RC" "0"
assert_eq "idempotent: target still has exactly the 2 moved files" \
  "$(count_present "$TGT" "$MOVE_A" "$MOVE_B")" "2"
assert_grep "idempotent: reports already-migrated / nothing to do" "$IDEM_OUT" "skip"
# A no-op second run must not create new staged changes.
assert_eq "idempotent: working tree clean after second --execute" \
  "$(git_q -C "$REPO" status --porcelain)" ""

# ─── Collision pre-check ──────────────────────────────────────────────────────
echo ""
echo "=== Collision: target exists & differs → abort before moving anything ==="
REPOC="$SCRATCH/collide"
build_fixture "$REPOC" <<EOF
repos/catalyst/shared/plans/c.md	source content
EOF
SRCC="$REPOC/source"; TGTC="$REPOC/target"
MANC="$SCRATCH/collide-manifest.jsonl"
"$AUDIT" --root "$SRCC" --org rightsite-cloud --out "$MANC" 2>/dev/null
# Pre-seed a DIFFERING target file at the collision path.
mkdir -p "$TGTC/repos/catalyst/shared/plans"
printf 'DIFFERENT target content\n' > "$TGTC/repos/catalyst/shared/plans/c.md"
git_q -C "$REPOC" add -A; git_q -C "$REPOC" commit -q -m "pre-seed target collision"

COL_OUT="$("$MIGRATE" --manifest "$MANC" --source-root "$SRCC" --target-root "$TGTC" --execute 2>&1)"; COL_RC=$?
assert_eq "collision: non-zero exit" "$([[ $COL_RC -ne 0 ]] && echo nonzero || echo zero)" "nonzero"
assert_grep "collision: reports the conflicting path" "$COL_OUT" "repos/catalyst/shared/plans/c.md"
assert_eq "collision: source file untouched (move nothing on abort)" \
  "$([[ -e "$SRCC/repos/catalyst/shared/plans/c.md" ]] && echo present || echo gone)" "present"
assert_eq "collision: target file content unchanged" \
  "$(cat "$TGTC/repos/catalyst/shared/plans/c.md")" "DIFFERENT target content"

# ─── Untracked file in MOVE set → plain mv ────────────────────────────────────
echo ""
echo "=== Untracked file in MOVE set → plain mv (not git mv) ==="
REPOU="$SCRATCH/untracked"
build_fixture "$REPOU" <<EOF
repos/catalyst/shared/plans/tracked.md	tracked content
EOF
SRCU="$REPOU/source"; TGTU="$REPOU/target"
# Add an UNTRACKED file under source and hand-write a manifest that lists it MOVE.
mkdir -p "$SRCU/repos/catalyst/shared/notes"
printf 'untracked content\n' > "$SRCU/repos/catalyst/shared/notes/u.md"
MANU="$SCRATCH/untracked-manifest.jsonl"
{
  jq -nc '{path:"repos/catalyst/shared/plans/tracked.md",classification:"MOVE",repo:"catalyst",org:"rightsite-cloud",reason:"tracked"}'
  jq -nc '{path:"repos/catalyst/shared/notes/u.md",classification:"MOVE",repo:"catalyst",org:"rightsite-cloud",reason:"untracked"}'
} > "$MANU"

UNT_OUT="$("$MIGRATE" --manifest "$MANU" --source-root "$SRCU" --target-root "$TGTU" --execute 2>&1)"; UNT_RC=$?
assert_eq "untracked: exit 0" "$UNT_RC" "0"
assert_eq "untracked: untracked file moved to target" \
  "$([[ -e "$TGTU/repos/catalyst/shared/notes/u.md" ]] && echo present || echo gone)" "present"
assert_eq "untracked: untracked file gone from source" \
  "$([[ -e "$SRCU/repos/catalyst/shared/notes/u.md" ]] && echo present || echo gone)" "gone"
assert_eq "untracked: tracked file also moved" \
  "$([[ -e "$TGTU/repos/catalyst/shared/plans/tracked.md" ]] && echo present || echo gone)" "present"

# ─── Empty manifest / zero MOVE records → exit 0, nothing to migrate ──────────
echo ""
echo "=== Empty manifest → exit 0, 'nothing to migrate' ==="
REPOE="$SCRATCH/empty"
build_fixture "$REPOE" <<EOF
repos/Adva/x.md	only Adva content, no MOVE records
EOF
SRCE="$REPOE/source"; TGTE="$REPOE/target"
MANE="$SCRATCH/empty-manifest.jsonl"
"$AUDIT" --root "$SRCE" --org rightsite-cloud --out "$MANE" 2>/dev/null  # yields 0 MOVE
EMP_OUT="$("$MIGRATE" --manifest "$MANE" --source-root "$SRCE" --target-root "$TGTE" --execute 2>&1)"; EMP_RC=$?
assert_eq "empty: exit 0" "$EMP_RC" "0"
assert_grep "empty: 'nothing to migrate'" "$EMP_OUT" "nothing to migrate"

# ─── Missing required args ────────────────────────────────────────────────────
echo ""
echo "=== Missing required args → non-zero ==="
BAD_OUT="$("$MIGRATE" --source-root "$SRC" --target-root "$TGT" --execute 2>&1)"; BAD_RC=$?
assert_eq "missing --manifest: non-zero exit" "$([[ $BAD_RC -ne 0 ]] && echo nonzero || echo zero)" "nonzero"
"$MIGRATE" --help >/dev/null 2>&1
assert_eq "--help exits 0" "$?" "0"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Results ==="
echo "PASS: $PASSES"
echo "FAIL: $FAILURES"
echo ""
echo "migrate-thoughts-pollution.test.sh: ${PASSES} passed, ${FAILURES} failed"
exit "$FAILURES"
