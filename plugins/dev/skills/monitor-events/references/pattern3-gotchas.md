# Pattern 3 Gotchas

_Read this when a reactive PR lifecycle wait loop misbehaves — events not matching, filters silently dropping events, or a runaway fix loop._

## Gotchas

- **`check_suite.completed` has no `vcs.pr.number`.** A check suite spans many
  PRs; the affected PR numbers live in `body.payload.prNumbers`. Filter with `(.body.payload.prNumbers // [] | index($PR) != null)`, not `.attributes."vcs.pr.number" == $PR`.
- **The filter is one jq expression.** Clauses are joined with `or`, not
  comma. Each clause is parenthesized.
- **Bash quoting.** The shell-variable interpolation (`'"$PR_NUMBER"'`) is
  intentional — the outer single quotes protect the jq syntax from $-expansion,
  the inner double quotes re-enable it for one variable. Test your filter
  by piping a fixture event through `jq -c "select(<filter>)"` before
  trusting it in production.
- **Iteration cap.** `MAX_ITER=20` prevents runaway loops on a stuck failure
  mode. Apply per-failure-type fix budgets inside each handler too (e.g. give up after 3 distinct fix attempts on the same CI check).
- **All filtering belongs inside the `--filter` jq predicate (CTL-240, CTL-372).**
  Do NOT add a downstream `| grep …` / `| awk …` / `| sed …` / `| jq …`
  post-pipe to a `catalyst-events tail` invocation. The primary reason is
  clarity: `--filter` is the single place a reader can look to know what
  reaches the consumer. Splitting filter logic across two stages hides
  conditions and invites small regressions (someone drops the
  `--line-buffered` flag, or the post-pipe pattern no longer matches the
  canonical envelope). Use `catalyst-events build-orchestrator-filter
  "$ORCH_DIR"` to generate a complete scope-aware predicate from the worker
  signal directory instead of hand-rolling secondary pipes.

  Secondary reason (the historical CTL-240 concern): BSD `awk`, unflagged
  BSD `grep`, and unflagged `sed` buffer stdout in 4 KB blocks when stdout
  is not a TTY (the Monitor harness captures it). With the typical
  ~1–3 events/min orchestrator cadence the buffer never fills and
  notifications stall silently for 15+ minutes despite live PR activity.
  `grep --line-buffered` and `jq --unbuffered` DO mechanically flush per
  line on macOS and Linux (per their man pages), so the buffering failure
  mode is conditional, not absolute — but you should still not need either
  flag, because filtering belongs in `--filter`.

  Anti-pattern: `| grep -v '"event.name":"filter.wake"'` on the
  orchestrator's Monitor (observed in real sessions). Wrong for two reasons:
  (a) `filter.wake.*` envelopes are canonical-only and do not satisfy any
  clause of `build-orchestrator-filter`'s v1 predicate, so they never reach
  the consumer in the first place. (b) The pattern would also strip the
  orchestrator's OWN intended `filter.wake.${ORCH_NAME}` wake — the event
  the orchestrator registered for. Since CTL-346 the broker no longer
  re-classifies its own emissions, so there is no feedback loop to defend
  against on the consumer side either.
- **`github.*` events carry `orchestrator: null` and `worker: null` (CTL-240).**
  Real webhook events are scoped only by `.attributes."vcs.repository.name"`,
  `.attributes."vcs.ref.name"`, `.attributes."vcs.pr.number"`,
  `.attributes."vcs.revision"`, and `.body.payload.prNumbers`. A scope predicate like
  `.attributes."catalyst.orchestrator.id" == "orch-foo"` will silently drop every github event.
  Use branch-ref prefix matching (`.attributes."vcs.ref.name" | startswith("refs/heads/orch-foo-")`)
  and PR-number-set matching (`.attributes."vcs.pr.number" | IN(501,502)`) instead — or use
  `build-orchestrator-filter` which handles this for you.
