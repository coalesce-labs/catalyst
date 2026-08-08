#!/usr/bin/env bash
# Shell tests for the CAT-29 execution-core dependency preflight.

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$TEST_DIR/.." && pwd)/catalyst-execution-core"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1${2:+ — $2}"; }
stub() { printf '#!/usr/bin/env bash\nexit 0\n' >"$1/$2"; chmod +x "$1/$2"; }

echo "catalyst-execution-core preflight tests (CAT-29)"
GOOD="$SCRATCH/good"; mkdir -p "$GOOD"; stub "$GOOD" linearis; stub "$GOOD" node
if PATH="$GOOD:/usr/bin:/bin" bash -c 'source "$1"; resolve_required_tools' _ "$SCRIPT"; then pass "accepts linearis and node on PATH"; else fail "accepts linearis and node on PATH"; fi

NO_LINEARIS="$SCRATCH/no-linearis"; mkdir -p "$NO_LINEARIS"; stub "$NO_LINEARIS" node
OUT="$(PATH="$NO_LINEARIS:/usr/bin:/bin" CATALYST_REQUIRED_TOOLS=linearis bash -c 'source "$1"; resolve_required_tools' _ "$SCRIPT" 2>&1)"; RC=$?
if [[ "$RC" -ne 0 && "$OUT" == *linearis* && "$OUT" == *"PATH="* ]]; then pass "missing linearis failure names tool and effective PATH"; else fail "missing linearis failure names tool and effective PATH" "rc=$RC out=$OUT"; fi

NO_RUNTIME="$SCRATCH/no-runtime"; mkdir -p "$NO_RUNTIME"; stub "$NO_RUNTIME" linearis
if PATH="$NO_RUNTIME:/usr/bin:/bin" /bin/bash -c 'source "$1"; resolve_runtime' _ "$SCRIPT" >/dev/null 2>&1; then fail "fails when JS runtime is absent"; else pass "fails when JS runtime is absent"; fi

CORE_DIR="$SCRATCH/core"
OUT="$(PATH="$NO_LINEARIS:/usr/bin:/bin" CATALYST_DIR="$CORE_DIR" EXECUTION_CORE_RUNTIME=node CATALYST_REQUIRED_TOOLS=linearis bash -c 'source "$1"; cmd_start' _ "$SCRIPT" 2>&1)"; RC=$?
if [[ "$RC" -ne 0 && ! -e "$CORE_DIR/execution-core/daemon.pid" ]]; then pass "cmd_start fails before writing a PID file"; else fail "cmd_start fails before writing a PID file" "rc=$RC out=$OUT"; fi

if [[ -d /opt/homebrew/bin ]] && [[ -x /opt/homebrew/bin/node ]] && [[ -x /opt/homebrew/bin/linearis ]]; then
	if PATH=/usr/bin:/bin CATALYST_REQUIRED_TOOLS=linearis bash -c 'source "$1"; PATH="$(catalyst_agent_path "$PATH")"; resolve_runtime >/dev/null && resolve_required_tools' _ "$SCRIPT"; then pass "Homebrew-only dependencies pass after hardening"; else fail "Homebrew-only dependencies pass after hardening"; fi
else
	echo "SKIP: Homebrew-only dependency fixture unavailable on this host"
fi

if PATH="$NO_LINEARIS:/usr/bin:/bin" CATALYST_SKIP_DEP_PREFLIGHT=1 bash -c 'source "$1"; resolve_required_tools' _ "$SCRIPT"; then pass "escape hatch bypasses dependency gate"; else fail "escape hatch bypasses dependency gate"; fi

echo "$PASSES passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
