#!/usr/bin/env bash
# Tests for install-account-rotation.sh (CTL-2145 Phase 3).
#
# NO PLATFORM SKIP, deliberately. The sibling install-orphan-sweep.test.sh opens with
# `[[ "$(uname -s)" != "Darwin" ]] && exit 0`, and its own header admits the cost: the
# CI runner is ubuntu, so all of its assertions execute only on a developer's Mac and
# the workflow reports a green skip. A suite whose coverage depends on where it runs is
# the same failure class as an assertion that cannot fail. This one instead drives the
# seams the installer already exposes — CATALYST_FORCE_OS, CATALYST_FORCE_BAKE_DIR, a
# PATH-shadowed launchctl mock, a scratch HOME — so every assertion runs everywhere.
#
# Run: bash plugins/dev/scripts/__tests__/install-account-rotation.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALLER="${REPO_ROOT}/plugins/dev/scripts/install-account-rotation.sh"

PASSES=0
FAILURES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }

SCRATCH="$(mktemp -d)"
# A bake dir that is genuinely NON-ephemeral: not under any temp root, and its own git
# repo so `rev-parse --absolute-git-dir` does not report a .git/worktrees/ path. Built
# inside the repo (like the sibling suite) because every temp root is refused by design.
BAKE_ROOT="${REPO_ROOT}/.tmp-install-account-rotation-test.$$"
trap 'rm -rf "${SCRATCH:?}" "${BAKE_ROOT:?}"' EXIT

if [[ ! -x "$INSTALLER" ]]; then
	fail "${INSTALLER} is missing or not executable"
	echo ""
	echo "== ${PASSES} passed, ${FAILURES} failed =="
	exit 1
fi

# ─── mocks ───────────────────────────────────────────────────────────────────
MOCKBIN="${SCRATCH}/mockbin"
mkdir -p "$MOCKBIN"
LAUNCHCTL_LOG="${SCRATCH}/launchctl.log"
: >"$LAUNCHCTL_LOG"
cat >"$MOCKBIN/launchctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >>"${LAUNCHCTL_LOG}"
exit 0
EOF
chmod +x "$MOCKBIN/launchctl"
export PATH="${MOCKBIN}:${PATH}"
export LAUNCHCTL_LOG

# CTL-1968: launchctl is a PATH-shadowed mock and HOME is a scratch dir, so this suite
# deliberately exercises the bootstrap path. The product refuses to mutate gui/<uid>
# from a foreign HOME (a scratch HOME does NOT sandbox launchd). Declaring the seal is
# how a test opts back in; a suite that FORGOT to seal is what the guard refuses.
export CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1

FAKE_HOME="${SCRATCH}/home"
mkdir -p "${FAKE_HOME}/Library/LaunchAgents" "${FAKE_HOME}/.config/catalyst"
export HOME="$FAKE_HOME"
# Never read the developer's real Layer-2 config: on a host with a registered pristine
# clone the installer would resolve THAT as BAKE_DIR and every path assertion below
# would silently be about the wrong tree.
export CATALYST_LAYER2_CONFIG_FILE="${SCRATCH}/absent-layer2.json"
export CATALYST_FORCE_OS=Darwin
# The stray-loop retire step shells out to `ps` and can kill processes. It has its own
# dedicated section below; every other case opts out so a test run can never signal a
# bystander process.
export CATALYST_SKIP_STRAY_RETIRE=1
# Keep the node-class gate deterministic and off the developer's real config.
export CATALYST_NODE_CLASS=worker

BAKE_DIR="${BAKE_ROOT}/plugins/dev/scripts"
mkdir -p "${BAKE_DIR}/coord"
# Copy the WHOLE coord dir, not just the plist + actor: the install path also runs
# materialize-coord-kit.sh from the bake dir, and a fixture missing it sends test 6b
# down its "reported why it did not run" branch — which passes while leaving the real
# materialize path completely uncovered.
cp -R "${REPO_ROOT}/plugins/dev/scripts/coord/." "${BAKE_DIR}/coord/"
git init -q "$BAKE_ROOT" >/dev/null 2>&1 || true
export CATALYST_FORCE_BAKE_DIR="$BAKE_DIR"

# An accounts env so the D5 applicability gate passes for the install cases.
ACCTS="${SCRATCH}/claude-accounts.env"
printf 'CLAUDE_TOKEN_acct1="sk-ant-fake-1"\nCLAUDE_TOKEN_acct2="sk-ant-fake-2"\n_catalyst_active_token="$CLAUDE_TOKEN_acct1"\n' >"$ACCTS"
export CLAUDE_ACCOUNTS_ENV="$ACCTS"

DEST="${FAKE_HOME}/Library/LaunchAgents/ai.coalesce.catalyst-account-rotation.plist"

# ─── 1. --print renders a valid, fully-substituted plist ─────────────────────

echo "Test 1: --print renders a valid plist"
OUT="$(bash "$INSTALLER" --print 2>&1)"
RC=$?
if [[ $RC -eq 0 ]]; then pass "--print exits 0"; else fail "--print exited ${RC}: $OUT"; fi
grep -q '<string>ai.coalesce.catalyst-account-rotation</string>' <<<"$OUT" &&
	pass "carries the Label" || fail "no Label in rendered plist"
if grep -q "<string>${BAKE_DIR}/coord/account-rotation-watch.sh</string>" <<<"$OUT"; then
	pass "ProgramArguments points at the BAKE dir's actor"
else
	fail "ProgramArguments does not name ${BAKE_DIR}/coord/account-rotation-watch.sh: $(grep -A3 ProgramArguments <<<"$OUT")"
fi
if grep -qE '<integer>[0-9]+</integer>' <<<"$OUT"; then
	pass "StartInterval substituted to an integer"
else
	fail "StartInterval is not an integer: $(grep -A1 StartInterval <<<"$OUT")"
fi
grep -q '<key>KeepAlive</key>' <<<"$OUT" &&
	fail "rendered plist has KeepAlive — it could zombie" || pass "no KeepAlive in the rendered plist"
grep -q '<string>shadow</string>' <<<"$OUT" &&
	pass "rollout knob defaults to shadow" || fail "mode is not shadow by default: $(grep -A3 CATALYST_ACCOUNT_ROTATION <<<"$OUT")"
grep -q "${FAKE_HOME}/catalyst/account-rotation.log" <<<"$OUT" &&
	pass "log path substituted to \$HOME" || fail "log path not substituted"

echo "Test 1b: --print-only is accepted as the same thing (install-services uses it)"
OUT2="$(bash "$INSTALLER" --print-only 2>&1)"
if [[ "$OUT2" == "$OUT" ]]; then
	pass "--print and --print-only render identically"
else
	fail "--print and --print-only disagree"
fi

echo "Test 1c: an unknown flag is REJECTED, not silently treated as an install"
OUT3="$(bash "$INSTALLER" --bogus-flag 2>&1)"
RC3=$?
if [[ $RC3 -ne 0 ]]; then
	pass "unknown flag exits non-zero (rc=${RC3}) instead of installing for real"
else
	fail "unknown flag was ignored and the installer proceeded: $OUT3"
fi

# ─── 2. no REPLACE_ token survives ───────────────────────────────────────────

echo "Test 2: every REPLACE_ token is substituted"
# Exclude the comment block, which documents the tokens by name on purpose.
LEFT="$(grep -n 'REPLACE_' <<<"$OUT" | grep -vE '^\s*[0-9]+:\s*(#|<!--|\s+[0-9]+\.)' | grep -vE 'Replace REPLACE_' || true)"
if [[ -z "$LEFT" ]]; then
	pass "no REPLACE_ token outside the instructional comment"
else
	fail "unsubstituted token(s) remain: $LEFT"
fi
# Positive control: the probe can see an unsubstituted token when one really is left.
if grep -q 'REPLACE_' <<<"$(cat "${BAKE_DIR}/coord/ai.coalesce.catalyst-account-rotation.plist")"; then
	pass "positive control: the raw template DOES contain REPLACE_ tokens"
else
	fail "positive control FAILED — the template has no tokens, so test 2 proves nothing"
fi

echo "Test 2b: PATH and CATALYST_DIR are baked with REAL values (the HIGH finding)"
# A plist without PATH cannot rotate at all: launchd hands a job only its built-in
# /usr/bin:/bin:/usr/sbin:/sbin, and the actor's default switch verb (catalyst-stack)
# lives in ~/.catalyst/bin. It fails as rc=127, and because the actor records the cap
# attempt BEFORE calling the verb, three ticks exhaust the hourly cap and every later
# tick logs "CAPPED" — indistinguishable from a working circuit breaker. Asserting the
# KEY alone is not enough; a PATH with the wrong dirs is the same bug, so assert the
# rendered value actually contains the dir holding catalyst-stack.
env_val_of() { # $1 key — read the <string> that FOLLOWS the given <key>
	grep -A2 "<key>$1</key>" | sed -n 's|.*<string>\(.*\)</string>.*|\1|p' | head -1
}
RENDERED_PATH="$(bash "$INSTALLER" --print 2>/dev/null | env_val_of PATH)"
if [[ -z "$RENDERED_PATH" ]]; then
	fail "the rendered plist declares no PATH — enforce mode can never resolve catalyst-stack"
else
	case ":${RENDERED_PATH}:" in
		*":${HOME}/.catalyst/bin:"*) pass "rendered PATH contains \${HOME}/.catalyst/bin (catalyst-stack resolves)" ;;
		*) fail "rendered PATH lacks \${HOME}/.catalyst/bin, so the switch verb still exit-127s: ${RENDERED_PATH}" ;;
	esac
	case "$RENDERED_PATH" in
		*REPLACE_*) fail "PATH left an unsubstituted token: ${RENDERED_PATH}" ;;
		*) pass "PATH carries no unsubstituted token" ;;
	esac
	# Positive control: the same case-match must be able to MISS.
	case ":/usr/bin:/bin:/usr/sbin:/sbin:" in
		*":${HOME}/.catalyst/bin:"*) fail "positive control FAILED — the PATH probe matches launchd's built-in PATH" ;;
		*) pass "positive control: the PATH probe rejects launchd's built-in PATH" ;;
	esac
fi

echo "Test 2c: a NON-DEFAULT CATALYST_DIR is persisted, and matches the materialized kit"
# launchd does not inherit the installing shell's environment. With CATALYST_DIR unset
# in the agent, account-rotation-watch.sh resolves it to \$HOME/catalyst and reads a
# latch that is not there — reporting INCONCLUSIVE on every tick forever — while the
# installer computed COORD_RT from the INSTALLING shell and materialized the kit
# somewhere else. Installer and agent must not be able to disagree, so assert the
# plist's value equals the dir the installer's own COORD_RT is derived from.
ALT_DIR="${SCRATCH}/alt-catalyst-runtime"
mkdir -p "$ALT_DIR"
RENDERED_CD="$(CATALYST_DIR="$ALT_DIR" bash "$INSTALLER" --print 2>/dev/null | env_val_of CATALYST_DIR)"
if [[ "$RENDERED_CD" == "$ALT_DIR" ]]; then
	pass "a non-default CATALYST_DIR is persisted into the plist verbatim"
else
	fail "expected CATALYST_DIR '${ALT_DIR}' in the plist, got '${RENDERED_CD}'"
fi
# The agent resolves COMMS_DIR as \${CATALYST_DIR}/comms/coord and the installer
# resolves COORD_RT the same way, so equal CATALYST_DIR is exactly equal COORD_RT.
# Assert that identity rather than trusting the two to stay in step by inspection.
if [[ "${RENDERED_CD}/comms/coord" == "${ALT_DIR}/comms/coord" ]]; then
	pass "the agent's COMMS_DIR resolves to the installer's COORD_RT (${ALT_DIR}/comms/coord)"
else
	fail "agent COMMS_DIR '${RENDERED_CD}/comms/coord' != installer COORD_RT '${ALT_DIR}/comms/coord'"
fi
# Positive control: the default render must differ, or the assertion above would pass
# on a plist that ignores CATALYST_DIR entirely.
DEFAULT_CD="$(bash "$INSTALLER" --print 2>/dev/null | env_val_of CATALYST_DIR)"
if [[ "$DEFAULT_CD" != "$RENDERED_CD" ]]; then
	pass "positive control: the default render (${DEFAULT_CD}) differs, so the value really tracks CATALYST_DIR"
else
	fail "positive control FAILED — the plist renders the same CATALYST_DIR regardless of the env"
fi

# ─── 3. pristine-path guard ──────────────────────────────────────────────────

echo "Test 3: an ephemeral bake dir is REFUSED and renders nothing"
for BAD in "/tmp/fake-catalyst-scripts" "${SCRATCH}/scripts"; do
	OUT4="$(CATALYST_FORCE_BAKE_DIR="$BAD" bash "$INSTALLER" --print 2>&1)"
	RC4=$?
	if [[ $RC4 -ne 0 ]] && ! grep -q '<plist' <<<"$OUT4"; then
		pass "refused ${BAD} (rc=${RC4}) and rendered no plist"
	else
		fail "did NOT refuse ${BAD} (rc=${RC4}): $(head -3 <<<"$OUT4")"
	fi
done
echo "Test 3b: a real LINKED WORKTREE is refused (the CTL-1306 shape)"
# The repo this test runs from is itself a linked worktree in normal development; when
# it is not, skip LOUDLY rather than silently reporting a pass.
WT_GITDIR="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir 2>/dev/null || true)"
case "$WT_GITDIR" in
	*/worktrees/*)
		OUT5="$(CATALYST_FORCE_BAKE_DIR="${REPO_ROOT}/plugins/dev/scripts" bash "$INSTALLER" --print 2>&1)"
		RC5=$?
		if [[ $RC5 -ne 0 ]]; then
			pass "refused a real linked worktree (rc=${RC5})"
		else
			fail "installed from a linked worktree — the path that vanishes"
		fi
		;;
	*)
		echo "  SKIP: this checkout is not a linked worktree (git-dir=${WT_GITDIR:-unknown});"
		echo "        the /tmp and /var/folders arms above still ran."
		;;
esac

# ─── 4. mode-resolution precedence ───────────────────────────────────────────

echo "Test 4: mode precedence env > config > installed plist > shadow"
mode_of() { grep -A2 '<key>CATALYST_ACCOUNT_ROTATION</key>' | sed -n 's|.*<string>\(.*\)</string>.*|\1|p' | head -1; }

GOT="$(CATALYST_ACCOUNT_ROTATION=enforce bash "$INSTALLER" --print 2>/dev/null | mode_of)"
[[ "$GOT" == "enforce" ]] && pass "env wins (enforce)" || fail "env: expected enforce, got '$GOT'"

PROJ="${SCRATCH}/proj"
mkdir -p "${PROJ}/.catalyst"
printf '{"catalyst":{"accountRotation":{"mode":"enforce"}}}\n' >"${PROJ}/.catalyst/config.json"
GOT="$(cd "$PROJ" && bash "$INSTALLER" --print 2>/dev/null | mode_of)"
[[ "$GOT" == "enforce" ]] && pass "config wins when env is unset" || fail "config: expected enforce, got '$GOT'"

# The installed-plist clause: a hand-flip must survive a routine reinstall.
mkdir -p "$(dirname "$DEST")"
bash "$INSTALLER" --print 2>/dev/null | sed 's|<string>shadow</string>|<string>enforce</string>|' >"$DEST"
GOT="$(bash "$INSTALLER" --print 2>/dev/null | mode_of)"
if [[ "$GOT" == "enforce" ]]; then
	pass "a hand-flip in the installed plist survives a reinstall"
else
	fail "installed-plist clause: expected enforce, got '$GOT' — a routine reinstall would revert an operator's flip"
fi

echo "Test 4b: an invalid mode falls back to shadow and does NOT fall through"
# The load-bearing case: `enforce` is sitting in the installed plist from above, so a
# mistyped rollback must not be "corrected" back to it.
GOT="$(CATALYST_ACCOUNT_ROTATION=shdow bash "$INSTALLER" --print 2>/dev/null | mode_of)"
if [[ "$GOT" == "shadow" ]]; then
	pass "typo => shadow, NOT the enforce sitting in the installed plist"
else
	fail "typo resolved to '$GOT' — an attempt to DISARM re-armed it"
fi
rm -f "$DEST"

echo "Test 4c: the invalid-mode warning NAMES THE SOURCE it actually read"
# The message used to hardcode CATALYST_ACCOUNT_ROTATION even when the bad value came
# from config or from the installed plist, sending an operator to grep the one place
# the typo is not. Behaviour (short-circuit to shadow) is unchanged; only attribution.
BADPROJ="${SCRATCH}/badproj"
mkdir -p "${BADPROJ}/.catalyst"
printf '{"catalyst":{"accountRotation":{"mode":"shdow"}}}\n' >"${BADPROJ}/.catalyst/config.json"
WARN_OUT="$(cd "$BADPROJ" && bash "$INSTALLER" --print 2>&1 >/dev/null)"
if grep -q 'config.json' <<<"$WARN_OUT"; then
	pass "a config typo is attributed to the config file"
else
	fail "config typo not attributed to config.json: ${WARN_OUT}"
fi
if grep -q "env CATALYST_ACCOUNT_ROTATION" <<<"$WARN_OUT"; then
	fail "a config typo is STILL blamed on the env var: ${WARN_OUT}"
else
	pass "a config typo is no longer blamed on the env var"
fi
GOT="$(cd "$BADPROJ" && bash "$INSTALLER" --print 2>/dev/null | mode_of)"
[[ "$GOT" == "shadow" ]] && pass "config typo still short-circuits to shadow (behaviour unchanged)" || fail "config typo resolved to '$GOT'"

# The env source must still be named when the env really is the culprit — otherwise
# the attribution change would just move the blame rather than fix it.
WARN_ENV="$(CATALYST_ACCOUNT_ROTATION=shdow bash "$INSTALLER" --print 2>&1 >/dev/null)"
if grep -q "env CATALYST_ACCOUNT_ROTATION" <<<"$WARN_ENV"; then
	pass "an env typo is attributed to the env var"
else
	fail "env typo not attributed to the env var: ${WARN_ENV}"
fi

# ─── 5. applicability gate (D5) ──────────────────────────────────────────────

echo "Test 5: the D5 gate refuses non-fatally, and never silently"
OUT6="$(CATALYST_NODE_CLASS=monitor bash "$INSTALLER" 2>&1)"
RC6=$?
if [[ $RC6 -eq 0 ]]; then pass "wrong node class: exit 0 (non-fatal delegate)"; else fail "wrong node class exited ${RC6}"; fi
if [[ ! -f "$DEST" ]]; then pass "wrong node class: installed nothing"; else fail "installed on a monitor node"; fi
if grep -qi "node class" <<<"$OUT6"; then pass "wrong node class: said why"; else fail "refused silently: $OUT6"; fi

OUT7="$(CLAUDE_ACCOUNTS_ENV="${SCRATCH}/no-such-accounts.env" bash "$INSTALLER" 2>&1)"
RC7=$?
if [[ $RC7 -eq 0 ]]; then pass "no accounts env: exit 0 (non-fatal delegate)"; else fail "no accounts env exited ${RC7}"; fi
if [[ ! -f "$DEST" ]]; then pass "no accounts env: installed nothing"; else fail "installed with no accounts to rotate between"; fi
if grep -qi "claude-accounts.env" <<<"$OUT7"; then pass "no accounts env: named the missing file"; else fail "refused silently: $OUT7"; fi

# ─── 6. install + idempotent reinstall ───────────────────────────────────────

echo "Test 6: install writes the plist and bootstraps idempotently"
: >"$LAUNCHCTL_LOG"
OUT8="$(bash "$INSTALLER" 2>&1)"
RC8=$?
if [[ $RC8 -eq 0 ]]; then pass "install exits 0"; else fail "install exited ${RC8}: $OUT8"; fi
if [[ -f "$DEST" ]]; then pass "wrote ${DEST##*/}"; else fail "no plist at $DEST"; fi
grep -q "bootout gui/$(id -u)/ai.coalesce.catalyst-account-rotation" "$LAUNCHCTL_LOG" &&
	pass "booted out any existing instance first" || fail "no bootout: $(cat "$LAUNCHCTL_LOG")"
grep -q "bootstrap gui/$(id -u)" "$LAUNCHCTL_LOG" &&
	pass "bootstrapped the fresh plist" || fail "no bootstrap: $(cat "$LAUNCHCTL_LOG")"
# NOT `grep -q ... | grep -v '#'`: `-q` prints nothing, so the downstream grep can only
# ever exit 1 and the `else` branch fires whether or not a token survived — a check that
# cannot fail. Match the operative lines directly, excluding the instructional comment.
INSTALLED_LEFT="$(grep -n 'REPLACE_' "$DEST" 2>/dev/null | grep -vE ':[[:space:]]*(#|<!--)' | grep -vE 'Replace REPLACE_' || true)"
if [[ -n "$INSTALLED_LEFT" ]]; then
	fail "the INSTALLED plist still carries a REPLACE_ token: $INSTALLED_LEFT"
else
	pass "the installed plist is substituted"
fi
# Positive control: the same probe DOES fire on the raw template.
if [[ -n "$(grep -n 'REPLACE_WITH_ABSOLUTE' "${BAKE_DIR}/coord/ai.coalesce.catalyst-account-rotation.plist" | grep -vE ':[[:space:]]*(#|<!--)' | grep -vE 'Replace REPLACE_' || true)" ]]; then
	pass "positive control: the installed-plist token probe fires on the raw template"
else
	fail "positive control FAILED — the token probe cannot fire, so the check above proves nothing"
fi
# Re-running must be safe and must converge on the same content.
CKSUM1="$(cksum <"$DEST")"
: >"$LAUNCHCTL_LOG"
bash "$INSTALLER" >/dev/null 2>&1
CKSUM2="$(cksum <"$DEST")"
if [[ "$CKSUM1" == "$CKSUM2" ]]; then
	pass "reinstall is idempotent (identical plist)"
else
	fail "reinstall produced a different plist"
fi

echo "Test 6b: the install path materialized the coord kit"
if grep -qi "materialized the coord kit" <<<"$OUT8"; then
	pass "ran materialize-coord-kit.sh"
else
	fail "materialize did not run: $OUT8"
fi
# And it produced the runtime dir the lane watchdog reads, as REAL files.
COORD_RT="${FAKE_HOME}/catalyst/comms/coord"
for f in lane-relaunch.sh account-rotation-watch.sh lib/rotation-window.sh; do
	if [[ -f "${COORD_RT}/${f}" && ! -L "${COORD_RT}/${f}" ]]; then
		pass "baked ${f} into the runtime dir as a real file"
	else
		fail "runtime dir is missing (or symlinked) ${f}"
	fi
done
if [[ -f "${COORD_RT}/launch-on-acct1.sh" && -f "${COORD_RT}/launch-on-acct2.sh" ]]; then
	pass "generated one launcher per provisioned handle"
else
	fail "per-account launchers were not generated into ${COORD_RT}"
fi

# ─── 7. --uninstall ──────────────────────────────────────────────────────────

echo "Test 7: --uninstall boots out and removes the plist"
: >"$LAUNCHCTL_LOG"
OUT9="$(bash "$INSTALLER" --uninstall 2>&1)"
RC9=$?
if [[ $RC9 -eq 0 ]]; then pass "--uninstall exits 0"; else fail "--uninstall exited ${RC9}: $OUT9"; fi
if [[ ! -f "$DEST" ]]; then pass "removed the plist"; else fail "plist still present"; fi
grep -q "bootout gui/$(id -u)/ai.coalesce.catalyst-account-rotation" "$LAUNCHCTL_LOG" &&
	pass "called bootout" || fail "no bootout on uninstall: $(cat "$LAUNCHCTL_LOG")"

echo "Test 7b: --uninstall works from an EPHEMERAL path (CTL-1306)"
# uninstall must never be gated on the bake dir, or `uninstall-services` from a
# worktree cannot remove the agent it is trying to remove.
: >"$LAUNCHCTL_LOG"
OUT10="$(CATALYST_FORCE_BAKE_DIR=/tmp/nope bash "$INSTALLER" --uninstall 2>&1)"
RC10=$?
if [[ $RC10 -eq 0 ]]; then
	pass "--uninstall from an ephemeral bake dir still exits 0"
else
	fail "--uninstall was blocked by the bake-dir guard (rc=${RC10}): $OUT10"
fi

echo "Test 7c: --uninstall is NOT gated on the D5 applicability check"
: >"$LAUNCHCTL_LOG"
RC11=0
CATALYST_NODE_CLASS=monitor CLAUDE_ACCOUNTS_ENV="${SCRATCH}/gone.env" bash "$INSTALLER" --uninstall >/dev/null 2>&1 || RC11=$?
if [[ $RC11 -eq 0 ]] && grep -q "bootout" "$LAUNCHCTL_LOG"; then
	pass "removing an agent that should not be there is exactly what uninstall is for"
else
	fail "uninstall was gated on applicability (rc=${RC11}); a mis-classed host could never clean up"
fi

# ─── 8. stray-loop retire (deliverable 4) ────────────────────────────────────
#
# The only section that lets the retire step run. It is exercised against a REAL
# self-limiting background process, never a `while :` spinner: an unbounded loop that
# outlives a failed assertion is the incident this repo already had (four spinners,
# ~4 CPU cores, 16.5 hours, while the script reported "cleanup verified").

echo "Test 8: the stray-loop retire kills a foreign loop and verifies positively"
STRAY_DIR="${SCRATCH}/old-job-dir"
mkdir -p "$STRAY_DIR"
cat >"${STRAY_DIR}/lane-relaunch.sh" <<'EOF'
#!/usr/bin/env bash
# Self-limiting stand-in for the zombie: it sleeps, and it dies on its own after 120s
# even if every kill below fails. Never `while :; do :; done`.
end=$((SECONDS + 120))
while [ $SECONDS -lt $end ]; do sleep 1; done
EOF
chmod +x "${STRAY_DIR}/lane-relaunch.sh"
bash "${STRAY_DIR}/lane-relaunch.sh" &
STRAY_PID=$!
sleep 1
if ps -p "$STRAY_PID" >/dev/null 2>&1; then
	pass "positive control: the stray loop is running before the installer sees it"
else
	fail "positive control FAILED — the stray never started, so the retire below proves nothing"
fi
OUT11="$(CATALYST_SKIP_STRAY_RETIRE=0 bash "$INSTALLER" 2>&1)"
# Fail CLOSED: assert the process is GONE with `ps -p`, never `kill -0 && echo`, which
# prints nothing when the probe itself errors and self-certifies success either way.
if ps -p "$STRAY_PID" >/dev/null 2>&1; then
	fail "the stray loop SURVIVED the retire step (pid ${STRAY_PID})"
	kill -9 "$STRAY_PID" 2>/dev/null || true
else
	pass "the stray loop is gone (asserted positively with ps -p)"
fi
if grep -qi "retiring stray" <<<"$OUT11"; then pass "logged the retirement"; else fail "retired silently: $OUT11"; fi

echo "Test 8b: retire is idempotent — a second run on a clean machine is a no-op"
OUT12="$(CATALYST_SKIP_STRAY_RETIRE=0 bash "$INSTALLER" 2>&1)"
RC12=$?
if [[ $RC12 -eq 0 ]] && grep -qi "no stray lane/rotation loop found" <<<"$OUT12"; then
	pass "clean machine: says so and exits 0"
else
	fail "second run was not a clean no-op (rc=${RC12}): $OUT12"
fi

echo "Test 8c: the retire step does NOT kill the supervised copy in the bake dir"
cp "${STRAY_DIR}/lane-relaunch.sh" "${BAKE_DIR}/coord/lane-relaunch.sh"
bash "${BAKE_DIR}/coord/lane-relaunch.sh" &
GOOD_PID=$!
sleep 1
CATALYST_SKIP_STRAY_RETIRE=0 bash "$INSTALLER" >/dev/null 2>&1
if ps -p "$GOOD_PID" >/dev/null 2>&1; then
	pass "left the current bake dir's own watchdog alone"
else
	fail "killed the supervised watchdog running from the bake dir"
fi
kill "$GOOD_PID" 2>/dev/null || true
wait "$GOOD_PID" 2>/dev/null || true

echo "Test 8d: the retire step does NOT kill the MATERIALIZED runtime copy"
# The copy operators are TOLD to run — coord/lane-relaunch.sh's own Usage header says
# "Run it from the materialized location, not from the repo". It lives under
# ${CATALYST_DIR:-$HOME/catalyst}/comms/coord, which is NOT under BAKE_DIR, so a
# BAKE_DIR-only exclusion classifies the fleet's live lane watchdog as a stray and
# TERM/KILLs it on every routine `catalyst-stack install-services`. Test 8c proves only
# the bake-dir copy survives; that gap is why this shipped green once already.
#
# Overwriting the materialized script mid-flight is safe: materialize-coord-kit.sh's
# _install_file is tmp+`mv -f`, so the running child keeps its own inode.
COORD_RT="${FAKE_HOME}/catalyst/comms/coord"
mkdir -p "$COORD_RT"
cp "${STRAY_DIR}/lane-relaunch.sh" "${COORD_RT}/lane-relaunch.sh"
chmod +x "${COORD_RT}/lane-relaunch.sh"
bash "${COORD_RT}/lane-relaunch.sh" &
RT_PID=$!
sleep 1
if ps -p "$RT_PID" >/dev/null 2>&1; then
	pass "positive control: the materialized watchdog is running before the installer sees it"
else
	fail "positive control FAILED — the materialized stand-in never started, so the assertion below proves nothing"
fi
OUT13="$(CATALYST_SKIP_STRAY_RETIRE=0 bash "$INSTALLER" 2>&1)"
if ps -p "$RT_PID" >/dev/null 2>&1; then
	pass "left the materialized lane watchdog alone"
else
	fail "KILLED the materialized lane watchdog (${COORD_RT}/lane-relaunch.sh): $OUT13"
fi
kill "$RT_PID" 2>/dev/null || true
wait "$RT_PID" 2>/dev/null || true

# Nothing this suite started may outlive it.
for p in "${STRAY_PID:-}" "${GOOD_PID:-}" "${RT_PID:-}"; do
	[[ -n "$p" ]] && kill -9 "$p" 2>/dev/null || true
done
LEAKED=0
for p in "${STRAY_PID:-}" "${GOOD_PID:-}" "${RT_PID:-}"; do
	[[ -n "$p" ]] && ps -p "$p" >/dev/null 2>&1 && LEAKED=1
done
if [[ $LEAKED -eq 0 ]]; then pass "no test process leaked"; else fail "a test process LEAKED"; fi


# ─── 14. a host that STOPS qualifying has its agent retired, not just declined ─
#
# CTL-2145 (Codex #3867 P1). The D5 gate in test 5 only ever DECLINED — it exited 0 and
# left whatever was already installed exactly where it was. So a worker reclassified to
# `monitor`, or one whose claude-accounts.env was removed, kept a LOADED LaunchAgent baked
# with its old mode (potentially `enforce`), still rotating accounts and restarting the
# stack on a host the gate now explicitly excludes — and every routine install-services run
# re-affirmed that state while logging a line that reads like the agent is absent.
#
# Both refusal paths are exercised, because they are two independent branches and only one
# of them had ever been reached with a plist already on disk.

echo "Test 14: a reclassified host retires the agent it already has"
: >"$LAUNCHCTL_LOG"
bash "$INSTALLER" >/dev/null 2>&1                       # install as a qualifying worker
if [[ -f "$DEST" ]]; then
	pass "positive control: the agent IS installed before the host stops qualifying"
else
	fail "fixture failed — nothing installed, so the retirement below would prove nothing"
fi
: >"$LAUNCHCTL_LOG"
OUT14="$(CATALYST_NODE_CLASS=monitor bash "$INSTALLER" 2>&1)"
RC14=$?
if [[ ! -e "$DEST" ]]; then
	pass "node-class refusal REMOVED the stale plist"
else
	fail "left ${DEST} in place on a host the gate excludes: $OUT14"
fi
if grep -q 'bootout' "$LAUNCHCTL_LOG" 2>/dev/null; then
	pass "booted the label out of the domain (removing the file alone leaves it loaded)"
else
	fail "never called launchctl bootout — the old agent keeps running: $(cat "$LAUNCHCTL_LOG")"
fi
if [[ $RC14 -eq 0 ]]; then
	pass "still exit 0 — retirement does not turn a non-fatal delegate into a failure"
else
	fail "retirement exited ${RC14}: $OUT14"
fi
if grep -qi 'retired' <<<"$OUT14"; then
	pass "said it retired the agent (a silent removal is as opaque as a silent no-op)"
else
	fail "removed the agent without saying so: $OUT14"
fi

echo "Test 14b: the same retirement fires when claude-accounts.env disappears"
: >"$LAUNCHCTL_LOG"
bash "$INSTALLER" >/dev/null 2>&1
if [[ ! -f "$DEST" ]]; then fail "fixture failed — reinstall did not restore the plist"; fi
: >"$LAUNCHCTL_LOG"
OUT15="$(CLAUDE_ACCOUNTS_ENV="${SCRATCH}/no-such-accounts.env" bash "$INSTALLER" 2>&1)"
if [[ ! -e "$DEST" ]] && grep -q 'bootout' "$LAUNCHCTL_LOG" 2>/dev/null; then
	pass "accounts-env refusal also retires the installed agent"
else
	fail "accounts-env refusal left the agent installed: $OUT15"
fi

echo "Test 14c: retirement is idempotent — nothing installed means nothing to do"
: >"$LAUNCHCTL_LOG"
OUT16="$(CATALYST_NODE_CLASS=monitor bash "$INSTALLER" 2>&1)"
RC16=$?
if [[ $RC16 -eq 0 ]] && ! grep -qi 'retired' <<<"$OUT16"; then
	pass "a second refusal on a clean host retires nothing and stays quiet about it"
else
	fail "claimed a retirement with nothing installed: $OUT16"
fi

# ─── 15. --print-only renders on a NON-Darwin host ───────────────────────────
#
# CTL-2145 (Codex #3867 P2). Print mode is documented as a side-effect-free preview and
# `catalyst-stack install-services --print` calls this delegate BEFORE its own Darwin gate.
# The platform gate used to sit ahead of the print branch, so on Linux the delegate exited 0
# having rendered nothing — and because the caller suppresses this delegate's stderr and
# accepts exit 0, "rendered nothing" and "rendered fine" were indistinguishable. The plist
# was simply missing from every non-Darwin preview.

echo "Test 15: --print-only renders on a non-Darwin host"
OUT17="$(CATALYST_FORCE_OS=Linux bash "$INSTALLER" --print 2>/dev/null)"
RC17=$?
if [[ $RC17 -eq 0 ]]; then pass "exit 0 on Linux"; else fail "--print on Linux exited ${RC17}"; fi
if grep -q '<string>ai.coalesce.catalyst-account-rotation</string>' <<<"$OUT17"; then
	pass "rendered the plist rather than exiting empty at the platform gate"
else
	fail "--print on Linux rendered nothing — the preview silently omits the agent"
fi
if [[ ! -e "$DEST" ]]; then
	pass "and installed nothing (print stays side-effect-free)"
else
	fail "--print on Linux installed a plist"
fi

echo "Test 15b: a real INSTALL on a non-Darwin host still exits early and non-fatally"
OUT18="$(CATALYST_FORCE_OS=Linux bash "$INSTALLER" 2>&1)"
RC18=$?
if [[ $RC18 -eq 0 && ! -e "$DEST" ]]; then
	pass "install path still no-ops on Linux (exit 0, nothing written)"
else
	fail "the print exemption leaked into the install path: rc=${RC18}"
fi
if grep -qi 'non-Darwin' <<<"$OUT18"; then
	pass "and still says why"
else
	fail "Linux install refused silently: $OUT18"
fi


# ─── 16. a stray loop that SURVIVES retirement fails the install ─────────────
#
# CTL-2145 (Codex #3867 P1). The final survival probe is written as a positive control
# precisely so it CAN fail — but its verdict was then thrown away by an unconditional
# `return 0`, so an install proceeded and reported success with the old loop still running
# alongside the new actor. (The tempting `((stale == 0)) && echo …` form does not save it
# either: that yields the AND-list's status, which `set -e` deliberately exempts, so it
# looks fail-closed while returning 0.)
#
# A process that survives both TERM and KILL cannot be fabricated portably — that is the
# point of the finding, since it happens for reasons the installer does not control (owned
# by another user, an unreaped zombie). So the PROBE is seamed instead: a PATH-shadowed `ps`
# that reports a stray on `-eo` and reports it still alive on `-p`, which is exactly the
# observable state a survivor produces. Scoped to these two cases only.

echo "Test 16: a stray loop surviving TERM and KILL refuses the install"
PSMOCK="${SCRATCH}/psmock"
mkdir -p "$PSMOCK"
make_ps_mock() { # $1 = "alive" | "dead" — what `ps -p <fake>` reports after the kills
	cat >"${PSMOCK}/ps" <<EOF
#!/usr/bin/env bash
FAKE_PID=99991
SURVIVES=$1
if [[ "\$*" == *"-eo"* ]]; then
	# Discovery: one stray, at a path that is neither the bake dir nor the runtime kit.
	printf '%7s %s\n' "\$FAKE_PID" "bash /private/tmp/ctl2145-fake-stray/lane-relaunch.sh"
	exit 0
fi
if [[ "\$1" == "-p" && "\$2" == "\$FAKE_PID" ]]; then
	[[ "\$SURVIVES" == "alive" ]] && exit 0
	exit 1
fi
exec /bin/ps "\$@"
EOF
	chmod +x "${PSMOCK}/ps"
}

make_ps_mock alive
rm -f "$DEST"
OUT19="$(PATH="${PSMOCK}:$PATH" CATALYST_SKIP_STRAY_RETIRE=0 bash "$INSTALLER" 2>&1)"
RC19=$?
if [[ $RC19 -ne 0 ]]; then
	pass "exited non-zero when the stray survived (the probe's verdict is load-bearing)"
else
	fail "install reported SUCCESS with a surviving stray loop: $OUT19"
fi
if [[ ! -e "$DEST" ]]; then
	pass "installed nothing — the refusal happens BEFORE the plist is written"
else
	fail "wrote ${DEST} despite refusing: the new actor now runs beside the old loop"
fi
if grep -qi 'SURVIVED' <<<"$OUT19" && grep -qi 'REFUSING' <<<"$OUT19"; then
	pass "named both the survivor and the refusal"
else
	fail "refused without naming what happened: $OUT19"
fi

# POSITIVE CONTROL — the identical mock, differing ONLY in what the survival probe reports.
# Without it, a mock that simply broke the installer would pass every assertion above.
echo "Test 16b: positive control — the same mock with the stray actually gone installs fine"
make_ps_mock dead
rm -f "$DEST"
OUT20="$(PATH="${PSMOCK}:$PATH" CATALYST_SKIP_STRAY_RETIRE=0 bash "$INSTALLER" 2>&1)"
RC20=$?
if [[ $RC20 -eq 0 && -f "$DEST" ]]; then
	pass "positive control: install succeeds when the stray is gone — the refusal was the probe, not the mock"
else
	fail "positive control FAILED (rc=${RC20}, plist $([[ -f "$DEST" ]] && echo present || echo absent)): test 16 proves nothing — $OUT20"
fi
if grep -qi 'verified all retired stray loops are gone' <<<"$OUT20"; then
	pass "and it says so positively rather than by silence"
else
	fail "clean retire printed no confirmation: $OUT20"
fi

echo ""
echo "== ${PASSES} passed, ${FAILURES} failed =="
[[ $FAILURES -eq 0 ]]
