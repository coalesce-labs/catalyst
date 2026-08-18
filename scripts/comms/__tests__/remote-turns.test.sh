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
# ⛔ The mkdir-lock branch only runs when flock is ABSENT — the stock macOS shape. On a host that
# has flock (this laptop does, via homebrew) the stale-lock cases would silently exercise the
# flock branch and assert nothing; the live-holder control below is what caught that. A PATH of
# /usr/bin:/bin covers everything the drainer uses (ls, sort, sed, cat, mkdir, grep, kill).
# ⛔ PATH-stripping does NOT work here: every CI runner has /usr/bin/flock, so the first version
# of this helper (PATH=/usr/bin:/bin) still found it and both stale-lock cases silently tested the
# flock branch. CI caught it via the control below, exactly as intended. CATALYST_DRAIN_LOCK=mkdir
# selects the stock-macOS branch explicitly, on any host.
drain_no_flock() {
	CATALYST_DRAIN_LOCK=mkdir CATALYST_SSH="$SCRATCH/fake-ssh" CATALYST_MD_CHANNELS="$CHANNELS" \
		bash "$DRAIN" --channel demo --hosts "${1:-mini}" 2>&1
}

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
RC=$?
if grep -qF "AFTER UNREACHABLE" "$CHANNEL_FILE"; then pass "mini's turn was delivered despite a dead host in the list"; else fail "mini's turn was delivered despite a dead host" "$OUT"; fi

echo ""
echo "--- ⛔ ...but an unreachable host must be REPORTED, not read as an empty queue (Codex #3517 P1) ---"
# The first cut swallowed the listing rc with `|| true`, printed "nothing queued", and exited 0.
if grep -q "COULD NOT LIST" <<<"$OUT"; then pass "the drain says it could not list the outbox"; else fail "the drain says it could not list the outbox" "$OUT"; fi
if grep -q "NOT an empty queue" <<<"$OUT"; then pass "it distinguishes that from an empty queue"; else fail "it distinguishes that from an empty queue" "$OUT"; fi
if [ "$RC" -ne 0 ]; then pass "the drain exits NON-ZERO when a host could not be inspected (rc=$RC)"; else fail "the drain exits non-zero on a failed listing" "rc=0 — a caller cannot tell anything went wrong"; fi
# ⛔ Positive control: a REACHABLE host with a genuinely empty outbox must NOT be reported as a
# failure, or the check above would pass against a drain that always complains.
OUT_EMPTY="$(drain mini)"
RC_EMPTY=$?
if grep -q "reachable, nothing queued" <<<"$OUT_EMPTY" && [ "$RC_EMPTY" -eq 0 ]; then
	pass "control — a reachable-but-empty host is NOT reported as a failure (rc=0)"
else
	fail "control — a reachable-but-empty host is not a failure" "rc=$RC_EMPTY: $OUT_EMPTY"
fi

echo ""
echo "--- ⛔ a second concurrent drain must SKIP, not append alongside the first (Codex #3517 P1) ---"
# Simulate the lock already being held. On a host with flock this is the flock branch; without
# it (stock macOS) it is the mkdir branch — the bug was conflating the two.
printf 'CONCURRENT TURN\n' | queue FLEET
if command -v flock >/dev/null 2>&1; then
	exec 8>"$CHANNEL_FILE.drain.lock"
	flock -n 8
	OUT_LOCK="$(drain mini)"
	RC_LOCK=$?
	exec 8>&-
else
	mkdir "$CHANNEL_FILE.drain.lockdir"
	OUT_LOCK="$(drain mini)"
	RC_LOCK=$?
	rmdir "$CHANNEL_FILE.drain.lockdir"
fi
if grep -q "another drain holds" <<<"$OUT_LOCK"; then pass "the second drain skipped because the lock was held"; else fail "the second drain skipped" "$OUT_LOCK"; fi
if grep -qF "CONCURRENT TURN" "$CHANNEL_FILE"; then fail "the locked-out drain appended anyway" "the single-appender guarantee does not hold"; else pass "it appended NOTHING while locked out"; fi
# ⛔ Positive control: once the lock is released the same turn IS delivered — otherwise the check
# above would pass against a drain that is simply broken.
OUT_AFTER="$(drain mini)"
if grep -qF "CONCURRENT TURN" "$CHANNEL_FILE"; then pass "control — after the lock is released the turn is delivered"; else fail "control — the turn is delivered once unlocked" "$OUT_AFTER"; fi

echo ""
echo "--- ⛔ a STALE mkdir lock is taken over, not obeyed forever (Codex #3517 P2) ---"
# A kill -9 / crash / reboot skips the EXIT trap. Before the fix every later drain read the
# orphaned directory as a live owner and exited 0 — the transport wedged while reporting success.
# Exercised directly (the mkdir branch is what runs on stock macOS, flock or not here).
printf 'AFTER STALE LOCK\n' | queue FLEET
mkdir -p "$CHANNEL_FILE.drain.lockdir"
echo "999999" >"$CHANNEL_FILE.drain.lockdir/pid" # a pid that is not running
OUT_STALE="$(drain_no_flock)"
# Control: the mkdir branch really is the one running. Its stale-lock message is unique to it,
# so seeing it proves the selection took effect rather than assuming it did.
if grep -qE "STALE lock|another drain \(pid" <<<"$OUT_STALE" || [ ! -d "$CHANNEL_FILE.drain.lockdir" ]; then
	pass "control — CATALYST_DRAIN_LOCK=mkdir selected the portable branch"
else
	fail "control — the mkdir branch is the one under test" "no mkdir-branch output; the flock branch probably ran"
fi
if grep -q "STALE lock" <<<"$OUT_STALE"; then pass "the stale lock is identified as stale"; else fail "the stale lock is identified" "$OUT_STALE"; fi
if grep -qF "AFTER STALE LOCK" "$CHANNEL_FILE"; then pass "the turn was delivered despite the orphaned lock"; else fail "the turn was delivered despite the orphaned lock" "$OUT_STALE"; fi
rm -rf "$CHANNEL_FILE.drain.lockdir"
# ⛔ Positive control: a lock held by a LIVE process must still be obeyed, or the takeover above
# would just be "the lock never works".
printf 'MUST NOT DELIVER\n' | queue FLEET
mkdir -p "$CHANNEL_FILE.drain.lockdir"
sleep 30 &
LIVE=$!
echo "$LIVE" >"$CHANNEL_FILE.drain.lockdir/pid"
OUT_LIVE="$(drain_no_flock)"
kill "$LIVE" 2>/dev/null
if grep -qF "MUST NOT DELIVER" "$CHANNEL_FILE"; then
	fail "control — a LIVE lock is still obeyed" "the takeover ignores a running holder; the lock is useless"
else
	pass "control — a lock held by a LIVE pid is still obeyed"
fi
rm -rf "$CHANNEL_FILE.drain.lockdir"

echo ""
echo "--- ⛔ '..' as a channel slug is refused (Codex #3517 P2) ---"
# The original traversal case used ../../etc, which is rejected merely for containing a slash —
# it never exercised the form that actually escapes.
printf 'x\n' | HOME="$REMOTE_HOME" bash "$POST" --channel .. --owner FLEET >/dev/null 2>&1
[ $? -eq 2 ] && pass "--channel .. is refused (rc 2)" || fail "--channel .. is refused (rc 2)"
printf 'x\n' | HOME="$REMOTE_HOME" bash "$POST" --channel . --owner FLEET >/dev/null 2>&1
[ $? -eq 2 ] && pass "--channel . is refused (rc 2)" || fail "--channel . is refused (rc 2)"
if [ -n "$(find "$REMOTE_HOME/catalyst/comms/outbox" -name '*.md' -not -path '*/demo/*' 2>/dev/null)" ]; then
	fail "no turn landed outside the channel directory" "$(find "$REMOTE_HOME/catalyst/comms/outbox" -name '*.md' -not -path '*/demo/*')"
else
	pass "no turn landed outside the channel directory"
fi

echo ""
echo "  PASSED: $PASSES   FAILED: $FAILURES"
[[ $FAILURES -eq 0 ]]
