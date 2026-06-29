#!/usr/bin/env bash
# Shell smoke tests for the `catalyst-install` LAUNCHER + router wiring (CTL-1369 PR3).
#
# The lifecycle LOGIC is unit-tested in execution-core/install-lifecycle.test.mjs (bun, GitHub
# CI-gated). This suite exercises the real bash launcher end-to-end (symlink resolution → bun/node
# exec → mjs) and the router's `catalyst install|uninstall|reinstall` dispatch, using --dry-run so
# nothing is provisioned. All assertions pass --class explicitly so they don't depend on the host's
# configured node class.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-install.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="${SCRIPT_DIR}/../catalyst-install"
ROUTER="${SCRIPT_DIR}/../catalyst"

FAILURES=0
PASSES=0
ok()   { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; echo "    $2"; }
expect_eq()       { if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
expect_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else fail "$1" "'$2' lacks '$3'"; fi; }
expect_absent()   { if [[ "$2" != *"$3"* ]]; then ok "$1"; else fail "$1" "'$2' unexpectedly contains '$3'"; fi; }

# A runtime is required (the launcher execs bun, falling back to node).
if ! command -v bun >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  echo "SKIP: neither bun nor node available"
  exit 0
fi

echo "catalyst-install — launcher --help"
out="$("$INSTALL" --help 2>&1)"; rc=$?
expect_eq "--help exits 0" "0" "$rc"
expect_contains "--help names the tool" "$out" "catalyst-install"

echo "catalyst-install — install/worker dry-run (full work stack, no updater)"
out="$("$INSTALL" install --class worker --dry-run 2>&1)"; rc=$?
expect_eq "worker dry-run exits 0" "0" "$rc"
expect_contains "worker runs install-services" "$out" "install-services"
expect_absent  "worker never adopts updater" "$out" "adopt-updater"

echo "catalyst-install — install/developer dry-run (updater + drain, no work stack)"
out="$("$INSTALL" install --class developer --dry-run 2>&1)"; rc=$?
expect_eq "developer dry-run exits 0" "0" "$rc"
expect_contains "developer adopts updater" "$out" "adopt-updater"
expect_absent  "developer never installs services" "$out" "install-services"

echo "catalyst-install — invalid inputs"
"$INSTALL" bogus-op >/dev/null 2>&1; expect_eq "unknown operation → rc 2" "2" "$?"
"$INSTALL" install --class nope >/dev/null 2>&1; expect_eq "unknown class → rc 2" "2" "$?"

echo "catalyst-install — uninstall dry-run (teardown, secrets preserved)"
out="$("$INSTALL" uninstall --class worker --dry-run 2>&1)"; rc=$?
expect_eq "uninstall dry-run exits 0" "0" "$rc"
expect_contains "uninstall removes agents" "$out" "uninstall-services"
expect_contains "uninstall preserves secrets" "$out" "secrets preserved"

echo "catalyst — router dispatches install → catalyst-install"
out="$("$ROUTER" install --class worker --dry-run 2>&1)"; rc=$?
expect_eq "router install dry-run exits 0" "0" "$rc"
expect_contains "router reaches the lifecycle driver" "$out" "install-services"

echo "catalyst-install — resolves through a symlink (the on-PATH production invocation)"
sym_tmp="$(mktemp -d)"
ln -s "$INSTALL" "$sym_tmp/catalyst-install"
out="$("$sym_tmp/catalyst-install" install --class worker --dry-run 2>&1)"; rc=$?
rm -rf "$sym_tmp"
expect_eq "symlinked launcher exits 0" "0" "$rc"
expect_contains "symlinked launcher still resolves the driver" "$out" "install-services"

echo
echo "──────────────────────────────────────────"
echo "catalyst-install.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]]
