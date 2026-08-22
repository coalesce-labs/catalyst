#!/usr/bin/env bash
# materialize-coord-kit.test.sh — CTL-2145. The materialize primitive bakes the
# committed coord kit into the DURABLE runtime dir ($CATALYST_DIR/comms/coord).
#
# The load-bearing assertion is "REAL FILES, not symlinks". The 2026-08-21 outage's
# proximate cause was `fleet-account.current` being a SYMLINK into a concierge job dir:
# when the job record was cleaned up the link dangled and the watchdog read nothing.
# A symlink back into the repo/worktree would reproduce that class of failure (a linked
# worktree is deleted at teardown), so the primitive copies and this test proves it.
#
# Everything is CATALYST_DIR-scoped; no test touches the real ~/catalyst.
#
# Run: bash plugins/dev/scripts/coord/__tests__/materialize-coord-kit.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COORD_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MATERIALIZE="${COORD_DIR}/materialize-coord-kit.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

if [[ ! -x "$MATERIALIZE" ]]; then
	echo "  FAIL: ${MATERIALIZE} is missing or not executable — nothing to exercise"
	echo ""
	echo "== 0 passed, 1 failed =="
	exit 1
fi

# A stub claude-accounts.env in the shape catalyst-stack's claude-account verb reads:
# CLAUDE_TOKEN_<handle> definition lines plus one _catalyst_active_token selector.
# Token VALUES are fake; the primitive must never read or echo them.
make_accounts_env() { # $1 dest, $2.. handles
	local dest="$1"; shift
	: >"$dest"
	local h
	for h in "$@"; do printf 'CLAUDE_TOKEN_%s="sk-ant-fake-%s"\n' "$h" "$h" >>"$dest"; done
	printf '_catalyst_active_token="$CLAUDE_TOKEN_%s"\n' "$1" >>"$dest"
}

run_materialize() { # $1 CATALYST_DIR, $2 accounts env (may be absent)
	CATALYST_DIR="$1" CLAUDE_ACCOUNTS_ENV="$2" bash "$MATERIALIZE" 2>&1
}

# ─── happy path ──────────────────────────────────────────────────────────────
CDIR="$SCRATCH/home-catalyst"
ACCTS="$SCRATCH/claude-accounts.env"
make_accounts_env "$ACCTS" acct1 acct2 acct3
OUT="$(run_materialize "$CDIR" "$ACCTS")"
RC=$?
COORD_RT="$CDIR/comms/coord"

echo "Test: materialize exits 0 on a well-formed accounts env"
if [[ $RC -eq 0 ]]; then pass "exit 0"; else fail "expected exit 0, got $RC — output: $OUT"; fi

# The baked kit must be RUNNABLE, not merely present. Both kit scripts source
# lib/rotation-window.sh relative to their own location and FATAL without it, so a bake
# that omits lib/ produces files that exist and cannot run — "installed in name only",
# the same shape as the incident. Asserted by actually EXECUTING the baked copy, because
# a presence check would pass on a lib that is there but unreadable.
echo "Test: the baked kit is RUNNABLE — its sourced lib is baked too"
if [[ ! -f "$COORD_RT/lib/rotation-window.sh" ]]; then
	fail "lib/rotation-window.sh was not baked — both kit scripts refuse to run without it"
elif [[ -L "$COORD_RT/lib/rotation-window.sh" ]]; then
	fail "lib/rotation-window.sh is a SYMLINK into the repo — dangles when the worktree goes"
else
	pass "lib/rotation-window.sh baked as a real file"
fi
# Execute the baked actor end to end. With no latch present it must reach its INCONCLUSIVE
# path (exit 0) rather than die on the FATAL missing-lib guard.
BAKED_OUT="$(CATALYST_DIR="$CDIR" CLAUDE_ACCOUNTS_ENV="$ACCTS" CATALYST_ACCOUNT_ROTATION=shadow \
	bash "$COORD_RT/account-rotation-watch.sh" 2>&1)"
if grep -qi 'FATAL' <<<"$BAKED_OUT"; then
	fail "the baked actor cannot run from the runtime dir: $BAKED_OUT"
else
	pass "the baked actor runs from the runtime dir (no FATAL missing-lib)"
fi
# Positive control: the same invocation against a lib-less bake DOES hit the FATAL guard,
# so the check above is capable of failing.
LIBLESS="$SCRATCH/libless"
mkdir -p "$LIBLESS"
cp "$COORD_RT/account-rotation-watch.sh" "$LIBLESS/"
CTL_OUT="$(CATALYST_DIR="$CDIR" CLAUDE_ACCOUNTS_ENV="$ACCTS" CATALYST_ACCOUNT_ROTATION=shadow \
	bash "$LIBLESS/account-rotation-watch.sh" 2>&1)"
if grep -qi 'FATAL' <<<"$CTL_OUT"; then
	pass "positive control: without lib/ the actor DOES refuse, so the check above can fail"
else
	fail "positive control FAILED — a lib-less bake did not refuse, so the runnable check proves nothing"
fi

echo "Test: the kit scripts are baked as REAL FILES, never symlinks (the incident)"
for s in lane-relaunch.sh; do
	if [[ ! -e "$COORD_RT/$s" ]]; then
		fail "$s was not baked into the runtime dir"
	elif [[ -L "$COORD_RT/$s" ]]; then
		fail "$s is a SYMLINK — a link into the repo/worktree dangles exactly like the job-dir link did"
	elif [[ -x "$COORD_RT/$s" ]]; then
		pass "$s baked as a real, executable file"
	else
		fail "$s baked but is not executable"
	fi
done

echo "Test: one launcher is generated per provisioned handle, from the template"
for h in acct1 acct2 acct3; do
	L="$COORD_RT/launch-on-$h.sh"
	if [[ -f "$L" && -x "$L" ]]; then
		if grep -q 'REPLACE_ACCOUNT\|REPLACE_HOME' "$L"; then
			fail "launch-on-$h.sh still carries an unsubstituted REPLACE_ token"
		elif grep -q "$h" "$L"; then
			pass "launch-on-$h.sh generated and substituted"
		else
			fail "launch-on-$h.sh does not mention its own handle"
		fi
	else
		fail "launch-on-$h.sh missing or not executable"
	fi
done

echo "Test: no launcher is generated for a handle that is not provisioned"
if [[ -e "$COORD_RT/launch-on-acct9.sh" ]]; then
	fail "launch-on-acct9.sh was generated for an unprovisioned handle"
else
	pass "no launcher for an unprovisioned handle"
fi

echo "Test: lanes.manifest is seeded from the example, and lane-pids/ exists"
if [[ -f "$COORD_RT/lanes.manifest" ]]; then pass "lanes.manifest seeded"; else fail "lanes.manifest not seeded"; fi
if [[ -d "$COORD_RT/lane-pids" ]]; then pass "lane-pids/ created"; else fail "lane-pids/ not created"; fi

echo "Test: fleet-account.current is a REAL FILE defaulting to the active handle"
CUR="$COORD_RT/fleet-account.current"
if [[ ! -f "$CUR" ]]; then
	fail "fleet-account.current not seeded"
elif [[ -L "$CUR" ]]; then
	fail "fleet-account.current is a SYMLINK — the exact shape that dangled in the incident"
elif [[ "$(cat "$CUR")" == "acct1" ]]; then
	pass "fleet-account.current seeded to the active handle (acct1)"
else
	fail "fleet-account.current is '$(cat "$CUR")', expected acct1"
fi

echo "Test: no token VALUE leaks into any materialized artifact (secrets hygiene)"
# Positive control first: the probe finds the fake token in the source env file, so a
# clean result below is 'looked and found nothing', not 'could not look'.
if grep -rq 'sk-ant-fake' "$ACCTS"; then
	pass "positive control: the token probe matches the stub accounts env"
else
	fail "positive control FAILED — the token probe cannot match a known-present token"
fi
if grep -rq 'sk-ant-fake' "$COORD_RT" 2>/dev/null; then
	fail "a token VALUE leaked into the materialized coord kit"
else
	pass "no token value in the materialized kit"
fi

# ─── idempotence + operator-edit preservation ────────────────────────────────
echo "Test: re-running preserves an operator-edited lanes.manifest and adds no duplicates"
printf 'ctl /Users/ryan/catalyst/wt/catalyst-workspace\n' >"$COORD_RT/lanes.manifest"
printf 'acct2\n' >"$CUR"
BEFORE_LAUNCHERS="$(find "$COORD_RT" -maxdepth 1 -name 'launch-on-*.sh' | wc -l | tr -d ' ')"
run_materialize "$CDIR" "$ACCTS" >/dev/null
AFTER_LAUNCHERS="$(find "$COORD_RT" -maxdepth 1 -name 'launch-on-*.sh' | wc -l | tr -d ' ')"
if [[ "$(cat "$COORD_RT/lanes.manifest")" == "ctl /Users/ryan/catalyst/wt/catalyst-workspace" ]]; then
	pass "operator-edited lanes.manifest preserved across a re-run"
else
	fail "re-run clobbered the operator-edited lanes.manifest"
fi
if [[ "$(cat "$CUR")" == "acct2" ]]; then
	pass "operator-set fleet-account.current preserved across a re-run"
else
	fail "re-run clobbered fleet-account.current (now '$(cat "$CUR")')"
fi
if [[ "$BEFORE_LAUNCHERS" == "$AFTER_LAUNCHERS" && "$AFTER_LAUNCHERS" == "3" ]]; then
	pass "re-run is idempotent — still exactly 3 launchers"
else
	fail "launcher count changed on re-run: $BEFORE_LAUNCHERS -> $AFTER_LAUNCHERS (expected 3)"
fi

# ─── .coord-source-dir breadcrumb ────────────────────────────────────────────
#
# account-rotation-watch.sh's _resolve_canonical_lib ends on a rung that reads this file.
# It shipped with NO writer anywhere in the repo, so the rung could never fire and the
# materialized actor had no path to canonical-event.sh at all. Assert both halves: the
# file is written, AND the path it records actually resolves the lib the reader builds
# from it — a breadcrumb that exists but points nowhere is the same dead rung.
echo "Test: the .coord-source-dir breadcrumb is written and its recorded path resolves"
BREADCRUMB="$COORD_RT/.coord-source-dir"
if [[ -r "$BREADCRUMB" ]]; then
	pass "wrote .coord-source-dir (the rung has a writer)"
else
	fail "no .coord-source-dir at ${BREADCRUMB} — _resolve_canonical_lib's last rung can never fire"
fi
REC_SRC="$(cat "$BREADCRUMB" 2>/dev/null || true)"
# The exact expression the reader builds: <recorded>/../lib/canonical-event.sh.
if [[ -n "$REC_SRC" && -r "${REC_SRC}/../lib/canonical-event.sh" ]]; then
	pass "the recorded dir resolves ../lib/canonical-event.sh (rung is live, not just present)"
else
	fail "recorded dir '${REC_SRC}' does not resolve ../lib/canonical-event.sh"
fi
# Positive control for the assertion above: the SAME probe against a dir that is
# deliberately wrong must fail, or the check proves nothing.
if [[ -r "${SCRATCH}/../lib/canonical-event.sh" ]]; then
	fail "positive control FAILED — the resolve probe passes for an unrelated dir too"
else
	pass "positive control: the resolve probe fails for an unrelated dir"
fi

# ─── no accounts env: non-fatal, no launchers ────────────────────────────────
echo "Test: with NO claude-accounts.env it is a clear, NON-FATAL no-op for launchers"
CDIR2="$SCRATCH/home-catalyst-2"
OUT2="$(run_materialize "$CDIR2" "$SCRATCH/does-not-exist.env")"
RC2=$?
COORD_RT2="$CDIR2/comms/coord"
if [[ $RC2 -eq 0 ]]; then
	pass "exit 0 (non-fatal delegate contract)"
else
	fail "expected a non-fatal exit 0, got $RC2 — output: $OUT2"
fi
if grep -qi 'claude-accounts.env' <<<"$OUT2"; then
	pass "says WHY no launchers were generated (a silent no-op is the failure mode)"
else
	fail "no message naming the missing claude-accounts.env — output: $OUT2"
fi
if find "$COORD_RT2" -maxdepth 1 -name 'launch-on-*.sh' 2>/dev/null | grep -q .; then
	fail "generated a launcher with no accounts env present"
else
	pass "generated no launchers"
fi
if [[ -x "$COORD_RT2/lane-relaunch.sh" ]]; then
	pass "still baked the kit scripts (the watchdog does not depend on account handles)"
else
	fail "did not bake the kit scripts when the accounts env was absent"
fi

echo ""
echo "== $PASSES passed, $FAILURES failed =="
[ "$FAILURES" -eq 0 ]
