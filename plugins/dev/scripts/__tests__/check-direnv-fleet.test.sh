#!/usr/bin/env bash
# check-direnv-fleet.test.sh — CTL-1944.
#
# The property under test is NOT "does it find direnv". It is that every way of being
# NOT-owner-ready renders RED. The failure this ticket came from was a host that read as fine
# because the check only ever warned, and the failure mode it must never regress into is a BLOCKED
# .envrc reading as a clean one — a blocked rc emits no variables, which is indistinguishable from
# a host with nothing configured unless the allowed-state is read positively.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/../check-direnv-fleet.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for l in "$@"; do echo "      $l"; done
}

if ! command -v direnv >/dev/null 2>&1; then
	# ⛔ A SKIP UNDER CI IS A FAILURE. Without direnv this suite runs only the binary-absent case
	# and still reports green — the two guards that carry the weight (blocked-.envrc, ambient-token)
	# would never execute, and the suite would ship INERT while looking installed. That is the exact
	# class CTL-1919/CTL-1935 are about, so CI must go red rather than quietly cover less.
	if [[ -n "${CI:-}" ]]; then
		echo "  FAIL: direnv is absent on a CI runner — this suite would skip its two core guards."
		echo "        The workflow step is responsible for installing it (apt-get install direnv)."
		echo ""
		echo "  PASSED: 0   FAILED: 1"
		exit 1
	fi
	echo "SKIP: direnv is not installed on this runner — the allowed-state cases cannot run."
	echo "      (The binary-absent case below does not need it and still runs.)"
	HAVE_DIRENV=0
else
	HAVE_DIRENV=1
fi

# Isolate direnv's allow-store so the test never reads or writes the operator's real one.
export XDG_DATA_HOME="$SCRATCH/xdg-data"
export XDG_CONFIG_HOME="$SCRATCH/xdg-config"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/direnv/profiles"

run() { bash "$SUBJECT" "$@" 2>&1; }

# ── a project whose .envrc really does export the tokens ────────────────────
mkproject() { # mkproject <dir>
	mkdir -p "$1"
	cat >"$1/.envrc" <<'ENVRC'
export LINEAR_API_TOKEN=lin_api_testtoken
export GITHUB_TOKEN=ghp_testtoken
export CLOUDFLARE_API_TOKEN=cf_testtoken
ENVRC
}

echo ""
echo "=== ⛔ the binary being ABSENT is a FAILURE, not a warning ==="
# A PATH with no direnv on it. This is the mini-2 condition.
OUT="$(PATH="/usr/bin:/bin" CATALYST_BREW="$SCRATCH/no-such-brew" run --dir "$SCRATCH" 2>&1)"
RC=$?
if [[ $RC -ne 0 ]]; then pass "an absent direnv exits non-zero (rc=$RC)"; else fail "an absent direnv exited 0" "$OUT"; fi
if grep -q 'direnv NOT installed' <<<"$OUT"; then pass "it names direnv as the missing thing"; else fail "the absent binary is not named" "$OUT"; fi

if [[ $HAVE_DIRENV -eq 1 ]]; then
	for p in personal catalyst catalyst-cloud; do : >"$XDG_CONFIG_HOME/direnv/profiles/${p}.env"; done

	echo ""
	echo "=== ⛔ THE CORE CASE: a BLOCKED .envrc must read BLOCKED, never clean ==="
	BLOCKED="$SCRATCH/blocked"
	mkproject "$BLOCKED"
	# deliberately NOT allowed
	OUT="$(run --dir "$BLOCKED")"
	RC=$?
	# control — prove the fixture really is blocked, so a pass here means something
	FOUND="$(cd "$BLOCKED" && direnv status 2>/dev/null | grep -E '^Found RC allowed ' | head -n1)"
	if [[ "$FOUND" == "Found RC allowed 1" ]]; then pass "control — the fixture really is blocked ($FOUND)"; else fail "the fixture is not in the blocked state" "$FOUND"; fi
	if grep -q 'is BLOCKED' <<<"$OUT"; then pass "the blocked .envrc is reported BLOCKED"; else fail "a blocked .envrc was not reported" "$OUT"; fi
	if [[ $RC -ne 0 ]]; then pass "a blocked .envrc exits non-zero (rc=$RC)"; else fail "a blocked .envrc exited 0" "$OUT"; fi
	if ! grep -q 'readiness: PASS' <<<"$OUT"; then pass "it does not report PASS"; else fail "a blocked host reported PASS" "$OUT"; fi

	echo ""
	echo "=== ⛔ REGRESSION GUARD: called FROM an allowed dir, a blocked target still reads BLOCKED ==="
	# This is the bug a naive `direnv status | grep 'RC allowed 0'` has: the "Loaded RC" block
	# describes the CALLER's rc. Run the check with the CWD inside an allowed project and the
	# --dir pointing at the blocked one; the caller's allowed rc must not mask the target.
	ALLOWED="$SCRATCH/allowed"
	mkproject "$ALLOWED"
	(cd "$ALLOWED" && direnv allow . >/dev/null 2>&1)
	OUT="$(cd "$ALLOWED" && bash "$SUBJECT" --dir "$BLOCKED" 2>&1)"
	RC=$?
	LOADED="$(cd "$ALLOWED" && direnv status 2>/dev/null | grep -E '^Loaded RC allowed ' | head -n1)"
	if grep -q 'is BLOCKED' <<<"$OUT"; then pass "the caller's allowed rc does not mask the target (caller: ${LOADED:-none})"; else fail "an allowed CALLER masked a blocked TARGET — the Loaded/Found confusion" "$OUT"; fi
	if [[ $RC -ne 0 ]]; then pass "and it still exits non-zero (rc=$RC)"; else fail "masked case exited 0" "$OUT"; fi

	echo ""
	echo "=== ✅ NEGATIVE CONTROL: an allowed, fully-provisioned project PASSES ==="
	OUT="$(run --dir "$ALLOWED")"
	RC=$?
	if [[ $RC -eq 0 ]]; then pass "a correct host exits 0 — the check is not always-red"; else fail "a correct host failed" "$OUT"; fi
	if grep -q 'readiness: PASS' <<<"$OUT"; then pass "it reports PASS"; else fail "no PASS line" "$OUT"; fi
	if grep -q 'ALLOWED (Found RC allowed 0)' <<<"$OUT"; then pass "the allowed state is read positively"; else fail "allowed state not reported" "$OUT"; fi
	if grep -q 'LINEAR_API_TOKEN is set' <<<"$OUT"; then pass "LINEAR_API_TOKEN is seen"; else fail "token not seen" "$OUT"; fi

	echo ""
	echo "=== ⛔ a token the .envrc does NOT export is reported EMPTY ==="
	OUT="$(run --dir "$ALLOWED" --require-token 'LINEAR_API_TOKEN NOT_EXPORTED_TOKEN')"
	RC=$?
	if grep -q 'NOT_EXPORTED_TOKEN is EMPTY' <<<"$OUT"; then pass "the missing token is named EMPTY"; else fail "a missing token was not reported" "$OUT"; fi
	if [[ $RC -ne 0 ]]; then pass "and that fails the check (rc=$RC)"; else fail "a missing token exited 0" "$OUT"; fi

	echo ""
	echo "=== ⛔ REGRESSION GUARD: the CALLER's ambient token must not make an UNPROVISIONED host pass ==="
	# `direnv exec` ADDS the .envrc's exports to the environment it inherits — it does not scrub.
	# So an agent whose own shell already carries LINEAR_API_TOKEN would see it in ANY directory,
	# and an unprovisioned host would report ready on the caller's credentials. That is this
	# ticket's own failure mode reproduced inside the check meant to catch it. Caught for real on
	# 2026-08-18 by the probe case below, which passed against an .envrc exporting no token.
	BARE="$SCRATCH/bare"
	mkdir -p "$BARE"
	echo 'export UNRELATED=1' >"$BARE/.envrc"
	(cd "$BARE" && direnv allow . >/dev/null 2>&1)
	OUT="$(LINEAR_API_TOKEN=lin_api_leaked_from_the_caller GITHUB_TOKEN=ghp_leaked CLOUDFLARE_API_TOKEN=cf_leaked run --dir "$BARE")"
	RC=$?
	if grep -q 'LINEAR_API_TOKEN is EMPTY' <<<"$OUT"; then pass "an ambient LINEAR_API_TOKEN does not count as provisioned"; else fail "the caller's token leaked into the verdict" "$OUT"; fi
	if [[ $RC -ne 0 ]]; then pass "the unprovisioned host still FAILS (rc=$RC)"; else fail "an unprovisioned host passed on inherited credentials" "$OUT"; fi
	# control — prove the leak was actually present in the caller's environment
	LEAKCHK="$(LINEAR_API_TOKEN=lin_api_leaked_from_the_caller sh -c 'printf %s "${LINEAR_API_TOKEN:+present}"')"
	if [[ "$LEAKCHK" == "present" ]]; then pass "control — the ambient token really was set for that run"; else fail "the leak fixture did not set the variable"; fi

	echo ""
	echo "=== ⛔ a MISSING PROFILE is a failure ==="
	rm -f "$XDG_CONFIG_HOME/direnv/profiles/catalyst-cloud.env"
	OUT="$(run --dir "$ALLOWED")"
	RC=$?
	if grep -q 'profile catalyst-cloud.env MISSING' <<<"$OUT"; then pass "the missing profile is named"; else fail "missing profile not reported" "$OUT"; fi
	if [[ $RC -ne 0 ]]; then pass "and it exits non-zero (rc=$RC)"; else fail "missing profile exited 0" "$OUT"; fi
	: >"$XDG_CONFIG_HOME/direnv/profiles/catalyst-cloud.env"

	echo ""
	echo "=== ⛔ NO .envrc at all is a failure, not a silent skip ==="
	EMPTY="$SCRATCH/empty"
	mkdir -p "$EMPTY"
	OUT="$(run --dir "$EMPTY")"
	RC=$?
	if grep -q 'no .envrc in' <<<"$OUT"; then pass "the absent .envrc is named"; else fail "absent .envrc not reported" "$OUT"; fi
	if [[ $RC -ne 0 ]]; then pass "and it exits non-zero (rc=$RC)"; else fail "absent .envrc exited 0" "$OUT"; fi

	echo ""
	echo "=== the live probe fails CLOSED when there is no token to probe with ==="
	NOTOK="$SCRATCH/notok"
	mkdir -p "$NOTOK"
	echo 'export SOMETHING_ELSE=1' >"$NOTOK/.envrc"
	(cd "$NOTOK" && direnv allow . >/dev/null 2>&1)
	OUT="$(run --dir "$NOTOK" --probe --require-token 'SOMETHING_ELSE')"
	RC=$?
	if grep -q 'probe SKIPPED' <<<"$OUT"; then pass "an unprobeable host says so"; else fail "the probe was silently skipped" "$OUT"; fi
	if [[ $RC -ne 0 ]]; then pass "and that is a failure, not a pass (rc=$RC)"; else fail "unprobeable host exited 0" "$OUT"; fi
fi

echo ""
echo "=== argument validation ==="
OUT="$(run --dir "$SCRATCH/definitely-not-here")"
RC=$?
if [[ $RC -eq 2 ]]; then pass "a nonexistent --dir is refused (rc 2)"; else fail "bad --dir not refused" "rc=$RC" "$OUT"; fi
OUT="$(run --bogus-flag)"
RC=$?
if [[ $RC -eq 2 ]]; then pass "an unknown flag is refused (rc 2)"; else fail "unknown flag not refused" "rc=$RC" "$OUT"; fi

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
