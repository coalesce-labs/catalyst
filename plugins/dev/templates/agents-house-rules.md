## Working the Loop (every agent — interactive too, not just skills)

<!--
  CANONICAL SOURCE for the Catalyst "agent house rules" block.
  Seed this section into every Catalyst-managed repo's agent-instructions doc —
  AGENTS.md when CLAUDE.md is a thin `@AGENTS.md` bridge, otherwise directly into
  the monolithic CLAUDE.md (that is the file the driving agent actually loads).
  `ensure-agent-house-rules.sh --fix` seeds/updates it idempotently; keep this
  file the single source of truth and let that script propagate changes.
  It is intentionally SELF-CONTAINED (no cross-references to other sections) so it
  ports into any repo, but it DEFERS the Linear-read mechanism to the
  `catalyst-dev:linearis` skill rather than copying it (single-source-of-truth).
  `check-project-setup.sh` §9 verifies presence via three reflex markers
  ("subscribe to the event log" / "👍" / "local replica"); keep those phrases
  intact. Delete this HTML comment when you paste the block into a repo.
-->

These are house rules for anyone touching this repo's dev / PR / ticket workflow — whether you are
running a slash-command skill **or** working interactively and ad-hoc. They are **default
reflexes, not skill internals**: reach for them without being told, even on a one-off PR you opened
by hand. They assume the `catalyst-dev` plugin is available (it is in every Catalyst-managed repo)
and defer their mechanism to it.

- **Waiting on GitHub / CI / Linear state → subscribe to the event log, don't poll.** To block on a
  state change (a PR merged, CI turning green, a review posted, a push to a branch, a ticket
  transition), wait on the unified Catalyst event log instead of re-querying in a loop. Reach for
  the `catalyst-dev:wait-for-github` skill for GitHub events (broker `broker_claim_pr` +
  `filter.wake`, falling back to `catalyst-events wait-for`) and `catalyst-dev:monitor-events` for
  the general wait-for-a-state-change pattern. A `gh` / `linearis` poll loop burns shared-quota API
  budget and silently misses reaction-only signals (next bullet). When the broker / webhook infra is
  down — or absent on a host with no event-log substrate — these skills degrade to a bounded
  single-event wait and a bounded poll becomes acceptable, but that degradation is the fallback,
  never your opening move.
- **Judging an automated code review → a clean pass is a reaction, not a review object.** The
  automated PR reviewer signals "no issues" with a 👍 reaction (or a terse "no major issues"
  comment) **instead of** opening review threads — detect it via the PR's reactions and issue
  comments, not only the reviews API. Recognizing the clean pass does **not** waive the rule that a
  PR is mergeable only once **every** review thread has been addressed and resolved.
- **Reading one Linear ticket → the freshness-gated local replica, not bare `linearis`.**
  Invoke the `catalyst-dev:linearis` skill and follow its "Reading Linear" contract — it reads the
  local replica behind a freshness gate (via its `linear_read_ticket` helper, a bash function that
  needs the plugin's skill context to resolve, so let the skill run it rather than hand-sourcing it)
  and, when the mirror is stale or missing, performs the loud fallback for you. Don't bypass the skill
  with a hand-rolled `sqlite3` read (that skips the freshness gate and silently creates an empty
  database if the mirror is absent) or a bare `linearis issues read <ID>` (it 429s the shared fleet
  quota — the skill's helper handles the stale/absent fallback so you never hand-roll that read).
  Writes and list/search go through `linearis`.
