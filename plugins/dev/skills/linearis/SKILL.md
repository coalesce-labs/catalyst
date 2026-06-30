---
name: linearis-cli
description:
  Reference for Linearis CLI commands to interact with Linear project management. Use when working
  with Linear tickets, cycles, projects, milestones, or when the user mentions ticket IDs like
  TEAM-123, ENG-456, PROJ-789.
---

# Linearis CLI Reference

> Verified against Linearis v2026.4.9 on 2026-05-31.

**CRITICAL: Always use these exact patterns. Do NOT guess or improvise syntax.**

> ⚠️ **Read the [Gotchas & Traps](#gotchas--traps) section before scripting** — `issues list` silently
> hides Done tickets, `linearis` eats stdin in loops, and there is no `--json` flag. These bite hard.

## Looking Up Syntax

For full flag details, run `linearis usage` (all domains) or `linearis <domain> usage` (one domain).
The `usage` output is authoritative and always current — prefer it over memorizing flags.

```bash
linearis usage                # Full overview of every domain and flag
linearis issues usage         # Just issue operations
linearis milestones usage     # Just milestone operations
linearis cycles usage         # Just cycle operations
```

## Reading Linear

**The read source is decided by whether the local Catalyst Cloud replica is opted in
*and* live — NOT by whether the node has a Cloud key. Writes never change.** The easiest
way to honor this rule is to call **`catalyst-linear read|list|search`** (CTL-1391): it
resolves the source itself and fails open to `linearis`, so you never decide based on
node identity.

### Mode 1 — Direct (default)

When the replica is **not opted in** (`CATALYST_LINEAR_REPLICA` unset/`off` *and* Layer-2
`catalyst.linearReplica.mode` not `on`) **or** no fresh replica file is present, read Linear
**directly**: `linearis issues read|list|search`. There is **no local mirror**. A node that
*has* a Cloud key but has not flipped the replica flag on is in this mode. (The broker's
`filter-state.db` still exists for orchestration fencing and the board UI, but it is **not**
a Linear read path — do not read ticket state from it.)

### Mode 2 — Replica-first (opted in *and* a live replica present)

When the replica is **opted in** (`CATALYST_LINEAR_REPLICA=on` or Layer-2
`catalyst.linearReplica.mode=on`) **and** a fresh local SQLite replica — kept current by
the Cloud change-feed — is present:

- **Read the replica FIRST** and **trust it** as the authoritative local copy.
- Do **NOT** reflexively re-verify against live Linear — that defeats the cache and
  burns the API budget.
- **Evidence-based escalation only.** Fall back to a direct `linearis` read for a
  specific item *only* when you have concrete evidence the replica read is wrong:
  it contradicts something you just directly observed; the replica freshness/staleness
  signal shows it is behind; or a ticket you expect is missing. When you escalate:
  - (a) read that item with a **direct `linearis issues read <ID>`** — a deliberate *live* read
    for ground truth. This is the one case bare `linearis` is correct: `catalyst-linear read`
    would just re-serve the same (suspect) replica row (it has no force-live option), **and**
  - (b) **surface the staleness as an issue** — a stale replica read signals a mirror
    gap (e.g. a missed webhook) worth investigating, not just a one-off retry.

### Writes — always `linearis`, both modes

`create` / `update` / state transitions / `discuss` / estimate / label **always** go
through `linearis`. The replica is **read-only** in both modes.

### How reads resolve

- **Daemon read paths** resolve the mode automatically via the read-source seam (CTL-1390) — callers do not choose.
- **Agent / skill / script ad-hoc reads — MANDATORY:** read Linear **only** through
  **`catalyst-linear read|list|search`** (CTL-1391) — never bare `linearis issues read|list|search`.
  `read` is **replica-first** when opted in *and* fresh — that is the quota win. `list`/`search`
  are **`linearis` passthrough today** (routed through `catalyst-linear` for one uniform rule and a
  future replica-backed list, but they still hit Linear — **no rate-limit relief yet**). The same
  command is correct on every node and fails open to `linearis`; output matches `linearis` JSON plus
  an additive `_meta`. **Three deliberate exceptions still use bare `linearis`:** (1) a **live
  re-verification** of a row you have evidence is stale/wrong (the Mode 2 escalation above —
  `catalyst-linear` can't force a live read); (2) **child-ticket discovery** — the replica has no
  children table, so `catalyst-linear read` returns `children:{nodes:[]}`; fetch children with a
  live `linearis issues read` or a `list`/`search` query; (3) **non-issue domains**
  (`cycles`/`projects`/`milestones`) — `catalyst-linear` is issue-scoped. Writes are always `linearis`.

> **Why mandatory, not "preferred".** Bare `linearis` reads always hit Linear directly and bypass the replica entirely — even on a node that opted in. On the rate-limited worker minis that burns the shared Linear quota and 429s the fleet. `catalyst-linear` is the executable form of the read rule; routing **all** reads through it is what makes "every client reads the replica" actually true. (Writes are unaffected — always `linearis`.)

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

> **Reads run through `catalyst-linear`.** The examples below document the CLI **syntax** — the
> flags carry over verbatim, so **run issue reads via `catalyst-linear read|list|search`** (it
> shares linearis's flags and fails open to linearis). The replica serves the common fields,
> **including `estimate` and `relations`/`inverseRelations` (by type + identifier)**, labels, and
> comments. Stay on bare `linearis` only for the documented gaps — **child tickets** (`children`
> is always `[]`), relation/state/team/cycle **UUIDs or names** (`state.id`, `team.key`,
> `parent.title`, `cycle.name`) — a **live re-verification**, or non-issue domains
> (`cycles`/`projects`/`milestones`). Any `linearis issues read|list|search` shown below is a
> **syntax reference**: run it through `catalyst-linear`.

### Read a ticket

```bash
catalyst-linear read ENG-123        # replica-first; fails open to linearis
```

### Search tickets

```bash
catalyst-linear search "keyword"
catalyst-linear search "auth bug" --team ENG --status "Todo"
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
