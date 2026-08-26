# Reading Linear — full detail

Deep detail behind the always-loaded rule in `SKILL.md` → "Reading Linear". Read this when you
need the freshness-gate internals, schema discovery, or the deprecated wrapper's history.

## Why direct SQL, not bare `linearis`

Bare `linearis` reads always hit the rate-limited Linear API. On the shared-quota fleet that burns
budget and 429s everyone. The replica (`~/catalyst/catalyst-replica.db`, a SQLite mirror kept
current by the per-host `catalyst-cloud-sync` change-feed writer) is a sub-ms local copy that
already has the answer — reading it is what makes "every client reads the replica" actually true.
It holds every issue field plus labels, relations, projects, cycles, users, and PR/review state.

## The freshness gate, copy-paste (portable macOS/Linux)

Prefer the shared helper (`linear_read_ticket`, `SKILL.md`) over re-implementing this — this is
what it does internally:

```bash
# Resolve the DB the way the daemon does: $CATALYST_REPLICA_DB, else $CATALYST_DIR, else $HOME.
DB="${CATALYST_REPLICA_DB:-${CATALYST_DIR:-$HOME/catalyst}/catalyst-replica.db}"
replica_fresh() {
  local lock="$DB.writer.lock" now age
  [[ -f "$lock" ]] || return 1
  # GNU `stat -c %Y` first, BSD `stat -f %m` fallback (on Linux `-f` is --file-system, not mtime).
  now=$(date +%s); age=$(( now - $(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock") ))
  (( age < 300 )) || return 1                                    # writer heartbeat < 5 min
  [[ -n "$(sqlite3 "$DB" "SELECT 1 FROM sync_meta WHERE key='cursor' AND value<>'' LIMIT 1;")" ]]  # seed complete
}
```

If the loud fallback persists, treat it as a replica-tier outage — configuration order and health
signals: `docs/linear-replica.md`.

## Caveat — the gates prove writer-liveness + seed-completeness, NOT per-row apply success

A rare class of rows (~0.7%) can be *present but stale* because their change-feed apply silently
failed (the `errno:1` apply-drift, catalyst-cloud#127 / CTL-1402) — the writer heartbeats and the
cursor advances past them, so the freshness gate reads green while that one row holds an old
value. Direct SQL cannot make this loud on its own. So: if a specific field **contradicts
something you just directly observed** (e.g. a state you just wrote), treat that one field as an
anomaly — re-read it via `linearis`, use the live value, and surface it. This is the residual
reason **writer reliability + apply-failure telemetry** (CTL-1402) matter; it is not license to
re-verify reads that don't contradict anything.

## Querying (discover the schema — don't guess columns)

Run `sqlite3 "$DB" .schema` (or `.schema issues`) to see the live columns. Verified 2026-07-01:

- `issues.state` is the **state NAME** directly (`Backlog`/`Implement`/`PR`/`Done`…) — no join.
- `issues` also has: `identifier`, `title`, `estimate`, `priority`/`priority_label`,
  `description`, `url`, `branch_name`, `parent_identifier`, `project_id`, `cycle_id`, `team_id`,
  `assignee_id`, the timestamp columns, and a **`raw`** column with the full Linear JSON.
- **Labels:** `issue_labels ⋈ labels` — `JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id`.
- **Relations (blocks / blocked-by / …):** the `relations` table (`type, issue_identifier,
  related_identifier`). **Relations lag ≤ 5 min** (reconcile poll, no webhook) — everything else
  is real-time.
- **Any uncolumned field:** `json_extract(raw,'$.path')` (e.g. `json_extract(raw,'$.state.type')`).

```bash
sqlite3 -json "$DB" "
  SELECT i.identifier, i.title, i.state, i.estimate,
         (SELECT group_concat(l.name, ', ') FROM issue_labels il
            JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id) AS labels
  FROM issues i WHERE i.identifier = 'ENG-123' AND i.removed_at IS NULL;"
```

> `AND removed_at IS NULL` is REQUIRED: a tombstoned (removed) issue must read as a MISS → fall
> back to live Linear, never as a stale hit.

## Still needs `linearis` (no issue-shaped replica form)

- **Non-issue domains:** `cycles` / `projects` / `milestones` / `initiatives` list & read — use
  `linearis` (see `SKILL.md` → Core Operations). Simple `cycles`/`projects` lookups can use those
  replica tables, but the linearis commands are the full path.
- **Genuinely unmirrored gaps:** cross-team-unsynced parent/child, plus a few unselected fields
  (`relation.id`, `cycle.name` — CTC-147; `state.id`, `team.key` — CTC-148; `children` is always
  `[]`). These are **closeable gaps, not permanent carve-outs** — file/track them; don't route
  around the replica by habit.

## `catalyst-linear` CLI — DEPRECATED

The `catalyst-linear read|list|search` wrapper (CTL-1391) is **superseded by direct SQL** for
agent/skill reads and retained only as a fail-open compatibility shim. Prefer direct SQL.
(`list`/`search` were always `linearis` passthrough — no replica benefit — and the wrapper's
additive `_meta` field + duplicate-flag collapsing broke bare-`linearis` jq pipelines.) The
daemon's own read paths use `replica-read.mjs` directly and are unaffected by this deprecation.
