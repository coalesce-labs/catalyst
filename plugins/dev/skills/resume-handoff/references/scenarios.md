# Common divergence scenarios, and a worked example

## How the codebase can have diverged from the handoff

- **Clean continuation** — all handoff changes present, no conflicts, clear next steps: proceed with the handoff's recommended actions as-is.
- **Diverged codebase** — some changes missing or modified, new related code landed since the handoff: reconcile the differences, then adapt the plan to the current state.
- **Incomplete handoff work** — tasks still marked `in_progress`: finish those first; you may need to re-understand a partial implementation before continuing it.
- **Stale handoff** — significant time passed, a major refactor happened since: the original approach may no longer apply — re-evaluate strategy rather than following it literally.

## Worked example: interactive

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

## Worked example: unattended

An automated context reset starts a fresh session with no one watching. The handoff's Resume contract reads `Next step: run the contract tests, then open the PR`, one open question carries `Default if unanswered: defer the P3 finding to a follow-up ticket`, and `Autonomy:` authorizes opening the PR but not merging it.

```
Prompt: /catalyst-dev:resume-handoff --unattended thoughts/shared/handoffs/PROJ-123/2025-01-08_13-55-22_auth-feature.md
Assistant: [Reads the handoff completely, runs the three verification tasks, reads the identified files]

I've analyzed the handoff from [date]. Here's the current situation...
[Presents the Step 2 analysis]
Proceeding with the contract tests, then the PR (unattended).

[Checks whether the CI watch in the Re-arm line is still running; re-arms it only if stopped; creates the todo list; runs the tests]
Open question on the P3 finding: taking the recorded default, deferring it to a follow-up ticket.
[Files the follow-up, opens the PR]

Done: tests pass, PR opened, P3 deferred to a follow-up. Stopped before the merge: the handoff's Autonomy line does not authorize it.
```

The session ends on a statement of what was done and what it stopped before, never on "Shall I proceed?".
