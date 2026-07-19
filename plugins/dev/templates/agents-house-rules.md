## Working the Loop (every agent — interactive too, not just skills)

<!--
  CANONICAL SOURCE for the Catalyst "agent house rules" block.
  Seed this section verbatim into every Catalyst-managed repo's agent-instructions
  doc — AGENTS.md when CLAUDE.md is a thin `@AGENTS.md` bridge, otherwise directly
  into the monolithic CLAUDE.md (that is the file the driving agent actually loads).
  It is intentionally SELF-CONTAINED (no cross-references to other sections) so it
  ports into any repo. `check-project-setup.sh` §9 verifies its presence via the
  three reflex markers ("subscribe to the event log" / "👍" / "local replica");
  keep those phrases intact so the checkup keeps recognizing a set-up project.
  Delete this HTML comment when you paste the block into a repo.
-->

These are house rules for anyone touching this repo's dev / PR / ticket workflow — whether you are
running a slash-command skill **or** working interactively and ad-hoc. They are **default
reflexes, not skill internals**: reach for them without being told, even on a one-off PR you opened
by hand.

- **Waiting on GitHub / CI / Linear state → subscribe to the event log, don't poll.** To block on a
  state change (a PR merged, CI turning green, a review posted, a push to a branch, a ticket
  transition), wait on the unified Catalyst event log instead of re-querying in a loop. Reach for
  the `catalyst-dev:wait-for-github` skill for GitHub events (broker `broker_claim_pr` +
  `filter.wake`, falling back to `catalyst-events wait-for`) and `catalyst-dev:monitor-events` for
  the general wait-for-a-state-change pattern. A `gh` / `linearis` poll loop burns shared-quota API
  budget and silently misses reaction-only signals (next bullet). When the broker / webhook infra is
  down these skills degrade to a bounded single-event wait — that degradation is the fallback, never
  your opening move.
- **Judging an automated code review → a clean pass is a reaction, not a review object.** The
  automated PR reviewer signals "no issues" with a 👍 reaction (or a terse "no major issues"
  comment) **instead of** opening review threads. Detect it via the PR's reactions and issue
  comments, not only the reviews API — otherwise a review that already passed reads as silence and
  you wait on it forever.
- **Reading one Linear ticket → the local replica, not bare `linearis`.** Use `linear_read_ticket
  <ID>` (it gates freshness and falls back loudly); a bare `linearis issues read <ID>` 429s the
  shared fleet quota. Writes and list/search still go through `linearis`.
