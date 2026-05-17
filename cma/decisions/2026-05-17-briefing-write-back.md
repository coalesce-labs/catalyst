# ADR: Per-routine thoughts write-back via routine-scoped branch

- **Status:** Accepted (tactical exception — superseded by
  [CTL-295](https://linear.app/coalesce-labs/issue/CTL-295))
- **Date:** 2026-05-17
- **Tickets:** [CTL-460](https://linear.app/coalesce-labs/issue/CTL-460) (morning-briefing),
  [CTL-469](https://linear.app/coalesce-labs/issue/CTL-469) (research-curate)
- **Source plan:**
  [`thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md`](../../thoughts/shared/plans/2026-05-16-catalyst-phase-agent-architecture.md)
  §Initiative 2 Phase 5 + §Initiative 4 Phase 3
- **Supersedes / extends:** [`2026-05-07-thoughts-strategy.md`](./2026-05-07-thoughts-strategy.md)
  (read posture unchanged)

## Context

The morning-briefing routine ([CTL-457](https://linear.app/coalesce-labs/issue/CTL-457) MVP,
[CTL-458](https://linear.app/coalesce-labs/issue/CTL-458) fan-out,
[CTL-459](https://linear.app/coalesce-labs/issue/CTL-459) ADR-drift detector) writes
`thoughts/briefings/<date>.md` once per scheduled run. The accepted ADR
([`2026-05-07-thoughts-strategy.md`](./2026-05-07-thoughts-strategy.md)) clones
`coalesce-labs/thoughts` **read-only** at session start. That decision unblocks read-heavy Phase 1
Routines (backlog triage, daily async update) but blocks the morning briefing, which needs to
persist a markdown file per run so the user can pull and review on their laptop.

Two write-back paths already exist in the base agent's system prompt:

1. **§1 humanlayer path** (CTL-448) — `humanlayer thoughts init` against the read-only clone,
   followed by `humanlayer thoughts sync` from the routine. This pushes to `main` via the humanlayer
   machinery and is the right home for research, plans, and other long-lived artifacts that belong
   on `main`.
2. **Direct `git commit + push` to `main`** — rejected. Routines firing daily would dump one commit
   per weekday to `main`, polluting the history humans browse.

Morning briefings are per-day ephemeral artifacts the user reviews and discards. They do not belong
on `main`; a routine-scoped branch is the right home. The same shape will work for the upcoming
research-curate routine ([CTL-469](https://linear.app/coalesce-labs/issue/CTL-469)) on
`routines/curation`.

The session container has outbound network access, the GitHub PAT is already provisioned for the
read-only clone, and a second clone fits inside the existing 5–15s startup overhead budget. The
marginal cost of a second clone is small (the writable clone is full-depth so subsequent rebase +
push work, but the thoughts repo is small enough — ~5.6MB — that this is unmeasurable in routine
wall-clock time).

## Decision

**Add an opt-in §1a writable clone path to the base agent's system prompt.** When a routine sets
`WRITABLE_THOUGHTS=true` and `THOUGHTS_WRITABLE_BRANCH=<branch>` in its `env:` block, the base
agent's session-startup ritual also:

1. Clones `coalesce-labs/thoughts` writable at `/workspace/thoughts-writable/` (separate working
   copy from the read-only `/workspace/thoughts-repo/`).
2. Checks out the routine-scoped branch (creates it from `main` if it does not exist).
3. Symlinks `/workspace/thoughts/briefings` to the writable clone's
   `repos/${THOUGHTS_DIR}/shared/briefings` so skills writing canonical paths land in the writable
   tree.

At routine end (before session exit), the same base block calls a write-back routine:

1. `git add -A` in the writable clone.
2. `git commit -m "routine(${ROUTINE_NAME}): ${RUN_DATE}"`.
3. `git push origin ${THOUGHTS_WRITABLE_BRANCH}`. On push failure, `fetch` + `rebase` once and
   retry. Hard failure exits non-zero so the run is visibly broken in `claude.ai/code/routines`.

Read-only routines (the existing default) leave `WRITABLE_THOUGHTS` unset and see no change.

The PAT scope on `coalesce-labs/thoughts` upgrades from `Contents: Read` to `Contents: Read+Write`
for the vault that backs routines opting in. The multi-PAT pattern documented in
[`cma/mcp/github.md`](../mcp/github.md) is the documented escape hatch when leak blast radius
matters more than vault-setup simplicity.

## Considered options

| Option                                                                       | Why considered                                                                                              | Why rejected                                                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Push from the read-only clone**                                         | Saves a second clone                                                                                        | Mixes read and write contexts; PAT scope on a single working tree blurs the read-only contract documented in `2026-05-07-thoughts-strategy.md` |
| **B. Memory Store**                                                          | Already discussed as a future direction                                                                     | 5.6 MB / 329-file corpus exceeds the 100 KB-per-file × 8-store envelope — same reason it was rejected for the read ADR                         |
| **C. humanlayer thoughts sync to main** (already in §1)                      | The mechanism exists                                                                                        | Routes daily briefing commits to `main`, polluting the branch humans browse. Right home for research/plans; wrong home for daily artifacts     |
| **D. Per-routine writable second clone on a routine-scoped branch (chosen)** | Isolates the routine's commit stream, leaves `main` untouched, sits next to the existing read clone, opt-in | Adds 5–15s to startup latency for routines that opt in (acceptable for scheduled runs); requires PAT scope upgrade (documented)                |

## Rationale

1. **Routine-scoped branches keep `main` clean.** `main` is the branch humans browse. Daily weekday
   commits from the morning-briefing routine would pollute the history. A `routines/briefings`
   branch holds the same content under a name that signals "machine output, review before merging."
2. **A second working copy isolates write state.** Adding write capability to the read clone would
   couple two distinct postures in one directory tree. Skills that resolve paths relative to
   `/workspace/thoughts/shared/` should never accidentally stage changes; the second clone makes "is
   this read or write?" answerable by directory inspection.
3. **The mechanism generalizes to other routines.** `THOUGHTS_WRITABLE_BRANCH` and `ROUTINE_NAME`
   are routine-supplied. CTL-469 (research-curate) sets these to `routines/curation` and
   `research-curate` respectively — same block, different branch.
4. **It does not invalidate the parent ADR.** The accepted Option C decision is still the read
   posture. §1a is explicitly additive and opt-in; the read clone, symlinks, and
   `Treat thoughts as read-only` guidance for the default case all remain.
5. **CTL-295 remains the long-term home.** All five open questions in the parent ADR (write-back
   model, per-write vs per-session push, conflict handling, Memory Store split, PAT scope split)
   remain open. This ADR is a tactical step that ships morning-briefing without prejudging any of
   them.

## Consequences

### Positive

- Morning-briefing ships without a second-system rewrite of the read posture.
- The `routines/briefings` branch is independently reviewable, mergeable, and squashable.
- Generalizes to research-curate (CTL-469) with one env-var override.
- Failure modes are loud: push failures exit non-zero, which `claude.ai/code/routines` surfaces as a
  failed run.

### Negative

- PAT scope on `coalesce-labs/thoughts` widens to `Contents: Read+Write` for vaults backing opt-in
  routines. A leak compromises the routines-branches namespace (but still not `main` — push
  protections on `main` are unchanged).
- One commit per scheduled run accumulates on `routines/briefings`. The parent plan's refactor note
  proposes a weekly squash; deferred to CTL-295 / a follow-up.
- The clone is full-depth (not `--depth=1`) so the rebase path works. Adds ~5–15s to startup for
  opt-in routines. Acceptable for scheduled runs; would not be for interactive UX.

### Neutral

- The routine-scoped branch needs to be created by the first opt-in run if it does not exist
  upstream. The §1a block handles this with `git ls-remote --exit-code` + `git checkout -b`. No
  human pre-creation step required.
- `humanlayer thoughts init` is **not** invoked in the writable clone. Routines that need
  research/plans on `main` continue to use the §1 humanlayer path; routines that need per-run
  artifacts on a routine-scoped branch use §1a. The two mechanisms coexist.

## Open questions (deferred to CTL-295)

All five open questions from the parent ADR remain open:

1. **Write-back model.** Does the platform converge on per-routine branches, per-session pushes to
   `main` via humanlayer, Memory Store, or a hybrid?
2. **Per-write vs per-session push.** §1a pushes once at routine end. Is that the right granularity,
   or should it be per-write for routines that produce multiple artifacts?
3. **Conflict handling.** §1a rebases once on push failure. Is that sufficient? What does a
   second-tier failure path look like?
4. **Memory Store split.** Is Memory Store the right home for a small mutable subset (preferences,
   exclusions, learned state) layered alongside the git-clone bulk corpus?
5. **PAT scope split.** Should the writable-clone PAT be split from the read PAT to limit leak blast
   radius? The multi-PAT pattern in `cma/mcp/github.md` is already documented; the question is when
   to require it operationally.

This ADR explicitly does NOT resolve any of these. It is a tactical exception that ships
morning-briefing on the existing infrastructure pending CTL-295.

## Implementation

- `cma/agents/base-system-prompt.md` §1a — the writable clone + write-back blocks shown above.
  Re-inlined into `cma/agents/base.yaml`'s `system` body via the documented
  `yq -i '.system = load_str("cma/agents/base-system-prompt.md")'` flow.
- `cma/routines/morning-briefing/routine.yaml` sets:

  ```yaml
  env:
    WRITABLE_THOUGHTS: "true"
    THOUGHTS_WRITABLE_BRANCH: "routines/briefings"
    ROUTINE_NAME: "morning-briefing"
  ```

  The morning-briefing routine writes a single artifact under `thoughts/briefings/<date>.md`. §1a's
  `mkdir -p` + `ln -sfn` block sets up that exact path: `/workspace/thoughts/briefings` becomes a
  symlink into the writable clone's `repos/${THOUGHTS_DIR}/shared/briefings` subtree. Skills
  resolving the canonical `thoughts/briefings/` path therefore land in the writable tree without
  further wiring.

- `cma/routines/research-curate/routine.yaml` sets:

  ```yaml
  env:
    WRITABLE_THOUGHTS: "true"
    THOUGHTS_WRITABLE_BRANCH: "routines/curation"
    ROUTINE_NAME: "research-curate"
  ```

  The research-curate routine writes to `thoughts/shared/research/{INDEX,CONTRADICTIONS}.md` and
  `thoughts/shared/plans/{INDEX,CONTRADICTIONS}.md` — four artifacts under the `shared/` subtree
  served by the read-only clone. Because `shared/` is read-only, the §1a `briefings` symlink does
  not help here. Instead, the routine prompt invokes `run.sh` with absolute paths into the writable
  clone:

  ```bash
  THOUGHTS_DIR="${CATALYST_THOUGHTS_DIRECTORY:-catalyst-workspace}"
  WCLONE="/workspace/thoughts-writable/repos/${THOUGHTS_DIR}"
  bash plugins/dev/scripts/research-curate/run.sh \
    --git-dir /workspace/thoughts-writable "${WCLONE}/shared/research"
  bash plugins/dev/scripts/research-curate/run.sh \
    --git-dir /workspace/thoughts-writable "${WCLONE}/shared/plans"
  ```

  The §1a write-back block (`git add -A; git commit; git push`) picks up writes anywhere under
  `/workspace/thoughts-writable/` — no symlink is required. The §1a `briefings` symlink remains a
  harmless no-op for this routine (it creates an empty subdir that git never sees).

- `cma/mcp/github.md` footnotes the PAT scope upgrade on the thoughts repo for vaults backing opt-in
  routines (covers both routines — same vault).

## Follow-ups

- [CTL-470](https://linear.app/coalesce-labs/issue/CTL-470) — follow-on to research-curate (blocked
  by CTL-469). Likely needs the same §1a path.
- [CTL-295](https://linear.app/coalesce-labs/issue/CTL-295) — the durable long-term write-back model
  that may supersede this ADR.
- Periodic squash on `routines/briefings` (daily commits) and `routines/curation` (weekly commits)
  to keep the branches from growing without bound. Tracked in CTL-295 follow-ups.
- Generalise §1a's `briefings` symlink. The parent plan §Initiative 4 Phase 3 §Refactor proposes
  extracting the write-back step into a shared helper agent the base agent can include. The two
  current users (briefings, curation) sit at different depths in the thoughts tree and use different
  path strategies (symlink vs absolute path); a real helper extraction becomes worthwhile once a
  third routine surfaces a missing parameter. Deferred until then to avoid premature abstraction.
