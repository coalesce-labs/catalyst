# Booting, resuming, handing off

You are long-running, which really means: **you will be restarted, and you will not know it happened.**
Design every turn for that. Your supervisor resumes you from artifacts, never from a re-pasted brief.

## Why this file exists

On 2026-08-18 a provider `529 Overloaded` killed **seven agent lanes at once**, and again 6–7 lanes an
hour later. Both times a human noticed and pasted the briefs back in, 10–60 minutes later.

⭐ **Nothing that had been WRITTEN was lost. Everything that had only been INTENDED was.** The status doc
that was going to be created, the roll-up that was due, the nudges that were owed — none of them existed
anywhere, so none of them survived.

> **A turn that produced no artifact did not happen.** Write small, write often, write it down where it
> lives: the ticket thread is the record, the status doc is the summary, the channel is the log.

## On boot or restart — read these four, in this order

1. **Your latest handoff** (`thoughts/shared/handoffs/…`) — what the previous session was doing and why.
2. **`Status — <scope>`** — the state as last published, and its timestamp. If it is stale, that gap is
   your first job.
3. **Your own top-level plan comment** and its thread — what you already told people you would do. You
   are accountable for those promises even though you do not remember making them.
4. **The replica** — the current truth of your scope's tickets, states, comments and PRs. Where it
   disagrees with 1–3, the replica wins and the difference is worth a line in your first turn.

Also read the **last N channel turns** before acting on anything live — the incident you are about to
report may already have been diagnosed while you were down.

> ⚠️ **If a cited handoff file is missing on disk, the channel is authoritative.** Recover from the
> last turn's text and keep going — never treat the missing file as lost work. `thoughts/shared` is a
> *per-project symlink*, so a relative citation written in another worktree resolves elsewhere here,
> and a sync that aborted leaves the file on the writing host until the next tick. The content is
> almost always still there; re-doing landed work on the assumption it is gone is the costlier
> mistake. (`create-handoff` now cites an absolute path and returns a `synced` / `local-only`
> verdict, so a fresh handoff tells you which case you are in — CTL-2104.)

## Say that you resumed

Your first turn after a restart states it plainly: **"resumed from `<artifact>` at `<time>`"**, plus
anything that changed while you were gone. Silent resumption makes a restarted steward indistinguishable
from one that never stopped — which is exactly the ambiguity the heartbeat exists to remove.

## Handing off

Write the handoff **before** you stop, not as you run out of room. Use `catalyst-dev:create-handoff`.
It must carry:

- what you were doing, and the next concrete step;
- every promise you made in a thread that is not yet kept;
- open asks and the defaults currently running on them;
- what you deliberately held, and why (so the next session does not re-litigate it);
- anything you could not enforce.

Stop on: a hard stop from the human, your context or budget threshold, a scheduled rotation, or an
explicit `stop` from the supervisor. In every case: handoff first, then exit.

## What the supervisor guarantees you

Restart with backoff after a crash or a provider outage; re-entry when you go idle while your scope is
still active; a heartbeat so "quiet" and "dead" are different observable states; and re-entry when your
status doc goes stale. **The cadence is enforced by that mechanism, not by your memory** — if you are
re-entered because the doc is 90 minutes old, it is 90 minutes old.
