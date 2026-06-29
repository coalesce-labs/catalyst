#!/usr/bin/env bash
# catalyst-stack-replica-writer-plist.test.sh — CTL-1394. Unit-test the PURE
# render_replica_writer_plist function (no filesystem / launchctl side effects).
# Run: bash plugins/dev/scripts/__tests__/catalyst-stack-replica-writer-plist.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="$(cd "${SCRIPT_DIR}/.." && pwd)/catalyst-stack"

FAILURES=0
PASSES=0
check() {
  local name="$1" ; shift
  if "$@"; then
    PASSES=$((PASSES + 1)); echo "  PASS: $name"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $name"
  fi
}
has()    { grep -qF -- "$1" <<<"$PLIST"; }
hasnt()  { ! grep -qF -- "$1" <<<"$PLIST"; }
hasnt_re() { ! grep -qiE -- "$1" <<<"$PLIST"; }

# Source catalyst-stack — its dispatch is guarded by [[ BASH_SOURCE == $0 ]], so sourcing
# loads the functions without running a command. (catalyst-stack uses set -uo pipefail, no -e.)
# shellcheck source=/dev/null
source "$STACK"

# ── host_name pinned ──────────────────────────────────────────────────────────
PLIST="$(render_replica_writer_plist "/path/to/launch.sh" "mini-2")"

check "Label is the replica-writer agent" has "<string>ai.coalesce.catalyst-replica-writer</string>"
check "ProgramArguments runs the launcher under /bin/bash" has "<string>/path/to/launch.sh</string>"
check "RunAtLoad true" has "<key>RunAtLoad</key>"
check "KeepAlive is a dict (not <true/>)" has "<key>KeepAlive</key>"
check "KeepAlive gates on SuccessfulExit" has "<key>SuccessfulExit</key>"
check "no StartInterval (KeepAlive-supervised, not periodic)" hasnt "StartInterval"
check "no AbandonProcessGroup" hasnt "AbandonProcessGroup"
check "stdout → replica-writer.log" has "replica-writer.log"
check "host name pinned in EnvironmentVariables" has "<string>mini-2</string>"
# CRITICAL (secret hygiene): the world-readable plist must carry NO token/secret.
check "no token/secret substring in the plist" hasnt_re "_TOKEN|lin_(api|oauth)_|Bearer "

# ── host_name omitted → no CATALYST_HOST_NAME key ─────────────────────────────
PLIST="$(render_replica_writer_plist "/x/launch.sh" "")"
check "no CATALYST_HOST_NAME key when host_name is empty" hasnt "CATALYST_HOST_NAME"

echo ""
if [[ "$FAILURES" -gt 0 ]]; then
  echo "FAIL: $FAILURES failed, $PASSES passed"
  exit 1
fi
echo "OK: $PASSES passed"
