# Reading, verifying, and planning from a handoff

## Step 1: Read and analyze

1. **Read the handoff document completely** (the Read tool, no `limit`/`offset`) and extract: the Resume contract (stopped at, next step, re-arm, open questions with their defaults, autonomy), task(s) and status, recent changes, learnings, artifacts, action items/next steps, other notes.
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

Present the analysis before doing anything else. Interactive: then get confirmation. Unattended: print the same summary with the last line replaced by `Proceeding with [recommended action 1] (unattended).` and go straight to Step 3.

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

Use TodoWrite: convert the handoff's action items into todos, add anything newly discovered, prioritize by dependency and the handoff's own guidance. Interactive: present the list and confirm before starting. Unattended: present it and start; the first todo is the handoff's `Next step:` from its Resume contract, or its first open action item when an older handoff has no contract.

## Step 4: Begin implementation

Start the first approved task (unattended: the first todo); reference the handoff's learnings and patterns throughout; update todos as work completes; consider writing a new handoff when the session ends (`/catalyst-dev:create-handoff`, with `--unattended` when this run is unattended).

## Guidelines throughout

- **Be thorough**: read the whole handoff first, verify every claimed change, check for regressions, read every referenced artifact.
- **Be interactive when someone is watching**: present findings before acting, get buy-in, allow course corrections.
- **Be decisive when no one is**: in unattended mode a question in your final message is a stall, because nobody will read it until the next reset. Decide, record the decision in one line, and keep going.
- **Leverage the handoff's learnings**: apply its documented patterns, avoid repeating its mistakes, build on what it already solved.
- **Never assume handoff state matches current state** — verify file references, breaking changes, and pattern validity before acting on any of it.

## Unattended mode

ON when any of these hold; interactive otherwise:

- the skill's arguments contain `--unattended`;
- `CATALYST_UNATTENDED=1` is in the environment;
- the run is a pipeline phase: `$CATALYST_TICKET` is set and no interactive user is present;
- the invoking prompt says the session is unattended (for example, an automated context reset).

What changes, and what does not:

1. **Verification does not change.** Read the handoff fully yourself and verify its state with sub-agents exactly as in Step 1. Unattended is not a licence to skip reading.
2. **Every confirmation gate is skipped.** Steps 2 and 3 present and proceed.
3. **Act on the recorded next step**, within the work the handoff already scoped. Do not widen scope because no one is there to object. First check each task in the handoff's `Re-arm:` line (loops, wakeups, monitors, background tasks): verify whether the prior task is still running before you re-arm it. Keep a healthy live task; restart a stopped task only after positively identifying it and confirming it is stopped. If its state is uncertain, investigate before launching another copy.
4. **A decision that would normally go to the human**: take the default the handoff records (`Default if unanswered:` in its Resume contract). With no recorded default, take the most reversible option. State the choice in one line and continue.
5. **A decision only a human can make** (credentials, spend, a product call, overruling a prior human decision): raise it through the ask SOP (the `catalyst-dev:ask` skill) with a default, then proceed on that default or on other unblocked work.
6. **Stop only before an irreversible outward action** (a merge, a deploy, a delete, a message to a person) that the handoff's `Autonomy:` line did not already authorize. Say explicitly which action you stopped before and why; that statement, not a question, ends the turn.
7. **Never end the turn on a question.** If the work is done or blocked, say what was done, what is blocked, and on what.

See [`scenarios.md`](scenarios.md) for what typically diverges and one worked example end to end for each mode.
