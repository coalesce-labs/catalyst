# bounded-poll — mechanism, numbers, failure mode

## Why foreground-only

A relay worker is one Claude Code session running `/relay-ticket <TICKET>`. It has no daemon, no
broker, and no way to spawn a wait that keeps running after the session's turn ends:

- A subagent cannot self-sustain a background wait loop — dispatching one and asking it to "wait
  and report back" produces a subagent that goes idle without ever reporting.
- Backgrounding the wait itself (`claude --bg` on a sub-shell, `&` inside the gate script) can exit
  print mode entirely, stranding uncommitted work with nothing watching it.

So bounded-poll runs **in the calling turn**, as an ordinary blocking Bash call. The session is
"busy waiting" for real wall-clock time, which is why the two constraints below (bounded, sparse)
both matter — an unbounded or tight version of this loop is just the old problem with a REST client
instead of a broker.

## The two presets

Both use one-shot `gh api` REST calls (never `gh pr view --json` / `gh pr checks --json` — those
are GraphQL and cost more per call). Pick the interval to match how fast the thing you're waiting
on typically resolves, and always state the interval and ceiling you used in the phase's report.

| Preset | Interval | Iterations | Ceiling (wall-clock) | REST calls | Use for |
|---|---|---|---|---|---|
| **CI** | 30 s | 30 | 15 min | 30 | CI checks, most of which resolve in minutes |
| **merge/review** | 5 min | 24 | 2 h | 24 | human review or merge approval, which can sit for a while |

Both are well inside GitHub's per-token REST budget (5,000 req/hr) even with several relay workers
running concurrently on the same laptop — the CI preset is ~120 req/hr *if* it ran continuously,
but it doesn't: it stops at 30 calls and 15 minutes, full stop.

## The loop

```bash
bounded_poll_pr_state() {
  local pr_number="$1"
  local repo interval max_iter count=0 state
  repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
  interval="${INTERVAL_SECONDS:-30}"
  max_iter="${MAX_ITERATIONS:-30}"

  while [ "$count" -lt "$max_iter" ]; do
    state=$(gh api "repos/${repo}/pulls/${pr_number}" \
      --jq 'if .merged then "MERGED" elif .state == "closed" then "CLOSED" else "OPEN" end' \
      2>/dev/null || echo "OPEN")
    [ "$state" != "OPEN" ] && { echo "$state"; return 0; }

    count=$((count + 1))
    [ "$count" -lt "$max_iter" ] && sleep "$interval"
  done

  # Ceiling hit — explicit, not silent.
  echo "BOUNDED-POLL: ceiling reached (${max_iter}/${max_iter} checks, $((max_iter * interval))s" \
       "elapsed) — PR #${pr_number} still OPEN. Ending this wait." >&2
  echo "PENDING"
  return 1
}
```

Swap the `gh api .../pulls/{n}` predicate for whatever REST call answers the question you're
actually asking (CI conclusion, review state — see
[gh-signal-traps.md](gh-signal-traps.md) for the two shapes that are easy to misread). The shape
of the loop — fixed interval, fixed ceiling, one REST call per tick, explicit non-zero return and a
`PENDING` sentinel on the printed line when the ceiling is hit — stays the same regardless of what
you're polling for.

## The failure mode when the ceiling is hit

This is the part that differs most from the old daemon design, which could extend a wait from 3
minutes to 2 hours mid-flight once diagnostics ruled out infrastructure trouble. bounded-poll has
no such extension: hitting the ceiling is not an error to retry around, it is the phase's answer.

- Exit non-zero and print `PENDING` (or your own sentinel) on stdout — never exit 0 with an
  ambiguous result.
- The calling `/relay-ticket` phase treats `PENDING` as "this phase is not done yet," reports that
  plainly in its RELAY REPORT (state, what was waited on, the interval/ceiling used), and ends the
  turn. It does not loop again inside the same session.
- The **coordinator** reading that report decides whether to re-dispatch the same phase later. That
  redispatch is a fresh session, not a resumed wait — bounded-poll never assumes continuity across
  invocations.
- If you need a longer effective wait than one ceiling allows, that is the coordinator
  re-dispatching bounded-poll again later, not a bigger `MAX_ITERATIONS`.
