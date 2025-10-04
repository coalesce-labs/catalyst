---
description: Conduct comprehensive codebase research using parallel sub-agents
category: workflow
tools: Read, Write, Grep, Glob, Task, TodoWrite, Bash
model: inherit
version: 1.0.0
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer user questions by spawning parallel sub-agents and synthesizing their findings.

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY
- DO NOT suggest improvements or changes unless the user explicitly asks for them
- DO NOT perform root cause analysis unless the user explicitly asks for them
- DO NOT propose future enhancements unless the user explicitly asks for them
- DO NOT critique the implementation or identify problems
- DO NOT recommend refactoring, optimization, or architectural changes
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Initial Setup

When this command is invoked, respond with:
```
I'm ready to research the codebase. Please provide your research question or area of interest, and I'll analyze it thoroughly by exploring relevant components and connections.
```

Then wait for the user's research query.

## Steps to Follow After Receiving the Research Query

### Step 1: Read Any Directly Mentioned Files First

- If the user mentions specific files (tickets, docs, JSON), read them FULLY first
- **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
- **CRITICAL**: Read these files yourself in the main context before spawning any sub-tasks
- This ensures you have full context before decomposing the research

### Step 2: Analyze and Decompose the Research Question

- Break down the user's query into composable research areas
- Take time to think deeply about the underlying patterns, connections, and architectural implications the user might be seeking
- Identify specific components, patterns, or concepts to investigate
- Create a research plan using TodoWrite to track all subtasks
- Consider which directories, files, or architectural patterns are relevant

### Step 3: Spawn Parallel Sub-Agent Tasks for Comprehensive Research

Create multiple Task agents to research different aspects concurrently.

We have specialized agents that know how to do specific research tasks:

**For codebase research:**
- Use the **codebase-locator** agent to find WHERE files and components live
- Use the **codebase-analyzer** agent to understand HOW specific code works (without critiquing it)
- Use the **codebase-pattern-finder** agent to find examples of existing patterns (without evaluating them)

**IMPORTANT**: All agents are documentarians, not critics. They will describe what exists without suggesting improvements or identifying issues.

**For thoughts directory (if using thoughts system):**
- Use the **thoughts-locator** agent to discover what documents exist about the topic
- Use the **thoughts-analyzer** agent to extract key insights from specific documents (only the most relevant ones)

**For external research (only if user explicitly asks):**
- Use the **external-research** agent for external documentation and resources
- IF you use external research agents, instruct them to return LINKS with their findings, and INCLUDE those links in your final report

**For Linear tickets (if relevant):**
- Use the **linear-ticket-reader** agent to get full details of a specific ticket (if Linear MCP available)
- Use the **linear-searcher** agent to find related tickets or historical context

The key is to use these agents intelligently:
- Start with locator agents to find what exists
- Then use analyzer agents on the most promising findings to document how they work
- Run multiple agents in parallel when they're searching for different things
- Each agent knows its job - just tell it what you're looking for
- Don't write detailed prompts about HOW to search - the agents already know
- Remind agents they are documenting, not evaluating or improving

**Example of spawning parallel research tasks:**

```
I'm going to spawn 3 parallel research tasks:

Task 1 - Find WHERE components live:
"Use codebase-locator to find all files related to [topic]. Focus on [specific directories if known]."

Task 2 - Understand HOW it works:
"Use codebase-analyzer to analyze [specific component] and document how it currently works. Include data flow and key integration points."

Task 3 - Find existing patterns:
"Use codebase-pattern-finder to find similar implementations of [pattern] in the codebase. Show concrete examples."
```

### Step 4: Wait for All Sub-Agents to Complete and Synthesize Findings

- **IMPORTANT**: Wait for ALL sub-agent tasks to complete before proceeding
- Compile all sub-agent results (both codebase and thoughts findings if applicable)
- Prioritize live codebase findings as primary source of truth
- Use thoughts/ findings as supplementary historical context (if thoughts system is used)
- Connect findings across different components
- Document specific file paths and line numbers (format: `file.ext:line`)
- Explain how components interact with each other
- Include temporal context where relevant (e.g., "This was added in commit abc123")
- Mark all research tasks as complete in TodoWrite

### Step 5: Gather Metadata for the Research Document

Collect metadata for the research document:

**If using thoughts system with metadata script:**
- Run `hack/spec_metadata.sh` or equivalent to generate metadata
- Metadata includes: date, researcher, git commit, branch, repository

**If using simple approach:**
- Get current date/time
- Get git commit hash: `git rev-parse HEAD`
- Get current branch: `git branch --show-current`
- Get repository name from `.git/config` or working directory

**Filename format:**
- With ticket: `thoughts/shared/research/YYYY-MM-DD-PROJ-XXX-description.md`
- Without ticket: `thoughts/shared/research/YYYY-MM-DD-description.md`
- Alternative: `research/YYYY-MM-DD-description.md` (if not using thoughts system)

Replace `PROJ` with your ticket prefix from `.claude/config.json`.

### Step 6: Generate Research Document

Create a structured research document with the following format:

```markdown
---
date: YYYY-MM-DDTHH:MM:SS+TZ
researcher: {your-name}
git_commit: {commit-hash}
branch: {branch-name}
repository: {repo-name}
topic: "{User's Research Question}"
tags: [research, codebase, {component-names}]
status: complete
last_updated: YYYY-MM-DD
last_updated_by: {your-name}
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

{High-level documentation of what you found. 2-3 paragraphs explaining the current state of the system in this area. Focus on WHAT EXISTS, not what should exist.}

## Detailed Findings

### {Component/Area 1}

**What exists**: {Describe the current implementation}
- File location: `path/to/file.ext:123`
- Current behavior: {what it does}
- Key functions/classes: {list with file:line references}

**Connections**: {How this component integrates with others}
- Calls: `other-component.ts:45` - {description}
- Used by: `consumer.ts:67` - {description}

**Implementation details**: {Technical specifics without evaluation}

### {Component/Area 2}

{Same structure as above}

### {Component/Area N}

{Continue for all major findings}

## Code References

Quick reference of key files and their roles:

- `path/to/file1.ext:123-145` - {What this code does}
- `path/to/file2.ext:67` - {What this code does}
- `path/to/file3.ext:200-250` - {What this code does}

## Architecture Documentation

{Document the current architectural patterns, conventions, and design decisions observed in the code. This is descriptive, not prescriptive.}

### Current Patterns

- **Pattern 1**: {How it's implemented in the codebase}
- **Pattern 2**: {How it's implemented in the codebase}

### Data Flow

{Document how data moves through the system in this area}

```
Component A → Component B → Component C
{Describe what happens at each step}
```

### Key Integrations

{Document how different parts of the system connect}

## Historical Context (from thoughts/)

{ONLY if using thoughts system}

{Include insights from thoughts/ documents that provide context}

- `thoughts/shared/research/previous-doc.md` - {Key decision or insight}
- `thoughts/shared/plans/plan-123.md` - {Related implementation detail}

## Related Research

{Links to other research documents that touch on related topics}

- `research/YYYY-MM-DD-related-topic.md` - {How it relates}

## Open Questions

{Areas that would benefit from further investigation - NOT problems to fix, just areas where understanding could be deepened}

- {Question 1}
- {Question 2}
```

### Step 7: Add GitHub Permalinks (If Applicable)

**If you're on the main/master branch OR if the commit is pushed:**

Generate GitHub permalinks and replace file references:

```
https://github.com/{owner}/{repo}/blob/{commit-hash}/{file-path}#L{line}
```

For line ranges:
```
https://github.com/{owner}/{repo}/blob/{commit-hash}/{file-path}#L{start}-L{end}
```

**If working on a feature branch that's not pushed yet:**
- Keep local file references: `path/to/file.ext:line`
- Add note: "GitHub permalinks will be added once this branch is pushed"

### Step 8: Sync and Present Findings

**If using thoughts system:**
- Run `humanlayer thoughts sync` to sync the thoughts directory
- This updates symlinks, creates searchable index, and commits to thoughts repo

**If using simple approach:**
- Just save the file to your research directory
- Optionally commit to git

**Present to user:**

```markdown
✅ Research complete!

**Research document**: {file-path}

## Summary

{2-3 sentence summary of key findings}

## Key Files

{Top 3-5 most important file references}

## What I Found

{Brief overview - save details for the document}

---

Would you like me to:
1. Dive deeper into any specific area?
2. Create an implementation plan based on this research?
3. Explore related topics?
```

### Step 9: Handle Follow-Up Questions

If the user has follow-up questions:

1. **DO NOT create a new research document** - append to the same one
2. **Update frontmatter fields:**
   - `last_updated`: {new date}
   - `last_updated_by`: {your name}
   - Add `last_updated_note`: "{Brief note about what was added}"

3. **Add new section to existing document:**

```markdown
---

## Follow-up Research: {Follow-up Question}

**Date**: {date}
**Updated by**: {your-name}

### Additional Findings

{New research results using same structure as above}
```

4. **Spawn new sub-agents as needed** for the follow-up research
5. **Re-sync** (if using thoughts system)

## Important Notes

### Parallel Execution
- ALWAYS use parallel Task agents for efficiency
- Don't wait for one agent to finish before spawning the next
- Spawn all research tasks at once, then wait for all to complete

### Research Philosophy
- Always perform fresh codebase research - never rely solely on existing docs
- The `thoughts/` directory (if used) provides historical context, not primary source
- Focus on concrete file paths and line numbers - make it easy to navigate
- Research documents should be self-contained and understandable months later

### Sub-Agent Prompts
- Be specific about what to search for
- Specify directories to focus on when known
- Make prompts focused on read-only documentation
- Remind agents they are documentarians, not critics

### Cross-Component Understanding
- Document how components interact, not just what they do individually
- Trace data flow across boundaries
- Note integration points and dependencies

### Temporal Context
- Include when things were added/changed if relevant
- Note deprecated patterns still in the codebase
- Don't judge - just document the timeline

### GitHub Links
- Use permalinks for permanent references
- Include line numbers for precision
- Link to specific commits, not branches (branches move)

### Main Agent Role
- Your role is synthesis, not deep file reading
- Let sub-agents do the detailed reading
- You orchestrate, compile, and connect their findings
- Focus on the big picture and cross-component connections

### Documentation Style
- Sub-agents document examples and usage patterns as they exist
- Main agent synthesizes into coherent narrative
- Both levels: documentarian, not evaluator
- Never recommend changes or improvements unless explicitly asked

### File Reading Rules
- ALWAYS read mentioned files fully before spawning sub-tasks
- Use Read tool WITHOUT limit/offset for complete files
- This is critical for proper decomposition

### Follow the Steps
- These numbered steps are not suggestions - follow them exactly
- Don't skip steps or reorder them
- Each step builds on the previous ones

### Thoughts Directory Handling

**If using thoughts system:**
- `thoughts/searchable/` is a special directory - paths found there should be documented as their actual location
- Example: `thoughts/searchable/allison/notes.md` → document as `thoughts/allison/notes.md`
- Don't change directory names (keep `allison/`, don't change to `shared/`)

**If NOT using thoughts system:**
- Skip thoughts-related agents
- Skip thoughts sync commands
- Save research docs to `research/` directory in workspace root

### Frontmatter Consistency
- Always include complete frontmatter as shown in template
- Use ISO 8601 dates with timezone
- Keep tags consistent across research documents
- Update `last_updated` fields when appending follow-ups

## Integration with Other Commands

This command integrates with the complete development workflow:

```
/research-codebase → research document
                  ↓
           /create-plan → implementation plan
                  ↓
          /implement-plan → code changes
                  ↓
              /validate → tests & verification
```

**How it connects:**

- **research_codebase → create_plan**: Research findings provide foundation for planning. The create_plan command can reference research documents in its "References" section.

- **Research before planning**: Always research the codebase first to understand what exists before planning changes.

- **Shared agents**: Both research_codebase and create_plan use the same specialized agents (codebase-locator, codebase-analyzer, codebase-pattern-finder).

- **Documentation persistence**: Research documents serve as permanent reference for future work.

## Example Workflow

```bash
# User starts research
/research-codebase

# You respond with initial prompt
# User asks: "How does authentication work in the API?"

# You execute:
# 1. Read any mentioned files fully
# 2. Decompose into research areas (auth middleware, token validation, session management)
# 3. Spawn parallel agents:
#    - codebase-locator: Find auth-related files
#    - codebase-analyzer: Understand auth middleware implementation
#    - codebase-pattern-finder: Find auth usage patterns
#    - thoughts-locator: Find previous auth discussions (if using thoughts)
# 4. Wait for all agents
# 5. Synthesize findings
# 6. Generate research document at research/2025-01-08-authentication-system.md
# 7. Present summary to user

# User follows up: "How does it integrate with the database?"
# You append to same document with new findings
```

## Adaptation Notes

This command is adapted from HumanLayer's research_codebase command. Key differences for portability:

- **Thoughts system**: Made optional - can use simple `research/` directory
- **Metadata script**: Made optional - can generate metadata inline
- **Ticket prefixes**: Read from `.claude/config.json` or use PROJ- placeholder
- **Linear integration**: Made optional - only used if Linear MCP available
- **Web research**: Uses `external-research` agent instead of `web-search-researcher`

The core workflow and philosophy remain the same: parallel sub-agents, documentarian mindset, and structured output.
