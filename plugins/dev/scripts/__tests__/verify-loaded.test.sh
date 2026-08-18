#!/usr/bin/env bash
# verify-loaded.test.sh — CTL-1916.
#
# ⛔ EVERY CASE COMES IN A PAIR. The tool's entire value is that it FAILS on a host that is
# not running what you think — so a suite that only ever shows it passing would certify
# nothing. Each negative below shares its fixture with a positive, changing exactly one
# fact, so a green result is evidence about that fact and not about the harness.
#
# The transport is sealed at the ONE seam the script routes every host question through
# (CATALYST_VERIFY_LOADED_RUNNER), rather than by shadowing `ssh`/`ps`/`grep` on PATH:
# a PATH stub only proves the stubbed name was not invoked, which is not the same as
# proving nothing reached the network.
#
# Run: bash plugins/dev/scripts/__tests__/verify-loaded.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV="$(cd "${SCRIPT_DIR}/.." && pwd)"
VL="${DEV}/verify-loaded.sh"

FAILURES=0; PASSES=0
ok()   { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
bad()  { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; echo "    $2"; }

# Portable mtime (Codex #3496 P1): this suite is gated on ubuntu-latest, where BSD
# `stat -f %m` means "file SYSTEM status" and aborts. The first cut used the macOS spelling
# and every CI run of this workflow died at line 39 before a single case executed —
# a test file that cannot start is indistinguishable from one with nothing to say.
# ⛔ PROBE THE DIALECT; DO NOT RELY ON THE WRONG ONE FAILING. The obvious
# `stat -f %m "$f" || stat -c %Y "$f"` is broken on GNU in the silent direction: `-f` there
# means "file SYSTEM status", so GNU stat treats BOTH `%m` and the filename as files,
# errors on `%m`, SUCCEEDS on the real file, and prints a multi-line block starting
# `  File: …` — exit 0, so the `||` never fires and that text flows into `$(( ))`, which
# under `set -u` dies with `File: unbound variable`. That is exactly what CI reported on
# the first fix attempt: a fallback that cannot detect its own failure.
if stat -c %Y . >/dev/null 2>&1; then
  _mtime() { stat -c %Y "$1"; }        # GNU/coreutils (ubuntu-latest)
else
  _mtime() { stat -f %m "$1"; }        # BSD/macOS
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ROOT="${TMP}/plugin-source"
MODULE_REL="plugins/dev/scripts/execution-core/cloud-feed-timer.mjs"
mkdir -p "$(dirname "${ROOT}/${MODULE_REL}")"
echo 'export const ok = true;' > "${ROOT}/${MODULE_REL}"

# The fake host. Every knob a case needs to vary is a file, so a case changes one fact and
# nothing else.
echo "12345"                                     > "${TMP}/pid"
echo "bun ${ROOT}/plugins/dev/scripts/execution-core/daemon.mjs" > "${TMP}/cmd"
echo '{"pid":12345,"mode":"enforce","armed":true,"msg":"cloud-feed: armed"}' > "${TMP}/daemon.log"
# start time is well after the module mtime unless a case says otherwise
echo "$(( $(_mtime "${ROOT}/${MODULE_REL}") + 60 )) $(_mtime "${ROOT}/${MODULE_REL}")" > "${TMP}/epochs"

cat > "${TMP}/runner.sh" <<'RUNNER'
#!/usr/bin/env bash
# $1 = host, $2 = command. Answers from the fixture files by inspecting the command shape.
T="${FIXTURE_DIR}"
cmd="$2"
# The injected runner can be made to FAIL wholesale, which is how the unreachable-host
# case is exercised (Codex #3496 P1: an unreachable host must not read as an absence).
if [ -f "${T}/runner_dies" ]; then echo "ssh: connect to host: Connection refused" >&2; exit 255; fi
case "$cmd" in
  *VL_REACHABLE_9f3a*) echo "VL_REACHABLE_9f3a" ;;
  *pgrep*)     cat "${T}/pid" ;;   # must precede the ps case: the probe contains both
  *"-o command="*) cat "${T}/cmd" ;;
  *"test -f"*) p="${cmd#*test -f \'}"; p="${p%%\'*}"; [ -f "$p" ] && echo yes || echo no ;;
  *IMPORT_OK*) if [ -f "${T}/import_fails" ]; then echo "error: Cannot find package"; else echo IMPORT_OK; fi ;;
  *"cloud-feed: armed"*) bash -c "$cmd" ;;   # REAL grep against the fixture log
  *lstart*)    cat "${T}/epochs" ;;
  *)           echo "" ;;
esac
RUNNER
chmod +x "${TMP}/runner.sh"

run_vl() {
  FIXTURE_DIR="$TMP" CATALYST_VERIFY_LOADED_RUNNER="${TMP}/runner.sh" \
    bash "$VL" --root "$ROOT" --host fakehost --log "${TMP}/daemon.log" "$@" 2>&1
}

expect_exit() {
  local name="$1" want="$2"; shift 2
  local out; out="$(run_vl "$@")"; local got=$?
  if [[ "$got" == "$want" ]]; then ok "$name"; else bad "$name" "expected exit ${want}, got ${got}:
${out}"; fi
}

echo "── worker role: the four links ──"

# ⭐ THE POSITIVE. Without it every FAIL below could be produced by a broken harness.
expect_exit "a correctly-loaded host PASSES (exit 0)" 0 --mode enforce

# ⭐ THE CONTROL THE TICKET NAMES: the daemon serving a DIFFERENT root.
echo "bun /somewhere/else/plugins/dev/scripts/execution-core/daemon.mjs" > "${TMP}/cmd"
expect_exit "a daemon serving a DIFFERENT root FAILS" 1 --mode enforce
out="$(run_vl --mode enforce)"
[[ "$out" == *"is NOT serving"* ]] && ok "…and names the root it is actually serving" \
  || bad "…and names the root it is actually serving" "$out"
echo "bun ${ROOT}/plugins/dev/scripts/execution-core/daemon.mjs" > "${TMP}/cmd"   # restore

# no daemon at all
: > "${TMP}/pid"
expect_exit "no daemon process at all FAILS" 1 --mode enforce
echo "12345" > "${TMP}/pid"

# module absent
mv "${ROOT}/${MODULE_REL}" "${TMP}/stashed-module"
expect_exit "an ABSENT gate module FAILS" 1 --mode enforce
mv "${TMP}/stashed-module" "${ROOT}/${MODULE_REL}"

# ⚠️ present-but-unimportable: the CTL-1831 shape, invisible to every git-level check.
touch "${TMP}/import_fails"
expect_exit "a module that is on disk but does NOT import FAILS" 1 --mode enforce
rm -f "${TMP}/import_fails"

# mode mismatch
expect_exit "a DIFFERENT announced mode FAILS" 1 --mode shadow

# ⛔ the armed line written by ANOTHER pid must not satisfy this pid's link
echo '{"pid":999,"mode":"enforce","armed":true,"msg":"cloud-feed: armed"}' > "${TMP}/daemon.log"
: > "${TMP}/daemon.log"   # the runner's grep is pid-anchored in production; here, no match
expect_exit "no armed line from THIS pid FAILS (an earlier pid's line does not count)" 1 --mode enforce
echo '{"pid":12345,"mode":"enforce","armed":true,"msg":"cloud-feed: armed"}' > "${TMP}/daemon.log"

# ⭐ link 4: started BEFORE the bytes changed — every other link still passes here, which
# is exactly why this link exists.
M="$(_mtime "${ROOT}/${MODULE_REL}")"
echo "$(( M - 60 )) ${M}" > "${TMP}/epochs"
expect_exit "a daemon that started BEFORE the module changed FAILS" 1 --mode enforce
out="$(run_vl --mode enforce)"
[[ "$out" == *"serving the previous bytes"* ]] && ok "…and says it is serving the previous bytes" \
  || bad "…and says it is serving the previous bytes" "$out"
[[ "$out" == *"PASS"*"serving-root"* ]] && ok "…while serving-root still PASSes (the link is not redundant)" \
  || bad "…while serving-root still PASSes" "$out"

# unreadable freshness inputs must FAIL, not pass quietly
echo "NA NA" > "${TMP}/epochs"
expect_exit "unreadable start-time/mtime FAILS CLOSED (never a quiet pass)" 1 --mode enforce
echo "$(( M + 60 )) ${M}" > "${TMP}/epochs"

echo "── monitor role: absence is ASSERTED, not skipped ──"
: > "${TMP}/pid"
expect_exit "monitor node with NO exec-core daemon PASSES" 0 --role monitor
echo "12345" > "${TMP}/pid"
expect_exit "monitor node RUNNING an exec-core daemon FAILS" 1 --role monitor

echo "── argument handling ──"
out="$(CATALYST_VERIFY_LOADED_RUNNER="${TMP}/runner.sh" bash "$VL" --root "$ROOT" --host h --role worker 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"--mode is required"* ]] && ok "worker role requires --mode" || bad "worker role requires --mode" "$out"
out="$(bash "$VL" --root "$ROOT" --host h --mode enforce --role bogus 2>&1)"; rc=$?
[[ $rc -ne 0 ]] && ok "an unknown --role is rejected" || bad "an unknown --role is rejected" "$out"

echo "── Codex #3496 round 1: four P1s, each with its own control ──"

# ⛔ P1: an unreachable host must FAIL, not read as "no daemon". This is the worst shape a
# verification tool can have — certifying a host it could not inspect — and the monitor
# role is where it bites, because there "nothing found" is the PASSING answer.
touch "${TMP}/runner_dies"
expect_exit "an UNREACHABLE host FAILS in worker role" 1 --mode enforce
expect_exit "⛔ an UNREACHABLE host FAILS in MONITOR role (absence must not be assumed)" 1 --role monitor
out="$(run_vl --role monitor)"
[[ "$out" == *"NOTHING below can be measured"* ]] && ok "…and says nothing could be measured" \
  || bad "…and says nothing could be measured" "$out"
rm -f "${TMP}/runner_dies"
# POSITIVE CONTROL: the same monitor invocation passes the moment the host answers.
: > "${TMP}/pid"
expect_exit "…and the SAME monitor call PASSes once the host is reachable" 0 --role monitor
echo "12345" > "${TMP}/pid"

# ⛔ P1: the armed-line pid match must be delimited, not a prefix. `"pid":12345` must not be
# satisfied by `"pid":123456` — a DIFFERENT process, which is precisely the earlier-pid
# confusion this link exists to prevent.
echo '{"pid":123456,"mode":"enforce","armed":true,"msg":"cloud-feed: armed"}' > "${TMP}/daemon.log"
expect_exit "⛔ a longer pid sharing this pid's PREFIX does not satisfy the link" 1 --mode enforce
# POSITIVE CONTROL: the exact pid, same fixture shape, passes — so the FAIL above is about
# the delimiter and not about the line being unparseable.
echo '{"pid":12345,"mode":"enforce","armed":true,"msg":"cloud-feed: armed"}' > "${TMP}/daemon.log"
expect_exit "…while the EXACT pid still passes" 0 --mode enforce

# ⛔ THE PROBE-SHELL SELF-MATCH — deliberately run over the REAL local transport, with no
# injected runner, because it is a property of the platform's pgrep and a fake runner
# cannot exhibit it.
#
# ⚠️ IT IS PLATFORM-SENSITIVE, AND THIS IS THE ONLY PLACE IT CAN FIRE. On GNU/procps
# (ubuntu-latest, where this suite is gated) `pgrep -f` matches the full command line of
# the `bash -c` shell running the probe, whose argv contains the pattern — so an
# unexcluded probe returns its own pid and every monitor node reports a daemon it does not
# have. On macOS the same call does NOT self-match (measured: rc=1 with the pattern in the
# invoking shell's argv), so a developer running this suite locally cannot reproduce it and
# must not conclude the exclusion is unnecessary. CI is the instrument for this one case.
echo "── the probe shell must not match itself (REAL transport; fires on Linux) ──"
UNIQ="zzz-verify-loaded-selfmatch-$$"
out="$(bash "$VL" --root "$ROOT" --host localhost --role monitor --process-pattern "$UNIQ" 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$out" == *"no execution-core daemon"* ]]; then
  ok "a pattern matching NOTHING reports no daemon (the probe shell is excluded)"
else
  bad "a pattern matching NOTHING reports no daemon (the probe shell is excluded)" "exit=${rc}
${out}"
fi

echo
echo "verify-loaded.test.sh: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]] || exit 1
