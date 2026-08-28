# Pattern 1 — Worker waits for its PR to merge

_Read this when a short-lived `claude -p` worker needs to block until its PR merges and then do post-merge work._

A `claude -p` worker that just opened PR #342 needs to block until the PR merges, then do post-merge work.

**Preferred (when `catalyst-filter` is running, CTL-269):** register a single semantic interest covering every concern the worker cares about (CI, comms, reviews, BEHIND, Linear), then wait on `filter.wake.${CATALYST_SESSION_ID}`. The Groq-backed daemon classifies raw events against the natural-language prompt and emits one wake per match. See [[catalyst-filter]] for the full registration recipe and the daemon-restart contract. The bounded-poll pattern below is the **fallback** for environments where the daemon is not running.

When the daemon is absent — the default for a single-session relay worker — use `[[wait-for-github]]`'s **bounded-poll** pattern instead: a foreground REST loop with a stated interval and iteration ceiling, never an event-log `wait-for` against a daemon that may not be running.

```bash
# bounded-poll — see [[wait-for-github]] § references/bounded-poll.md for the full pattern.
INTERVAL_SECONDS=30 MAX_ITERATIONS=30 bounded_poll_pr_state "$PR_NUMBER"
# returns MERGED / CLOSED on success, or prints PENDING / ERROR to stdout and
# exits non-zero when the 15-minute CI-preset ceiling is hit without resolving —
# see [[wait-for-github]] for the merge/review preset (5 min x 24 = 2h) and the
# two known GitHub-signal traps to check alongside it.
```

**Non-negotiable:** the daemon path's `wait-for` is always paired with an authoritative REST check afterward, and the fallback path's bounded-poll makes that same REST call the check on every tick — there is no daemon in between to trust instead. Reasons:

- The orch-monitor daemon may be down. No daemon → no webhook events → `wait-for` blocks until timeout. The `gh api` call after timeout is the safety net — and bounded-poll skips the daemon step entirely rather than waiting to discover it's down.
- Transient state can race the event. The webhook may arrive while the worker is doing setup before reaching `wait-for`. Polling REST directly has no such race.
- A daemon-path filter may not match exactly; `wait-for` returns the first matching line, `gh api` returns canonical truth. Use `gh api` (REST) either way, never `gh pr view --json` (GraphQL).
