#!/usr/bin/env bash
# Tests for check-config-drift.sh (CTL-489).
# Run: bash plugins/dev/scripts/__tests__/check-config-drift.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DRIFT="${REPO_ROOT}/plugins/dev/scripts/check-config-drift.sh"

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

echo "check-config-drift tests"

# ── Test 1: no drift — project matches template exactly → exit 0, no stdout ──
TPL1="${SCRATCH}/tpl1.json"
CFG1="${SCRATCH}/cfg1.json"
cat > "$TPL1" <<'EOF'
{
  "catalyst": {
    "projectKey": "x",
    "orchestration": { "dispatchMode": "phase-agents" }
  }
}
EOF
cat > "$CFG1" <<'EOF'
{
  "catalyst": {
    "projectKey": "x",
    "orchestration": { "dispatchMode": "phase-agents" }
  }
}
EOF
run "no drift → exit 0" expect_exit 0 bash "$DRIFT" --template "$TPL1" --config "$CFG1"
run "no drift → empty stdout" bash -c "
  out=\$(bash '$DRIFT' --template '$TPL1' --config '$CFG1' 2>/dev/null)
  [ -z \"\$out\" ]
"

# ── Test 2: single missing leaf at depth 3 → one warning + hint ──────────────
TPL2="${SCRATCH}/tpl2.json"
CFG2="${SCRATCH}/cfg2.json"
cat > "$TPL2" <<'EOF'
{
  "catalyst": {
    "projectKey": "x",
    "orchestration": { "dispatchMode": "phase-agents" }
  }
}
EOF
cat > "$CFG2" <<'EOF'
{ "catalyst": { "projectKey": "x" } }
EOF
run "missing leaf → exit 1" expect_exit 1 bash "$DRIFT" --template "$TPL2" --config "$CFG2"
bash "$DRIFT" --template "$TPL2" --config "$CFG2" > "${SCRATCH}/out2" 2>/dev/null || true
run "missing dispatchMode mentioned" expect_contains "${SCRATCH}/out2" "Missing catalyst.orchestration.dispatchMode"
run "template default quoted" expect_contains "${SCRATCH}/out2" 'template suggests "phase-agents"'
run "hint mentions setup-catalyst" expect_contains "${SCRATCH}/out2" "/catalyst-dev:setup-catalyst"

# ── Test 3: nested object exists but leaf inside is missing ──────────────────
TPL3="${SCRATCH}/tpl3.json"
CFG3="${SCRATCH}/cfg3.json"
cat > "$TPL3" <<'EOF'
{ "catalyst": { "a": { "b": { "c": 1, "d": 2 } } } }
EOF
cat > "$CFG3" <<'EOF'
{ "catalyst": { "a": { "b": { "c": 1 } } } }
EOF
run "nested missing leaf → exit 1" expect_exit 1 bash "$DRIFT" --template "$TPL3" --config "$CFG3"
bash "$DRIFT" --template "$TPL3" --config "$CFG3" > "${SCRATCH}/out3" 2>/dev/null || true
run "warns for a.b.d only" expect_contains "${SCRATCH}/out3" "Missing catalyst.a.b.d"
run "does NOT warn for a.b" expect_not_contains "${SCRATCH}/out3" "Missing catalyst.a.b "
run "does NOT warn for bare a" expect_not_contains "${SCRATCH}/out3" "Missing catalyst.a "

# ── Test 4: comment/$schema keys stripped from drift paths ───────────────────
TPL4="${SCRATCH}/tpl4.json"
CFG4="${SCRATCH}/cfg4.json"
cat > "$TPL4" <<'EOF'
{
  "$schema": "https://example.com/schema",
  "$comment": "top-level comment",
  "catalyst": {
    "_comment": "section comment",
    "$comment": "another",
    "z": { "v": 1 }
  }
}
EOF
cat > "$CFG4" <<'EOF'
{}
EOF
run "comment keys → exit 1 (real keys missing)" expect_exit 1 bash "$DRIFT" --template "$TPL4" --config "$CFG4"
bash "$DRIFT" --template "$TPL4" --config "$CFG4" > "${SCRATCH}/out4" 2>/dev/null || true
run "no \$schema path emitted" expect_not_contains "${SCRATCH}/out4" '$schema'
run "no \$comment path emitted" expect_not_contains "${SCRATCH}/out4" '$comment'
run "no _comment path emitted" expect_not_contains "${SCRATCH}/out4" "_comment"
run "real z.v path is emitted" expect_contains "${SCRATCH}/out4" "Missing catalyst.z.v"

# ── Test 5: placeholder branches [YOUR_ORG]/[YOUR_REPO] skipped ──────────────
TPL5="${SCRATCH}/tpl5.json"
CFG5="${SCRATCH}/cfg5.json"
cat > "$TPL5" <<'EOF'
{
  "catalyst": {
    "deploy": {
      "[YOUR_ORG]/[YOUR_REPO]": { "timeoutSec": 1800 }
    },
    "orchestration": { "dispatchMode": "phase-agents" }
  }
}
EOF
cat > "$CFG5" <<'EOF'
{ "catalyst": {} }
EOF
run "placeholder template → exit 1 (other keys missing)" expect_exit 1 bash "$DRIFT" --template "$TPL5" --config "$CFG5"
bash "$DRIFT" --template "$TPL5" --config "$CFG5" > "${SCRATCH}/out5" 2>/dev/null || true
run "no placeholder drift for YOUR_ORG" expect_not_contains "${SCRATCH}/out5" "YOUR_ORG"
run "no placeholder drift for YOUR_REPO" expect_not_contains "${SCRATCH}/out5" "YOUR_REPO"
run "no placeholder drift for deploy" expect_not_contains "${SCRATCH}/out5" "Missing catalyst.deploy"
run "dispatchMode drift still fires" expect_contains "${SCRATCH}/out5" "Missing catalyst.orchestration.dispatchMode"

# ── Test 6: allow-listed roots suppressed (already covered by check-project-setup.sh) ──
TPL6="${SCRATCH}/tpl6.json"
CFG6="${SCRATCH}/cfg6.json"
cat > "$TPL6" <<'EOF'
{
  "catalyst": {
    "projectKey": "x",
    "project": { "ticketPrefix": "PROJ" },
    "linear": {
      "teamKey": "PROJ",
      "stateMap": { "research": "In Progress" },
      "stateIds": { "research": "uuid-x" }
    },
    "orchestration": { "dispatchMode": "phase-agents" }
  }
}
EOF
cat > "$CFG6" <<'EOF'
{ "catalyst": {} }
EOF
run "allow-list scenario → exit 1" expect_exit 1 bash "$DRIFT" --template "$TPL6" --config "$CFG6"
bash "$DRIFT" --template "$TPL6" --config "$CFG6" > "${SCRATCH}/out6" 2>/dev/null || true
run "suppresses projectKey" expect_not_contains "${SCRATCH}/out6" "Missing catalyst.projectKey"
run "suppresses ticketPrefix" expect_not_contains "${SCRATCH}/out6" "Missing catalyst.project.ticketPrefix"
run "suppresses teamKey" expect_not_contains "${SCRATCH}/out6" "Missing catalyst.linear.teamKey"
run "suppresses stateMap sub-keys" expect_not_contains "${SCRATCH}/out6" "Missing catalyst.linear.stateMap"
run "suppresses stateIds sub-keys" expect_not_contains "${SCRATCH}/out6" "Missing catalyst.linear.stateIds"
run "non-allow-listed dispatchMode still warns" expect_contains "${SCRATCH}/out6" "Missing catalyst.orchestration.dispatchMode"

# ── Test 7: --json mode emits structured array ───────────────────────────────
bash "$DRIFT" --json --template "$TPL2" --config "$CFG2" > "${SCRATCH}/out7" 2>/dev/null || true
run "--json output parses as JSON" bash -c "jq empty < '${SCRATCH}/out7'"
run "--json output is an array" bash -c "
  type=\$(jq -r 'type' < '${SCRATCH}/out7')
  [ \"\$type\" = \"array\" ]
"
run "--json elements have path field" bash -c "
  has_path=\$(jq -r '.[0] | has(\"path\")' < '${SCRATCH}/out7')
  [ \"\$has_path\" = \"true\" ]
"
run "--json elements have template_value field" bash -c "
  has_v=\$(jq -r '.[0] | has(\"template_value\")' < '${SCRATCH}/out7')
  [ \"\$has_v\" = \"true\" ]
"

# ── Test 8: --merge-into preserves existing values, adds missing ─────────────
TPL8="${SCRATCH}/tpl8.json"
CFG8="${SCRATCH}/cfg8.json"
cat > "$TPL8" <<'EOF'
{
  "catalyst": {
    "projectKey": "default",
    "orchestration": { "dispatchMode": "phase-agents" }
  }
}
EOF
cat > "$CFG8" <<'EOF'
{ "catalyst": { "projectKey": "user-chosen-name" } }
EOF
OUT8="${SCRATCH}/merged8.json"
run "--merge-into runs" bash "$DRIFT" --template "$TPL8" --config "$CFG8" --merge-into "$OUT8"
run "merge preserves projectKey" bash -c "
  v=\$(jq -r '.catalyst.projectKey' < '$OUT8')
  [ \"\$v\" = \"user-chosen-name\" ]
"
run "merge adds dispatchMode" bash -c "
  v=\$(jq -r '.catalyst.orchestration.dispatchMode' < '$OUT8')
  [ \"\$v\" = \"phase-agents\" ]
"

# ── Test 9: --merge-into never overwrites user values ────────────────────────
TPL9="${SCRATCH}/tpl9.json"
CFG9="${SCRATCH}/cfg9.json"
cat > "$TPL9" <<'EOF'
{ "catalyst": { "filter": { "groqModel": "llama-3.1-8b-instant" } } }
EOF
cat > "$CFG9" <<'EOF'
{ "catalyst": { "filter": { "groqModel": "user-custom-model" } } }
EOF
OUT9="${SCRATCH}/merged9.json"
run "--merge-into runs (custom groqModel)" bash "$DRIFT" --template "$TPL9" --config "$CFG9" --merge-into "$OUT9"
run "merge keeps user groqModel" bash -c "
  v=\$(jq -r '.catalyst.filter.groqModel' < '$OUT9')
  [ \"\$v\" = \"user-custom-model\" ]
"

# ── Test 10: missing jq → exit 2 ─────────────────────────────────────────────
FAKE_PATH_DIR="$SCRATCH/nojq"
mkdir -p "$FAKE_PATH_DIR"
for bin in bash sh git date mktemp grep sed awk cat cut head tail sort tr rm mkdir readlink dirname realpath env; do
  if command -v "$bin" >/dev/null 2>&1; then
    ln -sf "$(command -v "$bin")" "$FAKE_PATH_DIR/$bin"
  fi
done
run "missing jq → exit 2" bash -c "PATH='$FAKE_PATH_DIR' bash '$DRIFT' --template '$TPL1' --config '$CFG1' >/dev/null 2>&1; [ \$? = 2 ]"

# ── Test 11: malformed project JSON → exit 2 ─────────────────────────────────
BADCFG="${SCRATCH}/bad.json"
echo "not json{" > "$BADCFG"
run "malformed project JSON → exit 2" bash -c "bash '$DRIFT' --template '$TPL1' --config '$BADCFG' >/dev/null 2>&1; [ \$? = 2 ]"

# ── Test 12: missing project file → exit 2 ──────────────────────────────────
run "missing project file → exit 2" bash -c "bash '$DRIFT' --template '$TPL1' --config '$SCRATCH/no-such-file.json' >/dev/null 2>&1; [ \$? = 2 ]"

# ── Test 12b: missing template file → exit 2 ────────────────────────────────
# Pins the template-not-found branch (separate from missing-config). Guards
# against an install-path regression where $TEMPLATE_PATH points at a stale
# location.
run "missing template file → exit 2" bash -c "bash '$DRIFT' --template '$SCRATCH/no-template.json' --config '$CFG1' >/dev/null 2>&1; [ \$? = 2 ]"

# ── Test 12c: --merge-into with empty FILE arg → exit 2 ─────────────────────
# Pins the empty-merge-target guard at lines 81-84. Without this, a future
# templating regression upstream (unset var consumed as the arg) would silently
# write to .tmp.$$ in CWD.
run "--merge-into '' → exit 2" bash -c "bash '$DRIFT' --template '$TPL1' --config '$CFG1' --merge-into '' >/dev/null 2>&1; [ \$? = 2 ]"

# ── Test 13: runs against the real catalyst template without error ───────────
# The catalyst repo's own .catalyst/config.json has known drift (repository.org,
# project.name, filter.groqModel — plan's "clean" claim was overstated). The script
# must exit non-2 (no setup error) and emit warnings; cleaning the actual config
# is the manual acceptance test for /catalyst-dev:setup-catalyst, not this script.
REAL_TPL="${REPO_ROOT}/plugins/dev/templates/config.template.json"
REAL_CFG="${REPO_ROOT}/.catalyst/config.json"
if [ -f "$REAL_TPL" ] && [ -f "$REAL_CFG" ]; then
  run "catalyst repo's own config: script runs cleanly (no setup error)" bash -c "
    bash '$DRIFT' --template '$REAL_TPL' --config '$REAL_CFG' >/dev/null 2>&1
    rc=\$?
    [ \"\$rc\" = 0 ] || [ \"\$rc\" = 1 ]
  "
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
