# CTL-2192 fixtures — captured live signals, not authored ones

AC4 asks for proof against a **captured live signal** rather than an authored fixture, and for the
assertion to be the **property** (claims stop growing), not a neighbour (a log line disappears).
A fixture written to match the assumed model will agree with the assumption; these three trees were
already on disk from the investigation, so they can disagree.

## Capture

- **Host**: `mini-2` (`100aaff3cc33d9f7`), macOS, 2026-08-23.
- **Source**: `~/catalyst/execution-core/workers/<TICKET>/` and
  `~/catalyst/execution-core/.sdk-workers/CTL-2192.json` on the live daemon's orchDir.
- **Command shape**: a per-file copy through one `sed` scrub (below). Dotfiles are included — the
  `.applied` / `.fence-suppressed` / `.warm-resume-budget` markers change what boot-resume does, so
  omitting them would quietly reshape the fixture into agreement with the fix.
- **Scrub** — the ONLY transformation applied, and it is path-only:
  | from | to |
  | --- | --- |
  | `/Users/ryan/catalyst/execution-core` | `%ORCH%` |
  | `/Users/ryan/catalyst/wt` | `%WT%` |
  | `/Users/ryan` | `%HOME%` |

  The harness re-expands `%ORCH%` to its tmp dir. Verified: zero residual `/Users/ryan` occurrences
  across all 82 files.
- **Deliberately EXCLUDED** (not a silent truncation — this is the whole exclusion list):
  `inbox*.jsonl` in each worker dir. They are Linear comment prose, several KB each, and no part of
  the claim-ladder replay reads them.

## ⚠️ The `.fixture` suffix — a committed phase signal is NOT inert

The 13 captured phase signals are committed as **`phase-<name>.json.fixture`**, not under their live
name. `loadFixture` strips the suffix as it copies into its tmp orchDir, so the replay still sees
`phase-implement.json`; nothing about the captured bytes changes.

The suffix exists because the **production** `orphan-sweep.sh` mutates these files. Its
`sweep_signals` runs a fully recursive `find "$SWEEP_WORKERS_GLOB_ROOT" -name 'phase-*.json' -type f`
(`orphan-sweep.sh:803`) whose default root is `$HOME/catalyst` (`:355`) — and every Catalyst worktree
lives under that root (`~/catalyst/wt/...`), so a checkout of this repo puts these fixtures directly in
the sweep's path. Any match whose `.status` is `running`, whose `updatedAt` is stale, and whose
`bg_job_id` is not live is rewritten in place to `status: "failed"`, `failureReason:
"orphan-sweep-stale"` (`:745-:798`).

Measured, not hypothetical: with the files under their live name the sweep fired on the CTL-2192
worktree twice on 2026-08-23 (09:12:25Z and 10:35:37Z). Two consequences, both real:

1. **This suite goes RED.** The mutation breaks `CHECKSUMS.txt`, and re-applying it fails 4/19 of
   `ctl-2192-claim-ladder.test.mjs` (the checksum test, the PRE-FIX POSITIVE CONTROL, the AC2
   recovery test, and the legacy-projection test). It is green on CI only because a plain CI clone
   runs no orphan-sweep daemon — precisely the class of defect CI cannot catch.
2. **The worktree is left permanently dirty on a TRACKED file.** The path is in neither
   `WORKTREE_NOISE_PATHS` nor `_is_settling_debris_path`, so `_precheck_has_real_source` returns
   true and the CTL-707 dispatch-time rebase stalls `rebase_refused_dirty_tree` rc=2 — destroy +
   recreate on research/plan, a parked escalation on implement/verify/review. Every worktree that
   rebases onto this branch would inherit it.

Only one of the 13 captures was exposed (the other 12 are `done`/`stalled`/`needs-human`/
`stalled-retryable`, which `sweep_signals` skips at `:748`) — but one tracked dirty file is all
`_precheck_has_real_source` needs, and `running` is the state under replay, so narrowing the captured
status would have left the hole open for the next capture.

**Capturing new signals?** Keep the suffix. The repo-wide guard
`no tracked file is shaped like a live phase signal` in `ctl-2192-claim-ladder.test.mjs` enumerates
`git ls-files` and fails on any tracked `phase-*.json` carrying a `.status`, so a future capture
cannot reintroduce this silently. (Bounding orphan-sweep's own recursion — it descends into every git
worktree under `$HOME/catalyst` — is a separate follow-up; this fixture is only the first repo file to
collide with it.)

## Checksums

`CHECKSUMS.txt` holds `sha256  path` for all 82 committed files, and
`ctl-2192-claim-ladder.test.mjs` asserts every one still matches. A later edit that quietly
reshapes a fixture to agree with a new assumption fails there.

The checksums are of the **committed (scrubbed)** bytes, not the pre-scrub originals — the scrub is
lossy on absolute paths by design, so a pre-scrub checksum would not be reproducible from this repo.

## The three trees, and what each is for

### `CTL-2192/` — Producer B (boot-resume)

The claim ladder, with mtimes:

| file | mtime (UTC) |
| --- | --- |
| `triage.claim.1` | 2026-08-23T03:55:07Z |
| `triage.claim.2` | 2026-08-23T03:55:16Z |
| `research.claim.1` | 2026-08-23T03:59:37Z |
| `research.claim.2` | 2026-08-23T04:02:58Z |
| `plan.claim.2` | 2026-08-23T04:28:35Z |
| `plan.claim.1` | 2026-08-23T07:19:15Z |
| `implement.claim.1` | 2026-08-23T07:24:20Z |

`research.claim.2` lands **6 seconds** after `daemon-boot.json`'s 04:02:52.490Z — a new daemon, an
empty in-memory registry, and a fresh generation minted beside a worker that was still running.
That is Producer B by construction, and it is this ticket reproducing its own bug while being
worked.

`.sdk-workers/CTL-2192.json` is captured too and is itself evidence: `pid` is the **daemon's**,
`childPid` is `null`, and there is **no `childPidResolved` key**. That is exactly the legacy shape
the Phase 1 ladder must classify `unknown` rather than `dead`, and exactly the rollout population
the Migration Notes describe.

### `CTC-355/` — Producer A (preemption ⇄ resume)

19 claim files: 2 triage, 8 research (00:50:43 → 01:07:34, ~17 min), 7 plan (01:09:47 → 01:20:13),
4 implement (01:21:20 → 01:27:26).

**Attribution is structured, not a prose scrape.** Counted by exact `event.name` over
`~/catalyst/events/2026-08.jsonl` on 2026-08-23:

| event name | count |
| --- | --- |
| `phase.research.preempted.CTC-355` | 10 |
| `phase.plan.preempted.CTC-355` | 5 |
| `phase.implement.preempted.CTC-355` | 3 |
| `phase.*.resumed-after-preemption.CTC-355` | 7 |

Positive control on that instrument: 1788 `phase.*.preempted.<TICKET>` events in the same file, so
the 18 above are a real slice and not an artefact of a query that matches nothing.

⚠️ **One correction to the plan's description.** The plan cited
`attentionReason: "preempted-by-priority"` on this ticket's **implement** signal as the positive
identification. It is not there any more — `phase-implement.json` has since been overwritten by a
later `stalled` / `rebase_refused_dirty_tree` park. The marker survives on **`phase-research.json`**,
and the event counts above are the durable evidence. Recorded here rather than silently working
around it.

### `CTC-166/` — the negative control

Only 2 research claims and 1 triage claim, with `research.claim.2` from **two days earlier**
(2026-08-21) than `research.claim.1`. The ladder is **not** universal: a fix that always re-claims
(or a harness that assumes every tree ladders) is wrong in the other direction, and this tree fails
it.

## One state the harness deliberately reverts, and why

All three trees carry `.linear-label-needs-human.applied`, and in all three it post-dates the ladder
being replayed:

| ticket | marker mtime | last claim in the replayed ladder |
| --- | --- | --- |
| CTL-2192 | 2026-08-23T04:36:08Z | `research.claim.2` 04:02:58Z |
| CTC-355 | 2026-08-22T01:27:29Z | `implement.claim.4` 01:27:26Z |
| CTC-166 | 2026-08-23T04:53:12Z | `research.claim.1` 04:36:18Z |

`selectBootResumeCandidates` short-circuits on that marker **before** the liveness arm, so replaying
the tree as-captured would exercise nothing at all and still print green — a check that cannot fail.
The harness therefore removes it as an explicit, named step (`withPreEscalationState`), restoring
the state the ticket was in when the ladder was actually produced. The files stay in the fixture so
the capture remains verbatim and the revert stays auditable.
