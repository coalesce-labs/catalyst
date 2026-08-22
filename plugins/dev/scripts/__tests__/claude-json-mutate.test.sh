#!/usr/bin/env bash
# CTL-1890: ~/.claude.json must be mutated through a single, locked seam.
#
# Two independent code paths (trust-workspace.sh, create-worktree.sh) both
# rewrite ~/.claude.json whole-file via jq→mktemp→mv, with zero synchronisation.
# Concurrent writes lose updates: the slower snapshot restores whatever it read
# before the faster writer finished, dropping project entries or — in the worst
# case — the entire top-level mcpServers block.
#
# Fix: plugins/dev/scripts/lib/claude-json-mutate.sh — a single executable seam
# that holds a portable mkdir lock (never flock) across the full read-jq-mv cycle.
#
# Case A (positive control): naive lockless writes must tear; if they don't, the
#   Cases B-F concurrency proof is meaningless. Green when the race is detected.
# Case B: 8 concurrent seam calls produce no lost update and leave the file valid.
# Case C: the seam succeeds with a non-functional flock stub on PATH; source has
#   no flock reference.
# Case D: the seam refuses (fail-closed, logged) when the lock is held by a live
#   owner process.
# Case E: the seam acquires a lock whose owner pid is dead (stale reap).
# Case F: trust-project on a pre-existing entry flips hasTrustDialogAccepted
#   without adding any ownership marker.
#
# Driven against the REAL shipped seam — never a stub.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "$SCRIPT_DIR")"
SEAM="${SCRIPTS_DIR}/lib/claude-json-mutate.sh"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

TMPS=()
# NOTE trailing `true`: cleanup must never change the test verdict.
cleanup() { local d; for d in "${TMPS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done; true; }
trap cleanup EXIT
newdir() { local d; d="$(mktemp -d)"; TMPS+=("$d"); echo "$d"; }
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "  ok — $*"; }

PRODUCERS=8
MCP_SERVER_COUNT=6  # servers that must survive every mutation

# make_fixture DIR — writes a realistic ~/.claude.json to DIR/claude.json.
# Echos the path to the fixture file.
make_fixture() {
  local dir="$1" file
  file="${dir}/claude.json"
  jq -n '{
    "mcpServers": {
      "server1": {"command": "cmd1"},
      "server2": {"command": "cmd2"},
      "server3": {"command": "cmd3"},
      "server4": {"command": "cmd4"},
      "server5": {"command": "cmd5"},
      "server6": {"command": "cmd6"}
    },
    "projects": {
      "/pre/existing": {
        "hasTrustDialogAccepted": false,
        "allowedTools": []
      }
    }
  }' > "$file"
  echo "$file"
}

# naive_write FILE PATH — byte-equivalent of today's lockless rewrite.
# Must NEVER call the seam; this is the defect, kept as a permanent positive control.
naive_write() {
  local file="$1" path="$2" tmpfile
  tmpfile="$(mktemp "${file}.XXXXXX")"
  if jq --arg p "$path" '.projects[$p] = {"hasTrustDialogAccepted": true}' \
      "$file" > "$tmpfile"; then
    mv "$tmpfile" "$file"
  else
    rm -f "$tmpfile"
    return 1
  fi
}

# --- Case A: Positive control — naive lockless writes must tear ------------------
# This case is documentation: it stays green precisely because the naive path
# still has the race. If it stops tearing, Cases B-F prove nothing.
D="$(newdir)"
FIXTURE_A="$(make_fixture "$D")"

pids=()
for i in $(seq 1 "$PRODUCERS"); do
  (
    path="${D}/path${i}"
    mkdir -p "$path"
    naive_write "$FIXTURE_A" "$path"
  ) &
  pids+=($!)
done
# Bounded: each worker runs one fixed mutation and exits — no watchdog needed.
for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done

TEAR=0
for i in $(seq 1 "$PRODUCERS"); do
  path="${D}/path${i}"
  jq -e --arg p "$path" '.projects[$p]' "$FIXTURE_A" >/dev/null 2>&1 || { TEAR=1; break; }
done
# Also check if any mcpServers keys were dropped (a full-file overwrite risk).
if [[ "$TEAR" -eq 0 ]]; then
  remaining=$(jq '.mcpServers | keys | length' "$FIXTURE_A")
  [[ "$remaining" -lt "$MCP_SERVER_COUNT" ]] && TEAR=1
fi
[[ "$TEAR" -eq 1 ]] \
  || fail "positive control DID NOT TEAR — $PRODUCERS concurrent naive writes lost no update; Cases B-F are meaningless on this host"
pass "positive control: naive lockless writes tore (at least one update lost); Cases B-F are meaningful"

# --- Case B: Concurrency through the seam — no lost update ----------------------
[[ -x "$SEAM" ]] || fail "seam not found or not executable: $SEAM"

D2="$(newdir)"
FIXTURE_B="$(make_fixture "$D2")"

pids=()
for i in $(seq 1 "$PRODUCERS"); do
  (
    path="${D2}/path${i}"
    mkdir -p "$path"
    CLAUDE_JSON="$FIXTURE_B" bash "$SEAM" trust-project "$path"
  ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done

for i in $(seq 1 "$PRODUCERS"); do
  path="${D2}/path${i}"
  jq -e --arg p "$path" '.projects[$p]' "$FIXTURE_B" >/dev/null 2>&1 \
    || fail "Case B: project path ${i} lost under concurrent seam writes"
done
remaining_b=$(jq '.mcpServers | keys | length' "$FIXTURE_B")
[[ "$remaining_b" -eq "$MCP_SERVER_COUNT" ]] \
  || fail "Case B: mcpServers dropped from $MCP_SERVER_COUNT to $remaining_b under concurrent seam writes"
jq -e . "$FIXTURE_B" >/dev/null 2>&1 \
  || fail "Case B: output file is not valid JSON after concurrent seam writes"
pass "Case B — $PRODUCERS concurrent seam calls: all project entries present, $MCP_SERVER_COUNT mcpServers intact, file valid JSON"

# --- Case C: Portability — no flock, mkdir test-and-set -------------------------
D3="$(newdir)"
FIXTURE_C="$(make_fixture "$D3")"
PATH_C="${D3}/portability-path"
mkdir -p "$PATH_C"

# Put a flock stub that fails and prints a marker. If the seam ever calls flock
# we will see the marker in stderr.
STUBS="${D3}/stubs"
mkdir -p "$STUBS"
printf '#!/bin/sh\necho "flock-stub-invoked" >&2\nexit 127\n' > "${STUBS}/flock"
chmod +x "${STUBS}/flock"

STDERR_C="${D3}/c.err"
set +e
CLAUDE_JSON="$FIXTURE_C" PATH="${STUBS}:${PATH}" \
  bash "$SEAM" trust-project "$PATH_C" 2>"$STDERR_C"
RC_C=$?
set -e

[[ "$RC_C" -eq 0 ]] \
  || fail "Case C: seam failed (rc=$RC_C) with a non-functional flock; output: $(cat "$STDERR_C")"
grep -q 'flock-stub-invoked' "$STDERR_C" \
  && fail "Case C: seam invoked flock — must use only mkdir for locking; stderr: $(cat "$STDERR_C")"
jq -e --arg p "$PATH_C" '.projects[$p].hasTrustDialogAccepted == true' "$FIXTURE_C" >/dev/null 2>&1 \
  || fail "Case C: mutation not applied on a flock-less PATH"

# Source-level guarantee: seam must contain no flock reference at all.
flock_refs=$(grep -c 'flock' "$SEAM" 2>/dev/null || true)
[[ "$flock_refs" -eq 0 ]] \
  || fail "Case C: seam source contains $flock_refs flock reference(s) — must use only mkdir"
pass "Case C — succeeds with non-functional flock stub; 0 flock references in seam source"

# --- Case D: Fail-closed — refuses when lock held by a live owner ---------------
D4="$(newdir)"
FIXTURE_D="$(make_fixture "$D4")"
LOCK_D="${FIXTURE_D}.lockd"
PATH_D="${D4}/fail-closed-path"
mkdir -p "$PATH_D"
BEFORE_D="$(cat "$FIXTURE_D")"

# Start a live process that holds the lock. sleep 30 is self-limiting
# (AGENTS.md: background processes must carry their own deadline).
sleep 30 &
SLEEPER=$!
mkdir -p "$LOCK_D"
echo "$SLEEPER" > "${LOCK_D}/owner"

STDERR_D="${D4}/d.err"
set +e
CLAUDE_JSON="$FIXTURE_D" CLAUDE_JSON_LOCK_TURNS=3 CLAUDE_JSON_LOCK_SLEEP=0.05 \
  bash "$SEAM" trust-project "$PATH_D" 2>"$STDERR_D"
RC_D=$?
set -e

# Explicit cleanup: kill sleeper and verify no leak (fail-closed verification).
kill "$SLEEPER" 2>/dev/null || true
wait "$SLEEPER" 2>/dev/null || true
ps -p "$SLEEPER" >/dev/null 2>&1 && fail "Case D: LEAKED sleeper pid $SLEEPER"
rm -rf "$LOCK_D" 2>/dev/null || true

[[ "$RC_D" -ne 0 ]] \
  || fail "Case D: seam returned 0 despite live lock holder — it proceeded unlocked"
AFTER_D="$(cat "$FIXTURE_D")"
[[ "$BEFORE_D" == "$AFTER_D" ]] \
  || fail "Case D: seam mutated the file despite failing to acquire the lock"
grep -qiE 'lock|NOT proceeding|timeout' "$STDERR_D" \
  || fail "Case D: no lock-timeout warning on stderr; got: $(cat "$STDERR_D")"
pass "Case D — rc=$RC_D (non-zero), file unchanged, lock-timeout warning on stderr"

# --- Case E: Dead-owner stale reap — acquires stale lock and applies mutation ---
D5="$(newdir)"
FIXTURE_E="$(make_fixture "$D5")"
LOCK_E="${FIXTURE_E}.lockd"
PATH_E="${D5}/stale-reap-path"
mkdir -p "$PATH_E"

# Use a PID that cannot be a live process on any supported host.
# 999999 is above kern.maxproc on stock macOS (99998) and the default Linux
# pid_max (32768). kill -0 will always fail → _cjm_lock_is_stale returns true.
DEAD_PID=999999
mkdir -p "$LOCK_E"
echo "$DEAD_PID" > "${LOCK_E}/owner"

set +e
CLAUDE_JSON="$FIXTURE_E" bash "$SEAM" trust-project "$PATH_E"
RC_E=$?
set -e

[[ "$RC_E" -eq 0 ]] \
  || fail "Case E: seam failed (rc=$RC_E) on a stale (dead-owner) lock — should have reaped it"
jq -e --arg p "$PATH_E" '.projects[$p].hasTrustDialogAccepted == true' "$FIXTURE_E" >/dev/null 2>&1 \
  || fail "Case E: mutation not applied after reaped stale lock"
pass "Case E — stale lock (dead owner pid $DEAD_PID) reaped, mutation applied"

# --- Case F: Idempotent flip on pre-existing entry — no ownership marker --------
D6="$(newdir)"
FIXTURE_F="$(make_fixture "$D6")"
PRE_PATH="${D6}/pre-existing"
mkdir -p "$PRE_PATH"

# Seed a project entry with hasTrustDialogAccepted: false and no marker.
jq --arg p "$PRE_PATH" '.projects[$p] = {
  "hasTrustDialogAccepted": false,
  "allowedTools": [],
  "mcpServers": {}
}' "$FIXTURE_F" > "${FIXTURE_F}.tmp" && mv "${FIXTURE_F}.tmp" "$FIXTURE_F"

set +e
CLAUDE_JSON="$FIXTURE_F" bash "$SEAM" trust-project "$PRE_PATH"
RC_F=$?
set -e

[[ "$RC_F" -eq 0 ]] \
  || fail "Case F: seam failed (rc=$RC_F) trusting a pre-existing entry"
jq -e --arg p "$PRE_PATH" '.projects[$p].hasTrustDialogAccepted == true' "$FIXTURE_F" >/dev/null 2>&1 \
  || fail "Case F: hasTrustDialogAccepted not flipped to true on pre-existing entry"
# Pre-existing entries must NOT receive the ownership marker (we did not create them).
marker=$(jq -r --arg p "$PRE_PATH" '.projects[$p]._catalystManaged // "absent"' "$FIXTURE_F")
[[ "$marker" == "absent" || "$marker" == "false" || "$marker" == "null" ]] \
  || fail "Case F: _catalystManaged marker stamped on a PRE-EXISTING entry (value: $marker) — must only appear on entries the seam creates"
# Assert no extra entries were added.
proj_count=$(jq '.projects | length' "$FIXTURE_F")
[[ "$proj_count" -eq 2 ]] \
  || fail "Case F: expected 2 project entries after flip, found $proj_count"
pass "Case F — pre-existing entry: trust flipped, no marker added, project count unchanged (2)"

# --- Phase 2: Ownership marker + marker-aware converge -------------------------
# Cases G-I are gated on converge-owned being implemented. If the seam returns
# rc=2 (not yet implemented) for converge-owned, skip G-I with a clear message.
# Use a real temp file so _cjm_acquire can create the lock directory.
_GATE_DIR="$(newdir)"
echo '{"mcpServers":{}}' > "${_GATE_DIR}/gate.json"
set +e
CLAUDE_JSON="${_GATE_DIR}/gate.json" bash "$SEAM" converge-owned mcpServers '{}' 2>/dev/null
CONVERGE_RC=$?
set -e

if [[ "$CONVERGE_RC" -eq 2 ]]; then
  echo "  SKIP: converge-owned not yet implemented — Cases G-I deferred to Phase 2"
else

# --- Case G: trust-project stamps _catalystManaged on NEW entries only ----------
D7="$(newdir)"
FIXTURE_G="$(make_fixture "$D7")"
NEW_PATH="${D7}/new-managed-path"
mkdir -p "$NEW_PATH"
PRE_PATH_G="${D7}/pre-existing-g"
mkdir -p "$PRE_PATH_G"

# Seed a pre-existing entry (no marker)
jq --arg p "$PRE_PATH_G" '.projects[$p] = {
  "hasTrustDialogAccepted": false,
  "allowedTools": []
}' "$FIXTURE_G" > "${FIXTURE_G}.tmp" && mv "${FIXTURE_G}.tmp" "$FIXTURE_G"

# Trust the NEW path — should stamp the marker
CLAUDE_JSON="$FIXTURE_G" bash "$SEAM" trust-project "$NEW_PATH"
marker_new=$(jq -r --arg p "$NEW_PATH" '.projects[$p]._catalystManaged // "absent"' "$FIXTURE_G")
[[ "$marker_new" == "true" ]] \
  || fail "Case G: _catalystManaged not stamped on a NEW entry (got: $marker_new)"

# Trust the PRE-EXISTING path — must NOT stamp the marker (Case F re-assertion)
CLAUDE_JSON="$FIXTURE_G" bash "$SEAM" trust-project "$PRE_PATH_G"
marker_pre=$(jq -r --arg p "$PRE_PATH_G" '.projects[$p]._catalystManaged // "absent"' "$FIXTURE_G")
[[ "$marker_pre" == "absent" || "$marker_pre" == "false" || "$marker_pre" == "null" ]] \
  || fail "Case G: _catalystManaged stamped on PRE-EXISTING entry (got: $marker_pre) — must not be"
pass "Case G — new entry gets _catalystManaged:true; pre-existing entry gets no marker"

# --- Case H: converge-owned never removes an unmarked (hand-added) entry -------
D8="$(newdir)"
FIXTURE_H="$(make_fixture "$D8")"

# Seed mcpServers: serena (managed), stale_owned (managed), operator_added (no marker)
jq '.mcpServers = {
  "serena":        {"command": "serena", "_catalystManaged": true},
  "stale_owned":   {"command": "stale",  "_catalystManaged": true},
  "operator_added":{"command": "op"}
}' "$FIXTURE_H" > "${FIXTURE_H}.tmp" && mv "${FIXTURE_H}.tmp" "$FIXTURE_H"

# converge-owned: desired owned-set = only serena
DESIRED_H='{"serena": {"command": "serena"}}'
CLAUDE_JSON="$FIXTURE_H" bash "$SEAM" converge-owned mcpServers "$DESIRED_H"

# operator_added must survive (no marker → untouchable)
jq -e '.mcpServers.operator_added' "$FIXTURE_H" >/dev/null 2>&1 \
  || fail "Case H: operator_added (no _catalystManaged marker) was removed — must be preserved"
# stale_owned must be removed (marked but absent from the desired spec)
jq -e '.mcpServers.stale_owned' "$FIXTURE_H" >/dev/null 2>&1 \
  && fail "Case H: stale_owned (managed, not in desired spec) was NOT removed"
# serena must be present (in the desired spec)
jq -e '.mcpServers.serena' "$FIXTURE_H" >/dev/null 2>&1 \
  || fail "Case H: serena (in desired spec) was removed or absent"
jq -e . "$FIXTURE_H" >/dev/null 2>&1 \
  || fail "Case H: output file is not valid JSON after converge-owned"
pass "Case H — converge-owned: operator_added preserved, stale_owned removed, serena present, file valid JSON"

# --- Case I: converge-owned is additive and idempotent --------------------------
D9="$(newdir)"
FIXTURE_I="$(make_fixture "$D9")"

# Initial: mcpServers has only one server with no marker
jq '.mcpServers = {"existing_unmanaged": {"command": "ex"}}' \
  "$FIXTURE_I" > "${FIXTURE_I}.tmp" && mv "${FIXTURE_I}.tmp" "$FIXTURE_I"

DESIRED_I='{"new_server": {"command": "new"}}'
# First run: adds new_server, stamps marker, leaves existing_unmanaged alone
CLAUDE_JSON="$FIXTURE_I" bash "$SEAM" converge-owned mcpServers "$DESIRED_I"
jq -e '.mcpServers.new_server' "$FIXTURE_I" >/dev/null 2>&1 \
  || fail "Case I: new_server was not added by converge-owned"
marker_i=$(jq -r '.mcpServers.new_server._catalystManaged // "absent"' "$FIXTURE_I")
[[ "$marker_i" == "true" ]] \
  || fail "Case I: new_server added by converge-owned missing _catalystManaged:true (got: $marker_i)"
jq -e '.mcpServers.existing_unmanaged' "$FIXTURE_I" >/dev/null 2>&1 \
  || fail "Case I (first run): existing_unmanaged (no marker) was removed"

# Second run: idempotent — no change
BEFORE_I="$(jq -c . "$FIXTURE_I")"
CLAUDE_JSON="$FIXTURE_I" bash "$SEAM" converge-owned mcpServers "$DESIRED_I"
AFTER_I="$(jq -c . "$FIXTURE_I")"
[[ "$BEFORE_I" == "$AFTER_I" ]] \
  || fail "Case I: second converge-owned run changed the file — must be idempotent"
pass "Case I — converge-owned: additive (new_server added+marked), idempotent on second run, existing_unmanaged preserved"

fi  # end converge-owned implemented gate

echo ""
echo "PASS: claude-json-mutate (CTL-1890, Phase 1+2 Cases A-I)"
