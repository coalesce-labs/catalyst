---
name: linearis-cli
description:
  Linear access rule + Linearis CLI reference. READS → query the local replica by direct SQL
  (`~/catalyst/catalyst-replica.db`); WRITES and list/search → the `linearis` CLI. Use when working
  with Linear tickets, cycles, projects, milestones, or when the user mentions ticket IDs like
  TEAM-123, ENG-456, PROJ-789.
---

# Linearis CLI Reference

> Verified against Linearis v2026.4.9 on 2026-05-31.

> ⚠️ **READ vs WRITE — the rule that governs everything below.** Linear **READS** → query the local
> replica by direct SQL (`~/catalyst/catalyst-replica.db`), or call `linear_read_ticket <ID>`.
> **Never** shell `linearis issues read` for a routine read — that hits the rate-limited API and 429s
> the shared quota. **WRITES** (create/update/state/comment/estimate/label) and **list/search/non-issue
> domains** → the `linearis` CLI. Full rule + freshness gate: **[Reading Linear](#reading-linear)**.

**CRITICAL: Always use these exact patterns. Do NOT guess or improvise syntax.**

> ⚠️ **Read the [Gotchas & Traps](#gotchas--traps) section before scripting** — `issues list` silently
> hides Done tickets, `linearis` eats stdin in loops, and there is no `--json` flag. These bite hard.

## Reading Linear

> **This is the single source of the Linear read rule.** Other skills/agents reference this
> section — they do **not** restate it.

**Linear READS → query the local Catalyst Cloud replica directly with SQL. Linear WRITES →
always `linearis`.** The replica (`~/catalyst/catalyst-replica.db`, a SQLite mirror kept
current by the per-host `catalyst-cloud-sync` change-feed writer) holds every issue field plus
labels, relations, projects, cycles, users, and PR/review state — so **one SQL query serves ANY
read**, including the label/relation joins the old CLI couldn't. This supersedes the
`catalyst-linear` wrapper (now deprecated — see below) for agent/skill ad-hoc reads.

> **Why direct SQL, not bare `linearis`.** Bare `linearis` reads always hit the rate-limited
> Linear API. On the shared-quota fleet that burns budget and 429s everyone. The replica is a
> sub-ms local copy that already has the answer — reading it is what makes "every client reads
> the replica" actually true.

### The rule

1. **Confirm the replica is FRESH + SEEDED** — both gates (mirrors the daemon's `isReplicaFresh`,
   `execution-core/replica-read.mjs`):
   - **Writer alive:** `<db>.writer.lock` mtime is **< 5 min** old. The writer heartbeats this
     file every few seconds regardless of Linear activity, so it tracks *liveness*, not
     data-change cadence — do **NOT** gate on the `.db`/`-wal` mtime (a quiet feed makes those
     look stale even when the mirror is perfectly current).
   - **Seed complete:** `sync_meta` has a **non-empty `cursor` row**. The writer deletes it at
     the start of a re-seed and rewrites it on completion, so its presence means you are not
     reading a half-truncated table mid-reseed.
2. **Fresh + seeded → query the replica and TRUST it.** Do **not** re-verify against live
   Linear — that defeats the cache and re-burns the quota.
3. **Not fresh / not seeded / your row missing → this is an ALARM, not a silent reroute.** Say
   so loudly, fall back to `linearis` for that one read, **and file a ticket** — a stale/absent
   replica signals a writer or mirror gap worth fixing, not a one-off retry.

> **Caveat — the gates prove writer-liveness + seed-completeness, NOT per-row apply success.**
> A rare class of rows (~0.7%) can be *present but stale* because their change-feed apply silently
> failed (the `errno:1` apply-drift, catalyst-cloud#127 / CTL-1402) — the writer heartbeats and the
> cursor advances past them, so the freshness gate reads green while that one row holds an old value.
> Direct SQL cannot make this loud on its own. So: if a specific field **contradicts something you
> just directly observed** (e.g. a state you just wrote), treat that one field as an anomaly —
> re-read it via `linearis`, use the live value, and surface it. This is the residual reason
> **writer reliability + apply-failure telemetry** (CTL-1402) matter; it is not license to re-verify
> reads that don't contradict anything.

### Freshness gate (copy-paste, portable macOS/Linux)

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

Scripts should use the shared helper instead of re-implementing this: source
`plugins/dev/scripts/lib/linear-read-replica.sh` and call `linear_read_ticket <ID>` (freshness
gate → SQL → loud `linearis` fallback).

### Querying (discover the schema — don't guess columns)

Run `sqlite3 "$DB" .schema` (or `.schema issues`) to see the live columns. Verified 2026-07-01:

- `issues.state` is the **state NAME** directly (`Backlog`/`Implement`/`PR`/`Done`…) — no join.
- `issues` also has: `identifier`, `title`, `estimate`, `priority`/`priority_label`,
  `description`, `url`, `branch_name`, `parent_identifier`, `project_id`, `cycle_id`, `team_id`,
  `assignee_id`, the timestamp columns, and a **`raw`** column with the full Linear JSON.
- **Labels:** `issue_labels ⋈ labels` — `JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id`.
- **Relations (blocks / blocked-by / …):** the `relations` table (`type, issue_identifier,
  related_identifier`). **Relations lag ≤ 5 min** (reconcile poll, no webhook) — everything
  else is real-time.
- **Any uncolumned field:** `json_extract(raw,'$.path')` (e.g. `json_extract(raw,'$.state.type')`).

Representative read — identifier, title, state, estimate, and labels in one query:

```bash
sqlite3 -json "$DB" "
  SELECT i.identifier, i.title, i.state, i.estimate,
         (SELECT group_concat(l.name, ', ') FROM issue_labels il
            JOIN labels l ON l.id = il.label_id WHERE il.issue_id = i.id) AS labels
  FROM issues i WHERE i.identifier = 'ENG-123' AND i.removed_at IS NULL;"
```

> `AND removed_at IS NULL` is REQUIRED: a tombstoned (removed) issue must read as a
> MISS → fall back to live Linear, never as a stale hit.

### Still needs `linearis` (no issue-shaped replica form)

- **Non-issue domains:** `cycles` / `projects` / `milestones` / `initiatives` list & read — use
  `linearis` (Core Operations below). Simple `cycles`/`projects` lookups can use those replica
  tables, but the linearis commands are the full path.
- **Genuinely unmirrored gaps:** cross-team-unsynced parent/child, plus a few unselected fields
  (`relation.id`, `cycle.name` — CTC-147; `state.id`, `team.key` — CTC-148; `children` is always
  `[]`). These are **closeable gaps, not permanent carve-outs** — file/track them; don't route
  around the replica by habit.

### Writes — always `linearis`

`create` / `update` / state transitions / `discuss` / estimate / label **always** go through
`linearis`. The replica is **read-only**.

### `catalyst-linear` CLI — DEPRECATED

The `catalyst-linear read|list|search` wrapper (CTL-1391) is **superseded by direct SQL** for
agent/skill reads and retained only as a fail-open compatibility shim. Prefer direct SQL.
(`list`/`search` were always `linearis` passthrough — no replica benefit — and the wrapper's
additive `_meta` field + duplicate-flag collapsing broke bare-`linearis` jq pipelines.) The
daemon's own read paths use `replica-read.mjs` directly and are unaffected by this deprecation.

## Looking Up Syntax

For full flag details, run `linearis usage` (all domains) or `linearis <domain> usage` (one domain).
The `usage` output is authoritative and always current — prefer it over memorizing flags.

```bash
linearis usage                # Full overview of every domain and flag
linearis issues usage         # Just issue operations
linearis milestones usage     # Just milestone operations
linearis cycles usage         # Just cycle operations
```

## Gotchas & Traps

These are non-obvious behaviors that silently produce wrong results. Verified empirically against
v2026.4.9.

1. **`issues list` HIDES Done tickets by default.** A default `issues list` returns every active state
   **plus Canceled**, but **silently omits completed/Done** tickets. So a ticket *absent* from the list
   is usually Done, not gone. For ground-truth state of a specific ticket, use **`issues read <ID>`**.
   To surface completed work, pass **`--status "Done"`** explicitly (`--completed-after` alone does NOT
   override the exclusion). The asymmetry is real: Canceled shows, Done doesn't.

2. **`linearis` consumes stdin** — in a `for`/`while` loop or heredoc it eats the loop's input and every
   iteration after the first misbehaves (often looking like a hang or empty result). **Append `</dev/null`
   to every linearis call in scripts and agent loops.**

3. **There is no `--json` flag.** JSON is the default output (`{ "nodes": [...] }`); passing `--json`
   errors with `unknown option '--json'`. Just pipe the bare command to `jq`.

4. **`--status` is a real server-side filter** — a misspelled/unknown value returns an **empty set**
   (`jq` will throw "Cannot iterate over null"), it does NOT fall back to all issues. Validate status
   spelling against the team's real workflow states (e.g. CTL uses Research/Plan/Implement/Validate/
   PR/Remediate/Triage/Done, not the generic "In Progress").

5. **Filter→scope coupling:** `--status` and `--cycle` on `issues list`/`search` **require `--team`**;
   `--milestone` **requires `--project`**. Omitting the scope errors. `projects list` has **no `--team`
   filter at all** (only `--limit`/`--after`) — list all and filter with `jq`, or pivot via
   `issues list --team ENG | jq '.nodes[].project'`.

6. **`--query` on `issues list` is deprecated** (still works) — use **`issues search "<query>"`** instead.

7. **Milestone/cycle name resolution isn't globally unique.** Milestone names can collide across
   projects — pass `--project` (or a UUID) on `milestones read/update`. `cycles list --active` and
   `--window <n>` are team-scoped — always pair with `--team` or you may grab another team's cycle.

8. **`project-milestones` (old name) fails SILENTLY** — it doesn't error, it falls through to the generic
   top-level `--help` dump (looks like success). The domain is `milestones`.

9. **Shell note (Bash tool runs zsh):** `status` and `state` are reserved/read-only var names —
   `status=$(linearis ...)` throws "read-only variable". Use `st`/`s`/`lstate`.

10. **`auth status` is the diagnostic entry point** — if calls silently return nothing, run
    `linearis auth status` (read-only) to confirm the token before debugging anything else;
    `linearis auth login` refreshes it.

## Core Operations

> **Reads → direct SQL against the replica** (see [Reading Linear](#reading-linear)). The
> `linearis issues read|list|search` examples below document the CLI **syntax** for the cases
> that still use it — the stale/absent fallback path, non-issue domains, and writes. The flags
> carry over verbatim.

### Read a ticket

```bash
# Preferred — the shared helper: freshness gate → replica SQL → loud linearis fallback, one call.
source "${SCRIPT_DIR}/lib/linear-read-replica.sh"   # plugins/dev/scripts/lib/linear-read-replica.sh
json=$(linear_read_ticket ENG-123) || return 1      # linearis-shaped JSON (state.name, estimate, labels.nodes[]…)
title=$(printf '%s' "$json" | jq -r '.title // empty')

# No helper on hand? Inline SQL — gate on freshness first (see Reading Linear):
DB="${CATALYST_REPLICA_DB:-${CATALYST_DIR:-$HOME/catalyst}/catalyst-replica.db}"
sqlite3 -json "$DB" \
  "SELECT identifier, title, state, estimate FROM issues WHERE identifier='ENG-123' AND removed_at IS NULL;"
```

> `linearis issues read ENG-123` is the STALE/ABSENT **fallback only**. `linear_read_ticket` runs it
> for you and surfaces the fallback loudly — do **not** shell it directly for a routine read.

### Search tickets

```bash
linearis issues search "keyword"
linearis issues search "auth bug" --team ENG --status "Todo"
```

### Create a ticket

```bash
linearis issues create "Title" --team ENG
linearis issues create "Title" --team ENG --description "Details" --priority 2 --project "Project"
```

`create` also accepts `--status`, `--cycle`, `--estimate`, `--parent-ticket`, `--due-date`, and the
relation flags (`--blocks`/`--blocked-by`/`--relates-to`/`--duplicate-of`) — set them at creation time
instead of a wasteful second `update`. Run `linearis issues usage` for the full list.

### Update a ticket

```bash
linearis issues update ENG-123 --status "In Progress"
linearis issues update ENG-123 --priority 1
linearis issues update ENG-123 --labels "bug" --label-mode add
linearis issues update ENG-123 --project "Project Name"
linearis issues update ENG-123 --project-milestone "Milestone Name"
```

`update` also supports relation flags (`--blocks`/`--blocked-by`/`--relates-to`/`--duplicate-of`/
`--remove-relation`) and clearers (`--clear-parent-ticket`/`--clear-cycle`/`--clear-estimate`/
`--clear-due-date`/`--clear-project-milestone`/`--clear-labels`). See `linearis issues usage`.

### Comment on a ticket

Commenting is a **thread model** under `issues` (the old flat `comments` domain is a deprecated
compatibility facade as of v2026.4.x — `linearis comments --help` itself says "prefer the `issues`
discussion commands").

```bash
# Start a comment / discussion thread (this is the one to use)
linearis issues discuss ENG-123 --body "Starting work on this"

# List root threads on a ticket (use BEFORE re-posting a mirror comment, to avoid dups)
linearis issues discussions ENG-123

# Reply to a thread — <thread> MUST be a root thread ID (from discuss/discussions), NOT ENG-123
linearis issues reply <thread-id> --body "follow-up"
linearis issues replies <thread-id>                # list replies in a thread

# Edit / delete (split verbs in the modern path)
linearis issues edit <comment-id> --body "..."     # edit a root or reply comment
linearis issues edit-reply <reply-id> --body "..."
linearis issues delete-comment <comment-id>
linearis issues delete-reply <reply-id>
```

Both `issues discuss` and `issues discussions` accept either a UUID or an `ABC-123` identifier — no
UUID-resolution dance needed for commenting. `comments create` still works but is deprecated and loses
nested-reply support — don't teach it as canonical.

**Common mistakes:**

```bash
linearis issues get ENG-123             # ❌ no 'get' — use 'read'
linearis issue view ENG-123             # ❌ no 'view' — use 'read'
linearis issues comment ENG-123 "text"  # ❌ no 'comment' subcommand — use 'issues discuss <id> --body'
linearis comments create ENG-123 ...     # ⚠️ deprecated facade — prefer 'issues discuss'
linearis issues update ENG-123 --state  # ❌ use --status, not --state
linearis project-milestones list        # ❌ renamed to 'milestones' in v2026.4
```

## Workflow: Backlog Grooming

### Get the lay of the land

```bash
# Discover teams and projects
linearis teams list | jq '.nodes[] | {key, name}'
linearis projects list | jq '.nodes[] | {name, status: .status.name, id}'
```

### Pull tickets by project

```bash
# All tickets in a specific project
linearis issues list --project "Auth System" --limit 100

# Tickets in a project, grouped by status (requires --team for --status filter)
linearis issues list --team ENG --project "Auth System" --status "Backlog,Todo" --limit 100
```

### Find orphaned tickets (no project assigned)

```bash
linearis issues list --team ENG --limit 200 | jq '[.nodes[] | select(.project == null)] | length'
linearis issues list --team ENG --limit 200 | jq '.nodes[] | select(.project == null) | {identifier, title, state: .state.name}'
```

### Triage by priority

```bash
# Urgent/high priority tickets
linearis issues list --team ENG --priority 1 --limit 50
linearis issues list --team ENG --priority 2 --limit 50

# Unestimated tickets in a project
linearis issues list --project "Auth System" --limit 100 | jq '.nodes[] | select(.estimate == null) | {identifier, title}'
```

### Find stale tickets

```bash
# Not updated in 30+ days
linearis issues list --team ENG --updated-before 2026-03-13 --status "In Progress" --limit 50
```

### Assign a ticket to a project

```bash
linearis issues update ENG-123 --project "Auth System"
```

## Workflow: Milestone Management

### See milestones for a project

```bash
linearis milestones list --project "Auth System"
```

### Read milestone details (including its issues)

```bash
linearis milestones read "Beta Launch" --project "Auth System"
linearis milestones read "Beta Launch" --project "Auth System" --limit 100
```

### Create a milestone

```bash
linearis milestones create "Beta Launch" --project "Auth System" --target-date 2026-06-15
linearis milestones create "GA Release" --project "Auth System" --description "General availability" --target-date 2026-09-01
```

### Rename or reschedule a milestone

```bash
linearis milestones update "Beta Launch" --project "Auth System" --name "Beta 2.0"
linearis milestones update "Beta Launch" --project "Auth System" --target-date 2026-07-01
```

### Assign tickets to a milestone

```bash
linearis issues update ENG-123 --project-milestone "Beta Launch"

# Clear a milestone assignment
linearis issues update ENG-123 --clear-project-milestone
```

### Audit milestone coverage

```bash
# Tickets in a project with no milestone
linearis issues list --project "Auth System" --limit 100 | jq '.nodes[] | select(.projectMilestone == null) | {identifier, title}'
```

## Workflow: Label Management

### Discover labels

```bash
linearis labels list --team ENG
linearis labels list --team ENG | jq '.nodes[] | {name, color}'
```

### See what a label contains

```bash
linearis issues list --team ENG --label "bug" --limit 100
linearis issues list --team ENG --label "tech-debt" --limit 100
```

### Re-label tickets

```bash
# Add a label (keeps existing labels)
linearis issues update ENG-123 --labels "needs-triage" --label-mode add

# Replace all labels
linearis issues update ENG-123 --labels "bug,P1" --label-mode overwrite

# Remove all labels
linearis issues update ENG-123 --clear-labels
```

## Workflow: Cycle Review

### Get the active cycle

```bash
linearis cycles list --team ENG --active
```

### Read cycle with all issues

```bash
CYCLE=$(linearis cycles list --team ENG --active | jq -r '.nodes[0].name')
linearis cycles read "$CYCLE" --team ENG --limit 100
```

### Summarize cycle progress

```bash
CYCLE=$(linearis cycles list --team ENG --active | jq -r '.nodes[0].name')
linearis cycles read "$CYCLE" --team ENG --limit 100 | jq '
  .issues
  | group_by(.state.name)
  | map({status: .[0].state.name, count: length, tickets: [.[].identifier]})
'
```

### Nearby cycles (for planning)

```bash
# Active cycle plus 2 before and after
linearis cycles list --team ENG --window 2
```

## Workflow: Status Transitions

Status names come from the team's workflow configuration. Use the stateMap in `.catalyst/config.json`
when available, otherwise read a ticket to discover valid status names.

```bash
# Common flow
linearis issues update ENG-123 --status "In Progress"
linearis issues update ENG-123 --status "In Review"
linearis issues update ENG-123 --status "Done"

# With comment
linearis issues update ENG-123 --status "Done"
linearis issues discuss ENG-123 --body "Merged: PR #456"
```

### UUID-based calls (CTL-207)

When `.catalyst/config.json` contains `catalyst.linear.stateIds`, prefer passing the UUID directly
to `--status` instead of the display name. Every linearis resolver short-circuits on UUIDs — zero
resolution API calls. The `linear-transition.sh` helper does this automatically.

```bash
# Resolve and cache UUIDs once (single GraphQL query)
plugins/dev/scripts/resolve-linear-ids.sh

# Then transitions use UUIDs from config — 1 fewer API call per update
plugins/dev/scripts/linear-transition.sh --ticket ENG-123 --transition done
```

### Team-key allowlist cache (CTL-633)

The PR-body guard `lib/linear-pr-skip.sh` optionally filters its output
through a cached snapshot of workspace team keys at
`${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/linear-team-keys.json`. The
cache is **manual** and **fail-open** — when the file is missing, empty,
malformed, or unreadable, the helper does no filtering (fresh installs
behave like today). Populate / refresh it with:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/catalyst"
linearis teams list --json |
  jq '{keys:[.nodes[].key]|sort, fetched_at:(now|todate)}' \
  > "${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/linear-team-keys.json"
```

Re-run after onboarding a new Linear team. The helper is invoked inside
non-interactive `gh pr create` / `gh pr edit` paths — no automatic
refresh is wired in.

## Important Rules

1. **--status NOT --state**: Always `--status` for issue updates (`--state` is not a valid flag)
2. **Commenting = `issues discuss`**: Create a comment with `linearis issues discuss <id> --body`; list
   threads with `issues discussions <id>`. The old `comments create` still works but is a **deprecated
   compatibility facade** — don't use it. There is no `issues comment` subcommand.
3. **milestones NOT project-milestones**: The command was renamed in v2026.4 (old name fails silently)
4. **--status requires --team**: On `issues list`/`search`, `--status` (and `--cycle`) only work with
   `--team`; `--milestone` requires `--project`
5. **--team accepts keys, names, and UUIDs on most commands** (e.g., `--team ENG`). Historically
   `issues create`/`search` required a UUID and keys silently fell back to the default team
   (czottmann/linearis#56) — this could not be reproduced on v2026.4.9 in a single-team workspace, so
   **verify scope** by checking returned identifiers' team prefix when using key-based `--team` on
   create/search in a multi-team workspace.
6. **Quotes for spaces**: `--status "In Progress"` not `--status In Progress`
7. **JSON is the default — no `--json` flag**: every command emits JSON; passing `--json` errors. Pipe
   the bare command to jq. (And append `</dev/null` in loops — see Gotchas.)
8. **Use `linearis <domain> usage`**: When unsure about flags, check usage instead of guessing

## Other domains (not detailed above)

v2026.4.9 also exposes these. **Read-only** subcommands (`list`/`read`/`status`/`download`) are safe;
`create`/`update`/`delete`/`archive`/`upload` **mutate** — don't run them in audits.

- `linearis users list [--active]` — workspace members (id/name/email); resolve assignee/owner UUIDs.
  Note service/OAuth accounts have synthetic emails (`*@oauthapp.linear.app`).
- `linearis attachments list <issue> [--source-type github]` — PR/Slack/link attachments on a ticket.
- `linearis documents list [--project X | --issue ENG-123]` + `documents read <doc>` — project/issue docs
  (`delete` trashes, not hard-delete).
- `linearis initiatives list [--status active] [--with-projects]` + `initiatives read <init>` —
  roadmap grouping above projects (defaults to excluding archived; pass `--include-archived`).
- `linearis files download <url> --output <path>` — fetch an asset from Linear storage.
- `linearis auth status` / `auth login` — verify/refresh the API token (see Gotchas #10).
