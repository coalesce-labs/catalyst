#!/usr/bin/env bash
# Tests for check-project-setup.sh — focuses on the CTL-253 webhook-pipeline checks
# (smee binary, smeeChannel + Linear webhookId both in cross-project Layer 2 — see CTL-272).
# Run: bash plugins/dev/scripts/__tests__/check-project-setup.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/check-project-setup.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Build an isolated project dir with a minimal valid .catalyst/config.json and an
# isolated $XDG_CONFIG_HOME for cross-project + per-project Layer 2 fixtures.
#   $1 — project dir to create
#   $2 — projectKey
make_project() {
  local dir="$1" key="$2"
  mkdir -p "$dir/.catalyst"
  cat > "$dir/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "$key",
    "project": { "ticketPrefix": "CTL" },
    "linear": {
      "teamKey": "CTL",
      "stateMap": { "research": "Research" }
    }
  }
}
EOF
  # thoughts/shared subdirs so the early thoughts checks don't dominate output
  mkdir -p "$dir/thoughts/shared/research" "$dir/thoughts/shared/plans" \
    "$dir/thoughts/shared/handoffs" "$dir/thoughts/shared/prs" "$dir/thoughts/shared/reports"
}

# Run the script in a fully isolated env: PATH stripped so `humanlayer` and `smee`
# are guaranteed-absent regardless of host setup; XDG_CONFIG_HOME pointed at the
# scratch dir so home Layer 2 files come from the fixture.
run_script() {
  local cwd="$1"
  ( cd "$cwd" \
    && env -i HOME="$HOME" PATH="/usr/bin:/bin" \
       XDG_CONFIG_HOME="$SCRATCH/xdg" \
       bash "$SCRIPT" \
  )
}

assert_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected substring: $pattern"
    echo "    actual output:"
    sed 's/^/      /' <<<"$output"
  fi
}

assert_not_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    unexpected substring: $pattern"
    echo "    actual output:"
    sed 's/^/      /' <<<"$output"
  else
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  fi
}

# ─── Test: smee binary missing → warn ───────────────────────────────────────
test_smee_missing() {
  echo "test: smee binary missing → warn (PATH stripped of npm bin)"
  local proj="$SCRATCH/proj-smee" key="proj-smee"
  make_project "$proj" "$key"
  mkdir -p "$SCRATCH/xdg/catalyst"
  # Configured smeeChannel + webhookId (both in cross-project Layer 2) so only the
  # smee binary check fires
  cat > "$SCRATCH/xdg/catalyst/config.json" <<EOF
{ "catalyst": { "monitor": {
  "github": { "smeeChannel": "https://smee.io/abc" },
  "linear": { "webhookId": "wh_test_123" }
} } }
EOF
  echo '{}' > "$SCRATCH/xdg/catalyst/config-${key}.json"

  local out
  out=$(run_script "$proj" 2>&1)
  assert_grep "smee binary warn fires" "$out" "smee binary not on PATH"
  assert_grep "install hint suggests smee-client" "$out" "npm install -g smee-client"
  assert_not_grep "smeeChannel warn does NOT fire" "$out" "Missing catalyst.monitor.github.smeeChannel"
  assert_not_grep "Linear webhook warn does NOT fire" "$out" "Missing catalyst.monitor.linear.webhookId"
}

# ─── Test: smeeChannel missing → warn (independent of daemon — the script
# never queries the daemon, so this implicitly proves AC #3) ────────────────
test_smee_channel_missing() {
  echo "test: smeeChannel missing → warn"
  local proj="$SCRATCH/proj-channel" key="proj-channel"
  make_project "$proj" "$key"
  mkdir -p "$SCRATCH/xdg/catalyst"
  # Home config has linear webhookId but no smeeChannel (so we isolate the smeeChannel warn)
  cat > "$SCRATCH/xdg/catalyst/config.json" <<EOF
{ "catalyst": { "monitor": { "linear": { "webhookId": "wh_test_123" } } } }
EOF
  echo '{}' > "$SCRATCH/xdg/catalyst/config-${key}.json"

  local out
  out=$(run_script "$proj" 2>&1)
  assert_grep "smeeChannel missing warn fires" "$out" "Missing catalyst.monitor.github.smeeChannel"
  assert_grep "fix command points at setup-webhooks.sh" "$out" "setup-webhooks.sh"
}

# ─── Test: home config file missing entirely → warn ─────────────────────────
test_home_config_missing() {
  echo "test: home config file missing entirely → warn"
  local proj="$SCRATCH/proj-nohome" key="proj-nohome"
  make_project "$proj" "$key"
  # No $SCRATCH/xdg/catalyst/ at all
  rm -rf "$SCRATCH/xdg"

  local out
  out=$(run_script "$proj" 2>&1)
  assert_grep "missing-home-config warn fires" "$out" "Cross-project Layer 2 config missing"
}

# ─── Test: Linear webhookId missing → warn ──────────────────────────────────
test_linear_webhook_missing() {
  echo "test: Linear webhookId missing in cross-project Layer 2 → warn"
  local proj="$SCRATCH/proj-linear" key="proj-linear"
  make_project "$proj" "$key"
  mkdir -p "$SCRATCH/xdg/catalyst"
  # smeeChannel present, webhookId absent — only the Linear warn should fire
  cat > "$SCRATCH/xdg/catalyst/config.json" <<EOF
{ "catalyst": { "monitor": { "github": { "smeeChannel": "https://smee.io/abc" } } } }
EOF
  echo '{}' > "$SCRATCH/xdg/catalyst/config-${key}.json"

  local out
  out=$(run_script "$proj" 2>&1)
  assert_grep "Linear webhook warn fires" "$out" "Missing catalyst.monitor.linear.webhookId"
  assert_grep "Linear fix hint mentions --linear-register" "$out" "setup-webhooks.sh --linear-register"
}

# ─── Test: all configured → no webhook warnings ─────────────────────────────
test_all_configured() {
  echo "test: all webhook config present → no webhook warnings"
  local proj="$SCRATCH/proj-allgood" key="proj-allgood"
  make_project "$proj" "$key"
  mkdir -p "$SCRATCH/xdg/catalyst"
  cat > "$SCRATCH/xdg/catalyst/config.json" <<EOF
{ "catalyst": { "monitor": {
  "github": { "smeeChannel": "https://smee.io/abc" },
  "linear": { "webhookId": "wh_test_456" }
} } }
EOF
  echo '{}' > "$SCRATCH/xdg/catalyst/config-${key}.json"

  local out
  out=$(run_script "$proj" 2>&1)
  assert_not_grep "no smeeChannel warn" "$out" "Missing catalyst.monitor.github.smeeChannel"
  assert_not_grep "no missing-home-config warn" "$out" "Cross-project Layer 2 config missing"
  assert_not_grep "no Linear webhook warn" "$out" "Missing catalyst.monitor.linear.webhookId"
}

# ─── Run ────────────────────────────────────────────────────────────────────
test_smee_missing
test_smee_channel_missing
test_home_config_missing
test_linear_webhook_missing
test_all_configured

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
