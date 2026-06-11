#!/usr/bin/env bash
# CTL-722 Phase 3: setup_execution_core_states must NOT early-return for a
# phase-agents repo — the dispatchMode gate is removed so every --full run
# provisions the contract states + registry entry.
#
# Run: bash plugins/dev/scripts/__tests__/setup-catalyst-statemap-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP_SCRIPT="${REPO_ROOT}/setup-catalyst.sh"

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

echo "setup-catalyst-statemap-gate tests (CTL-722)"

# Build a fake plugin root with a sentinel states script.
# When invoked, the sentinel writes a marker file and exits 0.
FAKE_PLUGIN_ROOT="${SCRATCH}/fake-plugin"
mkdir -p "${FAKE_PLUGIN_ROOT}/scripts"
SENTINEL="${SCRATCH}/states-script-ran"
cat > "${FAKE_PLUGIN_ROOT}/scripts/setup-execution-core-states.sh" <<STUB
#!/usr/bin/env bash
touch "${SENTINEL}"
exit 0
STUB
chmod +x "${FAKE_PLUGIN_ROOT}/scripts/setup-execution-core-states.sh"

# Build a fixture project with dispatchMode=phase-agents (the non-execution-core default).
build_phase_agents_project() {
  local dir="$1"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-project",
    "linear": { "teamKey": "CTL" },
    "orchestration": { "dispatchMode": "phase-agents" }
  }
}
EOF
}

# Build a fixture project with dispatchMode=execution-core (should always run).
build_execution_core_project() {
  local dir="$1"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-project",
    "linear": { "teamKey": "CTL" },
    "orchestration": { "dispatchMode": "execution-core" }
  }
}
EOF
}

# ─── Test: phase-agents repo calls the states script (CTL-722 regression) ────
WORK_PA="${SCRATCH}/phase-agents"
build_phase_agents_project "$WORK_PA"
rm -f "$SENTINEL"

(
  CATALYST_SETUP_LIB_ONLY=1
  export CATALYST_SETUP_LIB_ONLY
  # shellcheck source=/dev/null
  source "$SETUP_SCRIPT"
  PROJECT_DIR="$WORK_PA" CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN_ROOT" \
    setup_execution_core_states
) > "${SCRATCH}/pa-out" 2>&1 || true

run "setup_execution_core_states runs under dispatchMode=phase-agents (CTL-722)" \
  bash -c "[ -f '${SENTINEL}' ]"

# ─── Test: execution-core repo also calls the states script (regression guard) ──
WORK_EC="${SCRATCH}/execution-core"
build_execution_core_project "$WORK_EC"
rm -f "$SENTINEL"

(
  CATALYST_SETUP_LIB_ONLY=1
  export CATALYST_SETUP_LIB_ONLY
  # shellcheck source=/dev/null
  source "$SETUP_SCRIPT"
  PROJECT_DIR="$WORK_EC" CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN_ROOT" \
    setup_execution_core_states
) > "${SCRATCH}/ec-out" 2>&1 || true

run "setup_execution_core_states still runs under dispatchMode=execution-core" \
  bash -c "[ -f '${SENTINEL}' ]"

# ─── Test: missing config -> silent no-op (existing behaviour preserved) ──────
WORK_NOCFG="${SCRATCH}/no-config"
mkdir -p "$WORK_NOCFG"
rm -f "$SENTINEL"

(
  CATALYST_SETUP_LIB_ONLY=1
  export CATALYST_SETUP_LIB_ONLY
  # shellcheck source=/dev/null
  source "$SETUP_SCRIPT"
  PROJECT_DIR="$WORK_NOCFG" CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN_ROOT" \
    setup_execution_core_states
) > "${SCRATCH}/nocfg-out" 2>&1 || true

run "setup_execution_core_states is a no-op when config is missing" \
  bash -c "[ ! -f '${SENTINEL}' ]"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
