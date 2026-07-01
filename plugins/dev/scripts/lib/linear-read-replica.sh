#!/usr/bin/env bash
# linear-read-replica.sh — CTL-1397: direct-SQLite Linear read helper for scripts.
#
# The read rule (single source: the `catalyst-dev:linearis` skill, "Reading
# Linear"): Linear READS → the local Catalyst Cloud replica by direct SQL; WRITES
# → always `linearis`. This helper is the scripted form of that rule — it replaces
# the deprecated `catalyst-linear read` CLI wrapper for the handful of bash scripts
# that parse a single ticket's fields.
#
# `linear_read_ticket <ID>` echoes the ticket JSON in the SAME shape `linearis
# issues read` / `catalyst-linear read` return (state.name, estimate, url,
# labels.nodes[], …), built from the replica's join tables so the label shape is
# always canonical (raw.labels is inconsistently array-vs-{nodes} across rows).
# Existing `jq` expressions keep working unchanged.
#
# Freshness is GATED, not assumed (mirrors execution-core/replica-read.mjs
# isReplicaFresh): the writer heartbeat `<db>.writer.lock` must be recent AND the
# `sync_meta` cursor must be present (proves the seed is complete, not mid-reseed).
# On stale / absent / MISS the helper is LOUD (stderr) and falls back to `linearis`
# for that one read — never silent: a stale replica is a writer/mirror gap to fix,
# per the read-replica-no-silent-fallback principle. Writes stay on `linearis`.
#
# Usage:
#   source "${SCRIPT_DIR}/lib/linear-read-replica.sh"
#   json=$(linear_read_ticket ENG-123) || return 1
#   title=$(printf '%s' "$json" | jq -r '.title // empty')
#
# This module is idempotent: sourcing it twice is a no-op.

[[ -n "${_CATALYST_LINEAR_READ_REPLICA_SH:-}" ]] && return 0
_CATALYST_LINEAR_READ_REPLICA_SH=1

# Resolve the replica DB path the SAME way the daemon does (config.mjs
# getReplicaDbPath): CATALYST_REPLICA_DB overrides; else $CATALYST_DIR/…; else
# $HOME/catalyst/… — so an install that sets CATALYST_DIR is honored.
: "${CATALYST_REPLICA_DB:=${CATALYST_DIR:-${HOME:-}/catalyst}/catalyst-replica.db}"
# Freshness threshold in ms (matches the daemon env var); default 5 min.
: "${CATALYST_LINEAR_REPLICA_STALE_MS:=300000}"
# Live-read fallback cap in ms (matches catalyst-linear's runLinearis); default 8s.
: "${CATALYST_LINEARIS_TIMEOUT_MS:=8000}"

# _lrr_live_read <ID> → run the linearis fallback, CAPPED so a 429-stalled / hung
# linearis can't block the caller forever (parity with catalyst-linear's runLinearis
# 8s cap). Uses `timeout` when present (GNU coreutils on the fleet); on timeout the
# non-zero exit propagates so callers fail safe. macOS without `timeout` runs bare.
_lrr_live_read() {
  local id="$1" cap_ms="${CATALYST_LINEARIS_TIMEOUT_MS:-8000}" secs
  if command -v timeout >/dev/null 2>&1 && [[ "$cap_ms" =~ ^[0-9]+$ ]] && ((cap_ms > 0)); then
    secs=$(((cap_ms + 999) / 1000)) # ceil ms → whole seconds, min 1
    timeout "${secs}s" linearis issues read "$id" </dev/null
  else
    linearis issues read "$id" </dev/null
  fi
}

# _lrr_mtime <path> → epoch-seconds mtime; empty if absent. GNU (`stat -c %Y`)
# FIRST, BSD (`stat -f %m`) as the fallback: on GNU/Linux `-f` means
# `--file-system` (it would NOT error, it prints filesystem text), so probing BSD
# first would yield garbage on the Linux fleet. macOS lacks `-c`, so it errors
# cleanly and falls through to `-f`.
_lrr_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# replica_fresh [db] → rc 0 when the replica is safe to read:
#   • sqlite3 available, and
#   • the writer heartbeat lock is younger than the staleness threshold, and
#   • sync_meta has a non-empty `cursor` row (seed complete, not mid-reseed).
# Any failure → rc 1 (caller falls back to linearis). Never prints.
replica_fresh() {
  local db="${1:-$CATALYST_REPLICA_DB}" lock now m age thr
  command -v sqlite3 >/dev/null 2>&1 || return 1
  lock="$db.writer.lock"
  [[ -f "$lock" ]] || return 1
  m=$(_lrr_mtime "$lock"); [[ -n "$m" ]] || return 1
  now=$(date +%s); age=$(( now - m ))
  thr=$(( ${CATALYST_LINEAR_REPLICA_STALE_MS:-300000} / 1000 ))
  (( age <= thr )) || return 1
  [[ -n "$(sqlite3 "$db" "SELECT 1 FROM sync_meta WHERE key='cursor' AND value<>'' LIMIT 1;" 2>/dev/null)" ]]
}

# linear_read_ticket <ID> [db] → echo ticket JSON (linearis-shaped) on stdout.
# rc 0 on any successful read (replica HIT or linearis fallback); rc 2 on bad id.
linear_read_ticket() {
  local id="$1" db="${2:-$CATALYST_REPLICA_DB}" json
  if [[ ! "$id" =~ ^[A-Za-z0-9]+-[0-9]+$ ]]; then
    printf '[linear-read-replica] bad ticket id: %s\n' "${id:-<empty>}" >&2
    return 2
  fi
  if replica_fresh "$db"; then
    json=$(sqlite3 "$db" "
      SELECT json_object(
        'id', i.id,
        'identifier', i.identifier,
        'title', i.title,
        'description', i.description,
        'priority', i.priority,
        'estimate', i.estimate,
        'url', i.url,
        'branchName', i.branch_name,
        'state', json_object('name', i.state),
        'assignee', CASE WHEN i.assignee_id IS NOT NULL
                         THEN json_object('id', i.assignee_id, 'name', i.assignee) END,
        'labels', json_object('nodes', json((
            SELECT COALESCE(json_group_array(json_object('id', l.id, 'name', l.name)), '[]')
            FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id)))
      )
      FROM issues i WHERE i.identifier = '$id' AND i.removed_at IS NULL LIMIT 1;" 2>/dev/null)
    if [[ -n "$json" && "$json" != "null" ]]; then
      printf '%s\n' "$json"
      return 0
    fi
    # Fresh replica, but the row is absent (not yet mirrored / tombstoned).
    printf '[linear-read-replica] MISS for %s (replica fresh, row absent) — falling back to linearis; file a ticket if this recurs.\n' "$id" >&2
  else
    printf '[linear-read-replica] replica STALE/ABSENT (writer heartbeat >%ds or seed incomplete) — falling back to linearis for %s; this is a writer/mirror gap to fix, not a retry.\n' "$(( ${CATALYST_LINEAR_REPLICA_STALE_MS:-300000} / 1000 ))" "$id" >&2
  fi
  # Loud fallback — one un-accelerated, timeout-capped live read. Writes stay on
  # linearis elsewhere.
  _lrr_live_read "$id"
}
