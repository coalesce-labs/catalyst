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

- **Reporting a negative → run a positive control first, or report inconclusive.** A negative result
  is only evidence if you can state what a positive one would have looked like **and you ran the same
  instrument against a case known to be present and saw it come back non-zero.** Before you report
  "zero", "absent", "unrelated", "clean", or "not owned", ask the question that separates *the thing
  is not there* from *I could not look* — and if you cannot separate them, say **inconclusive**. The
  five mechanisms that have actually produced a false clean result here, all of them silent:
  (1) an unstructured match over structured data — a substring `grep` for an event name counted the
  name where it appeared inside a commit message, reporting events that did not exist; (2) a
  malformed call returning a falsy sentinel — an ownership helper invoked with its arguments
  transposed returned `undefined` for every ticket, which reads as "not owned"; (3) an empty input
  set feeding a loop, so the body never ran and the trailing all-clear line printed on the strength
  of zero iterations (`[].every(p)` is `true`); (4) the right question asked of the wrong surface —
  counting a bot's issue comments returned zero while an unresolved *review thread* was the thing
  blocking the merge; (5) **the search tool skipping files it never says it skipped** — in the agent
  shell `grep` is a wrapper around `ugrep --ignore-files`, which honours `.gitignore`, and
  `~/.config/catalyst/.gitignore` excludes `config*.json`, so **a recursive grep never reads any live
  Catalyst config** and answers "not configured anywhere" for a value sitting in `config.json`. It is
  convincing because the `.bak-*` copies do NOT match that pattern, so you get plausible hits from
  stale backups while the live file is skipped. A recursive-grep zero over config, secrets, or
  build output is **inconclusive** until re-run with `/usr/bin/grep` or an explicit file list.
  (Sibling traps in the same family: `find` does not follow symlinks, so it misses what
  `cat`/`readFileSync` read straight through — e.g. bun's `.bun` store entries; and zsh kills an
  unquoted `--include=*.mjs` with "no matches found", returning nothing, which also reads as a real
  zero.) Prefer the verified helpers in `plugins/dev/scripts/lib/verified-checks.mjs`
  (count events by exact `event.name`, resolve ticket ownership under named rosters, enumerate every
  merge blocker) — each returns a verdict that can be explicitly **inconclusive** and throws on
  malformed input rather than degrading to a falsy answer. This rule governs the bullets below: a
  check that cannot fail loudly is not evidence for any of them.
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
- **Coordination has THREE roles, and "orchestrator" is not one of them.** Long-running coordination is
  done by single-threaded owners: a **concierge** (the one agent a human talks to — owns the status board,
  the ask inbox, routing and project scaffolding, and holds **no authority over stewards**), a **steward**
  (owns ONE initiative or project end-to-end until it closes; makes work ready and visible, the fleet does
  it), and **workers** (one phase of one ticket, driven by the pipeline). Invoke the `concierge` and
  `steward` skills by name; the phase pipeline's shared contract is `phase-agent-contract`. ⚠️ Reserve
  **"orchestrator"** for the pipeline MACHINERY — never for an agent or a person: this repo already calls
  the phase runners *workers* in code (`workers/<ticket>/`, `worker.session.started`), so a role by that
  name reads as the scheduler. Three rules bind you even when you are none of these roles:
  - **Reply where the message arrived, threaded, and never as the human.** A comment inside a scope is
    answered by that scope's **steward**, in-thread and tagged. Anything only a human can decide becomes
    an **ask ticket** (`catalyst-dev:ask`) with Options + a Default if silent — and you **proceed on the
    default**. Never answer someone else's ask, and never post as the human.
  - **Escalate inward, never outward:** instrument → steward → concierge → human (as an ask). An agent or
    instrument that pages a human directly is a defect, and a bare label in a human's queue is a defect.
  - **A stuck agent is a request for help, NOT an escalation — and the steward's job is to answer it.**
    The steward holds the broader context and has the standing mandate to *unblock*, not to relay.
    ⛔ **Gate zero — do you even know WHY it is stuck?** "Why has this not moved?" is **never** an
    escalation; it is a diagnosis job you **dispatch yourself, automatically**, the moment you notice a
    stall, a no-pickup, a phase that will not advance, or a PR that will not merge. Never file an ask
    whose options amount to *investigate vs don't investigate* or *wait vs look* — that spends a human's
    attention authorising work the agent could simply have done. When you do escalate afterwards, lead
    with **the cause**: an ask carrying a diagnosis is worth a human's time, an ask carrying a question
    mark usually is not. (Ryan, 2026-08-21, on an ask that offered him "leave it — it will pick up on its
    own" versus "investigate", and then held a P1 as his top blocking item for ~13h.)
    Only once the cause is known do the next three questions apply: **can I decide this myself?** (technical
    calls — which approach, retry-or-abandon, rebase-or-re-cut — are theirs, not the human's); **does this
    need to block at all?** (if a sane default exists, take it and record it — see the ask rule above);
    and **who else can move this?** They may pull in another agent, another steward, or the human, and
    pulling in a peer is the preferred move. Only a genuine product/priority/approval decision — or an
    action only a human can physically take — survives to become an ask.
    ⛔ **A system-level failure is never a per-ticket human block.** Provider overloaded, out of capacity,
    rate-limited, connectivity down: that is ONE fleet alert, and the affected tickets retry and resume by
    themselves. Measured 2026-08-21: of 86 items flagged as waiting on a human, **3** genuinely were —
    41 were the model provider being overloaded, escalated one ticket at a time as if each were a
    priority call.
  - **Rank what does reach the human by blast radius, not by age.** An ask must record what it `blocks`,
    and the ordering the human sees is *how much open work is held, weighted by that work's priority* —
    `catalyst-dev:ask` → `references/triage.md`, with `scripts/ask-triage.sh` ready-made. Search for an
    existing ask before filing a new one and attach to it instead of duplicating: duplicates split one
    decision's urgency across several rows and sink it below trivia.
  - **Cite an identifier only after `create` returned it.** A guessed ticket number is usually a real,
    unrelated ticket — worse than no number at all.
- **Skills here use progressive disclosure — read the reference you need, not all of them.** A skill is a
  short `SKILL.md` covering the common path, plus `references/*.md` loaded **on demand**; the SKILL.md
  names which reference answers which situation. Follow that table rather than reading the whole tree.
  `plugins/dev/skills/__tests__/skill-shape.test.sh` enforces the shape and `skills-gate` runs it on
  every PR, so the budget is real.
