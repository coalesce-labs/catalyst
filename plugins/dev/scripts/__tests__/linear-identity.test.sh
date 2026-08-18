#!/usr/bin/env bash
# shellcheck disable=SC2016  # the single-quoted bodies handed to run()/reason() below
# are shell source for a CHILD shell; their `$` deliberately does not expand here.
# Tests for lib/linear-identity.sh — CTC-403.
#
# The module's whole value is that a confident answer and "I could not look" are
# different results. So every positive assertion below is paired with the degraded
# case over the same call, and the two must NOT produce the same output. The failure
# this guards against is on record: an empty-but-fresh replica read as healthy and
# produced a fleet-wide admission freeze with every signal green (CTL-1420).
#
# Run: bash plugins/dev/scripts/__tests__/linear-identity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/../lib/linear-identity.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH:?}"' EXIT

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
assert_eq() {
	if [[ $2 == "$3" ]]; then pass "$1"; else fail "$1" "expected: $3" "actual:   $2"; fi
}

TEAM="f317bf00-0000-0000-0000-000000000001"

# A fixture replica in the real schema's shape. `fresh=1` writes the writer-lock
# heartbeat and the sync_meta cursor that `replica_fresh` gates on.
make_db() {
	local db="$1" fresh="${2:-1}" with_states="${3:-1}"
	rm -f "$db" "$db.writer.lock"
	sqlite3 "$db" "
    CREATE TABLE sync_meta (key TEXT, value TEXT);
    CREATE TABLE issues (id TEXT, team_key TEXT, team_id TEXT, removed_at INTEGER);
    CREATE TABLE workflow_states (id TEXT, team_id TEXT, name TEXT, type TEXT, position REAL, archived_at INTEGER);
    CREATE TABLE labels (id TEXT, name TEXT, removed_at INTEGER);
    INSERT INTO sync_meta VALUES ('cursor','abc123');
    INSERT INTO issues VALUES ('i1','CTL','${TEAM}',NULL);
    INSERT INTO labels VALUES ('lab-uniq','needs-human',NULL);
    INSERT INTO labels VALUES ('lab-dup-a','dupe',NULL);
    INSERT INTO labels VALUES ('lab-dup-b','dupe',NULL);
  " 2>/dev/null
	if [[ $with_states == "1" ]]; then
		sqlite3 "$db" "
      INSERT INTO workflow_states VALUES ('st-done','${TEAM}','Done','completed',1.0,NULL);
      INSERT INTO workflow_states VALUES ('st-todo','${TEAM}','Todo','unstarted',2.0,NULL);
      INSERT INTO workflow_states VALUES ('st-old','${TEAM}','Retired','unstarted',3.0,1700000000000);
    " 2>/dev/null
	fi
	if [[ $fresh == "1" ]]; then touch "$db.writer.lock"; else
		touch "$db.writer.lock"
		# 1 hour old — well past the 5-minute default staleness threshold
		touch -t "$(date -v-1H '+%Y%m%d%H%M' 2>/dev/null || date -d '1 hour ago' '+%Y%m%d%H%M')" "$db.writer.lock"
	fi
}

# Each call runs in its own shell: the module caches its source-guard and exports a
# reason global, and a leaked reason from a previous call would let a later assertion
# pass on the wrong evidence.
run() {
	local db="$1" body="$2"
	CATALYST_REPLICA_DB="$db" bash -c "set -uo pipefail; . '$LIB' >/dev/null 2>&1; $body" 2>/dev/null
}
reason() {
	local db="$1" body="$2"
	CATALYST_REPLICA_DB="$db" bash -c "set -uo pipefail; . '$LIB' >/dev/null 2>&1; $body >/dev/null 2>&1; printf '%s' \"\$LINEAR_IDENTITY_REASON\"" 2>/dev/null
}

DB="$SCRATCH/fresh.db"
make_db "$DB" 1 1

echo ""
echo "=== a fresh, populated replica answers ==="
assert_eq "team id resolves" "$(run "$DB" 'linear_identity_team_id CTL')" "$TEAM"
assert_eq "state id resolves" "$(run "$DB" 'linear_identity_state_id CTL Done')" "st-done"
assert_eq "success clears the reason" "$(reason "$DB" 'linear_identity_team_id CTL')" ""
assert_eq "label id resolves" "$(run "$DB" 'linear_identity_label_id needs-human')" "lab-uniq"

echo ""
echo "=== archived states are excluded ==="
# Resolving to an archived state produces a write Linear accepts and a board nobody sees.
assert_eq "archived state is not found" "$(reason "$DB" 'linear_identity_state_id CTL Retired')" "state-not-found"
assert_eq "states json omits the archived one" \
	"$(run "$DB" 'linear_identity_states_json CTL | grep -c Retired || true')" "0"
assert_eq "states json carries the live ones" \
	"$(run "$DB" 'linear_identity_states_json CTL | grep -c st-done')" "1"

echo ""
echo "=== ⛔ degraded replicas fail NAMED, and never substitute a stale answer ==="
STALE="$SCRATCH/stale.db"
make_db "$STALE" 0 1
assert_eq "a stale replica is refused" "$(reason "$STALE" 'linear_identity_team_id CTL')" "replica-stale"
assert_eq "…and returns NOTHING, not a last-known-good id" "$(run "$STALE" 'linear_identity_team_id CTL')" ""

ABSENT="$SCRATCH/nope.db"
rm -f "$ABSENT"
assert_eq "an absent replica is its own reason, not 'stale'" \
	"$(reason "$ABSENT" 'linear_identity_team_id CTL')" "replica-absent"

echo ""
echo "=== ⛔ the CTL-1420 shape: empty BUT FRESH must not read as a confident answer ==="
EMPTY="$SCRATCH/empty.db"
make_db "$EMPTY" 1 0 # fresh gate open, zero workflow_states
assert_eq "an empty state table is a failure, not '{}'" \
	"$(reason "$EMPTY" 'linear_identity_states_json CTL')" "state-not-found"
assert_eq "…and emits no object at all" "$(run "$EMPTY" 'linear_identity_states_json CTL')" ""
# Positive control: the SAME call on the SAME fresh gate DOES answer when data exists,
# so the failure above is the empty table and not a broken freshness gate.
assert_eq "control — the gate itself is open on a populated db" \
	"$(run "$DB" 'linear_identity_states_json CTL | grep -c st-todo')" "1"

echo ""
echo "=== a team with no issues is 'not resolvable', never 'no such team' ==="
# The two are indistinguishable from this source; claiming the stronger one would send
# an operator to re-create a team that already exists.
assert_eq "unknown team key" "$(reason "$DB" 'linear_identity_team_id NOPE')" "team-not-resolvable"

echo ""
echo "=== an ambiguous label is refused rather than silently first-wins ==="
# Picking one would apply a label to the wrong team's board and look like it worked.
assert_eq "duplicate label name" "$(reason "$DB" 'linear_identity_label_id dupe')" "label-ambiguous"
assert_eq "missing label name" "$(reason "$DB" 'linear_identity_label_id absent-label')" "label-not-found"

echo ""
echo "=== a quote in an argument cannot break out of the query ==="
assert_eq "quoted team key is escaped, not injected" \
	"$(reason "$DB" "linear_identity_team_id \"CTL' OR '1'='1\"")" "team-not-resolvable"

echo ""
echo "=== ⛔ regression: the reason survives, and the value is reachable without a subshell ==="
# A caller that does `id=$(linear_identity_team_id X)` runs the function in a SUBSHELL,
# so LINEAR_IDENTITY_REASON dies with it and the caller reports "unknown" — a failure
# that reports, but reports nothing usable. LINEAR_IDENTITY_VALUE exists so a caller can
# invoke directly and still get the answer. resolve-linear-ids.sh shipped the subshell
# form first and printed "(unknown)" for an absent replica; this holds the fix.
assert_eq "direct call exposes the value" \
	"$(run "$DB" 'linear_identity_team_id CTL >/dev/null; printf "%s" "$LINEAR_IDENTITY_VALUE"')" "$TEAM"
assert_eq "direct call preserves the NAMED reason on failure" \
	"$(run "$ABSENT" 'linear_identity_team_id CTL >/dev/null 2>&1; printf "%s" "$LINEAR_IDENTITY_REASON"')" "replica-absent"
assert_eq "a failed call leaves no stale value behind" \
	"$(run "$ABSENT" 'linear_identity_team_id CTL >/dev/null 2>&1; printf "%s" "$LINEAR_IDENTITY_VALUE"')" ""

echo ""
echo "=== ⛔ Codex #3501 P1: the cursor gate and the read share ONE snapshot ==="
# Two separate sqlite3 invocations let a cold reseed start between them, so the read
# observes partially restored tables — a nonempty but INCOMPLETE state map, or a
# duplicated label transiently looking unique. Both are confident WRONG answers, the one
# outcome this module exists to prevent. Simulated here by the observable end state: a
# fresh writer lock with the cursor gone (mid-reseed), which the in-snapshot gate must
# catch even though replica_fresh's own cheap check already ran.
RESEED="$SCRATCH/reseed.db"
make_db "$RESEED" 1 1
sqlite3 "$RESEED" "DELETE FROM sync_meta;" 2>/dev/null
touch "$RESEED.writer.lock"
assert_eq "a mid-reseed replica is named, not answered" \
	"$(reason "$RESEED" 'linear_identity_team_id CTL')" "replica-reseeding"
assert_eq "…and yields no id" "$(run "$RESEED" 'linear_identity_team_id CTL')" ""

# ⚠️ The assertion above exercises the CHEAP early-out, not the race the P1 fix targets.
# The race — a reseed starting AFTER the gate and BEFORE the read — cannot be reproduced
# deterministically from a shell test. What CAN be tested is that the in-snapshot gate
# stands on its own: stub replica_fresh to pass (i.e. pretend the early-out saw a healthy
# replica) and confirm the read still refuses. Without this, the `_LID_NO_CURSOR` branch
# would be a protection nobody has ever seen fire.
assert_eq "the IN-SNAPSHOT gate refuses even when the early-out passes" \
	"$(CATALYST_REPLICA_DB="$RESEED" bash -c "set -uo pipefail; . '$LIB' >/dev/null 2>&1
	   replica_fresh() { return 0; }
	   linear_identity_team_id CTL >/dev/null 2>&1; printf '%s' \"\$LINEAR_IDENTITY_REASON\"" 2>/dev/null)" \
	"replica-reseeding"

echo ""
echo "=== ⛔ Codex #3501 P2: a SQLite failure is not an entity miss ==="
# The recorded live condition: workflow_states absent on a replica whose gate is open.
# The old helper sent sqlite's stderr to /dev/null, so the empty output was reinterpreted
# as state-not-found — "could not query" became "the entity is not there".
NOTABLE="$SCRATCH/notable.db"
make_db "$NOTABLE" 1 1
sqlite3 "$NOTABLE" "DROP TABLE workflow_states;" 2>/dev/null
assert_eq "a missing table is 'unreadable', NOT 'state-not-found'" \
	"$(reason "$NOTABLE" 'linear_identity_state_id CTL Done')" "replica-unreadable"
assert_eq "…and the map helper agrees" \
	"$(reason "$NOTABLE" 'linear_identity_states_json CTL')" "replica-unreadable"
# Control on the same db: the team read, whose table still exists, still answers — so the
# failure above is the dropped table and not a globally broken fixture.
assert_eq "control — the surviving table still resolves" \
	"$(run "$NOTABLE" 'linear_identity_team_id CTL')" "$TEAM"

echo ""
echo "=== ⛔ Codex #3501 P2: a NESTED failure keeps its reason ==="
# state_id/states_json call team_id. Capturing that with $( ) ran it in a subshell and
# discarded the reason, so a direct caller got rc=1 with an EMPTY reason — the module's
# named-failure contract defeated at the two helpers most callers use.
assert_eq "state_id surfaces the nested absent-replica reason" \
	"$(reason "$ABSENT" 'linear_identity_state_id CTL Done')" "replica-absent"
assert_eq "states_json surfaces it too" \
	"$(reason "$ABSENT" 'linear_identity_states_json CTL')" "replica-absent"
assert_eq "state_id surfaces a nested stale reason" \
	"$(reason "$STALE" 'linear_identity_state_id CTL Done')" "replica-stale"
assert_eq "state_id surfaces a nested unknown-team reason" \
	"$(reason "$DB" 'linear_identity_state_id NOPE Done')" "team-not-resolvable"

echo ""
echo "════════════════════════════════════════════"
echo "  PASSED: $PASSES   FAILED: $FAILURES"
echo "════════════════════════════════════════════"
[[ $FAILURES -eq 0 ]]
