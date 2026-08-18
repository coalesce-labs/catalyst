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
	# NOTE: replica_fresh also checks the sync_meta cursor. That check is KEPT here as a
	# cheap early-out, but it is no longer the one that matters — the authoritative cursor
	# gate now runs inside the same snapshot as the read (_lid_query_gated), because a
	# gate that passes in one connection says nothing about what a later one observes.
	replica_fresh "$db" || {
		# replica_fresh folds two different conditions into one rc: a stale writer
		# heartbeat, and an absent/empty seed cursor. They need different repairs — "the
		# writer is behind" vs "the seed never finished / is mid-reseed" — so name them
		# apart here rather than reporting both as stale.
		if [[ -z "$(sqlite3 "$db" "SELECT 1 FROM sync_meta WHERE key='cursor' AND value<>'' LIMIT 1;" 2>/dev/null)" ]]; then
			_lid_fail "replica-reseeding"
		else
			_lid_fail "replica-stale"
		fi
		return 1
	}
	LINEAR_IDENTITY_REASON=""
}

# The sentinel a gated query returns when the seed cursor is absent. Deliberately not a
# value any column can hold, so it can never be mistaken for a resolved id.
_LID_NO_CURSOR="__LID_NO_CURSOR__"

# _lid_query_gated <db> <scalar-select> — run the cursor gate and the read in ONE
# statement, i.e. ONE snapshot.
#
# ⛔ Codex #3501 P1: these used to be two separate `sqlite3` invocations. A cold reseed
# beginning after the cursor check but before the read lets the read observe partially
# restored tables — a nonempty but INCOMPLETE state map, or a duplicated label
# transiently looking unique. Both are confident wrong answers, which is the one outcome
# this module exists to prevent. `linear-write-proxy-resolve.mjs` already resolves this
# the same way (gate + resolution in one transaction); this now matches it.
#
# ⛔ Codex #3501 P2: the old helper sent sqlite's stderr to /dev/null, so an unreadable
# or MISSING table — the recorded live condition where `workflow_states` was absent —
# produced empty output that callers then read as `team-not-resolvable` /
# `state-not-found` / `label-not-found`. "Could not query" became "the entity is not
# there". The query status is now preserved and reported as its own named failure.
_lid_query_gated() {
	local db="$1" inner="$2" out rc=0
	out=$(sqlite3 "$db" "SELECT CASE
	      WHEN NOT EXISTS(SELECT 1 FROM sync_meta WHERE key='cursor' AND value<>'')
	      THEN '${_LID_NO_CURSOR}'
	      ELSE COALESCE((${inner}), '')
	    END;" 2>/dev/null) || rc=$?
	if [[ $rc -ne 0 ]]; then
		_lid_fail "replica-unreadable"
		return 1
	fi
	if [[ "$out" == "$_LID_NO_CURSOR" ]]; then
		# Seed incomplete / mid-reseed. Same class as stale, distinct name so an operator
		# can tell "the writer is behind" from "the seed never finished".
		_lid_fail "replica-reseeding"
		return 1
	fi
	# ⛔ Result via a GLOBAL, not stdout. Every caller below would otherwise capture this
	# with `$( )` — a subshell — and the reason set by the two _lid_fail calls above would
	# be discarded, exactly as it was for the nested team lookup Codex flagged. That is
	# the FOURTH time this defect appeared tonight, and the third inside a fix for it:
	# in bash, "returns a value" and "returns a diagnosis" cannot both go through stdout.
	_LID_QUERY_OUT="$out"
}
_LID_QUERY_OUT=""

# linear_identity_team_id <TEAM_KEY> [db] — echo the team UUID.
#
# ⚠️ Derived from the issues the replica carries for that key. A team with ZERO issues
# is therefore not resolvable here, and that is reported as `team-not-resolvable`
# rather than as "no such team": the two are indistinguishable from this source, and
# claiming the stronger one would send an operator to re-create a team that exists.
linear_identity_team_id() {
	local key="$1" db="${2:-$CATALYST_REPLICA_DB}" id
	_lid_ready "$db" || return 1
	_lid_query_gated "$db" "SELECT team_id FROM issues WHERE team_key='${key//\'/\'\'}' AND team_id IS NOT NULL AND removed_at IS NULL LIMIT 1" || return 1
	id="$_LID_QUERY_OUT"
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
	# ⛔ Codex #3501 P2: this nested call used to be `team=$(linear_identity_team_id …)`.
	# Command substitution is a SUBSHELL, so a replica-absent / replica-stale /
	# team-not-resolvable reason set inside it was discarded, and a direct caller got
	# rc=1 with an EMPTY reason — defeating this module's whole named-failure contract at
	# the two helpers most callers actually use. Third occurrence of this defect in one
	# night, the other two in setup-catalyst.sh and resolve-linear-ids.sh: in bash, a
	# function returning a value on stdout cannot also return a diagnosis, so nested
	# calls read LINEAR_IDENTITY_VALUE instead of capturing.
	linear_identity_team_id "$key" "$db" >/dev/null || return 1
	team="$LINEAR_IDENTITY_VALUE"
	_lid_query_gated "$db" "SELECT id FROM workflow_states WHERE team_id='${team//\'/\'\'}' AND name='${name//\'/\'\'}' AND archived_at IS NULL LIMIT 1" || return 1
	id="$_LID_QUERY_OUT"
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
	# Same subshell trap as linear_identity_state_id above — read the global, do not capture.
	linear_identity_team_id "$key" "$db" >/dev/null || return 1
	team="$LINEAR_IDENTITY_VALUE"
	_lid_query_gated "$db" "SELECT json_group_object(name, id) FROM workflow_states WHERE team_id='${team//\'/\'\'}' AND archived_at IS NULL" || return 1
	json="$_LID_QUERY_OUT"
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
	# group_concat keeps this a SCALAR select so it fits the single-statement snapshot;
	# the ambiguity count is derived from the separator, not from a second query.
	_lid_query_gated "$db" "SELECT group_concat(id, ',') FROM labels WHERE name='${name//\'/\'\'}' AND removed_at IS NULL" || return 1
	ids="$_LID_QUERY_OUT"
	[[ -n "$ids" ]] || {
		_lid_fail "label-not-found"
		return 1
	}
	n=$(awk -F',' '{print NF}' <<<"$ids")
	if [[ "$n" -gt 1 ]]; then
		_lid_fail "label-ambiguous"
		return 1
	fi
	LINEAR_IDENTITY_VALUE="$ids"
	printf '%s' "$ids"
}
