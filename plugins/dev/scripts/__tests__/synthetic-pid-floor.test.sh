#!/usr/bin/env bash
# Guard the CTL-1701 invariant: synthetic process fixtures cannot alias host pids.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FLOOR=5000000
FAILURES=0
PASSES=0

ok() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; echo "    $2"; }

extract_suffix_pids() {
  grep -ohE '\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_([0-9]{3,})=' "$1" \
    | sed -E 's/.*_([0-9]+)=/\1/' | sort -un
}

check_suffix_file() {
  local file="$1" minimum="$2" count=0 pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    count=$((count + 1))
    if (( 10#$pid < FLOOR )); then
      fail "synthetic pid floor: ${file#"${REPO_ROOT}/"}" \
        "synthetic fixture pid ${pid} is below ${FLOOR}"
    fi
  done < <(extract_suffix_pids "$file")
  if (( count >= minimum )); then
    ok "extractor is non-vacuous for ${file#"${REPO_ROOT}/"} (${count} pids)"
  else
    fail "extractor is non-vacuous for ${file#"${REPO_ROOT}/"}" \
      "expected at least ${minimum} declared pids, found ${count}"
  fi
}

ORPHAN="${REPO_ROOT}/plugins/dev/scripts/__tests__/orphan-sweep.test.sh"
PARITY="${REPO_ROOT}/plugins/dev/scripts/__tests__/parity-scenario.sh"
PROC_REAPER="${REPO_ROOT}/plugins/dev/scripts/execution-core/proc-reaper.test.mjs"
WATCHDOG="${REPO_ROOT}/plugins/dev/scripts/__tests__/daemon-watchdog-supervision.test.sh"
WORKFLOW="${REPO_ROOT}/.github/workflows/execution-core-tests.yml"

check_suffix_file "$ORPHAN" 40
check_suffix_file "$PARITY" 4

# The JavaScript parity fixture encodes pids as row(<pid>) / cwds[<pid>].
js_pids=()
while IFS= read -r pid; do js_pids+=("$pid"); done < <(
  grep -oE 'row\([0-9]{3,}|cwds\[[0-9]{3,}' "$PROC_REAPER" \
    | sed -E 's/[^0-9]//g' | sort -un
)
if (( ${#js_pids[@]} > 0 )); then
  ok "extractor is non-vacuous for ${PROC_REAPER#"${REPO_ROOT}/"} (${#js_pids[@]} pids)"
else
  fail "extractor is non-vacuous for ${PROC_REAPER#"${REPO_ROOT}/"}" "found no fixture pids"
fi
for pid in "${js_pids[@]}"; do
  (( 10#$pid >= FLOOR )) || fail "synthetic pid floor: ${PROC_REAPER#"${REPO_ROOT}/"}" \
    "synthetic fixture pid ${pid} is below ${FLOOR}"
done

# The watchdog's impossible owner pid is a file-content fixture rather than a var suffix.
watchdog_pid="$(sed -nE 's/.*echo "([0-9]{3,})".*LOCKDIR.*owner.*/\1/p' "$WATCHDOG")"
if [[ -n "$watchdog_pid" ]]; then
  ok "extractor is non-vacuous for ${WATCHDOG#"${REPO_ROOT}/"} (1 pid)"
  (( 10#$watchdog_pid >= FLOOR )) || fail "synthetic pid floor: ${WATCHDOG#"${REPO_ROOT}/"}" \
    "synthetic fixture pid ${watchdog_pid} is below ${FLOOR}"
else
  fail "extractor is non-vacuous for ${WATCHDOG#"${REPO_ROOT}/"}" "found no owner pid fixture"
fi

if grep -qF 'no real process is ever enumerated or signalled' "$WORKFLOW"; then
  fail "CI hermeticity comment is accurate" "obsolete unqualified hermeticity claim remains"
else
  ok "CI hermeticity comment is accurate"
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "$FAILURES" -eq 0 ]] || exit 1
