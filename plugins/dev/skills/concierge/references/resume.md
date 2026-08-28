# Boot, restart, hand off

⛔ **Your memory is Linear + the board + the channel + the handoff — never the process.** A turn that produced no artifact did not happen. Write small and often, because you will be restarted mid-thought and the only thing that survives is what you wrote down.

## On boot — and you cannot tell a first boot from a restart by feel

The supervisor tells you which it is (`role-supervisor`). Either way, **reconstruct from artifacts, never from a re-pasted brief** — a re-paste re-does landed work, which is the failure this whole mechanism exists to end.

1. Read your **handoff** if one exists, then the **board** (its stamp tells you how far behind you are).
2. Read the last ~20 **channel turns** for anything addressed to you.
3. Read every **open ask** and every **active scope's status doc**.
4. Read every **human comment** newer than your last reply — those are your SLA clock, and they are the
   one thing that cannot wait for the hourly pass.
5. **Say what you resumed from**, in your first turn: *"resumed from `<artifact>` at `<time>`"*. A role
   that comes back silently is indistinguishable from one that never went down, which makes the restart invisible to everyone debugging the fleet.

> ⚠️ **If a cited handoff file is missing on disk, the channel is authoritative.** Recover from the
> last turn's text; never treat the missing file as lost work. `thoughts/shared` is a *per-project
> symlink*, so a relative citation written in another worktree resolves elsewhere here, and an
> aborted sync leaves the file on the writing host until the next tick — the content is almost
> always still there. A fresh `create-handoff` cites an absolute path and returns a `synced` /
> `local-only` verdict, so it tells you which case you are in (CTL-2104).

## While running

- **Heartbeat is liveness; the status doc is not** (ruling). Never infer one from the other: a role can be
  writing docs and be wedged, or be perfectly alive during a quiet hour.
- Stamp everything from `TZ=America/Chicago date`. Never estimate a time.
- A **529 / overload is not your problem to solve** — the supervisor's jittered backoff owns it. Do not
  build a retry loop inside the role; two retry ladders on the same failure is a storm.

## Hand off

Write the handoff **before** you stop, on: a hard stop, your context or budget threshold, or a scheduled rotation. Use `catalyst-dev:create-handoff`. It must carry:

- the board's current stamp, and anything you knew that had **not** yet reached the board
- every open ask, with age and whether it is irreversible
- every scope whose steward you were about to page, and why
- any grill **in progress** — the questions asked, the answers received, and the recommendations you were
  going to proceed on. ⚠️ **A half-finished grill is the one state that cannot be reconstructed from Linear**, because the questions live in a thread and the reasoning does not.

Then stop. Your successor resumes from those artifacts.
