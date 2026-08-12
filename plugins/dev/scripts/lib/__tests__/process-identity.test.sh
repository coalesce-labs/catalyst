#!/usr/bin/env bash
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../process-identity.sh
source "$HERE/../process-identity.sh"

failures=0
ok() { echo "  PASS: $1"; }
bad() { echo "  FAIL: $1"; failures=$((failures + 1)); }
tmp="$(mktemp -d)"
children=""
cleanup() {
  local p
  for p in $children; do kill -9 "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT

sleep 30 & unrelated=$!; children="$children $unrelated"
cpi_pid_is_ours "$unrelated" 'definitely-not-sleep' && bad "identity rejects unrelated pid" || ok "identity rejects unrelated pid"

mkdir "$tmp/bin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/ps"
chmod +x "$tmp/bin/ps"
(PATH="$tmp/bin:$PATH"; cpi_pid_is_ours "$unrelated" sleep) && bad "identity fails closed when ps fails" || ok "identity fails closed when ps fails"

cpi_pid_gone "$unrelated" && bad "live pid is not gone" || ok "live pid is not gone"
cpi_pid_gone 5999999 && ok "nonexistent pid is gone" || bad "nonexistent pid is gone"

self_matches="$(cpi_find_orphans "process-identity.test.sh" || true)"
[[ -z "$self_matches" ]] && ok "orphan scan excludes caller and its forks" \
  || bad "orphan scan excludes caller and its forks (self=$$ got: $(echo $self_matches))"

marker="cpi-marker-$PPID-$$"
marker_script="$tmp/$marker.sh"
printf '#!/usr/bin/env bash\nexec -a "$0" sleep 30\n' > "$marker_script"
chmod +x "$marker_script"
bash "$marker_script" & marked=$!; children="$children $marked"
sleep 0.1
found="$(cpi_find_orphans "$marker")"
[[ "$found" == "$marked" ]] && ok "orphan scan finds exactly marker process" || bad "orphan scan finds exactly marker process (got: $found)"

cpi_stop_pid "$marked" 2 && ok "stop confirms real process gone" || bad "stop confirms real process gone"
wait "$marked" 2>/dev/null || true

shared="$tmp/orphan-process-identity.test.sh-probe.sh"
printf '#!/usr/bin/env bash\nexec -a "$0" sleep 30\n' > "$shared"; chmod +x "$shared"
bash "$shared" & shared_pid=$!; children="$children $shared_pid"
sleep 0.1
found="$(cpi_find_orphans "process-identity.test.sh")"
[[ "$found" == "$shared_pid" ]] \
  && ok "self forks excluded when the pattern matches the scanner too" \
  || bad "self forks excluded when the pattern matches the scanner too (want $shared_pid, got: $(echo $found))"
kill -9 "$shared_pid" 2>/dev/null || true; wait "$shared_pid" 2>/dev/null || true

awkish="$tmp/$marker-awkish.sh"
printf '#!/usr/bin/env bash\nexec -a "$0 awk placeholder" sleep 30\n' > "$awkish"; chmod +x "$awkish"
bash "$awkish" "awk placeholder" & awkish_pid=$!; children="$children $awkish_pid"
sleep 0.1
found="$(cpi_find_orphans "$marker")"
[[ "$found" == "$awkish_pid" ]] && ok "orphan whose argv contains 'awk ' is still found" \
  || bad "orphan whose argv contains 'awk ' is still found (want $awkish_pid, got: $(echo $found))"
kill -9 "$awkish_pid" 2>/dev/null || true; wait "$awkish_pid" 2>/dev/null || true

real_ps="$(command -v ps)"
mkdir "$tmp/selfstub"
printf '#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == "command=" ]] && exit 1; done\nexec %s "$@"\n' \
  "$real_ps" > "$tmp/selfstub/ps"; chmod +x "$tmp/selfstub/ps"
failopen="$tmp/$marker-failopen.sh"
printf '#!/usr/bin/env bash\nexec -a "$0" sleep 30\n' > "$failopen"; chmod +x "$failopen"
bash "$failopen" & failopen_pid=$!; children="$children $failopen_pid"
sleep 0.1
found="$(PATH="$tmp/selfstub:$PATH"; cpi_find_orphans "$marker")"
[[ " $(echo $found) " == *" $failopen_pid "* ]] && ok "self-identity read failure fails open" \
  || bad "self-identity read failure fails open (want $failopen_pid, got: $(echo $found))"
kill -9 "$failopen_pid" 2>/dev/null || true; wait "$failopen_pid" 2>/dev/null || true

sleep 30 & stubborn=$!; children="$children $stubborn"
original_gone="$(declare -f cpi_pid_gone)"
cpi_pid_gone() { return 1; }
cpi_stop_pid "$stubborn" 1 && bad "stop fails when death cannot be confirmed" || ok "stop fails when death cannot be confirmed"
eval "$original_gone"

exit "$failures"
