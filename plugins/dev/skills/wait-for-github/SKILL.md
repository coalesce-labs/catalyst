---
name: wait-for-github
version: 1.3.0
description: "Reference for the bounded-poll pattern — a foreground, single-session, quota-conscious way for a relay worker to wait on a GitHub event (CI completion, review, merge). Replaces the retired broker/filter.wake wait, which needs a daemon, a subagent, or a background loop this model does not have. Use whenever a relay-ticket phase needs to block on GitHub state without a poll storm or a silent stall. Not a slash command — reference doc for skill authors."
---

# wait-for-github — the bounded-poll pattern

## What this replaces

The daemon-era version of this skill waited on `filter.wake` from the `catalyst-broker` daemon, falling back to `catalyst-events wait-for` against the orch-monitor event log. Both depend on background infrastructure a single-session relay worker does not have: a `claude -p` worker cannot self-sustain a background wait loop (a backgrounded monitor never reports back, and backgrounding the gate can exit print mode and strand the work — see `monitor-events`). This skill now documents **bounded-poll**: the replacement, and the name every consumer should grep for.

## bounded-poll: the pattern

A single **foreground** loop, in the same session that needs the answer, that checks GitHub REST (never GraphQL) at a fixed interval for a stated number of iterations, then **stops** — it does not silently keep going and does not background itself. Full mechanism, the two presets (CI vs. merge/review), and the exact failure mode when the ceiling is hit: [references/bounded-poll.md](references/bounded-poll.md).

```bash
# CI preset: 30s interval x 30 iterations = 15 min ceiling
INTERVAL_SECONDS=30 MAX_ITERATIONS=30 bounded_poll_pr_state "$PR_NUMBER"
```

## When to use this

- A relay-ticket phase (e.g. the PR phase) needs to confirm CI finished, a review landed, or a PR merged, before it can report its phase result.
- You are NOT inside an orchestrator with a live event log — if the installed `catalyst-monitor status --json` reports `running: true`, prefer `monitor-events`' `catalyst-events wait-for` instead; bounded-poll is for when that infrastructure is absent, which is the default going forward.

## Known GitHub-signal traps

Two response shapes look like "done" or "failed" and are not. Read [references/gh-signal-traps.md](references/gh-signal-traps.md) before writing any check:

- A check-run's `conclusion` is the empty string `""` — **not** `null` — while it is still running, AND an empty check-run list (nothing created yet) is not the same as "all passed."
- A clean automated-review pass is often a 👍 **reaction** or a terse issue comment from the specific automated reviewer, not a review object — and a stale signal from an earlier push can be mistaken for a current one.

## Related skills

- `monitor-events` — canonical event-driven wait when the orch-monitor daemon IS running; documents `Monitor` vs `wait-for` and the narration invariant.
- `merge-pr` — the main consumer of bounded-poll for its post-PR merge-blocker loop.
- `create-pr` — uses a bounded CI-gate check before arming auto-merge.
