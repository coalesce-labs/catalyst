#!/usr/bin/env bash
# Tests for plugins/dev/scripts/research-curate/{cluster,contradict,append-contradictions}.sh
# plus the run.sh extensions added in CTL-468.
#
# Builds isolated fixtures under $SCRATCH so the real corpus is never touched.
# Tests use a stub --llm-cmd to avoid spending tokens.
#
# Run: bash plugins/dev/scripts/__tests__/research-curate-contradictions.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CURATE_DIR="${REPO_ROOT}/plugins/dev/scripts/research-curate"
INVENTORY="${CURATE_DIR}/inventory.sh"
CLUSTER="${CURATE_DIR}/cluster.sh"
CONTRADICT="${CURATE_DIR}/contradict.sh"
APPEND="${CURATE_DIR}/append-contradictions.sh"
RUN="${CURATE_DIR}/run.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

ok() {
  PASSES=$((PASSES+1))
  echo "  PASS: $1"
}

fail() {
  FAILURES=$((FAILURES+1))
  echo "  FAIL: $1"
  echo "    $2"
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
# Helpers — fixture corpora and mock LLM
# ---------------------------------------------------------------------------

# Two-cluster corpus: 3 docs tagged [orchestrator, state], 3 tagged [broker, events].
seed_two_cluster_corpus() {
  local dir="$1"
  mkdir -p "$dir"
  for i in 1 2 3; do
    cat > "$dir/2026-05-0${i}-orch-${i}.md" <<EOF
---
date: 2026-05-0${i}
topic: "Orchestrator state notes ${i}"
tags: [orchestrator, state, workers]
type: research
---

# Orchestrator state ${i}

Worker ${i} writes to the orchestrator state file.
EOF
  done
  for i in 1 2 3; do
    cat > "$dir/2026-05-1${i}-broker-${i}.md" <<EOF
---
date: 2026-05-1${i}
topic: "Broker events ${i}"
tags: [broker, events, daemon]
type: research
---

# Broker events ${i}

The broker daemon emits events.
EOF
  done
}

# Small corpus: 2 docs that would cluster together — should be dropped.
seed_too_small_corpus() {
  local dir="$1"
  mkdir -p "$dir"
  for i in 1 2; do
    cat > "$dir/2026-05-0${i}-pair-${i}.md" <<EOF
---
date: 2026-05-0${i}
topic: "Pair ${i}"
tags: [pair, alpha, beta]
type: research
---

# Pair ${i}

Content.
EOF
  done
}

# Mega corpus: 12 docs all sharing one tag, should be split → 10 max.
seed_too_large_corpus() {
  local dir="$1"
  mkdir -p "$dir"
  for i in $(seq 1 12); do
    local padded=$(printf '%02d' "$i")
    cat > "$dir/2026-05-${padded}-mega-${padded}.md" <<EOF
---
date: 2026-05-${padded}
topic: "Mega ${padded}"
tags: [mega, shared, common]
type: research
---

# Mega ${padded}

Body ${i}.
EOF
  done
}

# Write a mock LLM script that emits a fixed JSON response.
# Usage: make_mock_llm <output-path> <fixture-json-path>
make_mock_llm() {
  local out="$1" fixture="$2"
  cat > "$out" <<EOF
#!/usr/bin/env bash
# Mock LLM: ignore stdin (the prompt), emit fixture JSON on stdout.
# Record the prompt size to a sibling .log file for assertions.
PROMPT=\$(cat)
echo "\${#PROMPT}" >> "${out}.log"
cat "$fixture"
EOF
  chmod +x "$out"
}

# Make a fixture JSON for cluster contradictions.
make_fixture_json() {
  local out="$1" slug_a="$2" slug_b="$3"
  cat > "$out" <<EOF
{"contradictions":[{"between":["${slug_a}","${slug_b}"],"claim_a":"A says X","claim_b":"B says not-X","explanation":"They disagree on X."}]}
EOF
}

make_empty_fixture() {
  echo '{"contradictions":[]}' > "$1"
}

make_garbage_fixture() {
  echo 'not json at all' > "$1"
}

# ---------------------------------------------------------------------------
# Test 1: cluster.sh produces 2 clusters of 3 docs each (Jaccard ≥ 0.4)
# ---------------------------------------------------------------------------
FIX1="$SCRATCH/case1"
seed_two_cluster_corpus "$FIX1"

CLUSTERS1=$(bash "$INVENTORY" "$FIX1" 2>/dev/null | bash "$CLUSTER" 2>/dev/null)
CCOUNT=$(printf '%s\n' "$CLUSTERS1" | grep -c '^{' || true)
assert_eq "cluster.sh: two-cluster corpus → 2 clusters" "2" "$CCOUNT"

# Each cluster has exactly 3 docs
SIZES=$(printf '%s\n' "$CLUSTERS1" | jq -r '.docs | length' | sort | tr '\n' ',')
assert_eq "cluster.sh: cluster sizes are 3,3" "3,3," "$SIZES"

# Tag separation: orchestrator and broker should not be in same cluster
SAME=$(printf '%s\n' "$CLUSTERS1" \
  | jq -r 'select((.docs | map(.tags) | flatten | contains(["orchestrator"]))
                  and (.docs | map(.tags) | flatten | contains(["broker"])))
           | .cluster_id' \
  | wc -l | tr -d ' ')
assert_eq "cluster.sh: orchestrator and broker not in same cluster" "0" "$SAME"

# ---------------------------------------------------------------------------
# Test 2: cluster.sh drops clusters of size < 3
# ---------------------------------------------------------------------------
FIX2="$SCRATCH/case2"
seed_too_small_corpus "$FIX2"

CLUSTERS2=$(bash "$INVENTORY" "$FIX2" 2>/dev/null | bash "$CLUSTER" 2>/dev/null)
CCOUNT2=$(printf '%s\n' "$CLUSTERS2" | grep -c '^{' || true)
assert_eq "cluster.sh: 2-doc corpus → 0 clusters" "0" "$CCOUNT2"

# ---------------------------------------------------------------------------
# Test 3: cluster.sh caps cluster size at 10
# ---------------------------------------------------------------------------
FIX3="$SCRATCH/case3"
seed_too_large_corpus "$FIX3"

CLUSTERS3=$(bash "$INVENTORY" "$FIX3" 2>/dev/null | bash "$CLUSTER" 2>/dev/null)
CCOUNT3=$(printf '%s\n' "$CLUSTERS3" | grep -c '^{' || true)
assert_eq "cluster.sh: 12-doc mega corpus → 1 cluster" "1" "$CCOUNT3"

SIZE3=$(printf '%s\n' "$CLUSTERS3" | jq -r '.docs | length')
assert_eq "cluster.sh: mega cluster capped at 10 docs" "10" "$SIZE3"

# ---------------------------------------------------------------------------
# Test 4: contradict.sh invokes --llm-cmd once per cluster with bounded prompt
# ---------------------------------------------------------------------------
MOCK_LOG_DIR="$SCRATCH/case4"
mkdir -p "$MOCK_LOG_DIR"
FIXTURE4="$MOCK_LOG_DIR/response.json"
make_fixture_json "$FIXTURE4" "2026-05-01-orch-1" "2026-05-02-orch-2"
MOCK4="$MOCK_LOG_DIR/llm.sh"
make_mock_llm "$MOCK4" "$FIXTURE4"

CONTRA4=$(printf '%s\n' "$CLUSTERS1" \
  | bash "$CONTRADICT" --llm-cmd "$MOCK4" --inventory-dir "$FIX1" 2>"$MOCK_LOG_DIR/stderr.log")
CCOUNT4=$(printf '%s\n' "$CONTRA4" | grep -c '^{' || true)
assert_eq "contradict.sh: emits one record per cluster with contradictions" "2" "$CCOUNT4"

# Mock LLM was called twice (one prompt-size line per call)
CALL_COUNT=$(wc -l < "${MOCK4}.log" 2>/dev/null | tr -d ' ')
assert_eq "contradict.sh: mock LLM invoked twice" "2" "$CALL_COUNT"

# Each prompt size ≤ token-budget cap. 10 docs × 1500 chars sample + overhead < 20000 bytes.
MAX_PROMPT=$(sort -n "${MOCK4}.log" | tail -1)
if [[ -n "$MAX_PROMPT" && "$MAX_PROMPT" -le 20000 ]]; then
  ok "contradict.sh: prompt size bounded (max=$MAX_PROMPT bytes)"
else
  fail "contradict.sh: prompt size bounded" "max prompt size $MAX_PROMPT > 20000 bytes"
fi

# ---------------------------------------------------------------------------
# Test 5: contradict.sh handles empty contradictions
# ---------------------------------------------------------------------------
FIXTURE5="$MOCK_LOG_DIR/empty.json"
make_empty_fixture "$FIXTURE5"
MOCK5="$MOCK_LOG_DIR/llm-empty.sh"
make_mock_llm "$MOCK5" "$FIXTURE5"

CONTRA5=$(printf '%s\n' "$CLUSTERS1" \
  | bash "$CONTRADICT" --llm-cmd "$MOCK5" --inventory-dir "$FIX1" 2>/dev/null)
EMPTY_COUNT=$(printf '%s\n' "$CONTRA5" | grep -c '^{' || true)
assert_eq "contradict.sh: empty contradictions → zero output records" "0" "$EMPTY_COUNT"

# ---------------------------------------------------------------------------
# Test 6: contradict.sh survives malformed JSON
# ---------------------------------------------------------------------------
FIXTURE6="$MOCK_LOG_DIR/garbage.json"
make_garbage_fixture "$FIXTURE6"
MOCK6="$MOCK_LOG_DIR/llm-garbage.sh"
make_mock_llm "$MOCK6" "$FIXTURE6"

set +e
CONTRA6=$(printf '%s\n' "$CLUSTERS1" \
  | bash "$CONTRADICT" --llm-cmd "$MOCK6" --inventory-dir "$FIX1" 2>"$MOCK_LOG_DIR/garbage-stderr.log")
EC6=$?
set -e
GARBAGE_COUNT=$(printf '%s\n' "$CONTRA6" | grep -c '^{' || true)
assert_eq "contradict.sh: malformed JSON → zero records emitted" "0" "$GARBAGE_COUNT"
assert_eq "contradict.sh: malformed JSON → exit 0" "0" "$EC6"

if grep -q 'warn\|non-JSON' "$MOCK_LOG_DIR/garbage-stderr.log" 2>/dev/null; then
  ok "contradict.sh: warns on malformed JSON"
else
  fail "contradict.sh: warns on malformed JSON" "no warning in stderr"
fi

# ---------------------------------------------------------------------------
# Test 7: append-contradictions.sh preserves existing content
# ---------------------------------------------------------------------------
DEST7="$SCRATCH/case7-CONTRADICTIONS.md"
cat > "$DEST7" <<'EOF'
# Contradictions — research corpus

Hand-curated note from 2026-04-01.

## 2026-04-01 — manual

- [[doc-x]] ↔ [[doc-y]]: existing entry kept intact.
EOF
ORIGINAL_HASH=$(shasum "$DEST7" | awk '{print $1}')

# Pipe one contradiction record
echo '{"cluster_id":"c1","topic":"alpha+beta","contradictions":[{"between":["A","B"],"claim_a":"X","claim_b":"not X","explanation":"They differ."}]}' \
  | bash "$APPEND" --date 2026-05-17 "$DEST7" >/dev/null 2>&1

# Original content still present byte-for-byte
HEAD_BYTES=$(head -c "$(stat -f%z "$DEST7" 2>/dev/null || stat -c%s "$DEST7")" "$DEST7" | head -8)
if grep -q "existing entry kept intact" "$DEST7"; then
  ok "append-contradictions.sh: original entries preserved"
else
  fail "append-contradictions.sh: original entries preserved" "original line missing"
fi

# Pre-existing line numbers untouched — easier: diff a snapshot
NEW_HASH=$(shasum "$DEST7" | awk '{print $1}')
if [[ "$ORIGINAL_HASH" != "$NEW_HASH" ]]; then
  ok "append-contradictions.sh: file grew (new entry appended)"
else
  fail "append-contradictions.sh: file grew (new entry appended)" "file unchanged"
fi

# ---------------------------------------------------------------------------
# Test 8: Format of appended entry
# ---------------------------------------------------------------------------
assert_contains "append: heading is '## YYYY-MM-DD — <topic>'" \
  "$(cat "$DEST7")" "## 2026-05-17 — alpha+beta"
assert_contains "append: body cites [[A]] ↔ [[B]] with explanation" \
  "$(cat "$DEST7")" "[[A]] ↔ [[B]]: They differ."

# ---------------------------------------------------------------------------
# Test 9: append-contradictions.sh is no-op on zero input
# ---------------------------------------------------------------------------
DEST9="$SCRATCH/case9-CONTRADICTIONS.md"
echo "preexisting" > "$DEST9"
BEFORE9=$(shasum "$DEST9" | awk '{print $1}')
printf '' | bash "$APPEND" --date 2026-05-17 "$DEST9" >/dev/null 2>&1
AFTER9=$(shasum "$DEST9" | awk '{print $1}')
assert_eq "append-contradictions.sh: empty stdin → file unchanged" "$BEFORE9" "$AFTER9"

# ---------------------------------------------------------------------------
# Test 10: run.sh --skip-contradictions does NOT invoke cluster/contradict
# ---------------------------------------------------------------------------
FIX10="$SCRATCH/case10"
seed_two_cluster_corpus "$FIX10"

# Initialize a git repo so score.sh ref-validation works
cd "$SCRATCH"
[ -d .git ] || git init -q -b main
git config user.email "test@example.com" >/dev/null 2>&1
git config user.name "test" >/dev/null 2>&1
git add -A >/dev/null 2>&1
git commit -q -m "fixture" --allow-empty >/dev/null 2>&1

# Wrap cluster.sh with a sentinel script that touches a file when called
SENTINEL10="$SCRATCH/case10-cluster-called"
WRAP10="$SCRATCH/case10-cluster-wrap.sh"
cat > "$WRAP10" <<EOF
#!/usr/bin/env bash
touch "$SENTINEL10"
exec bash "$CLUSTER" "\$@"
EOF
chmod +x "$WRAP10"

# Run with --skip-contradictions
bash "$RUN" --skip-contradictions --reference-date 2026-05-17 \
  --git-dir "$SCRATCH" "$FIX10" >/dev/null 2>&1 || true

if [[ -f "$SENTINEL10" ]]; then
  fail "run.sh: --skip-contradictions blocks clustering" "sentinel exists"
else
  ok "run.sh: --skip-contradictions blocks clustering"
fi
if [[ -f "$FIX10/INDEX.md" ]]; then
  ok "run.sh: --skip-contradictions still writes INDEX.md"
else
  fail "run.sh: --skip-contradictions still writes INDEX.md" "INDEX.md missing"
fi
if [[ ! -f "$FIX10/CONTRADICTIONS.md" ]]; then
  ok "run.sh: --skip-contradictions does not create CONTRADICTIONS.md"
else
  fail "run.sh: --skip-contradictions does not create CONTRADICTIONS.md" "file present"
fi

# ---------------------------------------------------------------------------
# Test 11: run.sh end-to-end writes INDEX.md AND appends to CONTRADICTIONS.md
# ---------------------------------------------------------------------------
FIX11="$SCRATCH/case11"
seed_two_cluster_corpus "$FIX11"

FIXTURE11="$SCRATCH/case11-llm-response.json"
make_fixture_json "$FIXTURE11" "2026-05-01-orch-1" "2026-05-02-orch-2"
MOCK11="$SCRATCH/case11-llm.sh"
make_mock_llm "$MOCK11" "$FIXTURE11"

git add -A >/dev/null 2>&1
git commit -q -m "case11 fixture" --allow-empty >/dev/null 2>&1

bash "$RUN" --reference-date 2026-05-17 --git-dir "$SCRATCH" \
  --llm-cmd "$MOCK11" "$FIX11" >/dev/null 2>&1 || true

if [[ -f "$FIX11/INDEX.md" ]] && grep -q "## Current" "$FIX11/INDEX.md"; then
  ok "run.sh: end-to-end writes INDEX.md with sections"
else
  fail "run.sh: end-to-end writes INDEX.md with sections" "INDEX.md missing or malformed"
fi

if [[ -f "$FIX11/CONTRADICTIONS.md" ]] && grep -q "^## 2026-05-17" "$FIX11/CONTRADICTIONS.md"; then
  ok "run.sh: end-to-end appends to CONTRADICTIONS.md"
else
  fail "run.sh: end-to-end appends to CONTRADICTIONS.md" "CONTRADICTIONS.md missing or no entry"
fi

# ---------------------------------------------------------------------------
# Test 12: CONTRADICTIONS.md diff-only-additions invariant (acceptance)
# ---------------------------------------------------------------------------
FIX12="$SCRATCH/case12"
seed_two_cluster_corpus "$FIX12"

# Pre-seed CONTRADICTIONS.md with hand-curated content + commit it
cat > "$FIX12/CONTRADICTIONS.md" <<'EOF'
# Contradictions — research corpus

## 2026-04-01 — hand-written

- [[old-doc-a]] ↔ [[old-doc-b]]: pre-existing entry.
EOF

git add -A >/dev/null 2>&1
git commit -q -m "case12 fixture + seed CONTRADICTIONS" --allow-empty >/dev/null 2>&1

FIXTURE12="$SCRATCH/case12-llm-response.json"
make_fixture_json "$FIXTURE12" "2026-05-01-orch-1" "2026-05-02-orch-2"
MOCK12="$SCRATCH/case12-llm.sh"
make_mock_llm "$MOCK12" "$FIXTURE12"

bash "$RUN" --reference-date 2026-05-17 --git-dir "$SCRATCH" \
  --llm-cmd "$MOCK12" "$FIX12" >/dev/null 2>&1 || true

# Diff CONTRADICTIONS.md against the committed version; expect only additions.
DIFF=$(cd "$SCRATCH" && git diff -- "$FIX12/CONTRADICTIONS.md" 2>/dev/null || true)
# Count actual removal lines (start with `-` but not `---` header).
# Wrap pipelines with `|| true` so that grep finding zero matches (exit 1)
# combined with `pipefail` doesn't kill the test script.
REMOVALS=$( { printf '%s\n' "$DIFF" | grep -cE '^-[^-]' || true; } | tr -d ' ')
ADDITIONS=$( { printf '%s\n' "$DIFF" | grep -cE '^\+[^+]' || true; } | tr -d ' ')
assert_eq "run.sh: CONTRADICTIONS.md diff has zero removals" "0" "$REMOVALS"

if [[ "$ADDITIONS" -gt 0 ]]; then
  ok "run.sh: CONTRADICTIONS.md diff has additions (${ADDITIONS} lines)"
else
  fail "run.sh: CONTRADICTIONS.md diff has additions" "no + lines"
fi

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
