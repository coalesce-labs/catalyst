#!/usr/bin/env bash
# Tests that catalyst-stack wires the account-rotation agent in BOTH directions
# (CTL-2145 Phase 4).
#
# THE BIDIRECTIONAL ASSERTION IS THE POINT. CTL-1975 recorded exactly this defect one
# agent earlier: ai.coalesce.catalyst-usage-page was installed on every node by
# install-services and removed by NOTHING, so `catalyst uninstall`'s verify-clean —
# which probes the plist dir with a prefix regex — failed the teardown at its final
# phase with no code path anywhere able to clear the orphan it had left. An install
# delegate without a matching uninstall delegate is a latent teardown failure, so this
# suite refuses to let the install half ship alone.
#
# Source-scan plus a real `install-services --print` run: the scan proves the delegate
# is WIRED, the print proves it is REACHED and routed to --print-only.
#
# Run: bash plugins/dev/scripts/__tests__/install-services-account-rotation.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
STACK="${REPO_ROOT}/plugins/dev/scripts/catalyst-stack"
LABEL="ai.coalesce.catalyst-account-rotation"
DELEGATE="install-account-rotation.sh"

PASSES=0
FAILURES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

if [[ ! -f "$STACK" ]]; then
	fail "catalyst-stack not found at ${STACK}"
	echo ""
	echo "== ${PASSES} passed, ${FAILURES} failed =="
	exit 1
fi

# fn_body NAME — the source of one shell function, comments stripped, so a delegate
# merely MENTIONED in a comment can never satisfy an assertion below.
fn_body() {
	awk -v fn="^$1\\\\(\\\\) \\\\{" '$0 ~ fn, /^\}/' "$STACK" | grep -v '^[[:space:]]*#'
}

# ─── 1. the install delegate is wired ────────────────────────────────────────

echo "Test 1: cmd_install_services delegates to ${DELEGATE}"
INSTALL_BODY="$(fn_body cmd_install_services)"
if [[ -z "$INSTALL_BODY" ]]; then
	fail "could not extract cmd_install_services — every assertion below would vacuously pass"
else
	pass "extracted cmd_install_services (${#INSTALL_BODY} bytes)"
	if grep -q "$DELEGATE" <<<"$INSTALL_BODY"; then
		pass "install path references ${DELEGATE}"
	else
		fail "install path never references ${DELEGATE}"
	fi
	# Non-fatal, like every sibling delegate: a rotation hiccup must not block the
	# core stack services.
	if grep -qE "${DELEGATE}.*(\|\||warn)|warn .*rotation" <<<"$INSTALL_BODY"; then
		pass "the delegate is non-fatal (warns and continues)"
	else
		fail "the delegate has no visible non-fatal handling — a hiccup would abort install-services"
	fi
fi

# ─── 2. the UNINSTALL delegate is wired (the CTL-1975 lesson) ────────────────

echo "Test 2: cmd_uninstall_services also delegates — installed-by-one, removed-by-none is the CTL-1975 defect"
UNINSTALL_BODY="$(fn_body cmd_uninstall_services)"
if [[ -z "$UNINSTALL_BODY" ]]; then
	fail "could not extract cmd_uninstall_services — the assertion below would vacuously pass"
else
	pass "extracted cmd_uninstall_services (${#UNINSTALL_BODY} bytes)"
	if grep -q "$DELEGATE" <<<"$UNINSTALL_BODY"; then
		pass "uninstall path references ${DELEGATE}"
	else
		fail "uninstall path never references ${DELEGATE} — the agent would be installed by install-services and removed by NOTHING, failing verify-clean's prefix probe at teardown (CTL-1975)"
	fi
	if grep -q -- "--uninstall" <<<"$UNINSTALL_BODY"; then
		pass "uninstall path passes the uninstall flag to its delegates"
	else
		fail "uninstall path does not pass --uninstall to any delegate"
	fi
fi

# Positive control for fn_body itself: it must find a delegate that is definitely
# there. Without this, a broken extractor would make BOTH sections above pass or fail
# for reasons unrelated to the account-rotation wiring.
echo "Test 2b: positive control — the extractor sees a known sibling delegate"
if grep -q "install-orphan-sweep.sh" <<<"$INSTALL_BODY" && grep -q "install-orphan-sweep.sh" <<<"$UNINSTALL_BODY"; then
	pass "fn_body finds install-orphan-sweep.sh in both functions (extractor works)"
else
	fail "fn_body cannot see a known-present sibling delegate — every result in this file is suspect"
fi

# ─── 3. the label is a managed constant ──────────────────────────────────────

echo "Test 3: the label is registered in catalyst-stack"
if grep -q "$LABEL" "$STACK"; then
	pass "${LABEL} appears in catalyst-stack"
else
	fail "${LABEL} is not registered in catalyst-stack"
fi

# ─── 4. --print routes the delegate to --print-only ──────────────────────────

echo "Test 4: install-services --print reaches the delegate and renders no side effects"
# The delegate carries the CTL-1306 pristine-path guard, so from a LINKED WORKTREE — where
# day-to-day development happens — it correctly refuses and `|| true` swallows the refusal,
# rendering nothing. Asserting the label without accounting for that would make this suite
# pass only when run from a pristine clone: the same "coverage depends on where it runs"
# failure this file's header objects to. So point the delegate at a genuinely
# non-ephemeral bake dir (not under a temp root, its own git repo so
# `rev-parse --absolute-git-dir` reports no /worktrees/ segment) via the seam the
# installer already exposes for exactly this.
BAKE_ROOT="${REPO_ROOT}/.tmp-install-services-rotation-test.$$"
BAKE_DIR="${BAKE_ROOT}/plugins/dev/scripts"
mkdir -p "${BAKE_DIR}"
cp -R "${REPO_ROOT}/plugins/dev/scripts/coord" "${BAKE_DIR}/"
git init -q "$BAKE_ROOT" >/dev/null 2>&1 || true
trap 'rm -rf "${BAKE_ROOT:?}"' EXIT

PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PLIST_PREEXISTING=no
[[ -f "$PLIST_PATH" ]] && PLIST_PREEXISTING=yes

# CATALYST_FORCE_OS is exported through to the delegate, which otherwise early-exits on a
# non-Darwin host printing nothing — so without it this assertion would fail on the ubuntu
# CI runner for a reason that has nothing to do with the wiring under test.
# (cmd_install_services' own `uname -s` gate sits AFTER the print branch returns, so it is
# not in play here.)
OUT="$(CATALYST_FORCE_OS=Darwin CATALYST_FORCE_BAKE_DIR="$BAKE_DIR" bash "$STACK" install-services --print 2>&1)"
RC=$?
if [[ $RC -eq 0 ]]; then
	pass "install-services --print exits 0"
else
	# Print mode can legitimately fail on a host whose shipper config is unresolvable;
	# say so rather than reporting a rotation problem.
	fail "install-services --print exited ${RC} (not necessarily a rotation issue): $(tail -3 <<<"$OUT")"
fi
if grep -q "$LABEL" <<<"$OUT"; then
	pass "the rendered output includes the account-rotation agent"
else
	fail "install-services --print did not render ${LABEL} ($(grep -c . <<<"$OUT") lines of output)"
fi
# Positive control: with the bake dir forced back to this (ephemeral) worktree, the
# delegate refuses and the label is ABSENT — proving the assertion above is sensitive to
# the delegate actually running, not just to the label appearing somewhere in the file.
OUT_EPH="$(CATALYST_FORCE_OS=Darwin CATALYST_FORCE_BAKE_DIR="${REPO_ROOT}/plugins/dev/scripts" bash "$STACK" install-services --print 2>&1)"
if grep -q "$LABEL" <<<"$OUT_EPH"; then
	fail "positive control FAILED — the label rendered even from an ephemeral bake dir, so test 4 is not measuring the delegate"
else
	pass "positive control: from an ephemeral bake dir the delegate refuses and renders nothing"
fi
# The print path must route the delegate to --print-only, never to a real install.
PRINT_BLOCK="$(awk '/if \[\[ "\$print_only" == "yes" \]\]/,/return 0/' "$STACK")"
if grep -q "${DELEGATE}" <<<"$PRINT_BLOCK" && grep -q -- "--print-only" <<<"$PRINT_BLOCK"; then
	pass "the print branch invokes the delegate with --print-only"
else
	fail "the print branch does not route ${DELEGATE} to --print-only"
fi
# And it must not have installed anything while printing.
if [[ "$PLIST_PREEXISTING" == "yes" ]]; then
	echo "  SKIP: a rotation plist pre-existed on this host, so 'print installed nothing' is unmeasurable here"
elif [[ ! -f "$PLIST_PATH" ]]; then
	pass "print mode installed nothing"
else
	fail "print mode wrote ${PLIST_PATH}"
fi

# ─── 5. service-manifest registration ────────────────────────────────────────

echo "Test 5: the label is declared in the service manifest"
MANIFEST_MJS="${REPO_ROOT}/plugins/dev/scripts/execution-core/service-manifest.mjs"
if grep -q "$LABEL" "$MANIFEST_MJS" 2>/dev/null; then
	pass "service-manifest.mjs declares ${LABEL}"
else
	fail "service-manifest.mjs does not declare ${LABEL}"
fi
if grep -q "accountRotation" "$MANIFEST_MJS" 2>/dev/null; then
	pass "it is exported under a named LABELS key"
else
	fail "no accountRotation key in LABELS"
fi

echo ""
echo "== ${PASSES} passed, ${FAILURES} failed =="
[[ $FAILURES -eq 0 ]]
