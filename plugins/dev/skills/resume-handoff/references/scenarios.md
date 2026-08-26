# Common divergence scenarios, and a worked example

## How the codebase can have diverged from the handoff

- **Clean continuation** — all handoff changes present, no conflicts, clear next steps: proceed with the handoff's recommended actions as-is.
- **Diverged codebase** — some changes missing or modified, new related code landed since the handoff: reconcile the differences, then adapt the plan to the current state.
- **Incomplete handoff work** — tasks still marked `in_progress`: finish those first; you may need to re-understand a partial implementation before continuing it.
- **Stale handoff** — significant time passed, a major refactor happened since: the original approach may no longer apply — re-evaluate strategy rather than following it literally.

## Worked example

```
User: /catalyst-dev:resume-handoff specification/feature/handoffs/handoff-0.md
Assistant: Let me read and analyze that handoff document...

[Reads handoff completely]
[Spawns the three verification tasks from process.md Step 1]
[Waits for completion, reads identified files]

I've analyzed the handoff from [date]. Here's the current situation...

[Presents the Step 2 analysis]

Shall I proceed with implementing the webhook validation fix, or would you like to adjust the
approach?

User: Yes, proceed with the webhook validation
Assistant: [Creates the todo list from Step 3, begins implementation per Step 4]
```
