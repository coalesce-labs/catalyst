#!/usr/bin/env bash
# remote-turns.test.sh — hermetic coverage for the remote-owner channel transport.
#
# The pair was first proven against the REAL mini (a turn queued there, drained onto the
# laptop's channel, second drain a no-op). This test is the version CI can run: it injects a
# fake `ssh` via $CATALYST_SSH that executes the command locally in a fake remote $HOME.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POST="$SCRIPT_DIR/../post-turn.sh"
DRAIN="$SCRIPT_DIR/../drain-remote-turns.sh"

PASSES=0
FAILURES=0
SCRATCH="$(mktemp -d)"
trap 'chmod -R u+w "$SCRATCH" 2>/dev/null; rm -rf "${SCRATCH:?}"' EXIT

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

REMOTE_HOME="$SCRATCH/remote-home"
CHANNELS="$SCRATCH/md-channels"
mkdir -p "$REMOTE_HOME" "$CHANNELS"
CHANNEL_FILE="$CHANNELS/demo.md"
printf '# demo channel\n\nfirst line\n' >"$CHANNEL_FILE"

# A stand-in for ssh: drop the -o flags and the host, run the rest in the fake remote HOME.
# FAKE_SSH_FAIL_MV=1 makes only the ack step fail, which is how the at-least-once claim below
# is exercised without needing a real broken host.
cat >"$SCRATCH/fake-ssh" <<EOF
#!/bin/bash
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) shift 2 ;;
    *) break ;;
  esac
done
host="\$1"; shift
[ "\$host" = "unreachable" ] && exit 255
if [ -n "\${FAKE_SSH_FAIL_MV:-}" ] && printf '%s' "\$*" | grep -q "mv --"; then exit 1; fi
cd "$REMOTE_HOME" && HOME="$REMOTE_HOME" bash -c "\$*"
EOF
chmod +x "$SCRATCH/fake-ssh"

queue() { HOME="$REMOTE_HOME" bash "$POST" --channel demo --owner "$1" >/dev/null 2>&1; }
drain() { CATALYST_SSH="$SCRATCH/fake-ssh" CATALYST_MD_CHANNELS="$CHANNELS" bash "$DRAIN" --channel demo --hosts "${1:-mini}" 2>&1; }

echo ""
echo "=== a queued turn is delivered to the channel ==="
printf '## Turn X — hello\nbody\n' | queue FLEET
OUT="$(drain)"
if grep -qF "## Turn X — hello" "$CHANNEL_FILE"; then pass "the turn body reached the channel"; else fail "the turn body reached the channel" "$OUT"; fi
if grep -qF "first line" "$CHANNEL_FILE"; then pass "pre-existing channel content is preserved"; else fail "pre-existing channel content is preserved"; fi
if [ -n "$(ls -A "$REMOTE_HOME/catalyst/comms/outbox/demo/sent" 2>/dev/null)" ]; then pass "the delivered turn moved to sent/"; else fail "the delivered turn moved to sent/" "$OUT"; fi

echo ""
echo "=== a second drain delivers NOTHING (no duplicate) ==="
BEFORE="$(wc -l <"$CHANNEL_FILE")"
drain >/dev/null
AFTER="$(wc -l <"$CHANNEL_FILE")"
if [ "$BEFORE" = "$AFTER" ]; then pass "channel unchanged at $AFTER lines"; else fail "channel unchanged" "$BEFORE -> $AFTER"; fi

echo ""
echo "=== ⛔ a half-written .part is NEVER delivered ==="
printf 'HALF WRITTEN MUST NOT APPEAR\n' >"$REMOTE_HOME/catalyst/comms/outbox/demo/pending/99999999T999999Z-partial.part"
drain >/dev/null
if grep -qF "HALF WRITTEN MUST NOT APPEAR" "$CHANNEL_FILE"; then
	fail "a .part was delivered" "the atomic rename is not protecting a partial write"
else
	pass "the .part was skipped"
fi
# ⛔ Positive control: the .part is skipped because of its EXTENSION, not because the drain is
# broken and delivers nothing at all.
printf 'CONTROL TURN DELIVERED\n' | queue FLEET
drain >/dev/null
if grep -qF "CONTROL TURN DELIVERED" "$CHANNEL_FILE"; then
	pass "control — a real .md alongside the .part still delivers"
else
	fail "control — a real .md alongside the .part still delivers" \
		"the .part check above proves nothing: this drain delivers nothing at all"
fi

echo ""
echo "=== ⛔ AT-LEAST-ONCE: if the ack fails, the turn is NOT lost ==="
printf 'ACK FAILURE TURN\n' | queue FLEET
OUT="$(FAKE_SSH_FAIL_MV=1 CATALYST_SSH="$SCRATCH/fake-ssh" CATALYST_MD_CHANNELS="$CHANNELS" bash "$DRAIN" --channel demo --hosts mini 2>&1)"
if grep -qF "ACK FAILURE TURN" "$CHANNEL_FILE"; then pass "the turn still reached the channel"; else fail "the turn still reached the channel" "$OUT"; fi
if grep -q "could not mark it sent" <<<"$OUT"; then pass "the drain says LOUDLY that the next pass will duplicate"; else fail "the drain warns about the pending duplicate" "$OUT"; fi
if ls "$REMOTE_HOME/catalyst/comms/outbox/demo/pending"/*.md >/dev/null 2>&1; then pass "the turn stayed queued (re-delivery, not loss)"; else fail "the turn stayed queued" "it was dropped despite the failed ack"; fi

echo ""
echo "=== refusals ==="
printf '' | HOME="$REMOTE_HOME" bash "$POST" --channel demo --owner FLEET >/dev/null 2>&1
[ $? -eq 3 ] && pass "an EMPTY turn is refused (rc 3)" || fail "an EMPTY turn is refused (rc 3)"
printf 'x\n' | HOME="$REMOTE_HOME" bash "$POST" --channel ../../etc --owner FLEET >/dev/null 2>&1
[ $? -eq 2 ] && pass "a traversing --channel is refused (rc 2)" || fail "a traversing --channel is refused (rc 2)"
HOME="$REMOTE_HOME" bash "$POST" --owner FLEET </dev/null >/dev/null 2>&1
[ $? -eq 2 ] && pass "a missing --channel is refused (rc 2)" || fail "a missing --channel is refused (rc 2)"

echo ""
echo "=== an unreachable host does not abort the other hosts' turns ==="
printf 'AFTER UNREACHABLE\n' | queue FLEET
OUT="$(drain "unreachable,mini")"
if grep -qF "AFTER UNREACHABLE" "$CHANNEL_FILE"; then pass "mini's turn was delivered despite a dead host in the list"; else fail "mini's turn was delivered despite a dead host" "$OUT"; fi

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
