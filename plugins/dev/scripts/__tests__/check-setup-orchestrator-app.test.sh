#!/usr/bin/env bash
# Tests for the check-setup.sh orchestrator Linear app credential check (CTL-785).
# Verifies that check-setup.sh reports pass/warn correctly for configured,
# partial, and absent orchestrator app credentials — and that the secret never
# appears in output.
#
# Run: bash plugins/dev/scripts/__tests__/check-setup-orchestrator-app.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/check-setup.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

FIXTURE_SECRET="super-secret-value-$$"

assert_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected substring: $pattern"
    echo "    actual output (truncated):"
    echo "$output" | head -20 | sed 's/^/      /'
  fi
}

assert_not_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label (unexpected pattern found)"
    echo "    unexpected substring: $pattern"
  else
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  fi
}

# make_xdg <dir> <clientId> <clientSecret>
# Writes a minimal ~/.config/catalyst/config.json fixture under <dir>/catalyst/config.json.
# Pass empty strings to omit a field entirely.
make_xdg() {
  local dir="$1" client_id="$2" client_secret="$3"
  local cfg_dir="${dir}/catalyst"
  mkdir -p "$cfg_dir"

  local orch_block
  if [[ -n "$client_id" && -n "$client_secret" ]]; then
    orch_block="{\"clientId\":\"${client_id}\",\"clientSecret\":\"${client_secret}\"}"
  elif [[ -n "$client_id" ]]; then
    orch_block="{\"clientId\":\"${client_id}\"}"
  elif [[ -n "$client_secret" ]]; then
    orch_block="{\"clientSecret\":\"${client_secret}\"}"
  else
    orch_block="{}"
  fi

  cat > "${cfg_dir}/config.json" <<EOF
{
  "catalyst": {
    "linear": {
      "bot": {
        "orchestrator": ${orch_block}
      }
    }
  }
}
EOF
}

# make_project <dir> — minimal .catalyst/config.json so check-setup.sh can run
make_project() {
  local dir="$1"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test",
    "project": { "ticketPrefix": "TST" },
    "linear": { "teamKey": "TST", "stateMap": { "research": "Research" } }
  }
}
EOF
  mkdir -p "${dir}/thoughts/shared/research" "${dir}/thoughts/shared/plans" \
    "${dir}/thoughts/shared/handoffs" "${dir}/thoughts/shared/prs" \
    "${dir}/thoughts/shared/reports"
}

# run_script <project-dir> <xdg-dir>
run_script() {
  local cwd="$1" xdg_dir="$2"
  ( cd "$cwd" \
    && env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
       XDG_CONFIG_HOME="$xdg_dir" CATALYST_AUTONOMOUS=1 \
       bash "$SCRIPT" 2>&1 || true )
}

echo "check-setup.sh orchestrator app credential tests (CTL-785)"

# ─── Test 1: both clientId + clientSecret configured → pass ──────────────────
P1="${SCRATCH}/p1" X1="${SCRATCH}/x1"
make_project "$P1"
make_xdg "$X1" "my-client-id-123" "$FIXTURE_SECRET"
OUT1="$(run_script "$P1" "$X1")"

assert_grep "configured creds pass" "$OUT1" "Orchestrator Linear app credentials configured"
assert_not_grep "secret not printed" "$OUT1" "$FIXTURE_SECRET"

# ─── Test 2: clientId only (partial) → warn ───────────────────────────────────
P2="${SCRATCH}/p2" X2="${SCRATCH}/x2"
make_project "$P2"
make_xdg "$X2" "my-client-id-456" ""
OUT2="$(run_script "$P2" "$X2")"

assert_grep "partial creds warn" "$OUT2" "Orchestrator Linear app credentials incomplete"

# ─── Test 3: clientSecret only (partial) → warn ──────────────────────────────
P3="${SCRATCH}/p3" X3="${SCRATCH}/x3"
make_project "$P3"
make_xdg "$X3" "" "$FIXTURE_SECRET"
OUT3="$(run_script "$P3" "$X3")"

assert_grep "partial creds (secret only) warn" "$OUT3" "Orchestrator Linear app credentials incomplete"
assert_not_grep "secret not printed (partial case)" "$OUT3" "$FIXTURE_SECRET"

# ─── Test 4: neither configured → warn + fallback explanation ────────────────
P4="${SCRATCH}/p4" X4="${SCRATCH}/x4"
make_project "$P4"
make_xdg "$X4" "" ""
OUT4="$(run_script "$P4" "$X4")"

assert_grep "absent warn" "$OUT4" "Orchestrator Linear app not configured"
assert_grep "fallback explanation" "$OUT4" "daemon will fall back to the personal LINEAR_API_TOKEN"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
