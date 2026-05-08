#!/usr/bin/env bash
# Shell tests for catalyst-comms.
# Run: bash plugins/dev/scripts/__tests__/catalyst-comms.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
COMMS="${REPO_ROOT}/plugins/dev/scripts/catalyst-comms"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
export CATALYST_DIR="$SCRATCH"
export CATALYST_COMMS_DIR="$SCRATCH/comms"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

expect_contains() {
  local file="$1" needle="$2"
  grep -qF -- "$needle" "$file" || { echo "    missing: $needle"; return 1; }
}

expect_exit() {
  local expected="$1"; shift
  set +e
  "$@" > "${SCRATCH}/out" 2>&1
  local rc=$?
  set -e
  [ "$rc" = "$expected" ] || { echo "    expected rc=$expected got rc=$rc"; sed 's/^/    /' "${SCRATCH}/out"; return 1; }
}

# Reset the scratch comms dir between groups of tests.
reset_comms() {
  rm -rf "$CATALYST_COMMS_DIR"
}

echo "catalyst-comms tests"

# ── 1. help exits 0 ─────────────────────────────────────────────────────────
run "help exits 0 and prints usage" bash -c "
  out=\$($COMMS help 2>&1)
  echo \"\$out\" | grep -q Usage
"

# ── 2. unknown subcommand exits 1 ───────────────────────────────────────────
run "unknown subcommand exits 1" expect_exit 1 "$COMMS" bogus-cmd

# ── 3. join creates registry + channel file ─────────────────────────────────
reset_comms
"$COMMS" join test-ch --as alice --ttl 300 > "${SCRATCH}/join1.out" 2>&1
run "join creates channels.json" test -f "${CATALYST_COMMS_DIR}/channels.json"
run "join creates per-channel jsonl" test -f "${CATALYST_COMMS_DIR}/channels/test-ch.jsonl"
run "join registers participant as active" bash -c "
  jq -e '.\"test-ch\".participants[] | select(.name == \"alice\") | select(.status == \"active\")' \
    '${CATALYST_COMMS_DIR}/channels.json'
"

# ── 4. second join with same name updates lastSeen, no dup ─────────────────
sleep 1
"$COMMS" join test-ch --as alice --ttl 300 > /dev/null 2>&1
run "second join does not duplicate participant" bash -c "
  count=\$(jq '.\"test-ch\".participants | map(select(.name == \"alice\")) | length' \
    '${CATALYST_COMMS_DIR}/channels.json')
  [ \"\$count\" = \"1\" ]
"

# ── 5. send appends a valid JSONL line ─────────────────────────────────────
"$COMMS" send test-ch "hello world" --as alice --type info > "${SCRATCH}/send1.out" 2>&1
run "send appends one line" bash -c "
  count=\$(wc -l < '${CATALYST_COMMS_DIR}/channels/test-ch.jsonl' | tr -d ' ')
  [ \"\$count\" = \"1\" ]
"
run "send line has required fields" bash -c "
  jq -e 'has(\"id\") and has(\"from\") and has(\"to\") and has(\"ch\") and has(\"ts\") and has(\"type\") and has(\"body\")' \
    '${CATALYST_COMMS_DIR}/channels/test-ch.jsonl'
"
run "send prints msg id" bash -c "
  grep -q '^msg-' '${SCRATCH}/send1.out'
"

# ── 6. send fails when channel not joined ───────────────────────────────────
run "send fails on unknown channel" expect_exit 1 "$COMMS" send unknown-ch "x" --as alice

# ── 7. poll returns all messages ───────────────────────────────────────────
"$COMMS" send test-ch "second msg" --as alice --type info > /dev/null
run "poll returns 2 lines" bash -c "
  count=\$($COMMS poll test-ch | wc -l | tr -d ' ')
  [ \"\$count\" = \"2\" ]
"

# ── 8. poll --since N returns only later messages ──────────────────────────
run "poll --since 1 returns 1 line" bash -c "
  count=\$($COMMS poll test-ch --since 1 | wc -l | tr -d ' ')
  [ \"\$count\" = \"1\" ]
"

# ── 9. poll --filter-to filters correctly ──────────────────────────────────
"$COMMS" join test-ch --as bob --ttl 300 > /dev/null
"$COMMS" send test-ch "only for bob" --as alice --to bob --type info > /dev/null
"$COMMS" send test-ch "for all" --as alice --to all --type info > /dev/null
run "poll --filter-to bob includes bob-only + all, excludes messages to others" bash -c "
  out=\$($COMMS poll test-ch --filter-to bob)
  echo \"\$out\" | grep -q 'only for bob' && echo \"\$out\" | grep -q 'for all'
"

# ── 10. done with single active participant succeeds ──────────────────────
reset_comms
"$COMMS" join solo-ch --as alice --ttl 300 > /dev/null
run "done succeeds when lone participant posts done" expect_exit 0 "$COMMS" done solo-ch --as alice

# ── 11. done with two participants, only one done → exit 1 ────────────────
reset_comms
"$COMMS" join two-ch --as alice --ttl 300 > /dev/null
"$COMMS" join two-ch --as bob --ttl 300 > /dev/null
run "done exits 1 when not all participants have posted done" expect_exit 1 "$COMMS" done two-ch --as alice
run "done now succeeds after bob also posts done" expect_exit 0 "$COMMS" done two-ch --as bob

# ── 11b. done quorum ignores body text that mentions "type":"done" ─────────
# Regression: earlier implementation grep'd for the literal substring in the
# whole line, which would match when a participant sent an info message whose
# body quoted the done schema.
reset_comms
"$COMMS" join quorum-ch --as alice --ttl 300 > /dev/null
"$COMMS" join quorum-ch --as bob --ttl 300 > /dev/null
"$COMMS" send quorum-ch '{"type":"done"}' --as bob --type info > /dev/null
run "done exits 1 when body mentions type:done but no real done msg from bob" \
  expect_exit 1 "$COMMS" done quorum-ch --as alice

# ── 12. leave marks participant status:left ────────────────────────────────
reset_comms
"$COMMS" join leave-ch --as alice --ttl 300 > /dev/null
"$COMMS" join leave-ch --as bob --ttl 300 > /dev/null
"$COMMS" leave leave-ch --as bob > /dev/null
run "leave sets status:left" bash -c "
  jq -e '.\"leave-ch\".participants[] | select(.name == \"bob\") | select(.status == \"left\")' \
    '${CATALYST_COMMS_DIR}/channels.json'
"
# With bob left, alice alone posting done → quorum reached.
run "quorum ignores left participants" expect_exit 0 "$COMMS" done leave-ch --as alice

# ── 13. channels lists registered channels ─────────────────────────────────
run "channels includes leave-ch" bash -c "
  $COMMS channels | jq -e '.\"leave-ch\"'
"

# ── 14. status shows participants ──────────────────────────────────────────
run "status shows alice" bash -c "
  $COMMS status leave-ch | grep -q alice
"

# ── 15. gc --older-than 0 removes everything ──────────────────────────────
"$COMMS" gc --older-than 0 > "${SCRATCH}/gc.out" 2>&1
run "gc removes channel file" bash -c "
  ! test -f '${CATALYST_COMMS_DIR}/channels/leave-ch.jsonl'
"
run "gc removes registry entry" bash -c "
  out=\$($COMMS channels 2>/dev/null)
  [ \"\$out\" = \"{}\" ] || echo \"\$out\" | jq -e '. | has(\"leave-ch\") | not'
"

# ── 16. cross-worktree (different cwd sees same data) ─────────────────────
reset_comms
"$COMMS" join shared-ch --as alice --ttl 300 > /dev/null
(cd /tmp && "$COMMS" send shared-ch "from other cwd" --as alice --type info > /dev/null)
run "messages posted from different cwd visible" bash -c "
  $COMMS poll shared-ch | grep -q 'from other cwd'
"

# ── 17. send fans out comms.message.posted to global event log (CTL-210) ───
# A successful send must also append a `comms.message.posted` event to
# ~/catalyst/events/YYYY-MM.jsonl via catalyst-state.sh. Both stores share
# $CATALYST_DIR (set by the test harness), so we read events directly.
reset_comms
rm -rf "${CATALYST_DIR}/events"
"$COMMS" join fanout-ch --as alice --ttl 300 > /dev/null
MSG_ID=$("$COMMS" send fanout-ch "global fan-out test" --as alice --type info)
EVENTS_FILE="${CATALYST_DIR}/events/$(date -u +%Y-%m).jsonl"
# CTL-300: events are now canonical OTel-shaped. event.name lives at
# .attributes."event.name", message body at .body.payload.
run "send writes a comms.message.posted line to events.jsonl" bash -c "
  test -f '$EVENTS_FILE' && grep -q '\"event.name\":\"comms.message.posted\"' '$EVENTS_FILE'
"
run "fan-out event carries the matching msgId in body.payload" bash -c "
  jq -e --arg id '$MSG_ID' \
    'select(.attributes.\"event.name\" == \"comms.message.posted\" and .body.payload.msgId == \$id)' \
    '$EVENTS_FILE' >/dev/null
"
run "fan-out event records channel and type in body.payload" bash -c "
  jq -e --arg id '$MSG_ID' \
    'select(.attributes.\"event.name\" == \"comms.message.posted\" and .body.payload.msgId == \$id)
       | (.body.payload.channel == \"fanout-ch\" and .body.payload.type == \"info\")' \
    '$EVENTS_FILE' >/dev/null
"

# ── 18. send still succeeds when catalyst-state.sh is unavailable ──────────
# Override the resolver to a non-existent path; the send must still work.
reset_comms
rm -rf "${CATALYST_DIR}/events"
"$COMMS" join resilient-ch --as alice --ttl 300 > /dev/null
CATALYST_STATE_SCRIPT="/dev/null/missing" \
  "$COMMS" send resilient-ch "no events writer" --as alice --type info >/dev/null
run "send succeeds when state script unavailable" bash -c "
  grep -q 'no events writer' '${CATALYST_COMMS_DIR}/channels/resilient-ch.jsonl'
"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[ "$FAILURES" = "0" ]
