# Trigger — the relay-native merge/deploy signal (CTL-2244)

What actually causes `compound-estimate`, `ticket-retro`, and `ticket-compound` to run after a
ticket ships, and why the answer changed.

## Before CTL-2244 — two paths, one of them retiring

- **`merge-pr` Step 12b / 13b** (relay-native, fine): the interactive/relay merge flow invoked
  `compound-estimate` and `ticket-retro` directly, in the same session, right after the squash
  merge. No daemon involved.
- **`phase-monitor-merge`** (daemon-era): a `claude --bg` phase agent, dispatched by the retiring
  `phase-agent-dispatch` orchestrator, re-implemented the same compound-log write and invoked
  `ticket-retro` itself (`phase-monitor-merge/references/compound-log.md`) — a second, redundant
  path that only exists because the daemon pipeline used to be the primary dispatch model.
- **`ticket-compound`** had no automatic trigger at all: its own "Out of scope" note deferred to
  "the daemon firing this automatically after `monitor-deploy`" — a hook that was never built,
  because `phase-monitor-deploy` (the daemon-era deploy watcher) is itself being cut.

Both daemon-shaped things — `phase-monitor-merge`'s redundant invocation and `ticket-compound`'s
deferred `monitor-deploy` hook — depend on the retiring `phase-agent-dispatch` orchestrator. That
dependency is what this ticket removes.

## After CTL-2244 — one relay-native signal, no daemon

All three tools now share a single documented trigger point: **`merge-pr`'s post-merge
deploy-verification step** —
[`merge-pr/references/post-merge-deploy-verify.md`](../../merge-pr/references/post-merge-deploy-verify.md)
(CTL-2232) — once `verify_post_merge_deploy` resolves. Any terminal sentinel counts as "the ticket
is closed enough to learn from":

- `DEPLOYED`, `NOT_APPLICABLE`, `NO_DEPLOY_CONFIG`, `DEPLOY_FAILED`, `SMOKE_FAILED` — all terminal;
  run the closing ritual regardless of which one it is (a failed deploy is itself a learning —
  `ticket-compound`'s "what didn't work" is exactly this signal).
- `DEPLOY_PENDING` — the bounded-poll ceiling was hit with no answer yet; **do not** run the ritual
  on this one. Re-check later (a coordinator re-dispatching the check), the same way bounded-poll
  itself treats `PENDING` as "not done," never a silent skip.

Whoever is driving the merge (an interactive session, or a `/relay-ticket` phase) invokes, in
order: `/catalyst-dev:compound-estimate`, `/catalyst-dev:ticket-retro`, then
`/catalyst-dev:ticket-compound` — all three off that one signal. None of the three calls
`catalyst-events`, `phase-agent-dispatch`, or `phase-monitor-merge` to get invoked; there is no
event-log subscription anywhere in this contract.

## What did NOT change

Per this ticket's scope, only the **trigger** moved — the artifact stores are untouched:
`compound-estimate` still writes `thoughts/shared/retros/estimate/`, `ticket-retro` still writes
`thoughts/shared/retros/ticket/<date>.md`, `ticket-compound` still writes
`thoughts/shared/learnings/`. See each skill's own reference docs for those contracts.
