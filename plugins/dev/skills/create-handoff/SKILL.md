---
name: create-handoff
description:
  "Create handoff document for passing work to another session. **ALWAYS use when** the user says
  'create a handoff', 'hand this off', 'save progress for later', 'I need to stop here', or when
  context usage is high (>60%) during implementation and work needs to continue in a fresh session."
disable-model-invocation: false
allowed-tools: Write, Bash, Read
version: 1.0.0
---

# Create Handoff

## Prerequisites

```bash
# Check project setup (thoughts, CLAUDE.md snippet, config)
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## Configuration Note

This command uses ticket references like `PROJ-123`. Replace `PROJ` with your Linear team's ticket
prefix:

- Read from `.catalyst/config.json` if available
- Otherwise use a generic format like `TICKET-XXX`
- Examples: `ENG-123`, `FEAT-456`, `BUG-789`

You are tasked with writing a handoff document to hand off your work to another agent in a new
session. You will create a handoff document that is thorough, but also **concise**. The goal is to
compact and summarize your context without losing any of the key details of what you're working on.

## Process

### 1. Filepath & Metadata — computed, never composed

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/` (appropriate subdirectory)
- NEVER write to `thoughts/searchable/` — this is a read-only search index

**Do NOT compose the filename yourself.** `thoughts/shared` is a *per-project symlink*: the
same relative path resolves to a different physical subtree depending on which worktree you
are in, and a hand-typed `HH-MM-SS` drifts between the filename, the frontmatter and the
citation. Both produce a path you announce and the next turn cannot find (CTL-2104). Ask the
helper instead — it stamps the time mechanically and resolves the symlink for you:

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/handoff-durability.sh"

# <scope> = the ticket id (e.g. PROJ-123), or `general` when there is no ticket.
# <description> = brief kebab-case description.
HANDOFF_PATHS="$(handoff_resolve_path "<scope>" "<description>")"
HANDOFF_REL="$(printf '%s\n' "$HANDOFF_PATHS" | sed -n '1p')"   # thoughts/shared/handoffs/...
HANDOFF_ABS="$(printf '%s\n' "$HANDOFF_PATHS" | sed -n '2p')"   # /Users/.../repos/<project>/shared/...
printf 'relative: %s\nabsolute: %s\n' "$HANDOFF_REL" "$HANDOFF_ABS"
```

Capture **both** echoed lines. `$HANDOFF_ABS` is the absolute path you will cite; it is the
one form that stays correct no matter which worktree the reader is in.

Get current git information for metadata (branch, commit, repository name) using git commands.
Use the timestamp already embedded in `$HANDOFF_REL` for the frontmatter `date` — do not
generate a second one.

**Examples of what the helper returns:**

- With ticket: `thoughts/shared/handoffs/PROJ-123/2025-01-08_13-55-22_auth-feature.md`
- Without ticket: `thoughts/shared/handoffs/general/2025-01-08_13-55-22_refactor-api.md`

### 2. Handoff writing.

Using the above conventions, write your document **to a temp file** — `handoff_write_verified`
installs it at `$HANDOFF_ABS` in step 3 and proves the bytes landed:

```bash
HANDOFF_TMP="$(mktemp -t handoff-XXXXXX)"   # Write your document content here.
```

Use the following YAML frontmatter pattern. Use the metadata gathered in step 1, Structure the document with YAML
frontmatter followed by content:

Use the following template structure:

```markdown
---
date: [Current date and time with timezone in ISO format]
researcher: [Researcher name from thoughts status]
git_commit: [Current commit hash]
branch: [Current branch name]
repository: [Repository name]
topic: "[Feature/Task Name] Implementation Strategy"
tags: [implementation, strategy, relevant-component-names]
status: complete
last_updated: [Current date in YYYY-MM-DD format]
last_updated_by: [Researcher name]
type: handoff
source_ticket: [TICKET-ID or null]
source_plan: "[[plan-filename]]" # or null
source_research: "[[research-filename]]" # or null
---

# Handoff: {TICKET or General} - {very concise description}

## Task(s)

{description of the task(s) that you were working on, along with the status of each (completed, work
in progress, planned/discussed). If you are working on an implementation plan, make sure to call out
which phase you are on. Reference the plan and/or research documents using wiki-links (e.g.,
[[plan-filename]], [[research-filename]]), if applicable.}

## Critical References

{List any critical specification documents, architectural decisions, or design docs that must be
followed using wiki-links (e.g., [[doc-filename]]). Include only 2-3 most important references.
Leave blank if none.}

## Recent changes

{describe recent changes made to the codebase that you made in line:file syntax}

## Learnings

{describe important things that you learned - e.g. patterns, root causes of bugs, or other important
pieces of information someone that is picking up your work after you should know. consider listing
explicit file paths.}

## Artifacts

{ an exhaustive list of artifacts you produced or updated as filepaths and/or file:line references -
e.g. paths to feature documents, implementation plans, etc that should be read in order to resume
your work.}

## Action Items & Next Steps

{ a list of action items and next steps for the next agent to accomplish based on your tasks and
their statuses}

## Other Notes

{ other notes, references, or useful information - e.g. where relevant sections of the codebase are,
where relevant documents are, or other important things you learned that you want to pass on but
that don't fall into the above categories}
```

---

### 3. Install, sync, and report the durability verdict

Install the content and classify what actually happened. Both commands echo the fact you
will cite — never restate a path or a durability claim from memory:

```bash
# Installs atomically, then RE-READS the destination and byte-compares. Non-zero means the
# handoff is NOT on disk: say so and stop, do not announce a path that does not exist.
HANDOFF_ABS="$(handoff_write_verified "$HANDOFF_ABS" "$HANDOFF_TMP")" || exit 1
rm -f "$HANDOFF_TMP"

# ⚠️ REGISTER THE INSTALL. The `Track Handoff Documents` hook in hooks.toml matches
# `tool_name = "Write"` only, and this install path is Bash — so nothing records the
# handoff for you. `workflow-context.sh recent handoffs` returns the FIRST recorded
# entry and only falls back to the filesystem when there is none, so skipping this
# leaves the next `resume-handoff` auto-discovering an OLDER handoff.
"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add handoffs "$HANDOFF_REL" "<scope>" \
  || echo "warning: could not register the handoff in workflow context (auto-discovery may return an older one)" >&2

# Echoes exactly one verdict token: `synced`, or `local-only:<reason>`.
HANDOFF_VERDICT="$(handoff_sync_and_classify "$HANDOFF_ABS")"
printf 'absolute: %s\nrelative: %s\nverdict: %s\n' "$HANDOFF_ABS" "$HANDOFF_REL" "$HANDOFF_VERDICT"
```

⚠️ **Cite the echoed `$HANDOFF_ABS` verbatim, and do NOT re-type the path or the timestamp
from memory.** A re-typed stamp that differs by one second is a citation that misses a file
which genuinely exists — one of the three causes behind CTL-2104.

## Durability contract

The helper returns a verdict so the caller never has to re-verify a citation by hand. Report
the one you actually got — this section is the guarantee attached to each:

| Verdict                         | What it guarantees                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `synced`                        | Sync exited 0 **and** the bytes are in the thoughts repo's upstream tree. Safe to cite **from any host, now**. |
| `local-only:sync-failed`        | `humanlayer thoughts sync` exited non-zero (typically a rebase conflict).                                 |
| `local-only:not-in-pushed-tree` | Sync exited 0 but the file never reached the pushed tree — the silent-abort case.                         |
| `local-only:sync-unavailable`   | No `humanlayer` on PATH.                                                                                  |
| `local-only:git-unavailable`    | No `git`, or the thoughts tree is not a checkout — durability is unprovable here.                         |

**Every `local-only:*` verdict still means the file is written and verified on disk at
`$HANDOFF_ABS`.** No work is lost, and the path is safe to cite on **this host now**. Do
**not** retry the sync yourself — two retry ladders on one failure is a storm.

⚠️ **The next-tick guarantee applies to `not-in-pushed-tree` only.** That verdict is the
async case: the sync ran, and the following tick (≤300 s) usually carries the bytes up.
`sync-failed`, `sync-unavailable` and `git-unavailable` are **not** waiting on a tick —
an unresolved rebase conflict or missing tooling persists until somebody fixes it, and no
amount of waiting makes the handoff cross-host. Treat those three as **host-local until
something positively verifies the pushed bytes**; say so rather than promising a sync that
may never come.

⚠️ **`$HANDOFF_ABS` is this host's path.** It contains this machine's home and thoughts
checkout location, so it is the unambiguous citation *here* but may not resolve on another
host. Cite **both** forms: the absolute path for same-host use, and `$HANDOFF_REL` — the
`thoughts/shared/...` form — as the portable identity a reader on another host resolves in
their own tree.

Never announce "synced" on a `local-only:*` verdict. An unconditional durability claim is
exactly what made six real files look like phantoms.

Then respond to the user with the template matching your verdict, between
<template_response></template_response> XML tags. Do NOT include the tags in your response.

**When `HANDOFF_VERDICT` is `synced`:**

<template_response> Handoff written, verified, and synced — the pushed bytes are this
handoff. Resume from it in a new session with:

```bash
/catalyst-dev:resume-handoff <the echoed absolute path>
```

On another host, resolve `<the echoed relative path>` in that host's thoughts tree.

</template_response>

**When `HANDOFF_VERDICT` is `local-only:not-in-pushed-tree`** (the async case — a tick may
still carry it up):

<template_response> Handoff written and verified on disk, but **not yet in the pushed tree**
— safe to cite on this host now; cross-host resume follows the next sync tick (≤300 s).
Resume from it with:

```bash
/catalyst-dev:resume-handoff <the echoed absolute path>
```

</template_response>

**When `HANDOFF_VERDICT` is any other `local-only:*`** (`sync-failed`, `sync-unavailable`,
`git-unavailable` — these are **not** waiting on a tick):

<template_response> Handoff written and verified on disk, but **host-local**
(`<the verdict>`) — it is safe to cite on this host now, and it will **not** become
cross-host on its own: this verdict means the sync could not run or could not complete, so
it stays here until that is resolved. Resume from it on this host with:

```bash
/catalyst-dev:resume-handoff <the echoed absolute path>
```

</template_response>

for example (between <example_response></example_response> XML tags — do NOT include these tags
in your actual response to the user)

<example_response> Handoff written, verified, and synced — durable and safe to cite from any
host. Resume from it in a new session with:

```bash
/catalyst-dev:resume-handoff /Users/you/hlt/coalesce-labs/thoughts/repos/my-project/shared/handoffs/PROJ-123/2025-01-08_13-44-55_create-context-compaction.md
```

</example_response>

---

## Additional Notes & Instructions

- **more information, not less**. This is a guideline that defines the minimum of what a handoff
  should be. Always feel free to include more information if necessary.
- **be thorough and precise**. include both top-level objectives, and lower-level details as
  necessary.
- **avoid excessive code snippets**. While a brief snippet to describe some key change is important,
  avoid large code blocks or diffs; do not include one unless it's absolutely necessary. Prefer
  using `/path/to/file.ext:line` references that an agent can follow later when it's ready, e.g.
  `packages/dashboard/src/app/dashboard/page.tsx:12-24`
