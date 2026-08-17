#!/usr/bin/env bash
# CTL-1910 — THE BASE URL THE INSTALLER PINS MUST NAME A HOST THAT EXISTS.
#
# The defect this guards: `setup_cloud_replica` hard-pinned
# `https://app.catalystcloud.dev/api/v1` into every new customer's 0600,
# launchd-sourced `cloud-sync.env`. That host is NXDOMAIN. The writer could never
# reach the hub, the replica was never created or seeded, and setup exited 0 with
# two green checkmarks — a green install and a permanently empty replica, invisible
# unless the operator went and read the file.
#
# Nothing in the suite could have caught it, because nothing ever asked the one
# question that mattered: does this host exist?
#
# ── WHY THIS TEST HAS A CONTROL, AND REFUSES TO GUESS ────────────────────────
# A DNS lookup failing proves nothing on its own — the runner may have no
# resolver, no egress, or a captive DNS. So this asserts a NEGATIVE only after a
# POSITIVE control on a host that must always resolve. Three distinct verdicts:
#
#   control resolves + pinned resolves  -> PASS
#   control resolves + pinned NXDOMAIN  -> FAIL  (the real defect; the only failure)
#   control does NOT resolve            -> SKIP  (this runner cannot look; say so)
#
# The third is the important one. Collapsing "could not look" into either PASS or
# FAIL is the defect class that produced the bug in the first place.
#
# This is the same methodology the ticket used by hand: `web.dev` was resolved
# first to prove the host could resolve `.dev` at all, so `app.catalystcloud.dev`
# coming back empty was a real absence rather than a broken resolver.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"

PASS=0
FAIL=0
SKIP=0
ok() {
	PASS=$((PASS + 1))
	echo "  ok   — $1"
}
bad() {
	FAIL=$((FAIL + 1))
	echo "  FAIL — $1"
}
skip() {
	SKIP=$((SKIP + 1))
	echo "  SKIP — $1"
}

echo "CTL-1910 — the pinned cloud base URL names a host that exists"

[[ -f $SETUP ]] || {
	bad "setup-catalyst.sh not found at $SETUP"
	echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
	exit 1
}

# ── 1. Extract the pinned default FROM THE SHIPPED SCRIPT ────────────────────
# Read out of the source rather than restated here: a copy in this file could
# agree with itself while the installer shipped something else entirely.
pinned="$(sed -n 's|.*CATALYST_CLOUD_BASE_URL:-\(https://[^}"]*\)}.*|\1|p' "$SETUP" | head -1)"
if [[ -n $pinned ]]; then
	ok "found the pinned default in setup-catalyst.sh: $pinned"
else
	bad "could not extract a pinned CATALYST_CLOUD_BASE_URL default from $SETUP — if the parameter-expansion default was reshaped, FIX THIS PARSE rather than deleting the test"
	echo ""
	echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
	exit 1
fi

host="${pinned#*://}"
host="${host%%/*}"
host="${host%%:*}"
ok "host under test: $host"

# ── 2. A resolver, or we cannot look ─────────────────────────────────────────
resolve() {
	# Two mechanisms, because a runner may ship either. Both print nothing on
	# NXDOMAIN and something on success.
	if command -v dig >/dev/null 2>&1; then
		dig +short +timeout=5 +tries=2 "$1" 2>/dev/null | head -3
	elif command -v host >/dev/null 2>&1; then
		host -W 5 "$1" 2>/dev/null | grep -i 'has address' | head -3
	elif command -v getent >/dev/null 2>&1; then
		getent hosts "$1" 2>/dev/null | head -3
	else
		# No resolver tool at all — report the inability, never a clean answer.
		return 2
	fi
}

CONTROL_HOST="${CATALYST_DNS_CONTROL_HOST:-one.one.one.one}"
control_out="$(resolve "$CONTROL_HOST")"
control_rc=$?

if [[ $control_rc -eq 2 ]]; then
	skip "no DNS tool available (dig/host/getent all absent) — cannot look, so nothing is asserted"
	echo ""
	echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
	exit 0
fi

if [[ -z $control_out ]]; then
	skip "control host $CONTROL_HOST did not resolve — this runner has no working DNS/egress, so a negative on $host would be meaningless"
	echo ""
	echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
	exit 0
fi
ok "POSITIVE CONTROL: $CONTROL_HOST resolves — this runner can resolve, so an empty answer below is a real absence"

# ── 3. The assertion ─────────────────────────────────────────────────────────
pinned_out="$(resolve "$host")"
if [[ -n $pinned_out ]]; then
	ok "the pinned host $host RESOLVES ($(echo "$pinned_out" | tr '\n' ' ' | sed 's/ *$//'))"
else
	bad "the pinned host $host does NOT RESOLVE (NXDOMAIN) while the control does — every new customer's cloud-sync.env would point the replica writer at a host that cannot be reached, and setup would still exit 0. This is CTL-1910 exactly."
fi

# ── 4. The specific dead host must never come back AS A VALUE ────────────────
# Belt and braces, and it works with no DNS at all, so this fails even on an
# offline runner where sections 2-3 skip.
#
# ⚠️ COMMENTS ARE STRIPPED FIRST, and that is not a loophole — it is the
# difference between naming the dead host and USING it. The corrected comment in
# setup_cloud_replica documents `app.catalystcloud.dev` as the NXDOMAIN host on
# purpose: that record is why nobody re-pins it. A blunt whole-file grep flags
# that documentation, which pressures the next person to delete the explanation
# to get CI green — so the check is scoped to executable lines, where a re-pin
# would actually have to live.
# (Caught by this test failing against its own first draft.)
code_hits="$(grep -vE '^[[:space:]]*#' "$SETUP" | grep -c 'app\.catalystcloud\.dev' || true)"
if [[ ${code_hits:-0} -gt 0 ]]; then
	bad "setup-catalyst.sh USES app.catalystcloud.dev on $code_hits executable line(s) — measured NXDOMAIN 2026-08-17 from two hosts, with a resolving .dev control"
else
	ok "app.catalystcloud.dev appears on no executable line (documented in comments only)"
fi
# ...and the mention must SURVIVE somewhere, or the reason it is forbidden is lost
# and the next person re-pins it from the stale "canonical host" note in the docs.
if grep -qE '^[[:space:]]*#.*app\.catalystcloud\.dev' "$SETUP"; then
	ok "the NXDOMAIN finding is still recorded in a comment (the reason survives the fix)"
else
	bad "no comment records that app.catalystcloud.dev is NXDOMAIN — the finding was deleted along with the bug, so nothing stops it coming back"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
[[ $FAIL -eq 0 ]]
