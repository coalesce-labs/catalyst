# Phase-specific Work — Active Listen Loop

Reuse the reactive listen loop from [[oneshot]] § Phase 5 Step 2. The full control flow lives there;
this skill copies the body verbatim, substituting `phase-monitor-merge` framing in place of
`oneshot`'s session-id machinery. Key elements that MUST be preserved:

1. **Event-driven, not polling.** `catalyst-events wait-for` blocks until a PR-lifecycle event
   fires. Filter clause matches the canonical event names `github.pr.merged`,
   `github.check_suite.completed`, `github.pr_review*`, and `github.push` keyed by
   `attributes."vcs.pr.number"` (PR/review events) or `body.payload.prNumbers`
   (check_suite/workflow_run — see [[event-schema]]). When the broker daemon is up, register a
   `pr_lifecycle` interest via `agent.checkin.claimed_pr` and wait on
   `filter.wake.${CATALYST_SESSION_ID}` instead (the single-wake path — see [[monitor-events]]
   Pattern 3). **CTL-1680:** when the reviewer-arrival window (Merge step) sets
   `MERGE_WAKE_TIMEOUT_SEC`, the next wait MUST cap its `--timeout` at that many seconds so the loop
   re-evaluates the window deadline even if no PR-lifecycle event arrives — otherwise the general
   wait can block far past the window (600s broker / 180+7200s raw) and delay an already-earned merge.

2. **REST is authoritative.** Every loop iteration calls `gh api repos/${REPO}/pulls/${PR_NUMBER}`
   and reads `.merged` + `.mergeable_state`. Never use `gh pr view --json mergeable` (GraphQL is
   eventually consistent for the merge-state fields and frequently lies).

3. **State machine.** Branch on `mergeable_state`:

   | state            | action                                                                                                                                  |
   | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
   | clean            | proceed to merge step                                                                                                                   |
   | blocked          | resolve via `/catalyst-dev:review-comments` (bot threads) or run an inline CI fix-up commit (up to 3 attempts); 4th attempt → `stalled` |
   | behind           | `git fetch && git rebase origin/<base> && git -c core.hooksPath=/dev/null push --force-with-lease`                                      |
   | dirty            | merge conflicts — emit `failed` with reason "merge conflicts (DIRTY)"                                                                   |
   | unknown/unstable | continue waiting for the next event                                                                                                     |

4. **Human reviewer changes-requested.** After every wake, query `gh pr view --json reviews` for the
   most recent `CHANGES_REQUESTED` from a human reviewer (filter on `.author.login` not matching
   known bots). If present, emit `failed` with reason "human reviewer ${LOGIN} requested changes —
   operator action required". Do NOT attempt to address human review comments programmatically.
   The same applies to an unresolved human review **thread** left on a `COMMENTED`/`APPROVED`
   review: it never surfaces as `CHANGES_REQUESTED` and does not always flip
   `mergeable_state`, so the unresolved-thread gate counts human threads separately and
   emits `failed` for them instead of dispatching `/catalyst-dev:review-comments` (CTL-1680).

5. **Wake narration.** Every iteration produces one short line of assistant text before re-entering
   the wait (defeats the assistant `end_turn` rendering bleed described in [[monitor-events]] §
   Narration). Shape: `wake: <event.name> #<PR_NUMBER> — <action being taken>`.

6. **⚠️ A yield does NOT resume you — it names an ending (CTL-1854).**

   **For CI and re-review, the answer is the event-driven wait above, not a yield.** Nothing
   redispatches a yielded phase when the GitHub event lands: the only runtime handling of
   `awaiting-work` returns `noop` while the deadline is live and writes `failed` when it passes. So
   yielding *instead of* staying in the `catalyst-events wait-for` loop guarantees you never observe
   the merge you were waiting for — it converts a wait that works into a bounded one that cannot.
   **Stay in the wait.**

   Use a yield only when you are ending the turn regardless and the alternative is ending it
   silently. It buys an accurate, bounded record — `yield-expired` instead of
   `ended-without-declaration` — and buys nothing else. If you want to be resumed, do not stop.

   ```bash
   # Runnable as written. CTL-1998: "$EMIT" is now assigned in the PRELUDE, so it is
   # safe here too — this line keeps the explicit path only because it is the earliest
   # emit in the file and reads better without the indirection. (Previously EMIT was
   # first assigned in the terminal block, which made any earlier use abort the shell
   # under `set -u`; one such use had already crept in at the unresolved-human-thread
   # branch.)
   "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
     --phase "$PHASE" --ticket "$TICKET" --status yield

   # To wait less than the 30-minute ceiling, pass a concrete number of seconds:
   "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
     --phase "$PHASE" --ticket "$TICKET" --status yield --yield-seconds 600
   ```

   **⚠️ A yield does not bound the child process — you must.** The emitter updates JSON; it
   terminates nothing. A backgrounded child reparents to PID 1 and outlives your exit, so yielding
   beside an unbounded background job leaves it running long after the signal expires. Yield only
   when the background work is **self-limiting** (its own internal deadline — `AGENTS.md` →
   "Spawning a background process"); otherwise stay alive until it finishes.

   Ending the turn without a declaration is **not** neutral and does not mean "resume later":
   `sdk-run-phase-agent` writes `failed` / `abandoned` / `ended-without-declaration`, and a human is
   paged for a phase whose work may have completed. Measured 2026-08-14: five such runs across both
   hosts in one day, in exactly this phase and `implement`, every one with a clean SDK exit — two of
   them fleet-blocking. "I'll be re-invoked when it completes" is a belief the runtime does not
   share; a yield is how you actually say it. It is bounded (30 min per episode, re-yielding buys
   no more), so it defers the terminal — it never removes it.
