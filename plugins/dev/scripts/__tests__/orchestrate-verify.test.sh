#!/usr/bin/env bash
# Shell tests for orchestrate-verify.sh (CTL-222).
# Run: bash plugins/dev/scripts/__tests__/orchestrate-verify.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
VERIFY="${REPO_ROOT}/plugins/dev/scripts/orchestrate-verify.sh"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# Build a scratch repo with a base commit on `main`, then create a feature
# branch with the given files added so `git diff main..` returns them.
scratch_setup() {
  SCRATCH="$(mktemp -d)"
  cd "$SCRATCH"

  git init -q -b main
  git config user.email "test@example.com"
  git config user.name "test"
  echo "base" > README.md
  git add README.md
  git commit -q -m "base"

  git checkout -q -b feature

  mkdir -p "${SCRATCH}/bin"
  ORCH_DIR="${SCRATCH}/orch"
  mkdir -p "${ORCH_DIR}/workers"
}

scratch_teardown() {
  cd /
  rm -rf "$SCRATCH"
  unset SCRATCH ORCH_DIR
}

# Stage files, commit, and put a stub `gh` on PATH. The pr-view fixture
# uses {{MERGE_SHA}} as a placeholder — replaced with the real HEAD SHA so
# the script's merge-SHA-based diff range refers to a real commit.
seed_changes_and_gh() {
  # Args: GH_PR_LIST_TEMPLATE GH_PR_VIEW_TEMPLATE
  local pr_list_tpl="$1" pr_view_tpl="$2"
  git add -A
  git commit -q -m "feature changes"
  local merge_sha
  merge_sha=$(git rev-parse HEAD)

  local pr_list_json pr_view_json
  pr_list_json="${pr_list_tpl//\{\{MERGE_SHA\}\}/$merge_sha}"
  pr_view_json="${pr_view_tpl//\{\{MERGE_SHA\}\}/$merge_sha}"

  cat > "${SCRATCH}/bin/gh" <<EOF
#!/usr/bin/env bash
args="\$*"
if [[ "\$args" == *"pr list"* ]]; then
  cat <<JSON
${pr_list_json}
JSON
elif [[ "\$args" == *"pr view"* ]]; then
  cat <<JSON
${pr_view_json}
JSON
else
  echo "stub gh: unexpected: \$args" >&2
  exit 99
fi
EOF
  chmod +x "${SCRATCH}/bin/gh"
  export PATH="${SCRATCH}/bin:${PATH}"
}

# Seed a worker signal file at $ORCH_DIR/workers/<ticket>.json.
make_signal() {
  local ticket="$1"
  cat > "${ORCH_DIR}/workers/${ticket}.json" <<EOF
{
  "ticket": "${ticket}",
  "definitionOfDone": {
    "testsWrittenFirst": false,
    "unitTests": {"exists": false, "count": 0},
    "apiTests": {"exists": false, "count": 0},
    "functionalTests": {"exists": false, "count": 0}
  }
}
EOF
}

run_verify() {
  local ticket="$1" req="${2:-backend}"
  shift 2
  # Any remaining args (e.g. --test-convention adjacency) pass through.
  set +e
  OUT=$("$VERIFY" \
    --worktree "$SCRATCH" \
    --ticket "$ticket" \
    --base-branch main \
    --signal-file "${ORCH_DIR}/workers/${ticket}.json" \
    --test-requirements "$req" "$@" 2>&1)
  RC=$?
  set -e
}

echo "orchestrate-verify tests"
echo

# ---------------------------------------------------------------
# 1. No-source-file run is clean (only docs changed)
# ---------------------------------------------------------------
echo "test: doc-only diff produces no '0\\\\n0' count artefact"
scratch_setup
echo "doc change" >> README.md
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-1"
run_verify "TICK-1" "backend"
# Detect the broken "0\n0" pattern that the bug produces — a count
# rendered as two adjacent lines inside parentheses, e.g. "(0\n0 files)".
if echo "$OUT" | tr '\n' '|' | grep -qE '\(0\|0 '; then
  fail "no '0\\\\n0' count artefact in stdout" "$OUT"
else
  pass "no '0\\\\n0' count artefact in stdout"
fi
echo "$OUT" | grep -q "integer expression" && fail "no 'integer expression' errors" "$OUT" || pass "no 'integer expression' errors"
scratch_teardown
echo

# ---------------------------------------------------------------
# 2. Merged-with-deleted-branch lookup succeeds
# ---------------------------------------------------------------
echo "test: merged PR found via --state all"
scratch_setup
echo "doc" >> README.md
seed_changes_and_gh \
  '[{"number":99,"state":"MERGED","mergedAt":"2026-05-04T00:00:00Z"}]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-2"
run_verify "TICK-2" "backend"
echo "$OUT" | grep -q "PR #99 is MERGED" && pass "merged PR detected" || fail "merged PR detected" "$OUT"
echo "$OUT" | grep -q "No PR found for branch" && fail "should not report 'No PR found' for merged PR" "$OUT" || pass "no false-negative on merged PR"
scratch_teardown
echo

# ---------------------------------------------------------------
# 3. Loose-route regex tightened
# ---------------------------------------------------------------
echo "test: setup-webhooks.sh is NOT flagged as API route"
scratch_setup
mkdir -p plugins/dev/scripts
echo '#!/bin/bash' > plugins/dev/scripts/setup-webhooks.sh
echo 'echo hi' >> plugins/dev/scripts/setup-webhooks.sh
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-3"
run_verify "TICK-3" "backend"
echo "$OUT" | grep -q "API routes changed" && fail "setup-webhooks.sh should not trigger API route check" "$OUT" || pass "setup-webhooks.sh not flagged as API"
scratch_teardown
echo

echo "test: apiClient.ts is NOT flagged as API route"
scratch_setup
mkdir -p src
cat > src/apiClient.ts <<'EOF'
export const fetchClient = () => 1;
EOF
cat > src/apiClient.test.ts <<'EOF'
import { fetchClient } from './apiClient';
test('x', () => { fetchClient(); });
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-4"
run_verify "TICK-4" "backend"
echo "$OUT" | grep -q "API routes changed" && fail "apiClient.ts should not trigger API route check" "$OUT" || pass "apiClient.ts not flagged as API"
scratch_teardown
echo

# ---------------------------------------------------------------
# 4. Real route file does trigger API check
# ---------------------------------------------------------------
echo "test: src/api/foo.ts DOES trigger API route check"
scratch_setup
mkdir -p src/api
cat > src/api/foo.ts <<'EOF'
export const handler = () => 1;
EOF
# No corresponding API test, so we expect the API check to fail.
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-5"
run_verify "TICK-5" "fullstack"
echo "$OUT" | grep -qE "API (routes|files)" && pass "src/api/foo.ts detected as route" || fail "src/api/foo.ts detected as route" "$OUT"
scratch_teardown
echo

# ---------------------------------------------------------------
# 5. RESULT: FAIL exits non-zero
# ---------------------------------------------------------------
echo "test: missing test file triggers FAIL with non-zero exit"
scratch_setup
mkdir -p src
cat > src/widget.ts <<'EOF'
export const f = () => 1;
EOF
# Deliberately no test file alongside.
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-6"
run_verify "TICK-6" "backend"
echo "$OUT" | grep -q "RESULT: FAIL" && pass "RESULT: FAIL printed" || fail "RESULT: FAIL printed" "$OUT"
[ "$RC" -ne 0 ] && pass "exit code is non-zero on FAIL (rc=$RC)" || fail "exit code is non-zero on FAIL" "rc=$RC; out: $OUT"
scratch_teardown
echo

# ---------------------------------------------------------------
# NEW: Signal file pr.number+mergeCommitSha overrides empty gh pr list (CTL-400)
# ---------------------------------------------------------------
echo "test: signal-file pr.number+mergeCommitSha used when branch is deleted (CTL-400)"
scratch_setup
echo "feature" >> README.md
git add -A && git commit -q -m "feature"
CTL400_SHA=$(git rev-parse HEAD)

# gh pr list returns [] — simulates deleted head branch after --delete-branch
cat > "${SCRATCH}/bin/gh" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *"pr list"* ]]; then echo "[]"; exit 0; fi
echo "stub gh: unexpected call: \$*" >&2; exit 99
EOF
chmod +x "${SCRATCH}/bin/gh"
export PATH="${SCRATCH}/bin:${PATH}"

# Signal file already has pr.number + pr.mergeCommitSha (written by worker before merge)
cat > "${ORCH_DIR}/workers/TICK-CTL400.json" <<EOF
{
  "ticket": "TICK-CTL400",
  "pr": {
    "number": 698,
    "url": "https://github.com/org/repo/pull/698",
    "mergedAt": "2026-05-14T16:00:00Z",
    "mergeCommitSha": "${CTL400_SHA}",
    "ciStatus": "merged"
  },
  "definitionOfDone": {
    "testsWrittenFirst": false,
    "unitTests": {"exists": false, "count": 0},
    "apiTests": {"exists": false, "count": 0},
    "functionalTests": {"exists": false, "count": 0}
  }
}
EOF
run_verify "TICK-CTL400" "backend"
echo "$OUT" | grep -q "PR #698 is MERGED" && pass "signal-file: merged PR detected via pr.number+sha" || fail "signal-file: merged PR detected" "$OUT"
echo "$OUT" | grep -q "No PR found for branch" && fail "no false-positive when branch is deleted" "$OUT" || pass "no false-positive on deleted branch"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #1: merge SHA absent from worktree objects must NOT abort
# ---------------------------------------------------------------
echo "test: merged PR whose merge SHA is not a local object still diffs (CTL-596 #1)"
scratch_setup
mkdir -p src
cat > src/widget.ts <<'EOF'
export const f = () => 1;
EOF
cat > src/widget.test.ts <<'EOF'
import { f } from './widget';
test('f', () => { f(); });
EOF
git add -A && git commit -q -m "feature work"

# gh pr list returns [] (deleted head branch). Signal file carries a merge SHA
# that does NOT exist in this repo's object database (40 hex chars, all dead).
cat > "${SCRATCH}/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"pr list"* ]]; then echo "[]"; exit 0; fi
if [[ "$*" == *"repo view"* ]]; then echo "org/repo"; exit 0; fi
if [[ "$*" == *"api repos"* ]]; then echo '{"merged":true,"merge_commit_sha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}'; exit 0; fi
echo "stub gh: unexpected: $*" >&2; exit 99
EOF
chmod +x "${SCRATCH}/bin/gh"
export PATH="${SCRATCH}/bin:${PATH}"

cat > "${ORCH_DIR}/workers/TICK-596A.json" <<'EOF'
{
  "ticket": "TICK-596A",
  "pr": { "number": 700, "mergeCommitSha": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
  "definitionOfDone": {
    "testsWrittenFirst": false,
    "unitTests": {"exists": false, "count": 0},
    "apiTests": {"exists": false, "count": 0},
    "functionalTests": {"exists": false, "count": 0}
  }
}
EOF
run_verify "TICK-596A" "backend"
# Must NOT abort with the empty-diff error, and MUST see the changed source file.
echo "$OUT" | grep -q "No changed files found" && fail "CTL-596 #1: must not abort on absent merge SHA" "$OUT" || pass "CTL-596 #1: no empty-diff abort"
echo "$OUT" | grep -q "Source files changed: 1" && pass "CTL-596 #1: changeset resolved via merge-base" || fail "CTL-596 #1: changeset resolved via merge-base" "$OUT"
[ "$RC" -ne 2 ] && pass "CTL-596 #1: did not exit 2 (rc=$RC)" || fail "CTL-596 #1: exited 2" "rc=$RC; out: $OUT"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #2: __tests__/ sibling with -service suffix is recognized
# ---------------------------------------------------------------
echo "test: src/core/__tests__/foo-service.test.ts covers src/core/foo-service.ts (CTL-596 #2)"
scratch_setup
mkdir -p src/core/__tests__
cat > src/core/foo-service.ts <<'EOF'
export const foo = () => 1;
EOF
cat > src/core/__tests__/foo-service.test.ts <<'EOF'
import { foo } from '../foo-service';
test('foo', () => { foo(); });
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596B"
run_verify "TICK-596B" "backend"
echo "$OUT" | grep -q "Missing tests for" && fail "CTL-596 #2: __tests__ sibling should be found" "$OUT" || pass "CTL-596 #2: __tests__ sibling recognized"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #2: qualifier .integration.test.ts is recognized
# ---------------------------------------------------------------
echo "test: __tests__/widget.integration.test.ts covers src/widget.ts (CTL-596 #2)"
scratch_setup
mkdir -p src/__tests__
cat > src/widget.ts <<'EOF'
export const w = () => 1;
EOF
cat > src/__tests__/widget.integration.test.ts <<'EOF'
import { w } from '../widget';
test('w', () => { w(); });
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596C"
run_verify "TICK-596C" "backend"
echo "$OUT" | grep -q "Missing tests for" && fail "CTL-596 #2: qualifier test should be found" "$OUT" || pass "CTL-596 #2: qualifier test recognized"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #2: config-declared test/** root is honored
# ---------------------------------------------------------------
# Note (CTL-596): the config (vitest.config.ts) and the test live on the BASE,
# not in the PR — this is realistic (config pre-exists) and avoids two artifacts
# of the unchanged file-categorization (:191): a *.config.ts counts as a "source
# file" needing its own test, and a test file in the diff would be matched by the
# stem-in-diff step before test_roots_for runs. Putting both on base forces the
# on-disk config-root discovery path (step 2) to be the thing under test.
echo "test: vitest include test/**/*.test.ts covers src/tools/run.ts (CTL-596 #2)"
scratch_setup
git checkout -q main
mkdir -p src/tools test/tools
cat > vitest.config.ts <<'EOF'
export default { test: { include: ["test/**/*.test.ts"] } };
EOF
cat > test/tools/run.test.ts <<'EOF'
import { run } from '../../src/tools/run';
test('run', () => { run(); });
EOF
git add -A && git commit -q -m "vitest config + test root on base"
git checkout -q feature
git merge -q --no-edit main 2>/dev/null || git rebase -q main
# The PR adds only the source file; its test already lives under the
# config-declared test/ root.
cat > src/tools/run.ts <<'EOF'
export const run = () => 1;
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596D"
run_verify "TICK-596D" "backend"
echo "$OUT" | grep -q "Missing tests for" && fail "CTL-596 #2: config-declared test root should be honored" "$OUT" || pass "CTL-596 #2: config test root recognized"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #3: pre-existing `as any` the PR never touched must NOT FAIL
# ---------------------------------------------------------------
# Note (CTL-596): the PR must MODIFY legacy.ts (Check #7 only inspects changed
# source files) — appending a benign line puts it in the changeset while the
# pre-existing casts stay on untouched lines. Whole-file grep counts 3 (old =
# FAIL); added-line delta counts 0 (new = PASS).
echo "test: pre-existing as any casts on base do not fail Check #7 (CTL-596 #3)"
scratch_setup
mkdir -p src
git checkout -q main
cat > src/legacy.ts <<'EOF'
export const a = (x: unknown) => x as any;
export const b = (x: unknown) => x as any;
export const c = (x: unknown) => x as any;
EOF
cat > src/legacy.test.ts <<'EOF'
import { a } from './legacy';
test('a', () => { a(1); });
EOF
git add -A && git commit -q -m "legacy with pre-existing casts"
git checkout -q feature
git merge -q --no-edit main 2>/dev/null || git rebase -q main
# PR appends a benign line — legacy.ts is now in the diff, but the ADDED line
# contains zero `as any`.
echo 'export const d = () => 2;' >> src/legacy.ts
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596E"
run_verify "TICK-596E" "backend"
echo "$OUT" | grep -qE "'as any' cast" && fail "CTL-596 #3: pre-existing casts must not fail" "$OUT" || pass "CTL-596 #3: pre-existing casts ignored"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #3: an ADDED `as any` still FAILs Check #7
# ---------------------------------------------------------------
echo "test: a newly added as any still fails Check #7 (CTL-596 #3)"
scratch_setup
mkdir -p src
cat > src/added.ts <<'EOF'
export const g = (x: unknown) => x as any;
EOF
cat > src/added.test.ts <<'EOF'
import { g } from './added';
test('g', () => { g(1); });
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596F"
run_verify "TICK-596F" "backend"
echo "$OUT" | grep -qE "'as any' cast" && pass "CTL-596 #3: added cast detected" || fail "CTL-596 #3: added cast detected" "$OUT"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #2: --test-convention adjacency NARROWS (ignores config root)
# ---------------------------------------------------------------
# Proves the flag is a real narrowing: the same config-declared test/** root
# that glob mode honors (TICK-596D) must NOT be honored under adjacency, so the
# source reports Missing tests.
echo "test: adjacency mode does not honor config-declared test root (CTL-596 #2)"
scratch_setup
git checkout -q main
mkdir -p src/tools test/tools
cat > vitest.config.ts <<'EOF'
export default { test: { include: ["test/**/*.test.ts"] } };
EOF
cat > test/tools/run.test.ts <<'EOF'
import { run } from '../../src/tools/run';
test('run', () => { run(); });
EOF
git add -A && git commit -q -m "vitest config + test root on base"
git checkout -q feature
git merge -q --no-edit main 2>/dev/null || git rebase -q main
cat > src/tools/run.ts <<'EOF'
export const run = () => 1;
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596G"
run_verify "TICK-596G" "backend" --test-convention adjacency
echo "$OUT" | grep -q "Missing tests for" && pass "CTL-596 #2: adjacency ignores config root (narrowing verified)" || fail "CTL-596 #2: adjacency should ignore config root" "$OUT"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #3: pre-existing console.log over threshold does NOT FAIL
# ---------------------------------------------------------------
# The >2 threshold pattern is where added-line vs whole-file confusion bites
# hardest: a legacy file with 3 console.log the PR merely touches must PASS.
echo "test: pre-existing console.log (>2) on a touched file does not fail Check #7 (CTL-596 #3)"
scratch_setup
mkdir -p src
git checkout -q main
cat > src/noisy.ts <<'EOF'
export const a = () => { console.log('a'); };
export const b = () => { console.log('b'); };
export const c = () => { console.log('c'); };
export const d = () => { console.log('d'); };
EOF
cat > src/noisy.test.ts <<'EOF'
import { a } from './noisy';
test('a', () => { a(); });
EOF
git add -A && git commit -q -m "noisy with pre-existing console.log"
git checkout -q feature
git merge -q --no-edit main 2>/dev/null || git rebase -q main
# PR appends one benign line — adds zero console.log.
echo 'export const e = () => 2;' >> src/noisy.ts
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596H"
run_verify "TICK-596H" "backend"
echo "$OUT" | grep -qE "console.log statements" && fail "CTL-596 #3: pre-existing console.log must not fail" "$OUT" || pass "CTL-596 #3: pre-existing console.log ignored"
scratch_teardown
echo

# ---------------------------------------------------------------
# CTL-596 defect #1: diff range resolves via origin/<base> (production path)
# ---------------------------------------------------------------
# TICK-596A covers the local-main fallback (scratch repos have no origin).
# Production worktrees track origin/<base>; this fixture creates a real origin
# so the `git rev-parse origin/main` preference branch is exercised.
echo "test: changeset resolves against origin/main when present (CTL-596 #1)"
scratch_setup
git checkout -q main
ORIGIN596="$(mktemp -d)"
git init -q --bare "$ORIGIN596"
git remote add origin "$ORIGIN596"
git push -q origin main
git checkout -q feature
mkdir -p src
cat > src/origin.ts <<'EOF'
export const o = () => 1;
EOF
cat > src/origin.test.ts <<'EOF'
import { o } from './origin';
test('o', () => { o(); });
EOF
seed_changes_and_gh '[]' \
  '{"state":"MERGED","mergeStateStatus":"UNKNOWN","mergeCommit":{"oid":"{{MERGE_SHA}}"}}'
make_signal "TICK-596J"
run_verify "TICK-596J" "backend"
echo "$OUT" | grep -q "Source files changed: 1" && pass "CTL-596 #1: changeset resolved via origin/main" || fail "CTL-596 #1: changeset resolved via origin/main" "$OUT"
echo "$OUT" | grep -q "No changed files found" && fail "CTL-596 #1: must not abort with origin/main present" "$OUT" || pass "CTL-596 #1: no empty-diff abort (origin path)"
rm -rf "$ORIGIN596"; unset ORIGIN596
scratch_teardown
echo

# Note (CTL-596): no empty-catch DETECTION fixture. The detection uses
# `grep -Pzo`, which silently no-ops under BSD grep (the script runs `#!/bin/bash`
# non-interactively, so `grep` is /usr/bin/grep, not ugrep/GNU). The plan scoped
# the matcher as an unchanged "documented assumption", so the only CTL-596 change
# here is the ADDED_LINES gate in front of it. The platform no-op is filed as a
# separate finding rather than fixed in this PR.

# ---------------------------------------------------------------
echo
if [ $FAILURES -eq 0 ]; then
  echo "ALL PASSED ($PASSES)"
  exit 0
else
  echo "FAILED: $FAILURES (passes: $PASSES)"
  exit 1
fi
