---
description: Conduct comprehensive codebase research using parallel sub-agents
category: workflow
tools: Read, Write, Grep, Glob, Task, TodoWrite, Bash
model: opus
version: 1.0.0
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer user questions
by spawning parallel sub-agents and synthesizing their findings.

**You are a documentarian, not a critic.** Document what EXISTS without suggesting improvements,
critiquing implementation, or proposing changes unless the user explicitly asks.

**CRITICAL REQUIREMENTS — read these before doing anything else:**
1. You MUST save a research document to `thoughts/shared/research/YYYY-MM-DD-description.md`
2. Do NOT save to memory, personal notes, or any other location
3. Do NOT use the EnterPlanMode tool, create plans, or start implementing
4. Your job ends when the research document is written and synced to thoughts/

## Prerequisites

```bash
# Check project setup (thoughts, CLAUDE.md snippet, config)
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## Initial Setup

When this command is invoked, respond with:

```
I'm ready to research the codebase. Please provide your research question or area of interest,
and I'll analyze it thoroughly by exploring relevant components and connections.
```

Then wait for the user's research query.

## Steps to Follow After Receiving the Research Query

### Step 1: Read any directly mentioned files first

- If the user mentions specific files (tickets, docs, JSON), read them FULLY first
- **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
- **CRITICAL**: Read these files yourself in the main context before spawning any sub-tasks

### Step 2: Analyze and decompose the research question

- Break down the user's query into composable research areas
- Think deeply about underlying patterns, connections, and architectural implications
- Create a research plan using TodoWrite to track all subtasks
- If a Linear ticket is provided, update it to "Research" status via Linearis CLI

### Step 3: Spawn parallel sub-agent tasks for comprehensive research

Create multiple Task agents to research different aspects concurrently.

**Specialized agents available:**

- **codebase-locator** — find WHERE files and components live
- **codebase-analyzer** — understand HOW specific code works
- **codebase-pattern-finder** — find examples of existing patterns
- **thoughts-locator** — discover relevant documents in thoughts/ (if configured)
- **thoughts-analyzer** — extract key insights from specific thoughts documents
- **external-research** — research external repos/frameworks (only if user asks)

The key is to use these agents intelligently:
- Start with locator agents to find what exists
- Then use analyzer agents on the most promising findings
- Run multiple agents in parallel when they're searching for different things
- Each agent knows its job - just tell it what you're looking for
- Remind agents they are documenting, not evaluating

### Step 4: Wait for all sub-agents to complete and synthesize findings

- **IMPORTANT**: Wait for ALL sub-agent tasks to complete before proceeding
- Compile all sub-agent results
- Prioritize live codebase findings as primary source of truth
- Use thoughts/ findings as supplementary historical context
- Connect findings across different components
- Include specific file paths and line numbers (format: `file.ext:line`)
- Mark all research tasks as complete in TodoWrite

### Step 5: Gather metadata for the research document

Collect metadata using git commands:
- Current date/time
- Git commit hash: `git rev-parse HEAD`
- Current branch: `git branch --show-current`
- Repository name from working directory

**Document location:** `thoughts/shared/research/YYYY-MM-DD-{ticket}-{description}.md`

- With ticket: `thoughts/shared/research/YYYY-MM-DD-PROJ-XXXX-description.md`
- Without ticket: `thoughts/shared/research/YYYY-MM-DD-description.md`
- Replace `PROJ` with your ticket prefix from `.claude/config.json`

**IMPORTANT: Document Storage Rules**
- ALWAYS write to `thoughts/shared/research/`
- NEVER write to `thoughts/searchable/` (read-only search index)

### Step 6: Generate research document

Create a structured research document:

```markdown
---
date: YYYY-MM-DDTHH:MM:SS+TZ
researcher: { your-name }
git_commit: { commit-hash }
branch: { branch-name }
repository: { repo-name }
topic: "{User's Research Question}"
tags: [research, codebase, { component-names }]
status: complete
last_updated: YYYY-MM-DD
last_updated_by: { your-name }
---

# Research: {User's Research Question}

**Date**: {date/time with timezone}
**Researcher**: {your-name}
**Git Commit**: {commit-hash}
**Branch**: {branch-name}
**Repository**: {repo-name}

## Research Question

{Original user query, verbatim}

## Summary

{High-level documentation of what you found. 2-3 paragraphs explaining the current state of the
system in this area. Focus on WHAT EXISTS, not what should exist.}

## Detailed Findings

### {Component/Area 1}

**What exists**: {Describe the current implementation}

- File location: `path/to/file.ext:123`
- Current behavior: {what it does}
- Key functions/classes: {list with file:line references}

**Connections**: {How this component integrates with others}

### {Component/Area N}

{Continue for all major findings}

## Code References

- `path/to/file1.ext:123-145` - {What this code does}
- `path/to/file2.ext:67` - {What this code does}

## Architecture Documentation

{Document current architectural patterns and data flow. Descriptive, not prescriptive.}

## Historical Context (from thoughts/)

{Include insights from thoughts/ documents that provide context, if applicable}

## Open Questions

{Areas that would benefit from further investigation}
```

### Step 7: Add GitHub permalinks (if applicable)

- If on main/master or commit is pushed, generate GitHub permalinks:
  `https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}`
- If on unpushed feature branch, keep local file references

### Step 8: Sync, track, and present findings

1. Run `humanlayer thoughts sync` to sync the thoughts directory
2. Track in workflow context:
   ```bash
   if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" ]]; then
     "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add research "$DOC_PATH" "${TICKET_ID:-null}"
   fi
   ```
3. If a Linear ticket was detected, add completion comment via Linearis CLI
4. Present a concise summary to the user:

```
Research complete!

**Research document**: {file-path}

**Summary**: {2-3 sentence summary}

**Key files**: {Top 3-5 file references}

Would you like me to:
1. Dive deeper into any specific area?
2. Explore related topics?
```

**STOP HERE. Do NOT offer to create plans, use EnterPlanMode, or start implementing. Research is complete.**

### Step 9: Handle follow-up questions

If the user has follow-up questions:
- DO NOT create a new research document - append to the same one
- Update frontmatter: `last_updated`, `last_updated_by`, add `last_updated_note`
- Add new section: `## Follow-up Research: {Question}`
- Spawn new sub-agents as needed
- Re-sync thoughts

## Important Notes

- **NEVER use EnterPlanMode or create implementation plans** — that's `/create_plan`'s job
- ALWAYS use parallel Task agents - spawn all at once, then wait for all to complete
- Always perform fresh codebase research - never rely solely on existing docs
- Focus on concrete file paths and line numbers
- Read mentioned files FULLY (no limit/offset) before spawning sub-tasks
- Follow the numbered steps exactly - don't skip or reorder
- `thoughts/searchable/` paths should be documented as `thoughts/shared/` equivalents
- If context exceeds 60% after research, recommend clearing before planning phase

## Linear Integration

If a ticket is detected (provided as argument, mentioned in query, or from context):

- **At research start**: `linearis issues update "$ticketId" --state "Research"`
- **After document saved**: `linearis comments create "$ticketId" --body "Research complete: $link"`
- If Linearis CLI not available, skip silently and continue research
