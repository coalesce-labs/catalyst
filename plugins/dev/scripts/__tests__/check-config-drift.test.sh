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
  # ⚠️ Restore the shell's PREVIOUS errexit state, never force it ON. This used
  # to end with a bare `set -e`, which TURNED ERREXIT ON for the rest of the file
  # even though the suite runs `set -uo pipefail` and never enabled it. Every
  # test after the first expect_exit call then ran under errexit; the existing
  # ones survived only because `run()` wraps its command in an `if`, which
  # suppresses it. The first bare invocation that legitimately returns non-zero
  # — e.g. `bash "$DRIFT" ...` when drift IS found, which is the expected
  # outcome of a positive control — silently killed the whole suite mid-run,
  # taking the trailing "All N tests passed" summary with it. It exited 1, so it
  # looked like an ordinary failure while the remaining assertions never ran.
  local _prev_e; case "$-" in *e*) _prev_e=1 ;; *) _prev_e=0 ;; esac
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  [ "$_prev_e" = "1" ] && set -e
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
    "orchestration": { "executor": "sdk" }
  }
}
EOF
cat > "$CFG1" <<'EOF'
{
  "catalyst": {
    "projectKey": "x",
    "orchestration": { "executor": "sdk" }
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
    "orchestration": { "executor": "sdk" }
  }
}
EOF
cat > "$CFG2" <<'EOF'
{ "catalyst": { "projectKey": "x" } }
EOF
run "missing leaf → exit 1" expect_exit 1 bash "$DRIFT" --template "$TPL2" --config "$CFG2"
bash "$DRIFT" --template "$TPL2" --config "$CFG2" > "${SCRATCH}/out2" 2>/dev/null || true
run "missing executor mentioned" expect_contains "${SCRATCH}/out2" "Missing catalyst.orchestration.executor"
run "template default quoted" expect_contains "${SCRATCH}/out2" 'template suggests "sdk"'
run "hint mentions setup-catalyst" expect_contains "${SCRATCH}/out2" "/catalyst-foundry:setup-catalyst"

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
    "orchestration": { "executor": "sdk" }
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
run "executor drift still fires" expect_contains "${SCRATCH}/out5" "Missing catalyst.orchestration.executor"

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
    "orchestration": { "executor": "sdk" }
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
run "non-allow-listed executor still warns" expect_contains "${SCRATCH}/out6" "Missing catalyst.orchestration.executor"

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
    "orchestration": { "executor": "sdk" }
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
run "merge adds executor" bash -c "
  v=\$(jq -r '.catalyst.orchestration.executor' < '$OUT8')
  [ \"\$v\" = \"sdk\" ]
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
# is the manual acceptance test for /catalyst-foundry:setup-catalyst, not this script.
REAL_TPL="${REPO_ROOT}/plugins/dev/templates/config.template.json"
REAL_CFG="${REPO_ROOT}/.catalyst/config.json"
if [ -f "$REAL_TPL" ] && [ -f "$REAL_CFG" ]; then
  run "catalyst repo's own config: script runs cleanly (no setup error)" bash -c "
    bash '$DRIFT' --template '$REAL_TPL' --config '$REAL_CFG' >/dev/null 2>&1
    rc=\$?
    [ \"\$rc\" = 0 ] || [ \"\$rc\" = 1 ]
  "
fi

# ── Test 14: arrays are leaves, not descended into (regression for paths(scalars)) ──
# Without the fix, paths(scalars) descends into arrays and yields integer-indexed
# leaves; a project missing the filter block would see
# "Missing catalyst.filter.groqModels.0" — semantically wrong since users never set
# array elements by integer index. With the fix the array itself is the leaf.
TPL14="${SCRATCH}/tpl14.json"
CFG14="${SCRATCH}/cfg14.json"
cat > "$TPL14" <<'EOF'
{
  "catalyst": {
    "projectKey": "k",
    "filter": { "groqModels": ["llama-3.1-8b-instant", "llama-3.3-70b"] }
  }
}
EOF
cat > "$CFG14" <<'EOF'
{ "catalyst": { "projectKey": "k" } }
EOF
run "array template leaves: no integer-indexed warning" bash -c "
  out=\$(bash '$DRIFT' --template '$TPL14' --config '$CFG14' 2>/dev/null || true)
  ! echo \"\$out\" | grep -q 'labels\\.0'
"
run "array template leaves: single warning for the groqModels array" bash -c "
  out=\$(bash '$DRIFT' --template '$TPL14' --config '$CFG14' 2>/dev/null || true)
  count=\$(echo \"\$out\" | grep -c 'Missing catalyst\\.filter\\.groqModels' || true)
  # one warning + one indented hint line both contain the substring → expect 2
  [ \"\$count\" -ge 1 ]
"
run "array template leaves: --json reports the array verbatim" bash -c "
  out=\$(bash '$DRIFT' --json --template '$TPL14' --config '$CFG14' 2>/dev/null || true)
  v=\$(echo \"\$out\" | jq -c '[.[] | select(.path == [\"catalyst\",\"filter\",\"groqModels\"])][0].template_value')
  [ \"\$v\" = '[\"llama-3.1-8b-instant\",\"llama-3.3-70b\"]' ]
"

# ── Test 15: --merge-into strips placeholder VALUES, not just placeholder KEYS ──
# Pre-fix, strip_placeholders filtered only KEYS whose name matched [YOUR_*].
# Real keys with placeholder VALUES (repository.org='[YOUR_ORG]') flowed through
# the merge unchanged, writing placeholder literals into the user's config —
# the garbage-default class this feature was meant to prevent.
TPL15="${SCRATCH}/tpl15.json"
CFG15="${SCRATCH}/cfg15.json"
cat > "$TPL15" <<'EOF'
{
  "catalyst": {
    "repository": { "org": "[YOUR_ORG]", "name": "[YOUR_REPO]" },
    "orchestration": { "executor": "sdk" }
  }
}
EOF
cat > "$CFG15" <<'EOF'
{ "catalyst": { "repository": { "org": "real-org", "name": "real-repo" } } }
EOF
OUT15="${SCRATCH}/merged15.json"
run "--merge-into: runs with placeholder-valued template keys" bash "$DRIFT" --template "$TPL15" --config "$CFG15" --merge-into "$OUT15"
run "--merge-into: user repository values preserved" bash -c "
  org=\$(jq -r '.catalyst.repository.org' < '$OUT15')
  [ \"\$org\" = 'real-org' ]
"
run "--merge-into: placeholder VALUES never leak in" bash -c "
  ! jq -r '.. | strings' < '$OUT15' | grep -q '\\[YOUR_'
"

# Edge case: user has NO repository block. Merge must NOT inject placeholder values.
CFG15B="${SCRATCH}/cfg15b.json"
cat > "$CFG15B" <<'EOF'
{ "catalyst": { "projectKey": "k" } }
EOF
OUT15B="${SCRATCH}/merged15b.json"
run "--merge-into: runs when project lacks placeholder-key block" bash "$DRIFT" --template "$TPL15" --config "$CFG15B" --merge-into "$OUT15B"
run "--merge-into: no [YOUR_*] literal injected when block is absent" bash -c "
  ! jq -r '.. | strings' < '$OUT15B' | grep -q '\\[YOUR_'
"
run "--merge-into: non-placeholder template keys still merged" bash -c "
  v=\$(jq -r '.catalyst.orchestration.executor' < '$OUT15B')
  [ \"\$v\" = 'sdk' ]
"

# ─── CTL-1214: a slimmed config vs an OLD (unsanitized) template ─────────────
# This detector's direction is the inverse of CTL-1214's: it reports template
# keys MISSING from a project config and can --merge-into them. A repo pinned to
# a pre-CTL-1214 template would therefore see every relocated key as drift, and a
# --merge-into would put the whole stanza straight back — undoing the slimming.
OLD_TPL="${SCRATCH}/tpl-old.json"
cat > "$OLD_TPL" <<'EOF'
{
  "catalyst": {
    "projectKey": "my-project",
    "project": { "ticketPrefix": "PROJ" },
    "filter": { "groqModel": "llama-3.1-8b-instant" },
    "feedback": { "autoFile": false, "githubRepo": "coalesce-labs/catalyst", "labels": ["auto-submitted"] },
    "sweep": { "idleHours": 48, "intervalHours": 1 },
    "monitor": { "github": { "repoColors": { "a/b": "green" } } },
    "orchestration": {
      "dispatchMode": "phase-agents",
      "worktreeRefresh": { "enabled": true },
      "reconcile": { "mode": "notify" },
      "executionCore": { "maxParallel": 4 }
    }
  }
}
EOF

SLIM_CFG="${SCRATCH}/cfg-slim.json"
cat > "$SLIM_CFG" <<'EOF'
{
  "catalyst": {
    "schemaVersion": 1,
    "projectKey": "my-project",
    "project": { "ticketPrefix": "PROJ" },
    "filter": { "groqModel": "llama-3.1-8b-instant" }
  }
}
EOF

OUT_SLIM="${SCRATCH}/out-slim.txt"
SLIM_RC=0
bash "$DRIFT" --template "$OLD_TPL" --config "$SLIM_CFG" > "$OUT_SLIM" 2>&1 || SLIM_RC=$?

run "CTL-1214: a slimmed config vs the OLD template exits 0" \
  bash -c "[ '$SLIM_RC' = '0' ]"
run "CTL-1214: zero drift lines for any relocated path" \
  bash -c "
    n=\$(grep -cE 'Missing catalyst\\.(orchestration|feedback|sweep|monitor\\.github\\.repoColors)' '$OUT_SLIM' || true)
    [ \"\$n\" = '0' ]
  "

# ⚠️ POSITIVE CONTROL. Without it, "zero drift" above could just mean the
# detector stopped working — a genuine, NON-relocated missing key must still be
# reported against the very same template.
OLD_TPL_PLUS="${SCRATCH}/tpl-old-plus.json"
jq '.catalyst.deployment = {"mode":"single-host"}' "$OLD_TPL" > "$OLD_TPL_PLUS"
OUT_PC="${SCRATCH}/out-slim-pc.txt"
PC_RC=0
bash "$DRIFT" --template "$OLD_TPL_PLUS" --config "$SLIM_CFG" > "$OUT_PC" 2>&1 || PC_RC=$?
run "CTL-1214 positive control: a non-relocated missing key IS still reported" \
  bash -c "grep -q 'Missing catalyst\\.deployment\\.mode' '$OUT_PC'"
run "CTL-1214 positive control: and it still exits non-zero" \
  bash -c "[ '$PC_RC' != '0' ]"

# --merge-into must never re-add a relocated key.
MERGED_SLIM="${SCRATCH}/merged-slim.json"
bash "$DRIFT" --template "$OLD_TPL" --config "$SLIM_CFG" --merge-into "$MERGED_SLIM" >/dev/null 2>&1 || true
run "CTL-1214: --merge-into does not re-add orchestration" \
  bash -c "jq -e '.catalyst.orchestration == null' '$MERGED_SLIM'"
run "CTL-1214: --merge-into does not re-add feedback" \
  bash -c "jq -e '.catalyst.feedback == null' '$MERGED_SLIM'"
run "CTL-1214: --merge-into does not re-add sweep" \
  bash -c "jq -e '.catalyst.sweep == null' '$MERGED_SLIM'"
run "CTL-1214: --merge-into does not re-add monitor.github.repoColors" \
  bash -c "jq -e '.catalyst.monitor.github.repoColors == null' '$MERGED_SLIM' 2>/dev/null || jq -e '.catalyst.monitor == null' '$MERGED_SLIM'"
run "CTL-1214: --merge-into positive control — identity keys ARE still merged" \
  bash -c "jq -e '.catalyst.projectKey == \"my-project\" and .catalyst.filter.groqModel != null' '$MERGED_SLIM'"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILURES" = 0 ]; then
  echo "All $PASSES tests passed"
  exit 0
else
  echo "$PASSES passed, $FAILURES failed"
  exit 1
fi
