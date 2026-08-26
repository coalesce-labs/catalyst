# Trigger — the relay-native merge/deploy signal (CTL-2244)

What actually causes `compound-estimate`, `ticket-compound`, and `ticket-retro` to run after a ticket ships, and why the answer changed.

## Before CTL-2244 — two paths, one of them retiring

- **`merge-pr` Step 12b / 13b** (relay-native, fine): the interactive/relay merge flow invoked `compound-estimate` and `ticket-retro` directly, in the same session, right after the squash merge. No daemon involved.
- **`phase-monitor-merge`** (daemon-era): a `claude --bg` phase agent, dispatched by the retiring `phase-agent-dispatch` orchestrator, re-implemented the same compound-log write and invoked `ticket-retro` itself (`phase-monitor-merge/references/compound-log.md`) — a second, redundant path that only exists because the daemon pipeline used to be the primary dispatch model.
- **`ticket-compound`** had no automatic trigger at all: its own "Out of scope" note deferred to "the daemon firing this automatically after `monitor-deploy`" — a hook that was never built, because `phase-monitor-deploy` (the daemon-era deploy watcher) is itself being cut.

Both daemon-shaped things — `phase-monitor-merge`'s redundant invocation and `ticket-compound`'s deferred `monitor-deploy` hook — depend on the retiring `phase-agent-dispatch` orchestrator. That dependency is what this ticket removes.

## After CTL-2244 — one relay-native signal, no daemon

All three tools now share a single call site: **`merge-pr` Step 14** ([`merge-pr/references/post-merge.md`](../../merge-pr/references/post-merge.md), "Compound closing ritual"), which fires only after Step 13b's `verify_post_merge_deploy` call ([`merge-pr/references/post-merge-deploy-verify.md`](../../merge-pr/references/post-merge-deploy-verify.md), CTL-2232) resolves a **terminal** sentinel for the merge:

- `DEPLOYED`, `NOT_APPLICABLE`, `NO_DEPLOY_CONFIG`, `DEPLOY_FAILED`, `SMOKE_FAILED` — all terminal; run the closing ritual regardless of which one it is (a failed deploy is itself a learning — `ticket-compound`'s "what didn't work" is exactly this signal).
- `DEPLOY_PENDING` — the bounded-poll ceiling was hit with no answer yet; **do not** run the ritual on this one. Re-check later (a coordinator re-dispatching the check), the same way bounded-poll itself treats `PENDING` as "not done," never a silent skip.

Step 14 invokes, in order: `/catalyst-dev:compound-estimate`, `/catalyst-dev:ticket-compound`, then `/catalyst-dev:ticket-retro`. `ticket-compound` runs before `ticket-retro` on purpose — `ticket-retro` reads the learnings store `ticket-compound` writes, so running retro first would mean the retro that fired off this exact merge could not see the learning that merge just produced. None of the three calls `catalyst-events`, `phase-agent-dispatch`, or `phase-monitor-merge` to get invoked; there is no event-log subscription anywhere in this contract.

`ticket-compound` needed a frontmatter fix to be reachable from this trigger: `disable-model-invocation: true` marks a skill as user-invoked-only (it disables the model auto-triggering off the description) — a merge-driving model executing Step 14 as a documented step is not that auto-trigger, but the flag still blocked it, so `ticket-compound/SKILL.md` now sets `disable-model-invocation: false`, matching the precedent `compound-estimate` already set. It stays `user-invocable: true` — a human can still run it directly.

## What did NOT change

Per this ticket's scope, only the **trigger** moved — the artifact stores are untouched: `compound-estimate` still writes `thoughts/shared/retros/estimate/`, `ticket-retro` still writes `thoughts/shared/retros/ticket/<date>.md`, `ticket-compound` still writes `thoughts/shared/learnings/`. See each skill's own reference docs for those contracts.
