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
[[ " $self_matches " == *" $$ "* ]] && bad "orphan scan excludes caller" || ok "orphan scan excludes caller"

marker="cpi-marker-$PPID-$$"
marker_script="$tmp/$marker.sh"
printf '#!/usr/bin/env bash\nsleep 30 & wait\n' > "$marker_script"
chmod +x "$marker_script"
bash "$marker_script" & marked=$!; children="$children $marked"
sleep 0.1
found="$(cpi_find_orphans "$marker")"
[[ "$found" == "$marked" ]] && ok "orphan scan finds exactly marker process" || bad "orphan scan finds exactly marker process (got: $found)"

cpi_stop_pid "$marked" 2 && ok "stop confirms real process gone" || bad "stop confirms real process gone"
wait "$marked" 2>/dev/null || true

sleep 30 & stubborn=$!; children="$children $stubborn"
original_gone="$(declare -f cpi_pid_gone)"
cpi_pid_gone() { return 1; }
cpi_stop_pid "$stubborn" 1 && bad "stop fails when death cannot be confirmed" || ok "stop fails when death cannot be confirmed"
eval "$original_gone"

exit "$failures"
