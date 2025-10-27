---
description: Create handoff document for passing work to another session
category: workflow
tools: Write, Bash, Read
model: inherit
version: 1.0.0
---

# Create Handoff

## Prerequisites

Before executing, verify all required tools and systems:

```bash
# 1. Validate thoughts system (REQUIRED)
if [[ -f "scripts/validate-thoughts-setup.sh" ]]; then
  ./scripts/validate-thoughts-setup.sh || exit 1
else
  # Inline validation if script not found
  if [[ ! -d "thoughts/shared" ]]; then
    echo "❌ ERROR: Thoughts system not configured"
    echo "Run: ./scripts/humanlayer/init-project.sh . {project-name}"
    exit 1
  fi
fi

# 2. Validate plugin scripts
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-prerequisites.sh" || exit 1
fi
```

## Configuration Note

This command uses ticket references like `PROJ-123`. Replace `PROJ` with your Linear team's ticket
prefix:

- Read from `.claude/config.json` if available
- Otherwise use a generic format like `TICKET-XXX`
- Examples: `ENG-123`, `FEAT-456`, `BUG-789`

You are tasked with writing a handoff document to hand off your work to another agent in a new
session. You will create a handoff document that is thorough, but also **concise**. The goal is to
compact and summarize your context without losing any of the key details of what you're working on.

## Process

### 1. Filepath & Metadata

Use the following information to understand how to create your document: - create your file under
`thoughts/shared/handoffs/PROJ-XXX/YYYY-MM-DD_HH-MM-SS_description.md`, where: - YYYY-MM-DD is
today's date - HH-MM-SS is the hours, minutes and seconds based on the current time, in 24-hour
format (i.e. use `13:00` for `1:00 pm`) - PROJ-XXX is the ticket number directory (replace with
`general` if no ticket) - description is a brief kebab-case description (optionally including ticket
number) - Get current git information for metadata (branch, commit, repository name) using git
commands - Examples: - With ticket:
`thoughts/shared/handoffs/PROJ-123/2025-01-08_13-55-22_PROJ-123_auth-feature.md` - Without ticket:
`thoughts/shared/handoffs/general/2025-01-08_13-55-22_refactor-api.md`

### 2. Handoff writing.

using the above conventions, write your document. use the defined filepath, and the following YAML
frontmatter pattern. Use the metadata gathered in step 1, Structure the document with YAML
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
type: implementation_strategy
---

# Handoff: {TICKET or General} - {very concise description}

## Task(s)

{description of the task(s) that you were working on, along with the status of each (completed, work
in progress, planned/discussed). If you are working on an implementation plan, make sure to call out
which phase you are on. Make sure to reference the plan document and/or research document(s) you are
working from that were provided to you at the beginning of the session, if applicable.}

## Critical References

{List any critical specification documents, architectural decisions, or design docs that must be
followed. Include only 2-3 most important file paths. Leave blank if none.}

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
where relevant documents are, or other important things you leanrned that you want to pass on but
that don't fall into the above categories}
```

---

### 3. Approve and Sync

Ask the user to review and approve the document. if they request any changes, you should make them
and ask for approval again. Once the user approves the documents, you should run
`humanlayer thoughts sync` to save the document.

### Track in Workflow Context

After saving the handoff document, add it to workflow context:

```bash
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add handoffs "$HANDOFF_FILE" "${TICKET_ID:-null}"
fi
```

Once this is completed, you should respond to the user with the template between
<template_response></template_response> XML tags. do NOT include the tags in your response.

<template_response> Handoff created and synced! You can resume from this handoff in a new session
with the following command:

```bash
/resume_handoff path/to/handoff.md
```

</template_response>

for example (between <example_response></example_response> XML tags - do NOT include these tags in
your actual response to the user)

<example_response> Handoff created and synced! You can resume from this handoff in a new session
with the following command:

```bash
/resume_handoff thoughts/shared/handoffs/PROJ-123/2025-01-08_13-44-55_PROJ-123_create-context-compaction.md
```

</example_response>

---

##. Additional Notes & Instructions

- **more information, not less**. This is a guideline that defines the minimum of what a handoff
  should be. Always feel free to include more information if necessary.
- **be thorough and precise**. include both top-level objectives, and lower-level details as
  necessary.
- **avoid excessive code snippets**. While a brief snippet to describe some key change is important,
  avoid large code blocks or diffs; do not include one unless it's absolutely necessary. Prefer
  using `/path/to/file.ext:line` references that an agent can follow later when it's ready, e.g.
  `packages/dashboard/src/app/dashboard/page.tsx:12-24`
