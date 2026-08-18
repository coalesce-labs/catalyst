#!/usr/bin/env bash
# direnv-provision.test.sh — CTL-1956.
#
# The property under test is NOT "does it copy files". It is the pair that made mini-2 a
# four-part failure and mini a hand-built host:
#
#   1. the runtime pieces are provisioned from the VENDORED copy — if the path resolution is
#      wrong the step "succeeds" and installs nothing, which is how a fix ships inert;
#   2. an EXISTING profile is left byte-identical — mini's personal.env is richer than any
#      placeholder, and clobbering it would break a working host to fix a broken one.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../lib/direnv-provision.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

[[ -f $SUBJECT ]] || {
	echo "  FAIL: $SUBJECT missing"
	echo "  PASSED: 0   FAILED: 1"
	exit 1
}
# shellcheck source=../lib/direnv-provision.sh
# shellcheck disable=SC1091
source "$SUBJECT"

export HOME="$SCRATCH/home"
export XDG_CONFIG_HOME="$SCRATCH/home/.config"
mkdir -p "$HOME"
CFG="$XDG_CONFIG_HOME/direnv"

echo "=== ⭐ the lib/ helpers are provisioned FROM THE VENDORED COPY ==="
OUT="$(ensure_direnv_runtime 2>&1)"
for lib in profiles otel; do
	VENDORED="$SCRIPT_DIR/../../direnv/lib/${lib}.sh"
	if [[ -f "$CFG/lib/${lib}.sh" ]] && cmp -s "$VENDORED" "$CFG/lib/${lib}.sh"; then
		pass "lib/${lib}.sh installed and byte-identical to the vendored copy"
	else
		fail "lib/${lib}.sh not installed from the vendored copy" "$OUT"
	fi
done

# ⛔ The control for the case above. If the vendored dir did not resolve, the loop would warn and
# install nothing — and an assertion that only checked "no error" would pass. Assert the warning is
# ABSENT, so a silently-inert run is red.
if printf '%s' "$OUT" | grep -q "vendored direnv lib.*missing from the checkout"; then
	fail "the vendored path did NOT resolve — provisioning ran and installed nothing" "$OUT"
else
	pass "the vendored path resolved (no 'missing from the checkout' warning)"
fi

echo ""
echo "=== ⭐ placeholder profiles are created only when ABSENT ==="
for prof in personal catalyst; do
	if [[ -f "$CFG/profiles/${prof}.env" ]]; then
		pass "${prof}.env created on a bare host"
	else
		fail "${prof}.env was not created on a bare host"
	fi
done

echo ""
echo "=== ⛔ THE CORE CASE: an EXISTING profile is never clobbered ==="
# mini's shape: a real, credential-bearing profile already on disk.
REAL="# a real hand-provisioned profile
export SOMETHING_HOST_LOCAL=value
"
printf '%s' "$REAL" >"$CFG/profiles/personal.env"
BEFORE="$(md5 -q "$CFG/profiles/personal.env" 2>/dev/null || md5sum "$CFG/profiles/personal.env" | cut -d' ' -f1)"
ensure_direnv_runtime >/dev/null 2>&1
AFTER="$(md5 -q "$CFG/profiles/personal.env" 2>/dev/null || md5sum "$CFG/profiles/personal.env" | cut -d' ' -f1)"
if [[ $BEFORE == "$AFTER" ]]; then
	pass "an existing personal.env is byte-identical after a re-run ($BEFORE)"
else
	fail "an existing personal.env was CLOBBERED — this would break mini to fix mini-2" "before=$BEFORE after=$AFTER"
fi
# Negative control: the assertion above must be capable of failing. Prove the md5 comparison
# actually distinguishes a changed file, otherwise "identical" could mean "both unreadable".
printf '%s' "${REAL}# mutated\n" >"$CFG/profiles/personal.env"
MUTATED="$(md5 -q "$CFG/profiles/personal.env" 2>/dev/null || md5sum "$CFG/profiles/personal.env" | cut -d' ' -f1)"
if [[ $MUTATED != "$BEFORE" ]]; then
	pass "control fires: the md5 comparison does detect a changed file"
else
	fail "control did NOT fire — the no-clobber assertion above proves nothing"
fi

echo ""
echo "=== ⭐ the source_up target is created on a bare host, and not overwritten ==="
ORG="$HOME/code-repos/github/coalesce-labs"
mkdir -p "$ORG"
ensure_direnv_runtime >/dev/null 2>&1
if [[ -f "$ORG/.envrc" ]] && grep -q 'use_profile personal' "$ORG/.envrc"; then
	pass "coalesce-labs/.envrc created with use_profile personal"
else
	fail "coalesce-labs/.envrc was not created"
fi
printf 'use_profile personal\n# operator edit\n' >"$ORG/.envrc"
ensure_direnv_runtime >/dev/null 2>&1
if grep -q '# operator edit' "$ORG/.envrc"; then
	pass "an existing coalesce-labs/.envrc is left alone"
else
	fail "an existing coalesce-labs/.envrc was overwritten"
fi

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
