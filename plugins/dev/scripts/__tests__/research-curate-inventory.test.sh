#!/usr/bin/env bash
# Tests for plugins/dev/scripts/research-curate/{inventory,score,generate-index,run}.sh (CTL-467).
# Builds isolated fixtures under $SCRATCH so the real corpus is never touched.
#
# Run: bash plugins/dev/scripts/__tests__/research-curate-inventory.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CURATE_DIR="${REPO_ROOT}/plugins/dev/scripts/research-curate"
INVENTORY="${CURATE_DIR}/inventory.sh"
SCORE="${CURATE_DIR}/score.sh"
GENERATE="${CURATE_DIR}/generate-index.sh"
RUN="${CURATE_DIR}/run.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

ok() {
  local name="$1"
  PASSES=$((PASSES+1))
  echo "  PASS: $name"
}

fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $name"
  echo "    $detail"
}

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok "$name"
  else
    fail "$name" "expected '$expected' got '$actual'"
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    ok "$name"
  else
    fail "$name" "missing '$needle' in: $(head -c 200 <<<"$haystack")"
  fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    fail "$name" "unexpectedly found '$needle'"
  else
    ok "$name"
  fi
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

FIX_DIR="$SCRATCH/research"
mkdir -p "$FIX_DIR"

# Initialize a git repo so file:line ref validation has something to look at.
# Each test that needs git-cat-file paths creates them under $FIX_DIR before
# committing, so HEAD has them.
cd "$SCRATCH"
git init -q -b main
git config user.email "test@example.com"
git config user.name "test"

# Create some referenced files (so HEAD has them)
mkdir -p src/lib
cat > src/server.ts <<'EOF'
// fake server.ts
export const PORT = 3000;
EOF
cat > src/lib/state-reader.ts <<'EOF'
// fake state-reader.ts
export const STATE = {};
EOF

# Fixture A: recent doc with full frontmatter, valid refs → should be `current`
cat > "$FIX_DIR/2026-05-01-alpha-research.md" <<EOF
---
date: 2026-05-01T10:00:00Z
topic: "Alpha research summary"
tags: [research, alpha, observability]
type: research
---

# Alpha research

The server lives at \`src/server.ts:1\` and the state reader at
\`src/lib/state-reader.ts:1\`. Both valid at HEAD.
EOF

# Fixture B: old doc with broken ref → should be `needs-review`
cat > "$FIX_DIR/2025-11-01-beta-research.md" <<EOF
---
date: 2025-11-01
topic: "Beta — old, has broken ref"
tags: [research, beta]
type: research
---

# Beta

Refers to \`src/server.ts:1\` (valid) and \`src/deleted.ts:42\` (does not exist at HEAD).
EOF

# Fixture C: very old doc, no recent activity, no broken refs but stale → `likely-stale`
cat > "$FIX_DIR/2025-08-01-gamma-research.md" <<EOF
---
date: 2025-08-01
topic: "Gamma — very old, no recent commits"
tags: [research, gamma]
type: research
---

# Gamma

Refers to \`src/server.ts:1\` only.
EOF

# Fixture D: minimal frontmatter (only title + date) — exercises fallback parser
cat > "$FIX_DIR/2026-04-15-CTL-99-minimal.md" <<EOF
---
title: "CTL-99: Minimal frontmatter doc"
date: 2026-04-15
type: research
---

# CTL-99: Minimal

Body without refs.
EOF

# Fixture E: no frontmatter at all — exercises filename-date fallback
cat > "$FIX_DIR/2026-04-20-no-frontmatter.md" <<EOF
# No frontmatter doc

Just a body, no YAML up top.
EOF

# Fixture F: should be ignored (INDEX.md, CONTRADICTIONS.md, dotfile)
cat > "$FIX_DIR/INDEX.md" <<EOF
# old INDEX

stale content that should be overwritten
EOF
cat > "$FIX_DIR/CONTRADICTIONS.md" <<EOF
# contradictions

not curated by this skill
EOF
cat > "$FIX_DIR/.hidden.md" <<EOF
hidden
EOF

git add -A
git commit -q -m "fixture: seed corpus"

# ---------------------------------------------------------------------------
# Test 1: inventory.sh emits one JSON object per markdown file
# ---------------------------------------------------------------------------
MANIFEST=$(bash "$INVENTORY" "$FIX_DIR" 2>/dev/null)
DOC_COUNT=$(echo "$MANIFEST" | grep -c '^{')
assert_eq "inventory emits 5 docs (skips INDEX/CONTRADICTIONS/dotfiles)" "5" "$DOC_COUNT"

# Test 2: required fields present
FIRST=$(echo "$MANIFEST" | head -1)
for field in filename path date tags word_count file_line_refs; do
  if jq -e --arg f "$field" 'has($f)' <<<"$FIRST" >/dev/null 2>&1; then
    ok "inventory entry has '$field'"
  else
    fail "inventory entry missing '$field'" "got: $FIRST"
  fi
done

# Test 3: filename-date fallback (Fixture E has no frontmatter)
NO_FM=$(echo "$MANIFEST" | jq -c 'select(.filename == "2026-04-20-no-frontmatter.md")')
DATE_VAL=$(jq -r '.date' <<<"$NO_FM")
assert_eq "filename-date fallback when no frontmatter" "2026-04-20" "$DATE_VAL"

# Test 4: frontmatter tags array parsed
ALPHA=$(echo "$MANIFEST" | jq -c 'select(.filename == "2026-05-01-alpha-research.md")')
TAGS=$(jq -r '.tags | join(",")' <<<"$ALPHA")
assert_eq "frontmatter tags parsed" "research,alpha,observability" "$TAGS"

# Test 5: file:line refs extracted from Fixture A (uses tightened regex — requires extension)
REF_COUNT=$(jq '.file_line_refs | length' <<<"$ALPHA")
assert_eq "alpha has 2 file:line refs extracted" "2" "$REF_COUNT"

# Test 6: INDEX.md / CONTRADICTIONS.md / dotfiles skipped
assert_not_contains "INDEX.md skipped" "$MANIFEST" '"INDEX.md"'
assert_not_contains "CONTRADICTIONS.md skipped" "$MANIFEST" '"CONTRADICTIONS.md"'
assert_not_contains ".hidden.md skipped" "$MANIFEST" '".hidden.md"'

# Test 7: score.sh classifies fixtures correctly with a pinned reference date
#  alpha   (2026-05-01): age 16d, refs valid → current
#  beta    (2025-11-01): age 197d, has broken ref → needs-review (or likely-stale)
#  gamma   (2025-08-01): age 289d, refs valid but no recent activity → likely-stale
#  minimal (2026-04-15): age 32d, no refs → current
#  no-fm   (2026-04-20): age 27d, no refs → current
SCORED=$(bash "$INVENTORY" "$FIX_DIR" 2>/dev/null \
  | bash "$SCORE" --reference-date 2026-05-17 --git-dir "$SCRATCH" 2>/dev/null)

STATUS_ALPHA=$(echo "$SCORED" | jq -r 'select(.filename=="2026-05-01-alpha-research.md") | .status')
assert_eq "alpha classified current" "current" "$STATUS_ALPHA"

STATUS_BETA=$(echo "$SCORED" | jq -r 'select(.filename=="2025-11-01-beta-research.md") | .status')
# Beta is age 197d + has broken ref. Both conditions trip needs-review. But age>=180 with
# no recent activity (we haven't committed anything mentioning beta tags) → likely-stale wins.
# Either is acceptable as long as it's NOT 'current'.
if [[ "$STATUS_BETA" == "needs-review" || "$STATUS_BETA" == "likely-stale" ]]; then
  ok "beta classified non-current ($STATUS_BETA)"
else
  fail "beta classification" "expected needs-review or likely-stale, got '$STATUS_BETA'"
fi

STATUS_GAMMA=$(echo "$SCORED" | jq -r 'select(.filename=="2025-08-01-gamma-research.md") | .status')
assert_eq "gamma classified likely-stale (age>=180, no activity)" "likely-stale" "$STATUS_GAMMA"

STATUS_MINIMAL=$(echo "$SCORED" | jq -r 'select(.filename=="2026-04-15-CTL-99-minimal.md") | .status')
assert_eq "minimal classified current (age 32d, no refs)" "current" "$STATUS_MINIMAL"

# Test 8: broken_refs counted on beta
BROKEN_BETA=$(echo "$SCORED" | jq -r 'select(.filename=="2025-11-01-beta-research.md") | .broken_refs')
assert_eq "beta has 1 broken ref" "1" "$BROKEN_BETA"

# Test 9: generate-index.sh emits three sections
INDEX_OUT=$(echo "$SCORED" | bash "$GENERATE" "research" 2>/dev/null)
assert_contains "INDEX has Current section" "$INDEX_OUT" "## Current"
assert_contains "INDEX has Needs Review section" "$INDEX_OUT" "## Needs Review"
assert_contains "INDEX has Likely Stale section" "$INDEX_OUT" "## Likely Stale"

# Test 10: INDEX links to source docs by [[wiki-link]]
assert_contains "INDEX has wiki link to alpha" "$INDEX_OUT" "[[2026-05-01-alpha-research]]"
assert_contains "INDEX has wiki link to gamma" "$INDEX_OUT" "[[2025-08-01-gamma-research]]"

# Test 11: deterministic output (same input → same bytes)
INDEX_OUT_2=$(echo "$SCORED" | bash "$GENERATE" "research" 2>/dev/null)
if [[ "$INDEX_OUT" == "$INDEX_OUT_2" ]]; then
  ok "INDEX generation deterministic"
else
  fail "INDEX generation deterministic" "second run differed"
fi

# Test 12: --dry-run writes to /tmp, NOT to fixture dir
rm -f "$FIX_DIR/INDEX.md"  # remove old fixture INDEX
SNAPSHOT_BEFORE=$(ls -1 "$FIX_DIR" | sort)
bash "$RUN" --dry-run --reference-date 2026-05-17 --git-dir "$SCRATCH" "$FIX_DIR" >/dev/null 2>&1
SNAPSHOT_AFTER=$(ls -1 "$FIX_DIR" | sort)
assert_eq "dry-run does not create INDEX.md in target dir" "$SNAPSHOT_BEFORE" "$SNAPSHOT_AFTER"

DRYRUN_PATH="/tmp/research-curate-INDEX-research.md"
if [[ -f "$DRYRUN_PATH" ]]; then
  ok "dry-run wrote to /tmp"
  rm -f "$DRYRUN_PATH"
else
  fail "dry-run wrote to /tmp" "$DRYRUN_PATH missing"
fi

# Test 13: real run writes only INDEX.md
# Recreate a stale INDEX.md so we have a baseline
cat > "$FIX_DIR/INDEX.md" <<EOF
# old INDEX
EOF
git add -A
git commit -q -m "fixture: seed INDEX baseline"

# Touch all source files into a known state, then run
SOURCE_HASHES_BEFORE=$(cd "$FIX_DIR" && find . -maxdepth 1 -name '*.md' ! -name 'INDEX.md' \
  -exec shasum {} \; | sort)
bash "$RUN" --reference-date 2026-05-17 --git-dir "$SCRATCH" "$FIX_DIR" >/dev/null 2>&1
SOURCE_HASHES_AFTER=$(cd "$FIX_DIR" && find . -maxdepth 1 -name '*.md' ! -name 'INDEX.md' \
  -exec shasum {} \; | sort)
assert_eq "source docs untouched after real run" "$SOURCE_HASHES_BEFORE" "$SOURCE_HASHES_AFTER"

if [[ -f "$FIX_DIR/INDEX.md" ]] && grep -q "Current" "$FIX_DIR/INDEX.md"; then
  ok "real run wrote new INDEX.md in target dir"
else
  fail "real run wrote new INDEX.md" "INDEX.md missing or empty"
fi

# Test 14: idempotent — second run produces no diff
HASH1=$(shasum "$FIX_DIR/INDEX.md" | awk '{print $1}')
bash "$RUN" --reference-date 2026-05-17 --git-dir "$SCRATCH" "$FIX_DIR" >/dev/null 2>&1
HASH2=$(shasum "$FIX_DIR/INDEX.md" | awk '{print $1}')
assert_eq "real run idempotent" "$HASH1" "$HASH2"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "  Passed: $PASSES"
echo "  Failed: $FAILURES"

if [[ $FAILURES -eq 0 && $PASSES -gt 0 ]]; then
  exit 0
else
  exit 1
fi
