# Reading, verifying, and planning from a handoff

## Step 1: Read and analyze

1. **Read the handoff document completely** — the Read tool, no `limit`/`offset` — and extract: task(s) and status, recent changes, learnings, artifacts, action items/next steps, other notes.
2. **Spawn parallel research tasks to verify current state** (do NOT use sub-agents for the handoff itself — only for this verification):

   ```
   Task 1 - Verify recent changes:
   Check the files in "Recent changes" still show the described state; look for later
   modifications, conflicts, or regressions. Tools: Read, Grep, Glob.
   Return: current state with file:line references.

   Task 2 - Validate codebase state against "Learnings":
   Verify the patterns/implementations described in "Learnings" still exist; look for breaking
   changes or new related code since the handoff. Tools: Read, Grep, Glob.
   Return: validation results and any discrepancies.

   Task 3 - Gather artifact context:
   Read every artifact the handoff lists (feature docs, plans, research). Tools: Read.
   Return: summary of contents and key decisions.
   ```

3. **Wait for all three tasks**, then read the critical files they identified in full.

## Step 2: Synthesize and present

Present the analysis before doing anything else, then get confirmation:

```
I've analyzed the handoff from [date] by [researcher]. Here's the current situation:

**Original Tasks:** [task]: [handoff status] → [current verification]
**Key Learnings Validated:** [learning, file:line] - [still valid / changed]
**Recent Changes Status:** [change] - [present / missing / modified]
**Artifacts Reviewed:** [document]: [key takeaway]
**Recommended Next Actions:** 1. [next step]  2. [second priority]
**Potential Issues Identified:** [conflicts, regressions, missing dependencies]

Shall I proceed with [recommended action 1], or would you like to adjust the approach?
```

## Step 3: Create the action plan

Use TodoWrite: convert the handoff's action items into todos, add anything newly discovered, prioritize by dependency and the handoff's own guidance. Present the list and confirm before starting.

## Step 4: Begin implementation

Start the first approved task; reference the handoff's learnings and patterns throughout; update todos as work completes; consider writing a new handoff when the session ends (`/catalyst-dev:create-handoff`).

## Guidelines throughout

- **Be thorough**: read the whole handoff first, verify every claimed change, check for regressions, read every referenced artifact.
- **Be interactive**: present findings before acting, get buy-in, allow course corrections.
- **Leverage the handoff's learnings**: apply its documented patterns, avoid repeating its mistakes, build on what it already solved.
- **Never assume handoff state matches current state** — verify file references, breaking changes, and pattern validity before acting on any of it.

See [`scenarios.md`](scenarios.md) for what typically diverges and one worked example end to end.
