# Core operations — full syntax

Full CRUD and comment-thread commands behind `SKILL.md` → "Core Operations". Run `linearis usage` / `linearis <domain> usage` for the authoritative, always-current flag list — prefer it to memorizing.

## Search tickets

```bash
linearis issues search "keyword"
linearis issues search "auth bug" --team ENG --status "Todo"
```

## Create a ticket

```bash
linearis issues create "Title" --team ENG
linearis issues create "Title" --team ENG --description "Details" --priority 2 --project "Project"
```

`create` also accepts `--status`, `--cycle`, `--estimate`, `--parent-ticket`, `--due-date`, and the relation flags (`--blocks`/`--blocked-by`/`--relates-to`/`--duplicate-of`) — set them at creation time instead of a wasteful second `update`.

## Update a ticket

```bash
linearis issues update ENG-123 --status "In Progress"
linearis issues update ENG-123 --priority 1
linearis issues update ENG-123 --labels "bug" --label-mode add
linearis issues update ENG-123 --project "Project Name"
linearis issues update ENG-123 --project-milestone "Milestone Name"
```

`update` also supports relation flags (`--blocks`/`--blocked-by`/`--relates-to`/`--duplicate-of`/`--remove-relation`) and clearers (`--clear-parent-ticket`/`--clear-cycle`/`--clear-estimate`/`--clear-due-date`/`--clear-project-milestone`/`--clear-labels`).

## Comment on a ticket — full command set

Commenting is a **thread model** under `issues` (the old flat `comments` domain is a deprecated compatibility facade as of v2026.4.x). Both `issues discuss` and `issues discussions` accept either a UUID or an `ABC-123` identifier.

```bash
# An AGENT starting a comment/discussion thread — go through linear-reply.mjs, NOT `discuss`
# (SKILL.md's ⛔ callout — `discuss` posts under the human's own identity):
direnv exec . node "$CLAUDE_PLUGIN_ROOT/scripts/linear-reply.mjs" ENG-123 --as <AGENT> --body-file <path> --top

# `linearis issues discuss` — ONLY when the comment is genuinely meant to be the human's own:
linearis issues discuss ENG-123 --body "Starting work on this"

# List root threads on a ticket (use BEFORE re-posting a mirror comment, to avoid dups)
linearis issues discussions ENG-123

# Reply to a thread — <thread> MUST be a root thread ID (from discuss/discussions), NOT ENG-123.
# An agent's reply still goes through linear-reply.mjs --parent <thread-id>, not `issues reply`
# (same identity risk as `discuss` — `issues reply` also posts under the personal token).
linearis issues reply <thread-id> --body "follow-up"
linearis issues replies <thread-id>                # list replies in a thread

# Edit / delete (split verbs in the modern path)
linearis issues edit <comment-id> --body "..."     # edit a root or reply comment
linearis issues edit-reply <reply-id> --body "..."
linearis issues delete-comment <comment-id>
linearis issues delete-reply <reply-id>
```

`comments create` still works but is deprecated and loses nested-reply support — don't teach it as canonical. See the `catalyst-dev:ask` skill for the ask/decision-ticket SOP and `scripts/ask.mjs` for its `create`/`accept` verbs (CTL-1922).

## Common mistakes

```bash
linearis issues get ENG-123             # ❌ no 'get' — use 'read'
linearis issue view ENG-123             # ❌ no 'view' — use 'read'
linearis issues comment ENG-123 "text"  # ❌ no 'comment' subcommand — use 'issues discuss <id> --body'
linearis comments create ENG-123 ...     # ⚠️ deprecated facade — prefer 'issues discuss'
linearis issues update ENG-123 --state  # ❌ use --status, not --state
linearis project-milestones list        # ❌ renamed to 'milestones' in v2026.4
```

## Other domains (not detailed above)

v2026.4.9 also exposes these. **Read-only** subcommands (`list`/`read`/`status`/`download`) are safe; `create`/`update`/`delete`/`archive`/`upload` **mutate** — don't run them in audits.

- `linearis users list [--active]` — workspace members (id/name/email); resolve assignee/owner UUIDs. Note service/OAuth accounts have synthetic emails (`*@oauthapp.linear.app`).
- `linearis attachments list <issue> [--source-type github]` — PR/Slack/link attachments.
- `linearis documents list [--project X | --issue ENG-123]` + `documents read <doc>` — project/issue docs (`delete` trashes, not hard-delete).
- `linearis initiatives list [--status active] [--with-projects]` + `initiatives read <init>` — roadmap grouping above projects (defaults to excluding archived; pass `--include-archived`).
- `linearis files download <url> --output <path>` — fetch an asset from Linear storage.
- `linearis auth status` / `auth login` — verify/refresh the API token.
