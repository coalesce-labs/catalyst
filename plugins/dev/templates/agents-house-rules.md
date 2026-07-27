## Working the Loop (every agent — interactive too, not just skills)

<!--
  CANONICAL SOURCE for the Catalyst "agent house rules" block — the single source
  of truth. Do not hand-paste it; `ensure-agent-house-rules.sh --fix` seeds/updates
  it idempotently into every Catalyst-managed repo (AGENTS.md when CLAUDE.md imports
  it, else the monolithic CLAUDE.md) and STRIPS this maintainer comment on the way in.
  When seeded, the block is wrapped in begin/end catalyst-house-rules HTML-comment
  sentinels; the seeder and `check-project-setup.sh` §9 key on those stable sentinels,
  so the heading and most prose can be reworded without breaking detection — EXCEPT
  three literal anchor phrases the seeder's integrity guard enforces: "subscribe to
  the event log", "reaction, not a review object", and "local replica" (keep them
  intact). The block defers its mechanisms to `catalyst-dev` skills (event-log waits →
  `catalyst-dev:wait-for-github` / `catalyst-dev:monitor-events`; Linear reads →
  `catalyst-dev:linearis`) rather than copying them (single-source-of-truth).
-->

These are house rules for anyone touching this repo's dev / PR / ticket workflow — whether you are
running a slash-command skill **or** working interactively and ad-hoc. They are **default
reflexes, not skill internals**: reach for them without being told, even on a one-off PR you opened
by hand. They defer their mechanism to the `catalyst-dev` plugin, available in every Catalyst-managed
repo. If that plugin is somehow unavailable, that is a broken environment — repair it (reload the
plugin) rather than routing around it. For GitHub state only, a single **bounded** `gh` check is an
acceptable last resort while you do; never a poll loop, and never a raw Linear API read (the
replica-read rule below is absolute).

- **Waiting on GitHub / CI / Linear state → subscribe to the event log, don't poll.** To block on a
  state change (a PR merged, CI turning green, a review posted, a push to a branch, a ticket
  transition), wait on the unified Catalyst event log instead of re-querying in a loop. Reach for
  the `catalyst-dev:wait-for-github` skill for GitHub events and `catalyst-dev:monitor-events` for
  the general wait-for-a-state-change pattern (they own the broker/webhook mechanics — don't
  reimplement them). A `gh` / `linearis` poll loop burns shared-quota API budget and silently misses
  reaction-only signals (next bullet). When the broker / webhook infra is down — or absent on a host
  with no event-log substrate — these skills degrade to a bounded single-event wait and a bounded
  poll becomes acceptable, but that degradation is the fallback, never your opening move.
- **Judging an automated code review → a clean pass is a reaction, not a review object.** The
  automated PR reviewer signals "no issues" with a 👍 reaction (or a terse "no major issues"
  comment) **instead of** opening review threads — detect it via the PR's reactions and issue
  comments, not only the reviews API. Recognizing the clean pass does **not** waive the rule that a
  PR is mergeable only once **every** review thread has been addressed and resolved.
- **Reading one Linear ticket → the freshness-gated local replica, not bare `linearis`.**
  Invoke the `catalyst-dev:linearis` skill and follow its "Reading Linear" contract — it reads the
  local replica behind a freshness gate (via its `linear_read_ticket` helper, run in the plugin's
  skill context) and does the loud stale/absent fallback for you. Don't hand-roll the read yourself:
  an **un-gated** `sqlite3` of the replica skips the freshness check (you may read stale data or
  create an empty DB), and a bare `linearis issues read <ID>` hits the rate-limited API and 429s the
  shared fleet quota — don't reach for it even as a fallback; the skill's helper owns the loud
  stale/absent path. Writes and list/search go through `linearis`.
- **Spawning a background process → make the LOOP ITSELF self-limiting; never let cleanup be
  load-bearing.** A background process must not be able to outlive the command that started it.
  Give it its own deadline so it dies on its own **even if every cleanup line you wrote is broken**
  — an unbounded `while :; do :; done` has no place in this repo. Prefer a self-limiting loop; it
  needs no external command and is portable — but it must **sleep**, not spin:
  `end=$((SECONDS+120)); while [ $SECONDS -lt $end ]; do sleep 1; done`. An empty body
  (`do :; done`) re-evaluates `$SECONDS` as fast as the CPU allows and burns a whole core for the
  duration — which is the very incident this rule exists to prevent, so do not write the deadline
  loop that way even though it terminates. If the background work is a real command rather than a
  keep-alive, prefer a watchdog that sleeps and then signals:
  `cmd & p=$!; (sleep 120; kill "$p" 2>/dev/null) & w=$!; wait "$p"; kill "$w" 2>/dev/null`.
  (`timeout` / `gtimeout` are a convenience *if* present — stock macOS, the fleet's primary launchd
  environment, ships neither and GNU coreutils is not a dependency, so never depend on them.) This is not hypothetical — four
  such spinners leaked out of one test run and burned ~4 CPU cores for 16.5 hours while the script
  that spawned them reported `cleanup verified`. Three traps, all of which fired in that incident:
  - **The shell here is `zsh`, which does NOT word-split an unquoted parameter.**
    `PIDS="$PIDS $!"; for p in $PIDS; do kill $p; done` iterates **once**, with the whole string as
    a single argument, and dies with `illegal pid`. Collect into an array (`pids+=($!)`) and iterate
    that, or write the ids to a file and read them back with `while read`.
  - **Never verify with a probe that fails open.** `kill -0 "$p" 2>/dev/null && echo STILL_ALIVE`
    prints nothing when the probe *itself* errors, so the script self-certifies success whether or
    not anything actually died. Assert positively and fail closed —
    `ps -p "$p" >/dev/null 2>&1 && { echo "LEAKED: $p"; exit 1; }` — the same discipline the
    worktree-safety gates already use.
  - **Backgrounded children survive a normal exit.** When your command returns, `&` children
    reparent to PID 1 and run forever, which is precisely why the deadline has to live inside the
    child rather than in the parent's cleanup.

  Before reporting a background task complete, prove the machine is clean (e.g. `pgrep -fl 'while :'`).
  Scoping applies too: write only inside your own worktree, and chain with `cd <dir> && <cmd>` — a
  bare `cd` on its own line that silently fails will apply your edits to whichever worktree the
  shell happened to be in.
