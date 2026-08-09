---
title: Configuration
description:
  The two config files Catalyst reads — one safe to commit, one for secrets — and the keys that
  matter most.
sidebar:
  order: 0
---

Catalyst reads two config files. The setup script (`setup-catalyst.sh`) writes both for you, so you
rarely edit them by hand. This page covers the keys you're most likely to touch.

- **`.catalyst/config.json`** — plain project info. Safe to commit to git.
- **`~/.config/catalyst/config-{projectKey}.json`** — secrets like API keys. Never commit this.

For a multi-host execution-core installation, the machine-local
`catalyst.cluster.dispatchOutageFallback` key controls sustained peer-view outages. Its values are
`last-known-good` (the default) and `full-roster`. The environment variable
`CATALYST_DISPATCH_OUTAGE_FALLBACK` takes precedence. The setting is consulted only on the outage
path; healthy dispatch does not read machine configuration for it.

The `projectKey` links the two files.

## Project config (`.catalyst/config.json`)

Safe to commit. It holds your repo, your ticket names, and how workflow steps map to Linear
statuses.

```json
{
  "catalyst": {
    "projectKey": "acme",
    "repository": { "org": "acme-corp", "name": "api" },
    "project": { "ticketPrefix": "ACME", "name": "Acme Corp API" },
    "linear": {
      "teamKey": "ACME",
      "stateMap": {
        "todo": "Todo",
        "research": "In Progress",
        "inProgress": "In Progress",
        "inReview": "In Review",
        "done": "Done"
      }
    }
  }
}
```

| Key                                 | What it does                                               |
| ----------------------------------- | ---------------------------------------------------------- |
| `catalyst.projectKey`               | Links to the secrets file (`config-{projectKey}.json`)     |
| `catalyst.repository.org` / `.name` | Your GitHub org and repo                                   |
| `catalyst.project.ticketPrefix`     | Linear ticket prefix, e.g. `ACME`                          |
| `catalyst.linear.teamKey`           | Linear team key; must match `ticketPrefix`                 |
| `catalyst.linear.stateMap`          | Maps each workflow step to one of your Linear status names |

### State map

As work moves, Catalyst updates the ticket's Linear status for you. `stateMap` says which status
name to use for each step (`research`, `inProgress`, `inReview`, `done`, and so on). Set a key to
`null` to skip that update.

You usually don't edit this by hand. When you run `setup-catalyst.sh` with a Linear token, it reads
your real status names and fills `stateMap` in. Pointing `stateMap` at a status that doesn't exist
makes the next update fail, so only edit it if your status names are unusual.

## How work runs: `dispatchMode`

The `orchestration.dispatchMode` key picks how Catalyst runs each ticket:

- **`execution-core`** — the autonomous daemon. It watches your board, picks up ready tickets, and
  runs them with no command from you. This is the away-from-keyboard mode.
- **`phase-agents`** — runs each ticket as ten short background jobs, one per step.
- **`oneshot-legacy`** — one long-running job per ticket. The older default.

```json
{
  "catalyst": {
    "orchestration": {
      "dispatchMode": "execution-core",
      "maxParallel": 3,
      "worktreeDir": null,
      "phaseAgents": {
        "models": { "implement": "sonnet", "pr": "sonnet", "monitor-deploy": "haiku" },
        "turnCaps": { "implement": 100 }
      }
    }
  }
}
```

### Push remote (`catalyst.pr.pushRemote`, CAT-60)

The push remote is machine-local routing, so its canonical home is Layer 2 at
`~/.config/catalyst/config.json`, not the repository's committed Layer-1 file. Keeping it outside
the git tree means a rebase cannot rewrite the setting that selects where the branch is published.

Resolution is `CATALYST_PUSH_REMOTE` → `catalyst.pr.pushRemote` → the branch's configured upstream
remote → `origin`. The value must name an existing, safe git remote. It controls branch publication
and remote-branch discovery when a worker resumes. It does **not** change the rebase or diff base:
those continue to use `origin/<base>`. The operator-facing branch listing in `cli/branches.mjs` is
still an `origin`-only surface and does not determine dispatch or publication behavior.

```json
{ "catalyst": { "pr": { "pushRemote": "fork" } } }
```

### Publish-capability preflight (`catalyst.orchestration.publishPreflight.mode`, CAT-60)

Before dispatch, execution-core asks GitHub whether the active identity has push permission for the
repository behind the resolved push remote. `CATALYST_PUBLISH_PREFLIGHT` overrides the Layer-2
`catalyst.orchestration.publishPreflight.mode`; the default is `shadow`:

- `off` does not probe.
- `shadow` emits `publish.preflight.would-block` for denial but still dispatches.
- `enforce` emits `publish.preflight.blocked` and stops that dispatch on definitive denial.

Verdicts are `allowed`, `denied`, or `unknown`. An inconclusive `unknown` (missing `gh`, timeout,
transient API failure, or unparseable remote) never blocks. Results are cached per repository,
remote, and GitHub identity for a bounded TTL so scheduler ticks conserve GitHub API quota.
`catalyst doctor` reports the same capability independently: denied is advisory in `shadow` and a
failure in `enforce`.

| Key                                                           | Default                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestration.dispatchMode`                                  | `oneshot-legacy`             | Which run mode to use (above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `catalyst.orchestration.publishPreflight.mode` _(Layer-2)_    | `shadow`                     | Before dispatch, verify that the resolved GitHub identity can push to the configured push remote. `off` skips the probe; `shadow` reports denied capability but still dispatches; `enforce` blocks dispatch only on a definitive denied verdict. `CATALYST_PUBLISH_PREFLIGHT` overrides this value. Unknown values fall back to `shadow`. |
| `orchestration.executor`                                      | `bg`                         | Which substrate runs a phase worker: `bg` (a `claude --bg` background job, today's behavior), `oneshot-legacy`, or `sdk` (the in-process Claude Agent SDK — **not yet implemented; falls back to `bg`**, CTL-1365b). Resolution: `CATALYST_EXECUTOR` env → this key → node-class default (all classes → `bg` today). Distinct from `dispatchMode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `orchestration.maxParallel`                                   | `3`                          | How many tickets run at once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `orchestration.worktreeDir`                                   | `~/catalyst/wt/<projectKey>` | Where worktrees are created                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `orchestration.pluginDirs`                                    | unset                        | Path(s) to the plugin checkout(s) workers run from (`<checkout>/plugins/dev`). Set by `setup-plugin-source.sh`; resolved by `phase-agent-dispatch` and refreshed by `catalyst-stack hotpatch` / merge-to-main. String or `:`-joined array. May also live in the machine config (Layer 2); the `CATALYST_PLUGIN_DIRS` env var overrides both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `orchestration.pluginPullOwner` _(Layer-2, machine-local)_    | `broker`                     | Which process pulls plugin checkouts current on this node: `broker` (the drift-check timer does `git fetch` + `reset --hard`, today's default) or `updater` (the standalone `catalyst-updater` LaunchAgent owns the pull; the broker keeps drift **detection** + lag alerting but skips the pull — detect-only). Read fresh each broker tick; env override `CATALYST_PLUGIN_PULL_OWNER`. Flipped to `updater` only by the supervised `catalyst-stack adopt-updater` cutover, which first confirms the updater agent is running (fail-closed to `broker`). A daemonless **developer** node runs no broker, so the updater is the only thing keeping it fresh. (CTL-1348)                                                                                                                                                                                                                                                         |
| `orchestration.phaseAgents.models[phase]`                     | `opus`                       | Model per step (`opus`, `sonnet`, or `haiku`). Phases: `triage`, `research`, `plan`, `implement`, `verify`, `review`, `pr`, `monitor-merge`, `monitor-deploy`, `teardown`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `orchestration.phaseAgents.turnCaps[phase]`                   | per-phase                    | Max Claude turns per step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `orchestration.draftPr.enabled`                               | `true`                       | Open a draft PR at the first implement commit; phase-pr flips it ready. Set `false` to create the PR only at the pr phase.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CATALYST_WORKFLOW_GITHUB_TOKEN` _(env var, never committed)_ | unset                        | A GitHub PAT with the `workflow` OAuth scope. When set, phase-pr automatically routes pushes that touch `.github/workflows/` through this token instead of the ambient `GITHUB_TOKEN` (which lacks `workflow` scope). When unset and such a push is attempted, phase-pr escalates with an actionable `human_question` telling the operator to grant the scope or push manually. Provision via the daemon launch environment or `~/.config/catalyst/config-<projectKey>.json`. Alternative: `gh auth refresh -s workflow` re-auths the host token.                                                                                                                                                                                                                                                                                                                                                                               |
| `orchestration.stalePrRescue.enabled`                         | `true`                       | Periodically rescue orphaned PRs that drifted to DIRTY or BEHIND after their workers died.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `orchestration.stalePrRescue.intervalSeconds`                 | `600`                        | How often the rescue timer ticks (seconds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `orchestration.stalePrRescue.stableSeconds`                   | `300`                        | How long a PR must sit DIRTY/BEHIND before a rescue is attempted (avoids reacting to transient states).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `orchestration.stalePrRescue.behindThreshold`                 | `10`                         | BEHIND-commit count that triggers a rebase rescue (commits-behind below this are skipped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `orchestration.stalePrRescue.maxAttempts`                     | `1`                          | Max rescue attempts per ticket. After exhaustion, the ticket is escalated to `needs-human`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `orchestration.stalePrRescue.maxConflictFiles`                | `5`                          | Max conflicting files before a DIRTY PR is deemed unresolvable and escalated instead of dispatched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `orchestration.orphanPrSweep.enabled`                         | `true`                       | Periodically scan all open PRs in the configured repo for ones that have no pipeline worker (orphans). When an orphan has been in a blocker state (DIRTY/BLOCKED/UNSTABLE) for `stableSeconds`, raises exactly one Needs-You inbox row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `orchestration.orphanPrSweep.intervalSeconds`                 | `600`                        | How often the orphan-PR sweep ticks (seconds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `orchestration.orphanPrSweep.stableSeconds`                   | `300`                        | How long an orphan must hold a blocker state before a Needs-You row is raised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `orchestration.orphanPrSweep.repo`                            | _(auto-detected)_            | The `org/repo` slug to pass to `gh pr list`. Falls back to top-level `.catalyst/config.json` repo fields, then `gh repo view`. Set this explicitly when auto-detection is unreliable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `orchestration.stalledPrSweep.enabled`                        | `false`                      | Periodically sweep all in-flight worker PRs for review-latency, CI-health, and no-push signals independent of worker liveness (CTL-1608). **Default-off** — enable only after validating thresholds on the live board. When enabled the timer writes `workers/<TICKET>/stalled-pr.json`; board-health reads those stamps via `getStalledPrState` and emits `nudge-stalled-pr` moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `orchestration.stalledPrSweep.intervalSeconds`                | `900`                        | How often the stalled-PR sweep ticks (seconds). Configurable per the `CATALYST_BH_STALLED_PR_*` env thresholds below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `orchestration.githubQuotaSweep.enabled`                      | `true`                       | Sample the host's GitHub core REST quota and atomically publish it to `<orchDir>/github-quota.json`. Set `false` to disable the timer; a previous snapshot may remain on disk but becomes stale and cannot arm board-health.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `orchestration.githubQuotaSweep.intervalSeconds`              | `300`                        | How often the daemon runs the quota sampler (seconds). The sampler calls the quota-reporting endpoint, which does not consume the core quota it reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `responder.intervalSeconds`                                   | `180`                        | How often the daemon-health responder launchd sweep runs (seconds, clamped 60–900). The responder (`health-responder.sh`, CTL-1509) detects a dead/stale cloud-sync replica writer and issues bounded `launchctl kickstart`s, escalating after the attempt cap. Baked into the launchd plist at install time (`install-health-responder.sh`); re-run `catalyst-stack install-services` after changing it.                                                                                                                                                                                                                                                                                                          |
| `orchestration.reconcile.mode`                                | `off`                        | Completion-declaration reconcile timer (CTL-1371). Linear state is driven by **explicit completion declarations** — the model/pipeline/human says "this is done" via `catalyst-linear-reconcile declare <TICKET>` — **never** inferred from PR/merge state (a draft PR opens while work is in progress; a merged PR is not yet Done — the pipeline puts deploy-verification + teardown between merge and Done). The timer drains _pending_ declarations and makes Linear reflect them, retrying any write that didn't land. `off` = inert (also the default); `notify` = compute drift + emit `ticket.completion.drift.<ticket>` events but **never write** (safe first-ship); `write` = write the declared state via the canonical primitive. Runs on the daemon event loop, separate from the dispatch scheduler. Idempotent + CTL-758 backward-write guard (never resurrects a Canceled ticket, never regresses a Done one). |
| `orchestration.reconcile.intervalSeconds`                     | `600`                        | How often the drain timer ticks (seconds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `orchestration.reconcile.declarationsDir`                     | `~/catalyst/completions`     | Directory holding the durable per-ticket completion markers (`<TICKET>.json`). Overridable via `CATALYST_COMPLETIONS_DIR`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `orchestration.orphanReaper.jobGc.enabled`                    | `true`                       | Enable periodic GC of stale `~/.claude/jobs/<id>` dirs (CTL-1165 D3). Set `false` to disable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `orchestration.orphanReaper.jobGc.retentionSeconds`           | `86400`                      | Delete a job dir only if its mtime is older than this many seconds (default 24 h). Env `CATALYST_JOB_GC_RETENTION_SECONDS` overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `orchestration.orphanReaper.jobGc.batchCap`                   | `200`                        | Max dirs deleted per sweep tick. Remaining dirs drain on subsequent ticks. Env `CATALYST_JOB_GC_BATCH_CAP` overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `orchestration.orphanReaper.workerGc.enabled`                 | `true`                       | Enable periodic GC of stale `execution-core/workers/<TICKET>/` dirs (CTL-1205). Set `false` to disable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `orchestration.orphanReaper.workerGc.retentionSeconds`        | `86400`                      | Delete a worker dir only if its mtime is older than this many seconds (default 24 h). Env `CATALYST_WORKER_GC_RETENTION_SECONDS` overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `orchestration.orphanReaper.workerGc.batchCap`                | `100`                        | Max worker dirs deleted per sweep tick. Env `CATALYST_WORKER_GC_BATCH_CAP` overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `orchestration.orphanReaper.procReaper.mode`                  | `shadow`                     | Orphan child-process reaper mode. `off` disables it; `shadow` (the default) logs `procOrphans.would-reap` for each candidate but **kills nothing**; `enforce` actually `SIGTERM`→grace→`SIGKILL`s them. Candidates are (a) orphaned reparented `node`/`bun` grandchildren a dead worker left behind, and (b) since CTL-1531, an orphan of **any** command that satisfies the ownership conjunction `ppid == 1` **and** cwd under `worktreeRoot` **and** that cwd definitely no longer exists (the `sh -c` runaway class) — that widened class is gated by its own `widenMode` knob and is **not** armed by setting this one to `enforce`. Ships in `shadow` so the never-kill allowlist + live-agent process-tree correlation — and the widened class in particular — can be audited on real hosts before any `enforce` flip.                                                                                                                                                                                                                                 |
| `orchestration.orphanReaper.procReaper.widenMode`             | `shadow`                     | **Independent** rollout mode for the CTL-1531 *widened* (any-command) orphan class, deliberately NOT derived from `mode`. `off` removes the widened admission entirely (a byte-identical revert of the feature); `shadow` (the default) classifies and reports widened candidates via `procOrphans.would-reap` but **never signals them, even when `mode` is already `enforce`**; `enforce` lets a widened candidate follow `mode`, so BOTH knobs must be open before an arbitrary PPID-1 command is signalled. An unrecognized value degrades to `shadow`, never to `enforce`. This exists because a host that already carries `mode: "enforce"` — granted for the narrow `node`/`bun` class after *its* shadow bake — must not inherit authority over the widened class on deploy; ADR-023 requires a per-actuator shadow window and an operator-owned flip. Mirrors `orphan-sweep.sh`'s `SWEEP_PROC_WIDEN`. |
| `orchestration.orphanReaper.procReaper.widenMaxKills`         | `5`                          | Per-run cap on **confirmed** terminations from the widened class (`0` = uncapped), mirroring `orphan-sweep.sh`'s `SWEEP_PROC_WIDEN_MAX_KILLS` and vector 2's `SWEEP_MAX_REMOVALS`. Delivered signals carry a second ceiling of `widenMaxKills × 2`, since a candidate is worth at most SIGTERM + SIGKILL; counting confirmed exits (not attempts) against the first ceiling is what stops a process that ignores SIGTERM from consuming a slot forever. The widened class's authorizing evidence — "this cwd no longer exists" — is **correlated** across a host, so a run that wants to kill more than a handful is a root-level event that wants a human. A non-numeric **or non-integer** value degrades to `5`, never to uncapped — a fractional cap such as `0.5` used to floor to `0`, which is the documented *uncapped* value, so a config typo silently removed the ceiling. |
| `orchestration.orphanReaper.procReaper.graceMs`               | `5000`                       | Milliseconds to wait after `SIGTERM` before re-probing and (only if still alive) `SIGKILL`ing, so `node`/`bun` can flush.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `orchestration.orphanReaper.procReaper.minEtimeSec`           | `900`                        | A process must have run at least this long (elapsed time) before it is eligible — corroboration only, never the sole gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `orchestration.orphanReaper.procReaper.worktreeRoot`          | `~/catalyst/wt`              | Only orphans whose working directory is under this root are reapable; an interactive `claude` or dev shell outside it is never touched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `orchestration.orphanReaper.procReaper.allowlistPatterns`     | `[]`                         | Extra case-insensitive argv substrings to never kill, on top of the built-in allowlist (the daemon, `broker/index.mjs`, `orch-monitor/server.ts`, the entire live-agent process tree, Tailscale, pid 1, and any foreign-uid process).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `orchestration.fleetHealth.enabled`                           | `true`                       | Whether the pre-exhaustion fleet-health probe runs. Set `false` (or `CATALYST_FLEET_HEALTH=0`) to disable it entirely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `orchestration.fleetHealth.intervalMs`                        | `120000`                     | How often the probe samples the four steady-state signals (milliseconds).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `orchestration.fleetHealth.jobsThreshold`                     | `500`                        | `~/.claude/jobs` dir count at or above which the `jobs` signal trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `orchestration.fleetHealth.agentsThreshold`                   | `12`                         | Live background-agent count at or above which the `agents` signal trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `orchestration.fleetHealth.procsThreshold`                    | `40`                         | Resident `node`/`bun` worker-process count at or above which the `procs` signal trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `orchestration.fleetHealth.swapUsedMbThreshold`               | `24576`                      | macOS swap-used MB at or above which the `swap` signal TRIPS (edge-triggered since CTL-1503). Raised above a 16 GB Mac's normal-swap ceiling so it stops firing every tick. Env `EXECUTION_CORE_FLEET_SWAP_MB_THRESHOLD`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `orchestration.fleetHealth.swapUsedMbClearThreshold`          | `16384`                      | CTL-1503 hysteresis band — the latched swap degradation CLEARS (fires `fleet.health.recovered` once) only when swap drops strictly below this LOWER threshold, so a value hovering in `[clear, trip)` can't re-flap. Clamped below `swapUsedMbThreshold` if misconfigured. Env `EXECUTION_CORE_FLEET_SWAP_MB_CLEAR_THRESHOLD`. |
| `orchestration.fleetHealth.selfHealEnabled`                   | `false`                      | Whether a sustained breach triggers self-heal (the two orphan-reaper intents plus a bounded `ppid==1` `node`/`bun` child sweep). **Default OFF** — the first ship is a pure alert. Enable with `EXECUTION_CORE_FLEET_SELF_HEAL=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `orchestration.fleetHealth.sustainedTicks`                    | `2`                          | Consecutive degraded ticks required before self-heal fires (once per breach episode; re-armed only after a healthy tick).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `catalyst.stallJanitor.censusIntervalSeconds` _(Layer 2)_     | `900` (15 min)               | How often the stall-janitor's git-heavy worktree/stall censuses (J1 orphan-worktree, J3 stall-clear, J4 terminal-signal GC) may run, off the per-tick scheduler hot path. Each fires a `git worktree list` per repo plus a `git status` per terminal worktree, so running them every tick on a many-worktree host ages the daemon heartbeat and holds new-work dispatch; this cadence keeps them off the hot path while the cheap J2 ghost-session kill still runs every tick (CTL-1324). Env `CATALYST_STALL_JANITOR_INTERVAL_MS` (milliseconds) overrides.                                                                                                                                                                                                                                                                                                                                                                    |

The orphan child-process reaper is the corroboration-heavy companion to the session-level reaper:
`claude stop` deregisters a worker's claude agent but leaves its reparented `node`/`bun`
grandchildren (MCP servers, sub-agent tooling, `bun test` runners) running — the bulk of the
resident-memory leak. It runs on the same 600-second cadence as the orphan-session sweep and refuses
to act unless every signal corroborates: a successful `claude agents` read this cycle (a failed read
aborts the whole sweep), the process is reparented and outside the live-agent process tree, its
command and working directory match, and it has persisted across two consecutive sweeps.

CTL-1531 widened *which commands* can be a candidate without relaxing any of that corroboration. A
non-`node`/`bun` orphan — the motivating case was four `sh -c "while :; do :; done"` loops that
pegged ~4 cores for 16.5 h from a worktree that had been deleted — is admitted **only** on positive
ownership evidence: strictly `ppid == 1`, cwd under `worktreeRoot`, and that cwd path no longer
existing. Both new probes fail closed (an unresolvable cwd, or a cwd-existence check that cannot
answer, spares the process), nothing outside `worktreeRoot` is ever a candidate regardless of ppid
or command, and the widened row still passes through every pre-existing gate.

That "cwd no longer exists" probe is **tri-state**, not a boolean: it distinguishes *definitely gone*
(a `stat` errno of `ENOENT`) from *cannot tell* (`EACCES` on an unreadable parent, `EIO` on a failing
disk, `ESTALE`/`ENOTCONN` on a dropped network mount), and spares on the latter. A plain
`existsSync`/`[[ -d ]]` collapses both into `false`, which would read an unanswerable probe as
positive evidence the worktree was deleted — the inversion of the fail-closed rule, on the one
conjunct that authorizes killing an arbitrary command.

Because the widened class can signal *any* command, it is staged behind its **own** rollout mode —
`procReaper.widenMode` in the daemon, `SWEEP_PROC_WIDEN` in the shell sweep — which defaults to
`shadow` **independently of `procReaper.mode`**. A host already running `mode: "enforce"` therefore
merely observes the new class until an operator flips the second knob (ADR-023: dark by default, one
knob per actuator, no enable-on-merge). In the daemon, an enforcing widened candidate additionally
has its whole ownership conjunction (ppid, argv, live-agent ownership, cwd still under the root and
still deleted) **re-proved from a fresh read immediately before the SIGTERM** — candidates are
classified from one snapshot and then signalled serially, so a late candidate would otherwise act on
evidence tens of seconds stale. Neither implementation ever writes a candidate's full argv to a log
line or event payload: an arbitrary command's argv routinely carries tokens, passwords and signed
URLs, and both logs are persisted (the daemon's is shipped to Loki), so only pid, command basename
and reason are recorded.

The same widening lands in the hourly `orphan-sweep.sh` vector 1 as an **additional** branch alongside the legacy
`bun run|turbo|node` branch (which stays path-unrestricted). Both implementations also carry a
widened-class-only **command denylist** (`tmux`, `screen`, `sshd`, `ssh`, `mosh-server`, `login`,
`launchd`, `init`, `systemd`, `nohup` — anchored so the `progname: ` setproctitle form such as
`tmux: server …` and `sshd: ryan [priv]` is matched): a session multiplexer is `ppid == 1` by
construction and inherits its cwd from whatever shell started it, so one kill would close every pane
the operator has open.

The shell branch is staged by these env vars (set them in the LaunchAgent's `EnvironmentVariables`;
`SWEEP_PROC_WIDEN` is baked into the shipped plist template by `install-orphan-sweep.sh`, which preserves an existing flip across the plist regeneration that every routine `install-services` performs — see `docs/orphan-sweep.md` → "Flipping the widened branch to enforce"):

| Env                             | Default  | Meaning                                                                                                                                                                                                                     |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SWEEP_PROC_WIDEN`              | `shadow` | `off` \| `shadow` \| `enforce` for the widened branch. **Dark by default** per ADR-023 — the flip to `enforce` is operator-owned, never enable-on-merge. Any other value logs a warning and falls back to `shadow`.            |
| `SWEEP_PROC_WIDEN_MAX_KILLS`    | `5`      | Per-run cap on **confirmed** widened terminations (`0` = uncapped), mirroring vector 2's `SWEEP_MAX_REMOVALS`. Counted on the enforcing path only, so `shadow` still reports the full candidate set. Overflow is logged and deferred to the next run. Delivered signals carry a second ceiling of `cap × 2`. |
| `SWEEP_PROC_WIDEN_MIN_AGE_SECS` | `900`    | Minimum process age (elapsed seconds) for a widened kill, matching `procReaper.minEtimeSec`. An unreadable age fails closed.                                                                                                  |
| `SWEEP_PROC_WIDEN_GRACE_SECS`   | `5`      | Seconds to wait for a **confirmed exit** after each of SIGTERM and SIGKILL. `kill` reports delivery, not exit — only a process observed to have actually gone is logged and emitted as reclaimed.                              |
| `SWEEP_PROC_CWD_TIMEOUT_SECS`   | `5`      | Deadline for the per-pid `lsof` cwd probe, so one hung/stale mount cannot wedge the LaunchAgent run. A timed-out probe yields an unknown cwd (spare), never a truncated path.                                                    |
| `CATALYST_LSOF_TIMEOUT_MS`      | `5000`   | The daemon-side sibling: the deadline `proc-reaper.mjs` puts on its own `lsof` cwd probe (single-pid and batched). A value outside `(0, 600000]` degrades to `5000`, never to unbounded. Scope is `lsof` only — the cwd **existence** probe is unbounded on both sides (declared, not implied). |

Both implementations refuse to run the widened branch at all when the worktree root itself is
missing or unreadable (`SWEEP_WT_ROOT` in the shell, `procReaper.worktreeRoot` in the daemon): a
renamed or unmounted root makes *every* cwd beneath it look deleted in the same pass, which is a
root-level fault rather than N independent orphans — and two-sweep persistence is no defense there,
because the same correlated fault answers both sweeps. Both also bound the widened class per run
(`widenMaxKills` / `SWEEP_PROC_WIDEN_MAX_KILLS`), bound the `lsof` cwd probe with a deadline so one
hung mount cannot wedge the sweep, and treat a liveness probe that *could not answer* as unknown
rather than as a confirmed exit — so a reclamation is only ever recorded for a process observed to
have actually gone.

Because these are two implementations of one policy, they have drifted in both directions across
review rounds. Every shared safety property now carries a `PARITY: <slug>` marker at its site in
both `plugins/dev/scripts/execution-core/proc-reaper.mjs` and `plugins/dev/scripts/orphan-sweep.sh`,
and `proc-reaper.test.mjs` asserts the two marker sets are identical — so a hardening added to one
side without the other fails CI instead of waiting for a reviewer.

The fleet-health probe is the steady-state guardrail that ties the reapers together: it samples four
degradation signals (the `~/.claude/jobs` dir count, the live background-agent count, the resident
`node`/`bun` worker-process count, and macOS swap-used MB), each read fail-safe so an unreadable
signal can only cause the probe to under-react. On a threshold breach it emits one
`fleet.health.degraded` event (the host lives in the OTel `resource` block, so the monitor composes
`fleet.health.degraded.<host>`). Self-heal is **default OFF** — the first ship is pure
observability. When enabled it fires the same two reap intents the 600-second timer emits plus a
capped (25-process) `node`/`bun` child sweep, once per sustained breach, re-armed only after the
fleet recovers to healthy.

For `execution-core` mode, the number of workers comes from a separate committed block,
`orchestration.executionCore.maxParallel` (default `4`). One daemon runs per machine and serves all
your projects.

### Which tickets the daemon picks up

In `execution-core` mode, the daemon reads a central registry at
`~/catalyst/execution-core/registry.json`. Each project there has an `eligibleQuery` that says which
tickets the daemon should pick up — `status: "Todo"`. The setup tool
`setup-execution-core-states.sh` writes this for you; you don't edit it by hand. That mode also
relies on the pipeline states — `Research`, `Plan`, `Implement`, `Validate`, and `PR` — which the
same tool creates on top of the `Todo` and `Triage` states your team workflow already has.

If the registry is missing (a fresh or headless host), enroll a project with
`catalyst-execution-core register --team <TEAM> --repo-root <path>` rather than writing the file by
hand — see [Remote and unattended hosts](/getting-started/remote-and-unattended-hosts/).

### Worker-status labels

Catalyst uses a workspace-scoped `worker-status` Linear label group with four mutually-exclusive
values (`queued`, `blocked`, `needs-input`, `needs-human`) to surface each worker's disposition on
the ticket — independently of where the ticket is in the pipeline. The
`setup-execution-core-states.sh` tool creates this group idempotently and never duplicates it. You
do not configure the label values in `config.json` — the group is a Linear-side contract that the
setup tool manages. See the
[Worker-status labels reference](/autonomous-workflow/worker-status-labels/) for what each label
means and how the HUD displays them.

## Linear app-actor identity (`catalyst.linear.bot.{worker,orchestrator}.botUserId`)

Catalyst posts to Linear as a Linear OAuth **app actor** — the "Linear for Agents" identity that
comments **as Catalyst**. Linear OAuth apps are account-level (one app serves every team), so the
bot identity and OAuth credentials now live in the **global** `~/.config/catalyst/config.json` under
`catalyst.linear.bot`, split into two app actors:

- `catalyst.linear.bot.worker` — the worker app that posts phase-agent mirror comments and mints
  tokens via `client_credentials`.
- `catalyst.linear.bot.orchestrator` — the orchestrator app that posts run-level updates.

Each carries a `botUserId` (the Linear user UUID of that app actor). The daemon and orch-monitor
read **both** `botUserId`s into a single set so the self-echo / loop-prevention guard suppresses
comments and issue events from **either** app actor. These UUIDs aren't secret (they appear on every
comment the app posts), but they are account-specific.

```json
{
  "catalyst": {
    "linear": {
      "bot": {
        "worker": {
          "clientId": "...",
          "clientSecret": "...",
          "webhookSecret": "...",
          "accessToken": "...",
          "botUserId": null
        },
        "orchestrator": {
          "clientId": "...",
          "clientSecret": "...",
          "accessToken": "...",
          "botUserId": null
        }
      }
    }
  }
}
```

| Key                                                                            | What it does                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalyst.linear.bot.worker.botUserId`                                         | Linear user UUID of the worker app actor. Suppresses self-echo on mirror comments / description updates. Also the read ID for the daemon's self-echo filter.                                                                                                                                                                                      |
| `catalyst.linear.bot.orchestrator.botUserId`                                   | Linear user UUID of the orchestrator app actor. **Also drives self-assign on claim (CTL-1011)** — the daemon writes this UUID as the Linear assignee when it claims a ticket. When absent, `applyAssignee` emits a single deduped `warn` and leaves the ticket unassigned. Daemon reads it **only at startup** — restart required after changing. |
| `catalyst.linear.bot.worker.{clientId,clientSecret,webhookSecret,accessToken}` | OAuth app-actor credentials for the worker identity. Secrets — keep in the un-committed global config                                                                                                                                                                                                                                             |

> **Self-assign activation:** `catalyst.linear.bot.orchestrator.botUserId` must be set AND the
> app-actor token must carry the `app:assignable` OAuth scope for the assignee write to succeed. If
> the token lacks scope, a deduped `warn` is emitted once per Linear team with the re-mint remedy.
> See [Self-assign activation runbook](/reference/configuration#self-assign-activation-runbook)
> below.

### Back-compat (transition period)

Every reader prefers the new global path and falls back to the old location, so a running daemon or
webhook receiver keeps working whether the value has been migrated yet:

- **Bot IDs:** `catalyst.linear.bot.{worker,orchestrator}.botUserId` (global) → fall back to
  `catalyst.monitor.linear.botUserId` (per-repo `.catalyst/config.json`, the legacy single-actor
  location).
- **Worker OAuth creds:** `catalyst.linear.bot.worker.{clientId,clientSecret}` (global) → fall back
  to `catalyst.linear.agent.{clientId,clientSecret}` (per-team
  `~/.config/catalyst/config-{projectKey}.json`, the legacy location).

The legacy keys remain readable, so you can migrate the values at any time without coordinating a
restart.

### Why it's required

Catalyst's app identity lets it post comments as the app, and a human reply on a ticket can wake a
parked worker. To make that work, the system must tell the agent's **own** comments and description
updates apart from a human's. Without a `botUserId` loaded:

- The agent's own mirror comments get written into the worker inbox as if a human had replied —
  noise, and a false "human replied" signal.
- Bot-authored issue events feed back into the event log as write loops.

So the `botUserId` set is the self-echo and loop-prevention guard for the whole Linear-for-Agents
channel. Set at least the worker `botUserId` for any workspace that uses the app-actor comms.

### How to obtain it

Query `viewer.id` with each app-actor token. The app OAuth credentials live in the global secrets
file under `catalyst.linear.bot.{worker,orchestrator}` (legacy: `catalyst.linear.agent` in the
per-team file):

```bash
TOKEN=$(jq -r '.catalyst.linear.bot.worker.accessToken // .catalyst.linear.agent.accessToken' ~/.config/catalyst/config.json)
BOT_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query{viewer{id name}}"}' | jq -r .data.viewer.id)
```

Write `$BOT_ID` into `~/.config/catalyst/config.json` under `catalyst.linear.bot.worker.botUserId`
(repeat for the orchestrator actor), then restart both readers — they only load it at startup:

```bash
catalyst-monitor stop && catalyst-monitor start
catalyst-execution-core restart
```

## Secrets config (`~/.config/catalyst/config-{projectKey}.json`)

Never commit this. One file per project, linked by `projectKey`. It holds API keys.

```json
{
  "catalyst": {
    "linear": { "apiToken": "lin_api_...", "teamKey": "ACME" },
    "sentry": { "org": "acme-corp", "project": "acme-web", "authToken": "sntrys_..." },
    "posthog": { "apiKey": "phc_...", "projectId": "12345" }
  }
}
```

| Integration | Required fields               | Used by                   |
| ----------- | ----------------------------- | ------------------------- |
| Linear      | `apiToken`, `teamKey`         | catalyst-dev, catalyst-pm, orch-monitor inbox reply |
| Sentry      | `org`, `project`, `authToken` | catalyst-debugging        |
| PostHog     | `apiKey`, `projectId`         | catalyst-analytics        |

Only set up the integrations you use — the setup script asks about each one.

### `linear.apiToken` must be a PERSONAL token, not the app-actor's

The orch-monitor Inbox's reply/unblock feature
([`lib/linear-comment.mjs`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/orch-monitor/lib/linear-comment.mjs))
posts comments as **you**, not as the Catalyst app — a Linear provenance gate (CTL-1567) deliberately
ignores app-authored comments, so a reply posted as the bot would silently do nothing. It resolves a
candidate token from, in priority order: env `LINEAR_API_TOKEN` → env `LINEAR_API_KEY` → this file's
`linear.apiToken` → the nested `catalyst.linear.apiToken` — and identity-checks EACH candidate, using
the first one that resolves to a real human (skipping, not failing on, any that resolve to an app
actor).

This matters because `LINEAR_API_TOKEN`/`LINEAR_API_KEY` are not exclusively a personal-token slot:
`lib/linear-app-actor.sh` exports the app-actor's own OAuth token into those same two env vars for any
daemon that needs bot credentials (broker/execution-core/monitor heartbeats). If your monitor process
sources that script, its env will always carry a non-empty (but bot) token — the identity walk exists
precisely so your real `linear.apiToken` here still gets tried and used instead of being permanently
shadowed. Generate a personal key at Linear → Settings → API → Personal API keys (`lin_api_...`, not
an OAuth `lin_oauth_...` value) and put it here.

## Cluster machine-level cloud token (`CATALYST_CLOUD_TOKEN`, CTL-1307)

`CATALYST_CLOUD_TOKEN` is a single **shared** service credential — the catalyst-cloud `ADMIN_TOKEN`
(interim, per CTC-27 / ADR-0006) — that must be **identical on every node**. It is an **optional
extension**: provisioning the token does **not** by itself change Catalyst's behavior. Catalyst
stays in its normal **local-only** state unless **both** the token is set **and** you have
specifically configured Catalyst to use the cloud (e.g. local replication + cloud-fed read). Nothing
in Catalyst reads the variable; only the opt-in cloud host-sync daemon (out-of-repo:
`catalyst-replica` / `catalyst-cloud`) consumes it. So it is safe to provision cluster-wide without
altering default behavior.

**Where it lives (shared state):** encrypted in the `catalyst-cluster` repo as
`secrets/cluster-cloud.sops.json` (a separate SOPS file from `cluster-bots`, so the cloud token can
rotate / be garbage-collected independently — it is superseded by per-tenant org-scoped keys per
CTC-46):

```json
{ "catalyst": { "cloud": { "token": "<catalyst-cloud ADMIN_TOKEN>" } } }
```

**How it reaches each node's machine-level environment (no manual per-host step):**

1. `cluster-sync` (daemon boot) decrypts it to `~/.config/catalyst/cluster-cloud.json` (mode
   `0600`), the same path every other cluster-shared secret takes.
2. `cloud-token-env.mjs` — run by `catalyst-stack start` (boot + keep-alive), or on demand via
   `catalyst-stack sync-cloud-env` — projects it:
   - writes the secret to `~/.config/catalyst/cluster.env` (mode `0600`), and
   - ensures a single **non-secret** guard line in `~/.zshenv` that sources `cluster.env`.
3. Every login/zsh shell — and any cloud daemon **(re)started in a shell context**, this fleet's
   convention for env-key pickup — then inherits `CATALYST_CLOUD_TOKEN`.

Rotation is boot-scoped: after the value changes in the cluster repo, run `catalyst cluster sync`
(or restart the daemon) to re-decrypt, then `catalyst-stack sync-cloud-env`, and restart any cloud
daemon so it picks up the new value. `catalyst doctor` reports an advisory `cloud-token` WARN if a
token is decrypted but not yet projected to the machine-level env. The operator runbook for
adding/rotating the secret in the `catalyst-cluster` repo lives in the `docs/cluster-onboarding.md`
developer guide ("Provisioning the shared cloud token").

## Node class (`catalyst.node.class`, CTL-1344)

`catalyst.node.class` names **what kind of machine this is**. It is the front door to per-class
packaging — one declarative field that sets sensible **defaults for levers that already exist**
(cluster-roster membership, boot-drain, which daemons start, where board reads come from). It adds
**no** new dispatch gate; the scheduler is unchanged.

| Class       | What it is                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `developer` | A daemonless client you chat on. Not in the cluster roster, boots drained, runs no execution-core daemon or broker — it reads board UI data from a worker's monitor (agent Linear reads follow the two-mode rule — see the `catalyst-dev:linearis` skill's "Reading Linear" section). On `catalyst-stack start`, the event-mirror daemon fans worker host event logs into the local copy so `catalyst-events tail`/`wait-for` see fleet events. |
| `worker`    | Runs the full stack and picks up work (the default; a laptop that both runs the daemon and is chatted on is a "head-full worker").                                                                                                                                                    |
| `monitor`   | A dedicated reporting host (CTL-1654). Like `developer` it carries the observation substrate (broker + monitor + event-mirror) without the execution layer (no heartbeat, no dispatch, no recovery). The event-mirror daemon (`event-mirror/index.ts`, launchd-supervised) fans each worker host's event log into the local `~/catalyst/events/YYYY-MM.jsonl` via ssh-tail with per-host byte cursors, so `catalyst-events tail`/`wait-for` resolve fleet events locally. Verify with `catalyst-stack verify-node`. |

The class is **machine-local**, so it lives in **Layer-2** (`~/.config/catalyst/config.json`) beside
`catalyst.host.name` — the same repo is checked out on every machine, so the role is per-machine,
not per-repo:

```json
{ "catalyst": { "node": { "class": "developer" } } }
```

**Resolution** mirrors `catalyst.host.name` (`getNodeClass()` in `execution-core/config.mjs`):

| Precedence | Source                                        |
| ---------- | --------------------------------------------- |
| 1          | `CATALYST_NODE_CLASS` env var (test/override) |
| 2          | `catalyst.node.class` in the Layer-2 config   |
| 3          | default `worker`                              |

- **Absent everywhere ⇒ `worker`** — today's behavior, zero change (the whole fleet is unset until
  it is migrated explicitly). A WARN notes that the class was inferred.
- **An explicit but unrecognized value** (a typo'd `developr`) does **not** silently become a
  work-eligible worker. It is treated as the most restrictive class and `catalyst doctor` **FAILs**
  until the value is corrected — so a typo can never make a node pick up work.
- A missing or malformed Layer-2 file never throws; it falls through to the `worker` default.

### Read-replica endpoint (`catalyst.readReplica.baseUrl`, CTL-1346)

> **Scope — board UI display only.** `catalyst.readReplica.baseUrl` governs the terminal HUD's board
> reads today (pointing the browser/PWA ticket-detail and search flows at the same endpoint is the
> forthcoming "split" topology — CTL-1347 / CTL-1354). It is **not** the agent Linear read path. For
> how agents read Linear ticket data, see the `catalyst-dev:linearis` skill's "Reading Linear"
> section (two-mode rule: standard node → `linearis issues read|list|search` directly; Catalyst
> Cloud node → `@catalyst-cloud/sdk`-managed local replica first, with `linearis` as the
> evidence-triggered fallback — CTL-1390). Writes always go through `linearis` in both modes.

Board data lives in a monitor's `filter-state.db` replica, which is written **only** by a node's
local broker. A daemonless `developer` node runs no broker, so its local replica is empty — it must
read a **worker's** monitor over the network. `catalyst.readReplica.baseUrl` names that endpoint,
resolved through:

| Precedence | Source                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | `CATALYST_MONITOR_URL` env var (explicit override)                                                                                             |
| 2          | `catalyst.readReplica.baseUrl` in the Layer-2 config (e.g. `http://mini:7400`)                                                                 |
| 3          | class-aware default — `developer`/`monitor` ⇒ **no fallback** (explicit error; both read a remote replica); `worker` ⇒ `http://127.0.0.1:7400` |

```json
{ "catalyst": { "readReplica": { "baseUrl": "http://mini:7400" } } }
```

A `developer` (or `monitor`) node with **no** endpoint configured returns an explicit unset/error
rather than silently reading an empty `localhost` replica; a `worker` keeps the `127.0.0.1:7400`
default (its own broker fills and serves the replica). This is **reads only** — writes still require
a host with its own Linear key, preserving per-host rate-limit isolation.

> **Scope:** this resolver currently backs the **terminal HUD's** board reads. Pointing the
> browser/PWA ticket-detail and search flows, and the `catalyst monitor` command, at the same remote
> endpoint is the "split" deployment topology tracked in CTL-1347 / CTL-1354.

### Local Linear replica + cloud-sync writer (`catalyst.linearReplica`, CTL-1394)

> **Not the same thing as `readReplica`.** `catalyst.readReplica.baseUrl` (above) is the **HTTP
> board endpoint** the terminal HUD reads. `catalyst.linearReplica` is the **local SQLite
> Linear-read tier** — a per-node `~/catalyst/catalyst-replica.db` kept fresh from the Catalyst
> Cloud change feed by a supervised writer, read by the scheduler's hot terminal checks
> (`replica-read.mjs`) and the `catalyst-linear` CLI. It exists to take Linear **reads** off the
> rate-limited `linearis` path (the 429 unblock), and is opt-in.

**The writer** is a supervised launchd LaunchAgent (`catalyst-stack adopt-cloud-sync`) that runs
`@catalyst-cloud/sdk`'s `CatalystReplica` with **this node's own cloud token**. It runs on **every
node class** — workers (mini/mini-2) read the replica from the scheduler hot path; developer nodes
(your laptop) read it via `catalyst-linear`. The token is never placed in the (world-readable)
plist; the launcher sources it from a `0600` file at run time.

| Key / env                                                               | Purpose                                                                                                                                                                                                                                                          | Default                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `CATALYST_LINEAR_REPLICA` env / `catalyst.linearReplica.mode` (Layer-2) | The **read flag** — `on` makes the scheduler + `catalyst-linear` trust the local replica; `off`/unset reads `linearis` directly. Env (`on`/`1` on, else off) wins over Layer-2 (`mode: "on"`).                                                                   | off                                                              |
| `CATALYST_REPLICA_DB` env                                               | Replica file path.                                                                                                                                                                                                                                               | `~/catalyst/catalyst-replica.db`                                 |
| `CATALYST_CLOUD_TOKEN` (the token itself)                               | The host's cloud token — read by a **standard name on every host** (sourced from the `0600` `cloud-sync.env`, or `cluster.env`). The per-host-ness is the **value** you provision, not the name — so the writer installs on arbitrary hosts with no code change. | —                                                                |
| `CATALYST_CLOUD_TOKEN_ENV` env / `catalyst.cloud.tokenEnv` (Layer-2)    | Optional escape hatch — point the writer at a **differently-named** token var on a specific host (per-host config, not code).                                                                                                                                    | `CATALYST_CLOUD_TOKEN`                                           |
| `CATALYST_CLOUD_BASE_URL` / `CATALYST_CLOUD_ACCOUNT` env                | Cloud feed coordinates.                                                                                                                                                                                                                                          | `https://api.catalyst-cloud.coalescelabs.ai/api/v1` / `tenant-0` |

**Seed-before-flip runbook** (run on each host):

1. **Operator credential step:** obtain the cloud credential from the operator who manages the
   service. This repository does not contain it. Provision it in the launcher's `0600` environment
   file:

   ```bash
   mkdir -p ~/.config/catalyst
   printf 'export CATALYST_CLOUD_TOKEN=%s\n' '<credential>' \
     > ~/.config/catalyst/cloud-sync.env
   chmod 600 ~/.config/catalyst/cloud-sync.env
   ```

2. Install and start the supervised writer:

   ```bash
   catalyst-stack adopt-cloud-sync
   ```

   If the writer was already adopted, restart it so it reads the newly provisioned token:

   ```bash
   launchctl kickstart -k gui/$(id -u)/ai.coalesce.catalyst-cloud-sync
   ```

3. Verify the complete write-to-read chain:

   ```bash
   catalyst-stack verify-cloud-sync
   ```

   Repeat after resolving any reported failure until every gating check passes. This verifies the
   token, replica database and schema, issue rows, fresh writer lock, and non-empty seed cursor; it
   also reports writer-agent and read-flag state. For automation, use
   `catalyst-stack verify-cloud-sync --json --strict`.

4. Enable replica reads through the guarded activation command:

   ```bash
   catalyst-stack activate-replica
   ```

   The command refuses to change the Layer-2 read flag until the seed checks in step 3 are genuinely
   green. Use `catalyst-stack activate-replica --dry-run` to preview the config merge without writing.

5. On a worker node, restart execution-core so the scheduler constructs its replica reader:

   ```bash
   catalyst-execution-core restart
   ```

**Why the writer can look healthy while doing nothing:** the launchd agent uses
`KeepAlive={SuccessfulExit:false}`. When no token is available, the writer deliberately exits `0`,
which tells launchd not to restart it; an installed plist can therefore coexist with an idle writer
and an unseeded database. Each such launch emits `catalyst.replica.writer_idle` to the unified event
log while preserving the non-crashing exit contract. `catalyst-stack verify-cloud-sync` is the
authoritative acceptance check—an installed service alone is not proof of a usable replica.

```json
{ "catalyst": { "linearReplica": { "mode": "on" } } }
```

## Deployment mode (`catalyst.deployment.mode`, CTL-1617)

`catalyst.deployment.mode` is the ONE declared answer to a question the system otherwise infers from
side effects — whether a webhook tunnel happens to be configured, whether a cluster roster happens to
resolve to more than one host. It is resolved **identically** by two independently maintained
implementations — `lib/deployment-mode.mjs` (Node/ESM) and `lib/catalyst-deployment-mode.sh` (the
Bash mirror, since Bash cannot import a JS leaf) — kept honest by a fixture-matrix cross-stack parity
test (`__tests__/deployment-mode-parity.test.sh`).

| Value                  | Meaning                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `single-host` (default) | A lone node — no cluster substrate expected.                                                                                  |
| `cluster`               | A coordinated multi-host fleet; roster/HRW/liveness are graded by `catalyst doctor`.                                          |
| `cloud`                 | A managed-container node; the smee webhook tunnel must NOT be live and secrets are platform-delivered.                       |

A 4th `both` value was deliberately rejected (CTL-1617 design §2) — the provider's own
`webhook.delivery.id` already makes concurrent smee+cloud ingestion dedup-safe without one.

Deployment mode is genuinely **fleet-scoped**, so — unlike `catalyst.node.class` — it lives primarily
in **Layer-1** (committed, shared by the whole repo checkout), with a **Layer-2 override** as the
exception hatch (e.g. a laptop dev-clone of a cluster-declared repo overriding to `single-host`):

In `.catalyst/config.json` (Layer-1, fleet-wide default):

```json
{ "catalyst": { "deployment": { "mode": "cluster" } } }
```

In `~/.config/catalyst/config.json` (Layer-2, per-host override):

```json
{ "catalyst": { "deployment": { "mode": "single-host" } } }
```

**This repository declares `cluster`** (CTL-1617 PR4 — the working installation is a 2-host fleet).
A dev-clone on a machine that runs no Catalyst stack should set the Layer-2 `single-host` override
above; without it, `catalyst doctor` on that machine reports a declared-cluster-but-no-roster
deployment-mode WARN (advisory only — nothing else changes).

**Resolution** (`resolveDeploymentMode()` / `catalyst_resolve_deployment_mode`):

| Precedence | Source                                                |
| ---------- | ------------------------------------------------------ |
| 1          | `CATALYST_DEPLOYMENT_MODE` env var                     |
| 2          | `catalyst.deployment.mode` in the Layer-2 config       |
| 3          | `catalyst.deployment.mode` in the Layer-1 config       |
| 4          | constant default `single-host`                         |

- **Absent everywhere ⇒ `single-host`** — zero-config, zero-behavior-change. (Once wired: a WARN
  will note the value was inferred — the resolver itself is deliberately log-free; the WARN lives in
  the `getDeploymentMode()` convenience wrapper, and doctor wiring lands in PR2 of the CTL-1617
  migration plan.)
- **An explicit but unrecognized value** (a typo) never silently activates cluster/cloud behavior —
  it degrades to `single-host` (the safest direction) at the layer it was found. (Future behavior,
  PR2: `catalyst doctor` will FAIL until the value is corrected.)
- A missing/malformed config file, or a present-but-non-string value (`true`, `123`, `[]`), both
  settle rather than throw — see `lib/deployment-mode.mjs`'s `classifyCandidate` for the full validity
  ladder.
- **ENV-vs-FILE asymmetry**: `CATALYST_DEPLOYMENT_MODE` is captured into a long-lived daemon's
  environment once, at launch. Layer-1/Layer-2 file edits are picked up **live**, on every call. A
  daemon needs restarting for an env change to take effect.
- **jq-absent degradation (Bash resolver only)**: when `jq` is unavailable, a Layer-1/Layer-2 file
  that could otherwise decide the mode is treated as absent (falls through) instead of failing the
  caller; the resolver exports `CATALYST_DEPLOYMENT_MODE_JQ_MISSING=1` as a breadcrumb (reset at the
  start of every resolution, so it always reflects the latest call). Grading that breadcrumb is
  future doctor work (PR2) — nothing consumes it yet.

PR1 (this file) ships the resolver in isolation — nothing outside its own tests imports it yet; wiring
into webhook ingestion gating, secret-provider selection, and `catalyst doctor`'s roster-consistency
checks lands in later PRs of the CTL-1617 migration plan.

## Secret contract registry (CTL-1616)

Every secret Catalyst resolves — the GitHub token, the Linear API token, the OAuth-mint
credentials, the cloud token, the Groq key, the cluster age-key — is a row in **one frozen
registry**, `SECRET_REGISTRY` in `plugins/dev/scripts/lib/secret-contract.mjs`. It **models** what
used to be independently hand-rolled resolution ladders per secret (the 2026-08-02 fleet 401
outage was four divergent copies of one chain) — the Linear-token read and the Linear OAuth-mint
trio are live consumers of it, but the `github-token`/`webhook-secret` rows and the `groq-api-key`
row are not yet RESOLVED through the registry: the live GitHub-token/webhook-secret value paths
(CTL-1612's `catalyst-secret-env.sh` / `github-auth-preflight.mjs`) and Groq's pre-existing
`lib/api-key-health.mjs` ladder remain their own, unrepointed implementations — but the
`github-token`/`webhook-secret` ROWS do have one live production consumer already:
`execution-core/cluster-sync.mjs` imports `SECRET_REGISTRY` and derives its boot-captured secret
membership (which changed credentials require daemon-restart signaling) from these rows' delivery
types, so their fields are load-bearing even before the resolution cutover (`docs/architecture.md`'s
Secret Contract section has the full per-row cutover status). Bash cannot import a JS leaf, so the registry has a
second, independently-maintained encoding — `plugins/dev/scripts/lib/catalyst-secret-contract.sh` —
kept honest by a cross-stack **three-way parity test**
(`__tests__/secret-contract-parity.test.sh`): bash and JS must each match a computed-expected
value, never merely match each other, and the two registries must enumerate identical row-id sets.
Both files are zero-import leaves (`node:fs`/`node:os`/`node:path` only on the JS side) so
`catalyst doctor`, which runs under bare Node, can import the engine without pulling in
`execution-core/config.mjs`'s `bun:sqlite`-reaching module graph.

### Registry rows

A row is a data fact, not code — the ~7-case engine below is what walks it. Every row declares:

| Field           | Meaning                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`            | Canonical identity; doubles as the SOPS bare-file basename for file-backed rows.                             |
| `envNames`      | Env-var aliases, precedence order (empty for rows with no direct env alias).                                |
| `delivery`      | One of the 7 delivery types below.                                                                           |
| `configJsonPath`| Dotted path inside the resolved Layer-2 JSON, for `config-json`/`platform-env` rows; `null` otherwise.       |
| `rotation`      | `{ class, trigger? }` — see Rotation below.                                                                  |
| `bootstrapFor`  | `"cluster"` \| `"cloud"` \| `null` — the deployment mode this row bootstraps.                                |

Rows with a more specific shape declare additional fields: `familyPrefix` (the one
`bare-file-family` row), `defaultLocalPath` (the one `local-only` row, resolved relative to
`HOME`), and — `linear-worker-actor` only — `credentialEnvPair` (an env-var pair checked ahead of
every config-file tier) and `legacyConfigTiers` + `requiredObjectFields` (§ Linear worker-actor
tiers below).

The 11 seed rows:

| id                          | delivery          | rotation                | bootstrapFor | notes                                                                 |
| ---------------------------- | ----------------- | ------------------------ | ------------ | ---------------------------------------------------------------------- |
| `github-token`                | `bare-file`        | `re-armable` / `timer`   | —            | aliases `GH_TOKEN`, `GITHUB_TOKEN`                                    |
| `webhook-secret`               | `bare-file`        | `boot-only`              | —            | env alias `CATALYST_WEBHOOK_SECRET`                                   |
| `linear-webhook-secret`        | `bare-file-family` | `boot-only`              | —            | `familyPrefix: "linear-webhook-secret-"`; a predicate, not a scalar   |
| `claude-accounts.env`          | `env-file`         | `boot-only`              | —            | presence-only (a whole sourced env file, not one value)               |
| `execution-core.env`           | `env-file`         | `boot-only`              | —            | same shape as `claude-accounts.env`                                   |
| `linear-api-token`             | `env-alias`        | `re-armable` / `on-401`  | —            | aliases `LINEAR_API_TOKEN`, `LINEAR_API_KEY`                          |
| `linear-orchestrator-actor`    | `config-json`      | `re-armable` / `on-401`  | —            | `catalyst.linear.bot.orchestrator` — kept separate from worker-actor  |
| `linear-worker-actor`          | `config-json`      | `boot-only`              | —            | `catalyst.linear.bot.worker` + a legacy fallback chain (below)        |
| `groq-api-key`                 | `config-json`      | `boot-only`              | —            | env alias `GROQ_API_KEY`, config path `groq.apiKey`                   |
| `cloud-token`                  | `platform-env`     | `boot-only`              | `cloud`      | default env-var `CATALYST_CLOUD_TOKEN`; the NAME is itself resolvable |
| `age-key`                      | `local-only`       | `n/a`                    | `cluster`    | presence-checked only, never value-read; default `~/.config/catalyst/age.key` |

`linear-orchestrator-actor` and `linear-worker-actor` are deliberately separate rows — they mint
identically and differ only in their config path, an easy-to-collapse-wrongly refactor the registry
exists to prevent.

### Delivery types

The engine dispatches on exactly one of 7 delivery types — parity cost between the bash and JS
implementations scales per type, not per row:

| Delivery           | Resolution chain                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bare-file`          | explicit `CATALYST_<ID>_FILE` override → `CATALYST_CONFIG_DIR` → the directory holding `CATALYST_LAYER2_CONFIG_FILE` (or its `~/.config/catalyst/config.json` default) → XDG dir → falls back to an inherited env alias if no file is found |
| `bare-file-family`   | not a resolvable scalar — a membership predicate (`isSecretFamilyMember`) over an open-ended prefix family          |
| `env-file`           | presence/non-empty check of a whole file at the same bare-file candidate paths (the file is *sourced*, not read for one value) |
| `env-alias`          | first non-empty `envNames` entry, in order — no file search at all                                                  |
| `config-json`        | env alias (if any) → the resolved Layer-2 JSON's `configJsonPath`                                                   |
| `platform-env`       | the row's env-var **name** is itself resolved (env override → Layer-2 name override → default), then that variable's value is read |
| `local-only`         | `statSync` presence check of a single path only — the value is never read                                           |

**Bare-file candidate directory ≠ `resolveLayer2Path()`.** `secretFileCandidates()`
(`secret-contract.mjs:607-620`, mirrored in `catalyst-secret-contract.sh:355-380`) builds its
Layer-2-directory candidate straight from `CATALYST_LAYER2_CONFIG_FILE` (or the hardcoded
`~/.config/catalyst/config.json` default) — it does **not** call `resolveLayer2Path()`, so a
`CATALYST_MACHINE_CONFIG`-only override is never consulted here, unlike every `config-json`/
`platform-env` row (below). An operator who sets only `CATALYST_MACHINE_CONFIG=/custom/config.json`
and drops a sibling `/custom/github-token` next to it will find that file skipped: both engines
still search the home/XDG locations. Provision bare-file secrets via `CATALYST_CONFIG_DIR`, the
XDG directory, or `CATALYST_LAYER2_CONFIG_FILE` itself so both engines look in the same place.

### Resolution result

`resolveSecret(id, { env, deploymentMode, cwd })` (JS) / `catalyst_resolve_secret <id>` (bash)
never throws. It returns `{ value, source, provider, rotation, ...extras }` for a known id, or
`{ value: null, source: null, provider: null, rotation: null }` for an unknown one. `provider` is
the row's `delivery` — a logging breadcrumb only; callers never branch on it. `source` is one of
`shared-file` | `operator-override` | `inherited` | `config-json` | `legacy-config-json` |
`platform-env` | `present` | `absent` | `none` — with two exceptions, both of them a *known* id
whose `source` collapses to `null` while `provider`/`rotation` stay populated (unlike the
unknown-id shape, where every field is `null`): the one `bare-file-family` row
(`linear-webhook-secret`) has no scalar value, so it resolves to
`{ value: null, source: null, provider: "bare-file-family", rotation: {...} }`; and, in genuine
cloud mode, any row other than the `cloud-token` bootstrap row itself resolves the identical
`{ value: null, source: null, provider, rotation }` shape (that row's own `provider`/`rotation`)
when `cloud-token` fails to resolve — the bootstrap short-circuit, § Cloud guard below. Both are
normal, expected states — not evidence of an unknown id — so callers must not treat a `null`
`source` as impossible or unknown-id-only. The bash mirror echoes the same three fields
pipe-joined (`value|source|provider`) and additionally exports non-secret
`CATALYST_SECRET_LAST_SOURCE`/`_PROVIDER` breadcrumbs for the calling shell — but deliberately
**never exports the resolved value** (`export -n` is reasserted on every call, since bash's export
attribute is sticky across reassignment), so a long-lived daemon shell can't leak a credential into
every child process it launches.

### Cloud guard

The cloud provider only ever activates when the full CTL-1617 deployment-mode object satisfies
**all three**: `mode === "cloud"`, `inferred === false`, and `recognized !== false`. Because the
guard lives once in the shared engine, every row gets it for free. When genuinely cloud, resolution
short-circuits to a pure env-alias read of `envNames` for the secret **value** — no file search for
the value, ever — with one carve-out: `cloud-token` itself is `platform-env` delivery, and even in
genuine cloud mode it first resolves its env-var **name** via `resolveCloudTokenName()` (env
override → the Layer-2 file's `catalyst.cloud.tokenEnv` → default), so a managed container can
still consult a config file to learn *which* variable to read before reading that variable's
value. Anything else (single-host, cluster, or an inferred/unrecognized cloud guess) runs the row's
normal delivery-type chain unchanged.

A second gate — the **bootstrap short-circuit** — applies only in genuine cloud mode: if the active
mode's `bootstrapFor` row (`cloud-token`) fails to resolve, every *other* cloud-mode secret
resolution returns `{ value: null, source: null, provider, rotation }` (that row's own `provider`
and `rotation`, populated) without probing further, so a half-provisioned managed container fails
loudly and coherently instead of limping through partial resolution. The
bootstrap row itself is exempt from this check (it must resolve on its own terms).

### Layer-2 path resolution

The registry's canonical Layer-2 config path chain, used by every `config-json`/`platform-env` row
and exported as `resolveLayer2Path(env)` (JS) / `catalyst_secret_resolve_layer2_path` (bash):

```
CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG > $XDG_CONFIG_HOME/catalyst/config.json > ~/.config/catalyst/config.json
```

This is a distinct chain from `lib/deployment-mode.mjs`'s own `resolveLayer2Path`, which
deliberately mirrors `execution-core/config.mjs`'s legacy homedir-only behavior — the two names
resolve different things on purpose. `execution-core/config.mjs`'s `getLayer2ConfigPath()` and
`execution-core/lib/node-class.mjs`'s own copy now delegate to this canonical chain, dual-read
against their legacy homedir-only chain for one release: the two only disagree on a host that sets
`CATALYST_MACHINE_CONFIG` or `XDG_CONFIG_HOME` without also setting `CATALYST_LAYER2_CONFIG_FILE`,
in which case the canonical (new) path wins and a one-time-per-message `WARN` is logged.

### Rotation

Every row declares a rotation class:

| Class                   | Meaning                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `boot-only`              | Captured once (at daemon boot, or per-call for a config-json mint) — a value change requires a restart to take effect. |
| `re-armable` / `timer`   | Proactively re-checked on a recurring tick — the row's declared shape (`github-token`). Its actual re-arm today still runs through the pre-existing CTL-1612 `rearmGithubTokenFromFile` (called every daemon cluster-sync tick in `execution-core/daemon.mjs`), not through this contract's own `registerRearmHook`/`armSecret` seam — see below, `github-token` remains hookless. |
| `re-armable` / `on-401`  | Reactively re-minted on an observed auth failure, not a timer (the Linear OAuth-mint shape).      |
| `n/a`                    | The row's value is never fetched at all (only `age-key` — rotation isn't a question the contract can answer for a presence-only row). |

`armSecret(id, { env, deploymentMode })` never throws and returns `{ armed, rotated,
restartRequired }`. `restartRequired` is the literal signal the 2026-08-02 outage lacked: it is
`true` exactly when a `boot-only` row's resolved value has changed since the last observation.
`registerRearmHook(id, fn)` attaches an in-process rearm implementation to a `re-armable` row — it
refuses (returns `false`, never throws) against a `boot-only`/`n/a` row, an unknown id, or a
non-function, so a hookless row can never silently claim "no restart needed". A `re-armable` row
with **no** hook registered degrades to exactly the same `boot-only`-shaped behavior (resolve
fresh, diff against the last-observed value, report `restartRequired` on change) — the capability
ceiling is honest either way. As shipped, `linear-orchestrator-actor` has a real hook (registered
by `execution-core/linear-remint.mjs` against its cooldown-guarded reminter); `github-token` and
`linear-api-token` remain hookless, so both currently take the degrade path in practice.

### Linear worker-actor's legacy fallback tiers

`linear-worker-actor` is the one row with a multi-tier fallback chain, folded from
`lib/linear-comment-post.sh`'s pre-existing four-rung precedence with every rung's precedence order
preserved. Note the fold GENERALIZED every file-backed tier's location, not just one: pre-fold, the
primary and global-legacy tiers read a hardcoded `$HOME/.config/catalyst/config.json` and the
per-team sibling sat beside it — post-fold all three resolve relative to the canonical
`resolveLayer2Path(env)`, so a `CATALYST_LAYER2_CONFIG_FILE`/`CATALYST_MACHINE_CONFIG` override
moves all three together. (Deprecating the legacy tiers is an explicit, separate follow-up — not
part of this fold.)

1. `credentialEnvPair` — `CATALYST_LINEAR_AGENT_CLIENT_ID`/`CATALYST_LINEAR_AGENT_CLIENT_SECRET`,
   checked first; both must be non-empty.
2. The primary `configJsonPath` tier (`catalyst.linear.bot.worker`).
3. `legacyConfigTiers`' `per-team-legacy` tier, tried only once the above both miss: a per-team
   legacy file (walking up from `cwd` for a `.catalyst/config.json` `projectKey`, reading a sibling
   `config-<key>.json`) — **the generalization**: that sibling now resolves relative to the
   canonical `resolveLayer2Path()` directory, not the old script's hardcoded
   `$HOME/.config/catalyst`, so it moves with `CATALYST_LAYER2_CONFIG_FILE`/`CATALYST_MACHINE_CONFIG`
   overrides exactly like every other row's Layer-2-relative path. An operator relying on the old
   hardcoded location under a custom Layer-2 path gets a different (but now-correct-for-the-chain)
   file here than the pre-fold script read.
4. `legacyConfigTiers`' `global-legacy` tier, tried only once tier 3 also misses: the global
   `catalyst.linear.agent` path in the canonical Layer-2 file.

A row that declares `requiredObjectFields` (only `linear-worker-actor`, requiring `clientId` and
`clientSecret`) must find every named field present and non-blank in a candidate tier's raw
object value before that tier is allowed to win — a partially-populated tier (e.g. a
credential-free `{webhookSecret, botUserId}` object) falls through to the next tier instead of
capturing resolution and failing downstream.

### Doctor integration

`catalyst doctor` consults the contract through `resolveSecret` directly — never a second
hand-rolled presence check — but for most checks it is **shadow-only observability**: the contract
is resolved and compared against the check's existing hand-rolled answer, and a disagreement is
reported as its own `STATUS.INFO` row (`<check>-secret-contract-shadow`) that never changes the
check's grade or exit code. `checkPeerUniqueness`, `checkBotCredentials`, and `checkWorkerLabels`
are the one cutover to date: they now read `linear-api-token` from the contract as their **live**
answer (their old hand-rolled `LINEAR_API_TOKEN ?? LINEAR_API_KEY` read is gone, and so is the
shadow comparison that has nothing left to compare against). `checkSecretContract` itself remains a
standalone INFO-only observation (presence of `linear-api-token` and `groq-api-key`) for every node
class. The one exception that does change doctor's exit code: `checkCloudTokenEnv` FAILs when the
active deployment mode is declared `cloud` (recognized, not inferred) and the `cloud-token`
bootstrap row does not resolve — the one FAIL doctor cannot route around, per the cloud guard's
bootstrap short-circuit above.

## GitHub merge rules live in GitHub

Catalyst can open PRs, fix CI, answer review bots, and merge. But GitHub decides what must pass
before code lands. Those rules live in **GitHub branch protection or rulesets**, not in
`.catalyst/config.json`.

For hands-off merging, set your `main` branch to require pull requests, require status checks to
pass, and require review threads to be resolved. Then Catalyst drives the PR to the finish and
GitHub enforces the gates. To require a human sign-off too, also require one approving review.

## More settings

Catalyst reads many more keys — for the event broker, the Monitor dashboard, webhooks, deploy
checks, and worktree setup. The setup script writes them, and
`plugins/dev/templates/config.template.json` lists them all. You only need the keys above to get
started.

### Runaway-dispatch guards (CTL-671)

The execution-core scheduler protects itself against a single ticket dominating the dispatch loop.
These knobs are env vars on the `catalyst-execution-core` process:

- `SCHEDULER_CIRCUIT_BREAKER_THRESHOLD` (default `8`) — consecutive failed dispatches (no forward
  progress) before a ticket is quarantined to terminal `stalled` + `needs-human`. A successful
  dispatch resets the counter, so a healthy ticket can never trip it.
- `SCHEDULER_RUNAWAY_THRESHOLD` (default `50`) — per-ticket `phase.*.<ticket>` event count within
  `SCHEDULER_RUNAWAY_WINDOW_MS` that fires one `phase.dispatch.runaway.<ticket>` alert.
  Observability only — it surfaces a dominating ticket without quarantining it.
- `SCHEDULER_RUNAWAY_WINDOW_MS` (default `600000`, 10 min) — rolling window for the runaway-rate
  alert and its once-per-window suppression marker.

The **phantom worker-dir validity sweep** quarantines a `workers/<ticket>/` dir only when all three
hold: the ticket is definitively **not-found** in Linear (a clean exit-0 not-found body — a nonzero
exit or transient outage classifies as `unknown` and is never quarantined), it is **not in the
eligible set**, and it has **no live bg worker**. This conjunction guarantees a transient Linear
outage can never quarantine a healthy, resolvable, in-flight ticket.
`SCHEDULER_CIRCUIT_BREAKER_THRESHOLD` is the Linear-independent backstop; the runaway knobs are
observability only.

### Broker watchdog session eviction (CTL-1516)

The broker's watchdog tick keeps per-session bookkeeping (`lastHeartbeat`, `workerToOrchestrator`)
and a wake-dedup cache (`_emittedWakeCache`). So these stay bounded over a long-lived broker process,
the tick sweeps expired wake-cache entries every pass and evicts a session's heartbeat/orchestrator
rows once it is definitively finished. This knob is an env var on the `catalyst-broker` process:

- `FILTER_HEARTBEAT_EVICT_MS` (default `1800000`, 30 min) — horizon past which a **stale** session's
  `lastHeartbeat` + `workerToOrchestrator` rows are evicted even if it never matched an interest. A
  session reported `dead` by `claude agents` is evicted immediately; an unknown-liveness session is
  evicted only once it is both stale (past `FILTER_HEARTBEAT_STALE_MS`) **and** older than this
  horizon, so eviction can never precede the stale threshold. Generous by default
  (≈10× `FILTER_HEARTBEAT_STALE_MS`) so only unambiguously-finished sessions are dropped — a genuine
  revival simply re-checks-in and recreates the rows.

### Board-health delegate (CTL-1290)

On a low-frequency cadence the scheduler runs a **whole-board health scan**: a read-only pass that
evaluates board-level invariants the per-item signals never surface — a silently-held dispatch (open
slots + a waiting queue + no recent dispatch), a worker idling far past its phase-normal age, a
ticket blocked by a dead blocker chain, a project gone silent, a rate-limit cliff, a node that owns
work but whose reconcile is failing. It emits one **`recovery.board-scan`** event per cadence (the
numbers ride out as chartable OTel attributes via CTL-1291) and proposes tiered remediation moves.
In `shadow` (the default) it takes **no action**; in `enforce` (CTL-1300) a proceeding scan
dispatches **one holistic recovery-pass delegate** — see the `enforce` row below.

Mode resolves from the env var (a single operator knob) over Layer-2 over the default. Unlike the
rest of the recovery family (which ships `off`), the board-health delegate **defaults to `shadow`**:
shadow is itself a dark state — it emits the scan and mutates nothing (the no-mutation guarantee is
structural, not configured), so the telemetry that is the feature's whole point ships on.

| Key                                                     | Default           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CATALYST_BOARD_HEALTH` _(env var)_                     | `shadow`          | `off` / `0` (kill-switch — strict no-op), `shadow` (scan + emit `recovery.board-scan`, take no action), `enforce` (CTL-1300 — on a proceeding scan, dispatch **one holistic recovery-pass delegate** anchored to a flagged ticket and carrying the whole-board context; reuses the capped + cooldown'd recovery-pass actuator. **Operator-gated — never auto-enabled**). Garbage values fall back to `shadow`. Overrides Layer-2. |
| `catalyst.boardHealth.mode` _(Layer-2)_                 | `shadow`          | Same three values; honored when the env var is unset.                                                                                                                                                                                                                                                                                                                                                                             |
| `CATALYST_BH_SANCTIONED_LATCHES` _(env var)_            | _(empty)_         | Comma-separated ticket ids a human has **deliberately parked** at needs-human (CTL-1432 B3). They stay visible in the board context's `frozenNeedsHuman` but are suppressed from `proposeMoves`, so the delegate stops re-proposing them every scan (which otherwise drowns the genuinely-stuck tickets). Overrides Layer-2.                                                                                                      |
| `catalyst.boardHealth.sanctionedNeedsHuman` _(Layer-2)_ | `[]`              | Array form of the sanctioned needs-human latch allowlist; honored when the env var is unset.                                                                                                                                                                                                                                                                                                                                      |
| `CATALYST_BH_GH_QUOTA` _(env var)_                      | `shadow`          | GitHub core REST quota invariant mode: `off` skips the snapshot read, `shadow` publishes quota state but keeps the invariant unobservable, and `enforce` lets a fresh low/exhausted snapshot trip Gate 3 with `rate-limit-cliff`. Garbage values fall back to `shadow`. Overrides Layer-2.                                                                                                                        |
| `catalyst.boardHealth.githubQuota` _(Layer-2)_           | `shadow`          | Same three values; honored when `CATALYST_BH_GH_QUOTA` is unset.                                                                                                                                                                                                                                                                                                                                                                  |
| `CATALYST_BH_GH_CORE_PCT`                                | `10`              | Remaining core REST percentage at or below which the quota state is `low`.                                                                                                                                                                                                                                                                                                                                                        |
| `CATALYST_BH_GH_QUOTA_STALE_MS`                          | `900000` (15 min) | Maximum snapshot age. A missing or older snapshot is unknown and unobservable, even in `enforce`.                                                                                                                                                                                                                                                                                                                                  |
| `CATALYST_BH_INTERVAL_MS`                               | `300000` (5 min)  | Cadence floor — the scan runs at most once per interval per host.                                                                                                                                                                                                                                                                                                                                                                 |
| `CATALYST_BH_DISPATCH_STALL_MS`                         | `600000` (10 min) | Dispatch-liveness threshold: free slots + a queue + no dispatch within this window flags a wedge.                                                                                                                                                                                                                                                                                                                                 |
| `CATALYST_BH_WORKER_AGE_MS`                             | `14400000` (4 h)  | Fallback worker-age threshold (per-phase normals override it).                                                                                                                                                                                                                                                                                                                                                                    |
| `CATALYST_BH_PROJECT_SILENCE_MS`                        | `86400000` (24 h) | Project-silence threshold (no ticket movement in the project past this window).                                                                                                                                                                                                                                                                                                                                                   |
| `CATALYST_BH_UNOWNED_INFLIGHT_MS`                       | `86400000` (24 h)   | Stale-unowned threshold (CTL-1475). A Linear state like `Implement` is a **claim** that a worker is on the ticket, not a label — and nothing takes the claim back when the worker dies. Past this age with **no live worker signal and no confirmed-open PR**, the ticket is flagged `unownedInFlight` and proposed as a **tier2 (anchorable)** `recover-unowned-in-flight` move, so the delegate dispatches a recovery pass rather than merely reporting it. Such tickets are invisible to every other path: admission only pulls `Todo`, and the recovery census scans worker dirs they have no entry in. Deliberately conservative — any evidence of ownership spares the ticket, since a false negative costs one more scan while a false positive re-dispatches work a human is holding. |
| `CATALYST_BH_STALLED_PR_REVIEW_MS`                     | `259200000` (72 h / 3 d)  | CTL-1608. How long a PR may sit without a review-request being responded to before board-health emits a `nudge-stalled-pr` move. Requires `orchestration.stalledPrSweep.enabled: true`. The stalled-PR timer stamps `reviewRequestedAt` in `workers/<TICKET>/stalled-pr.json`; board-health compares `now - reviewRequestedAt` against this threshold. |
| `CATALYST_BH_STALLED_PR_CI_MS`                         | `172800000` (48 h / 2 d)     | CTL-1608. How long a PR may have a continuously-failing CI check before it is flagged stalled. The timer stamps `ciFirstFailedAt` on first CI failure detection. |
| `CATALYST_BH_STALLED_PR_NOPUSH_MS`                     | `432000000` (120 h / 5 d)   | CTL-1608. How long a PR may go without a push (no new commits) while still open before it is flagged stalled. The timer stamps `lastPushAt` on each push detected. |

### Monitor reply-route trusted origins (CTL-1573)

`POST /api/ticket/<ticket>/reply` posts operator-authored text to Linear, and the monitor binds
`0.0.0.0` with no auth. Its cross-origin guard validates the request's `Origin` against an allowlist
that the caller cannot influence. (It previously compared `Origin` against the request's own `Host`
header — under DNS rebinding both are attacker-chosen, so that comparison could not reject the case
it existed for.)

Trusted **by default**, all qualified with the port the server actually bound:

- loopback — on a wildcard bind the **whole `127.0.0.0/8` range** (so `127.0.0.2` and the Debian-conventional `127.0.1.1` work), otherwise only when the bind is itself the loopback address — a LAN-bound monitor does not own `<loopback>:<port>`) — `localhost`, plus the literal(s) matching the **bound address family**

**Residual, and the real fix.** Host *names* (`localhost`, `os.hostname()`) are family-ambiguous — the browser picks. Under a single-family bind, a process squatting the other family's port can serve a page whose `Origin` is one of those names. No allowlist setting closes this; **bind dual-stack** and the squat becomes impossible rather than merely untrusted:

```bash
MONITOR_HOST=:: catalyst-monitor restart   # `start` no-ops when a monitor is already running
```

> **Dev-server note.** A prefix assignment (`MONITOR_HOST=:: catalyst-monitor restart`) exists only
> for that command. `bun run dev:ui` is a separate process, so **export** `MONITOR_HOST` (and
> `MONITOR_PORT`) in the shell that runs it, or the Vite proxy will target the default `127.0.0.1:7400`
> instead of the monitor's actual bind.

> **Management-CLI gap (CTL-1599).** `catalyst-monitor.sh` still prints, opens, and health-probes
> `http://localhost:$PORT` regardless of `MONITOR_HOST`, so a specific non-loopback bind will show a
> wrong URL and a failing probe even when the monitor is healthy. Wiring the CLI through is tracked
> separately; the allowlist itself honors the bind correctly.

| Env var | Default | Notes |
| ------- | ------- | ----- |
| `MONITOR_HOST` | `0.0.0.0` | Bind address. `::` binds dual-stack (accepts IPv4-mapped too) and is the remedy above. A **specific** address or hostname narrows the allowlist to that socket only — the monitor stops trusting other local interfaces and this host's own names, since it no longer owns those sockets. (binding `0.0.0.0` is IPv4-only, so `[::1]` is not trusted: another service can bind `[::1]` on the same port and its origin would otherwise pass)
- this machine's own names, **wildcard binds only** (the bare label of an FQDN is included so `http://mini:7400` works when `os.hostname()` is `mini.corp.example`; this trusts whatever that label resolves to, so on a network where a search domain or stale record maps it elsewhere, prefer a specific bind or an explicit `MONITOR_TRUSTED_ORIGINS`) (a name resolves to whichever interface DNS/mDNS picks, which need not be the one a specific bind listens on) — `os.hostname()` and its short label, plus the **actual** mDNS name on macOS (`scutil --get LocalHostName`). A `<short>.local` alias is **not** synthesized: when it is not the name the system really advertises, nothing owns it, so any LAN host could claim it over mDNS and pass the guard.
- this machine's own non-loopback addresses (LAN, Tailscale `100.x`) — but **only for a wildcard bind** (`0.0.0.0`/`::`). A server bound to one specific address trusts only that address, since another service can hold the same port on a different interface

Own names are trusted **only on the bound port, and only under the scheme the monitor serves
(`http`)**: a bare `http://mini` would let any *other* service on the same machine (e.g. something on
`:80`) drive the reply route. Comparison keys are full origins (`scheme://host[:port]`), so `http`
and `https` on the same host are distinct — a compromised plaintext endpoint cannot drive an HTTPS
route. On macOS the machine's real Bonjour name (`scutil --get LocalHostName`) is included, since it need
not share the first label of `os.hostname()`; it is cached for **5 minutes** (the lookup spawns a
subprocess and the allowlist rebuilds on rejected requests, so it must not run per-request — but a
renamed `LocalHostName` then takes effect without a daemon restart). Only `http`/`https` origins are
accepted — a non-special scheme such as `chrome-extension://` serializes to the opaque `"null"`,
which would otherwise match every opaque origin.

The allowlist is rebuilt on a **60s TTL** and again on any rejection, so an address that appears
later (Tailscale connecting, a DHCP change) is trusted without a restart, and one that is *removed*
stops being trusted within the TTL rather than lingering until the daemon restarts.

| Env var                    | Default | Notes                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONITOR_TRUSTED_ORIGINS`  | unset   | Comma- or whitespace-separated extra origins for deployments reached by a name that cannot be derived from `os.hostname()` — a **reverse proxy** or a full **Tailscale MagicDNS** alias. Accepts full origins (`https://catalyst.example`) or bare `host:port` (`mini-2.tail1234.ts.net:7400`). Entries are taken **exactly as given** (not widened to the bound port) and canonicalized the way a browser serializes `Origin`, so an IDN name may be written in either Unicode or punycode. |
| `MONITOR_TLS_PROXY_PEERS` | unset | Peer addresses of the **TLS-terminating reverse proxy** (comma-separated, e.g. `127.0.0.1,::1`). Requests arriving *from these peers* are classified `https` when the accounts `?refresh=true` guard probes the trusted-origin set — **required** when `MONITOR_TRUSTED_ORIGINS` lists an `https://` origin served through a local proxy, or every proxied refresh 403s (with it unset, all requests are plaintext). This is a deliberate operator declaration: `X-Forwarded-Proto` is never trusted (client-spoofable, and appending proxies put the client's value first). IPv4-mapped spellings are normalized, so `127.0.0.1` also matches a dual-stack bind's `::ffff:127.0.0.1`. |
| `MONITOR_DEV_UI=1` / `NODE_ENV=development` | unset | Trusts the Vite dev origin (`http://localhost:5173` — one spelling, since Vite binds a single address family and the other would be available to any local process). **Not needed for the standard `bun run dev:ui` flow** — the Vite proxy sends the monitor's own origin (`ui/vite.config.ts`), so proxied replies are already trusted. Accepts `1`/`true`/`yes`/`on`. Use only for a dev setup that bypasses that proxy, and note it must be set on the **monitor** process (`dev:ui` starts Vite only; the monitor runs out-of-band). |
| `MONITOR_DEV_UI_ORIGINS` | unset | Overrides the dev origins above (same format), for a non-default Vite port. Same caveat: set it on the monitor process. |

**Set this if replies 403.** A monitor opened through a proxy/alias not in the default set will
reject every reply until the name is listed here. Addresses are re-derived automatically (see the
TTL above); a *name* the daemon cannot derive still needs this variable.

Prefer writing a **full origin** (`https://catalyst.example`) over a bare host: a full origin pins
the scheme, whereas a bare `host[:port]` cannot state one and is therefore trusted under both
`http` and `https`.

Requests with **no** `Origin` are allowed — browsers always send it on a POST, so only non-browser
clients (`curl`, tests) omit it, and those are not CSRF vectors. This guard stops a browser being
used as a confused deputy; it is not authentication.

### Ingestion-silence detector (CTL-1122)

The broker tails every event, so it is the surviving process that can notice when an upstream
ingestion source has gone silent — the out-of-process check the monitor cannot do for itself (its
own health probe reports `up` iff it answers, so it can never observe its own death). Each watchdog
tick the broker judges per-source event recency and edge-triggers
`catalyst.ingestion.{stale,recovered}` (emit-only — it takes no corrective action; CTL-1123 is the
consumer). These knobs are env vars on the `catalyst-broker` process:

- `CATALYST_INGESTION_RECENCY` (default on; set `0` to disable) — master kill-switch, read at call
  time so it toggles without a broker restart.
- `FILTER_MONITOR_RECENCY_DEGRADED_MS` / `FILTER_MONITOR_RECENCY_DOWN_MS` (defaults `180000` /
  `600000`) — the `catalyst.monitor` heartbeat thresholds. The monitor beats on a fixed ~30s
  cadence, so these are tight (3m degraded / 10m down) and **ungated**.
- `FILTER_GITHUB_RECENCY_DEGRADED_MS` / `FILTER_GITHUB_RECENCY_DOWN_MS` (defaults `900000` /
  `1800000`) — the `catalyst.github` webhook thresholds. GitHub traffic idles organically, so these
  are wide (15m / 30m) **and activity-gated**: github silence only alarms while a worker is
  in-flight (a non-terminal `worker_state` row that has emitted an event within the last 30 min).
  With no active worker the source is forced healthy, so an idle fleet never false-alarms.
- `FILTER_INGESTION_RECENCY_HOLDDOWN_MS` (default `600000`) — flap guard: minimum gap between a
  recovery and the next stale alarm. A sustained outage that begins inside the window is deferred
  (re-checked each tick), never dropped.

Linear (`catalyst.linear`) recency is intentionally **not** wired: the linear-webhook bot-skip guard
suppresses bot-authored events before they reach the log, so the source goes quiet even during
active work. Its knobs (`FILTER_LINEAR_RECENCY_*`) are reserved for when a non-flaky threshold is
found.

### Out-of-band alert topics (CTL-1123)

The detector above only emits low-level `catalyst.ingestion.*` events. CTL-1123 adds an
**alert-policy** layer in the broker: it promotes the operator-actionable subset into a stable,
intentional **`catalyst.alert.{raised,cleared}`** topic (`event.entity=alert`, `event.label` = the
alert _kind_). Those events flow through the event log → `otel-forward` → the OTel collector →
fan-out (Loki, dash0), where a downstream alert rule routes them to a channel. **Delivery is
deliberately out of scope** — the broker emits intent only; no channel or credential lives in the
daemon. These knobs are env vars on the `catalyst-broker` process:

- `FILTER_ALERT_ENABLED` (default on; set `0` to disable) — master kill-switch for alert emission,
  read at call time (toggles without a broker restart).
- The **`system_down`** alert is promoted from a _critical_ source's sustained
  `catalyst.ingestion.stale` (currently `catalyst.monitor` — a dead monitor). It rides that
  already-debounced recency edge, so it has no thresholds of its own; raised on stale, cleared on
  recovered.
- The **`needs_human_pileup`** alert is a level signal: how many **active, non-terminal** tickets
  carry a `needs-human`/`needs-input` label in the broker's `filter-state.db` (Done/Canceled and
  removed tickets are excluded so a stale cached label can't pin the count). Knobs:
  - `FILTER_PILEUP_THRESHOLD` (default `3`) — minimum labelled-ticket count to alert.
  - `FILTER_PILEUP_PERSISTENCE_MS` (default `300000`) — the count must stay at/above the threshold
    this long before one alert fires (spike guard).
  - `FILTER_PILEUP_COOLDOWN_MS` (default `3600000`) — minimum gap after a clear before it can
    re-fire (flap guard).

### Broker-degraded detector (CTL-1523)

The broker's watchdog can edge-trigger a `broker.daemon.degraded` / `broker.daemon.recovered` pair
when its **interest table is empty while the fleet is actively working** — an empty table on an idle
fleet is the healthy steady state, so the fleet-activity reading is the discriminator. The episode is
edge-triggered with a **durable latch** (`~/catalyst/broker-degraded-latch.json`), so a broker
restart mid-episode resumes rather than re-emitting.

**The detector is dormant by default and only meaningful on legacy-wave hosts.** Under
**execution-core dispatch** nothing registers interests at all, so `interests.size === 0` is
permanently true and the gate carries no information. That is a property of execution-core, **not**
of every configuration named `phase-agents`: a **legacy-wave** host — one driving
`/catalyst-legacy:orchestrate`, which invokes `plugins/dev/scripts/orchestrate-register-interests.sh`
— does register interests (`pr_lifecycle` + `ticket_lifecycle` + `comms_lifecycle` unconditionally,
plus a per-ticket `phase_lifecycle` when `dispatchMode` is `phase-agents`). There an empty interest
table IS anomalous, and that is the deployment where enabling this is appropriate. These knobs are
env vars on the `catalyst-broker` process:

- `FILTER_BROKER_DEGRADED_ENABLED` (default **off**; set to exactly `1` to enable) — opt-in
  kill-switch. Unset (or any other value) means the detector evaluates nothing and emits nothing.
  **Changing this requires a broker restart.** The value is read at call time, so it takes effect
  without a code reload — but a running daemon's `process.env` is fixed at launch and there is no
  runtime control path that mutates it, so editing the env file (or exporting in a shell) does
  **not** reach a live broker. Restart it, or you will believe the detector is armed while it is
  still dormant. Flipping it **off** discards any in-progress debounce run, so a re-enable re-earns
  the full sustained-tick threshold; an already-open episode survives the switch and still emits
  its paired `recovered`.
- `FILTER_BROKER_DEGRADED_GRACE_MS` (default `300000`, 5 min) — startup grace. An empty interest
  table is not judged at all until the broker has been up this long, so a still-warming process never
  trips.
- `FILTER_BROKER_DEGRADED_SUSTAINED_TICKS` (default `5`) — consecutive anomalous watchdog ticks
  (~60s each) required before the degraded edge fires. The run must be contiguous: any non-anomalous
  tick resets it, so a single-tick blip cannot page.

The fleet-activity reading is **tri-state** — active, proven idle, or *unknown* (the worker-table read
failed). Only a proven-idle fleet closes an open episode (`recovered`, reason `fleet idle`); an
unknown reading neither trips nor clears, so a transient DB failure cannot manufacture a false
recovery followed by a duplicate degraded edge.

**This is not a dead-broker detector**, and neither is the ingestion-silence detector above: both run
inside the broker process, so a dead broker emits neither. `checkSourceRecency` detects an ingestion
**stall** while the broker is **alive**. Detecting a fully-dead broker requires an **external,
absence-based** check on the broker's own heartbeat/log series — e.g. a Loki `absent_over_time` alert
on `broker.daemon.heartbeat` or the broker `.log` stream (absence, because a fully-dead daemon is a
*missing series*, which `count_over_time == 0` cannot assert).

### Node admission state on the heartbeat (CTL-1322)

A daemon that is **alive but not accepting new work** (draining, or a liveness-cold hold) otherwise
looks fully healthy to uptime monitoring while pulling zero work — the recurring "why isn't work
moving?" blind spot. CTL-1322 makes that state **visible in telemetry**: every `node.heartbeat`
event now carries an `admission` block in `body.payload`:

```json
"admission": { "accepting": false, "holdReason": "drain", "effectiveCapacity": 0, "activeWorkers": 6 }
```

- `accepting` mirrors the scheduler's new-work gate exactly (`livenessFresh && !isDraining()`), so
  the heartbeat can never disagree with what the daemon actually enforces.
- `holdReason` is `"drain"` (the persistent operator-intent hold, CTL-1095), `"liveness-cold"` (the
  transient snapshot-staleness hold, CTL-731), or `null` when accepting. Drain takes precedence when
  both apply.
- `effectiveCapacity` is the admission ceiling (`maxParallel` when accepting, `0` when held);
  `activeWorkers` is the live background-worker count.

The orch-monitor surfaces it for the **local** node: the FleetOps Hosts "Daemon" column renders
`holding (<reason>)` (amber) instead of a misleading "live", and the footer health tooltip gains a
`<host> holding (<reason>)` line — without bumping the health pill (a drain is operator intent, not
a fleet alarm). Remote peers omit the field (the cross-host anchor transport carries no admission
yet) and render "live".

**Alerting** is a host-side Loki/Grafana rule (the same out-of-band, delivery-out-of-scope contract
as CTL-1123) — no in-repo change, no secrets in the daemon. Note the two telemetry paths: the
structured `admission` block rides the `node.heartbeat` **event** (the unified event log), which on
the current stack is **not** shipped to Loki — it powers the orch-monitor UI (the server reads the
local event log directly) and any on-host event consumer. What **is** in Loki — via the Alloy
daemon-`.log` shipper, stream `service_name="catalyst.execution-core"` — is the scheduler's
free-text hold line, so alert on that:

```logql
count_over_time({service_name="catalyst.execution-core"} |= "holding new-work dispatch" [12m]) > 0
```

with a `for: 10m` window; scope per node with `| host_name="mini.rozich"`. This one line fires for
**both** the drain hold (CTL-1095) and the liveness-cold hold (CTL-731). Follow-ups: ship the
catalyst event log to Loki so the _structured_ admission field becomes queryable, plus a
daemon-emitted debounced `catalyst.alert.not_accepting` edge (cleaner raised/cleared semantics).

### Coordination substrate (CTL-1488)

The distributed-coordination epic (ADR-022/023) adds a subsystem that durably orders and shares
**coordination events** across hosts via a `coordination-publish` background process: it tails the
unified event log, writes the ordered coordination subset to a local-first mirror
(`~/catalyst/coordination.jsonl`, carrying a monotonic `local_seq`) synchronously before any network
call, and — in `enforce` — exchanges those rows with a catalyst-cloud coordination hub (or, until the
hub is wired, an interim Loki-tail transport).

It ships behind the same **off→shadow→enforce** rollout discipline as the recovery family, but —
unlike the board-health delegate — its floor is **`off`**, not `shadow`: coordination adds an
always-on publisher process and, in enforce, network egress, so the safe default is fully inert until
an operator promotes it.

The publisher is launched by `catalyst-stack` — after `otel-forward`, on **worker + monitor** nodes
(gated `catalyst.node.class != developer`, following the reporting substrate) — as a self-managed
nohup child ([`catalyst-stack`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/catalyst-stack)
`start_coordination`). Because the daemon self-exits when the resolved mode is `off` (the default),
`catalyst-stack` short-circuits before spawning it, so launching it unconditionally is safe and an
unconfigured node is byte-identical to before: no publisher process, no PID file, no mirror. When the
mode is `shadow`/`enforce`, the daemon comes up idempotently (a re-run of `catalyst-stack start` — or
the keep-alive tick — never double-starts it); `catalyst-stack status` reports a `coordination` line
(`off (inert)`, or `running … mode=<mode>`). A missing `bun` is non-fatal (a bun-less host resolves to
`off` and never blocks the rest of the stack). **Enforce and the hub transport stay operator-gated** —
this wiring only makes `shadow`/`enforce` take effect where they were previously dark.

Mode resolves from the env var (a single operator knob) over Layer-2 over the default. The `0`
kill-switch and any unset/garbage value both resolve to `off`.

| Key | Default | Notes |
| --- | --- | --- |
| `CATALYST_COORDINATION_MODE` _(env var)_ | `off` | `off` / `0` (kill-switch — strict no-op: no publisher, no mirror, no egress), `shadow` (run the publisher and write the local `~/catalyst/coordination.jsonl` mirror only — no outbound publish, no inbound pull), `enforce` (also exchange rows with the hub: outbound buffer + inbound merge; **operator-gated, never auto-enabled**). Unset or garbage falls back to `off`. Overrides Layer-2. |
| `catalyst.coordination.mode` _(Layer-2)_ | `off` | Same three values; honored when the env var is unset. |
| `CATALYST_COORDINATION_HUB_URL` _(env var)_ | _(none)_ | Base URL of the catalyst-cloud coordination changefeed used in `enforce`. Overrides Layer-2. When empty/unset the publisher uses the interim Loki-tail transport instead. |
| `catalyst.coordination.hubUrl` _(Layer-2)_ | `null` | Same; honored when the env var is unset. |
