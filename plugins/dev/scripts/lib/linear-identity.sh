#!/usr/bin/env bash
# linear-identity.sh — CTC-403: resolve Linear TEAM, WORKFLOW-STATE and LABEL ids
# from the Catalyst Cloud replica instead of from hand-written host caches.
#
# ── WHY ──
# Identity was stored in four places, none authoritative: `.catalyst/config.json`
# → `catalyst.linear.teamId` (21 files, 7 repoRoots × 3 hosts),
# `~/.config/catalyst/linear-state-ids.json` (~248 workflow-state UUIDs, hosts
# disagreeing), `filter-state.db`, and identifier-keyed marker dirs. A Linear-to-Linear
# import preserves human identifiers and team keys but MINTS NEW INTERNAL UUIDs — and
# Catalyst keys on the UUID while caching on the key. So after the cutover every cache
# still MATCHED and every value beneath it was dead. That combination defeats staleness
# detection by construction: there is no observation that distinguishes it from health.
#
# The cloud registry is already authoritative for (account → workspace → team) and the
# replica already carries every workflow state on every issue, so this is mostly
# SUBTRACTION — read the copy that is already replicated rather than keep a parallel
# denormalized one with no invalidation path.
#
# ── ⛔ THE TRAP THIS DELIBERATELY DOES NOT WALK INTO ──
# Making identity a replica read couples it to replica freshness, and this fleet has
# that failure on record: an empty-but-fresh replica read as healthy and produced a
# fleet-wide admission freeze with every signal green (CTL-1420). So:
#   • freshness is GATED, via the SAME `replica_fresh` the ticket-read helper uses —
#     writer-lock recency AND a non-empty sync_meta cursor (seed complete, not
#     mid-reseed);
#   • a confident answer and "I could not look" are DIFFERENT results, never merged;
#   • there is NO fallback to a stale local cache. Substituting last-known-good is how
#     the original drift was built, one layer down. Callers get a named failure and
#     decide; this module never decides for them by guessing.
#
# Every function sets LINEAR_IDENTITY_REASON to "" on success, or to one of:
#   no-sqlite3 · replica-absent · replica-stale · team-not-resolvable ·
#   state-not-found · label-not-found · label-ambiguous
#
# Usage:
#   source "${SCRIPT_DIR}/lib/linear-identity.sh"
#   if team_id=$(linear_identity_team_id CTL); then … else echo "$LINEAR_IDENTITY_REASON"; fi
#
# Idempotent: sourcing twice is a no-op.

[[ -n "${_CATALYST_LINEAR_IDENTITY_SH:-}" ]] && return 0
_CATALYST_LINEAR_IDENTITY_SH=1

# Reuse the ticket-read helper's replica path resolution and freshness gate rather than
# re-deriving them. Two gates that must agree, maintained separately, is the same
# drift-with-no-invalidation shape this module exists to remove.
# shellcheck disable=SC2296
__LID_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
__LID_LIB_DIR="$(cd "$(dirname "$__LID_SELF")" && pwd)"
# shellcheck disable=SC1091
. "${__LID_LIB_DIR}/linear-read-replica.sh"

# ⛔ THE RESULT IS ALSO A GLOBAL, AND THAT IS THE POINT.
# Every function echoes its answer for convenience, but a caller that captures it with
# `$(…)` runs the function in a SUBSHELL — so LINEAR_IDENTITY_REASON, the whole reason
# a failure here is diagnosable, dies with that subshell and the caller reports
# "unknown". Callers that need the reason must invoke the function directly and read
# LINEAR_IDENTITY_VALUE instead:
#
#     if linear_identity_team_id CTL >/dev/null; then
#       id="$LINEAR_IDENTITY_VALUE"
#     else
#       echo "$LINEAR_IDENTITY_REASON"    # replica-stale, not "unknown"
#     fi
#
# This is not hypothetical tidiness — the first cut of resolve-linear-ids.sh's
# replica branch captured with `$(…)` and printed `(unknown)` for an absent replica,
# which is precisely the "the failure reports, but reports nothing usable" shape.
export LINEAR_IDENTITY_REASON=""
export LINEAR_IDENTITY_VALUE=""

_lid_fail() {
	LINEAR_IDENTITY_VALUE=""
	LINEAR_IDENTITY_REASON="$1"
	printf '[linear-identity] %s\n' "$1" >&2
	return 1
}

# _lid_ready [db] — the shared precondition: sqlite3 present, file there, gate open.
# ⛔ "absent" and "stale" are reported separately on purpose. They need different
# repairs (provision the replica vs fix the writer), and collapsing them is what turns
# an operator's first diagnostic step into a guess.
_lid_ready() {
	local db="${1:-$CATALYST_REPLICA_DB}"
	command -v sqlite3 >/dev/null 2>&1 || {
		_lid_fail "no-sqlite3"
		return 1
	}
	[[ -f "$db" ]] || {
		_lid_fail "replica-absent"
		return 1
	}
	replica_fresh "$db" || {
		_lid_fail "replica-stale"
		return 1
	}
	LINEAR_IDENTITY_REASON=""
}

_lid_q() { sqlite3 "$1" "$2" 2>/dev/null; }

# linear_identity_team_id <TEAM_KEY> [db] — echo the team UUID.
#
# ⚠️ Derived from the issues the replica carries for that key. A team with ZERO issues
# is therefore not resolvable here, and that is reported as `team-not-resolvable`
# rather than as "no such team": the two are indistinguishable from this source, and
# claiming the stronger one would send an operator to re-create a team that exists.
linear_identity_team_id() {
	local key="$1" db="${2:-$CATALYST_REPLICA_DB}" id
	_lid_ready "$db" || return 1
	id=$(_lid_q "$db" "SELECT team_id FROM issues WHERE team_key='${key//\'/\'\'}' AND team_id IS NOT NULL AND removed_at IS NULL LIMIT 1;")
	[[ -n "$id" ]] || {
		_lid_fail "team-not-resolvable"
		return 1
	}
	LINEAR_IDENTITY_VALUE="$id"
	printf '%s' "$id"
}

# linear_identity_state_id <TEAM_KEY> <STATE_NAME> [db] — echo the workflow-state UUID.
# Archived states are excluded: resolving to one produces a write Linear accepts and a
# board nobody sees.
linear_identity_state_id() {
	local key="$1" name="$2" db="${3:-$CATALYST_REPLICA_DB}" team id
	team=$(linear_identity_team_id "$key" "$db") || return 1
	id=$(_lid_q "$db" "SELECT id FROM workflow_states WHERE team_id='${team//\'/\'\'}' AND name='${name//\'/\'\'}' AND archived_at IS NULL LIMIT 1;")
	[[ -n "$id" ]] || {
		_lid_fail "state-not-found"
		return 1
	}
	LINEAR_IDENTITY_VALUE="$id"
	printf '%s' "$id"
}

# linear_identity_states_json <TEAM_KEY> [db] — echo {"<name>":"<uuid>", …} for the
# team's live states. This is the shape linear-state-ids.json caches, so a caller can
# compare the replica's answer to the cache without reshaping either.
#
# ⛔ An EMPTY object is a failure, not an empty answer: a fresh replica that carries no
# workflow states for a team is exactly the empty-but-fresh case CTL-1420 turned into a
# silent fleet-wide freeze. Returning `{}` here would hand a caller a confident nothing.
linear_identity_states_json() {
	local key="$1" db="${2:-$CATALYST_REPLICA_DB}" team json
	team=$(linear_identity_team_id "$key" "$db") || return 1
	json=$(_lid_q "$db" "SELECT COALESCE(json_group_object(name, id), '{}') FROM workflow_states WHERE team_id='${team//\'/\'\'}' AND archived_at IS NULL;")
	[[ -n "$json" && "$json" != "{}" ]] || {
		_lid_fail "state-not-found"
		return 1
	}
	LINEAR_IDENTITY_VALUE="$json"
	printf '%s' "$json"
}

# linear_identity_label_id <NAME> [db] — echo the label UUID.
#
# Labels are workspace-scoped in the replica (no team column), so a duplicate NAME
# across teams is genuinely ambiguous. That is reported as `label-ambiguous` rather
# than silently taking the first row — picking one would apply a label to the wrong
# team's board and look like it worked.
linear_identity_label_id() {
	local name="$1" db="${2:-$CATALYST_REPLICA_DB}" ids n
	_lid_ready "$db" || return 1
	ids=$(_lid_q "$db" "SELECT id FROM labels WHERE name='${name//\'/\'\'}' AND removed_at IS NULL;")
	[[ -n "$ids" ]] || {
		_lid_fail "label-not-found"
		return 1
	}
	n=$(printf '%s\n' "$ids" | /usr/bin/grep -c .)
	if [[ "$n" -gt 1 ]]; then
		_lid_fail "label-ambiguous"
		return 1
	fi
	LINEAR_IDENTITY_VALUE="$ids"
	printf '%s' "$ids"
}
