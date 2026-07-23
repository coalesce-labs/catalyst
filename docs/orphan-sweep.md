# Periodic Orphan Sweep

`orphan-sweep.sh` is a launchd-scheduled bash script that runs every 30 minutes and reclaims
orphaned resources on unattended hosts. It complements the execution-core real-time reaper
(CTL-657) — it acts whether or not the orchestrator daemon is alive.

## What It Reclaims (Five Vectors)

| # | Vector | What | Safety gate |
|---|--------|------|-------------|
| 1 | Stale processes | `bun`/`node`/`turbo` procs whose backing worktree is gone | Kill ONLY if proc CWD no longer exists on disk; unknown CWD → skip |
| 2 | Done-ticket worktrees | Worktrees for Linear "Done" tickets not cleaned by `/teardown` | `worktree-presweep.sh` stops sessions first; `git status --porcelain` must be clean; NEVER removes dirty worktrees |
| 3 | Stale phase signals | `status=running` signals whose `bg_job_id` is dead and >30 min old | Flip ONLY if `bg_job_id` absent from `claude agents --json`; never touch interactive-kind or terminal statuses |
| 4 | Trunk repo cache dirs | `~/.cache/trunk/repos` entries with mtime >30 days | mtime only; no live-process guard needed |
| 5 | Leaked agent-browser browsers | agent-browser's persistent daemon + its "Chrome for Testing" / `chrome-headless-shell` browser that outlived the CLI — reaped when a browser subtree is CPU-pegged (runaway) or older than a TTL, plus stale `~/.agent-browser/<session>.sock\|.pid` housekeeping (CTL-1500) | Target ONLY the Playwright browser under `ms-playwright/` (bundle `com.google.chrome.for.testing`) validated against the `agent-browser …/daemon.js` owner; any command under `/Applications/` is HARD-EXCLUDED so the user's personal `/Applications/Google Chrome.app` is NEVER touched |

Telemetry: one `emit-otel-event.sh` call per reclaimed resource (`catalyst.sweep.reclaim`, vector `agent_browser` for #5), fail-open.

### Vector 5 tuning (agent-browser reaper)

Version-agnostic backstop for the CTL-1500 leak (old agent-browser builds have no
idle timeout). Knobs (env, all with production defaults):

| Env | Default | Meaning |
|-----|---------|---------|
| `SWEEP_AB_ENABLED` | `1` | reaper on/off |
| `SWEEP_AB_CPU_THRESHOLD` | `30` | runaway browser %CPU threshold |
| `SWEEP_AB_MIN_AGE_SECS` | `600` | min browser age for the runaway rule (guards short automation bursts) |
| `SWEEP_AB_TTL_SECS` | `14400` | absolute leaked-browser age cap (4h) |
| `SWEEP_AB_SOCKET_DIR` | `$AGENT_BROWSER_SOCKET_DIR` → `$XDG_RUNTIME_DIR/agent-browser` → `~/.agent-browser` | sock/pid dir |

Reap = graceful `kill` of the daemon (its `SIGTERM` handler closes the browser) plus
the root browser process (cascades helper children), then removal of that session's
`.sock`/`.pid`. Complements the forward fix: phase workers now launch with
`AGENT_BROWSER_IDLE_TIMEOUT_MS` set so newer agent-browser self-shuts-down when idle.

## Installation

> **Golden rule (CTL-1306): install from the pristine clone, never a worktree.**
> The LaunchAgent bakes an absolute path to `orphan-sweep.sh` and that path is
> permanent. It MUST point at the main-only pristine clone `~/catalyst/plugin-source`
> (what `~/.catalyst/bin/*` and `catalyst.orchestration.pluginDirs` resolve to) —
> never an ephemeral checkout (a git worktree under `~/catalyst/wt/` or
> `.claude/worktrees/`, or a `/tmp` dir). A worktree path can be deleted, after
> which the job exit-127s silently every interval and debris piles up unnoticed —
> the original regression that killed the reaper on two of three hosts for ~10 days.

### 1. Install the launchd job

Normally the reaper is installed automatically as the 4th agent by
`catalyst-stack install-services` (which `catalyst-join.sh` runs during
onboarding), so a joined member gets it for free. To (re)install manually, run
the installer **from the pristine clone**:

```bash
bash ~/catalyst/plugin-source/plugins/dev/scripts/install-orphan-sweep.sh
launchctl list | grep orphan-sweep   # LastExit must be 0
```

`install-orphan-sweep.sh` is idempotent, prefers the registered `pluginDirs`
clone, and **refuses** to bake a linked-worktree or `/tmp` path. Preview with
`--print-only`; remove with `--uninstall`.

If `~/catalyst/plugin-source` is stale (e.g. a non-daemon host with no broker
auto-pull), fast-forward it first: `bash <repo>/plugins/dev/scripts/setup-plugin-source.sh`.

### 2. Verify a clean run

```bash
# Dry-run — logs intended actions without performing any
bash plugins/dev/scripts/orphan-sweep.sh --dry-run

# After an interval (or force a run)
tail -f ~/catalyst/orphan-sweep.log
```

### 3. Unload

```bash
launchctl unload ~/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist
```

## Configuration (env overrides)

| Variable | Default | Purpose |
|----------|---------|---------|
| `SWEEP_TRUNK_CACHE_DIR` | `$HOME/.cache/trunk/repos` | Vector 4 root |
| `SWEEP_WORKERS_GLOB_ROOT` | `$HOME/catalyst` | Vector 3 root (scans `*/workers/*/phase-*.json`) |
| `SWEEP_WT_ROOT` | `$HOME/catalyst/wt` | Vector 2 worktree root |
| `SWEEP_STALE_SECS` | `1800` | Staleness threshold for vector 3 |
| `SWEEP_CACHE_MTIME_DAYS` | `30` | Cache age threshold for vector 4 |
| `SWEEP_LINEAR_TEAMS` | `CTL ADV` | Teams to query for Done tickets (vector 2) |
| `SWEEP_DRY_RUN` | unset | Set to `1` or use `--dry-run` flag |
| `SWEEP_RUN_ID` | timestamp | Tags all telemetry for one run |

## Health check & troubleshooting

`catalyst-doctor` asserts the reaper is healthy (CTL-1306). Every reaper check is
a **WARN**, never a FAIL — the doctor's exit code gates the `catalyst-join`
activation gate, which runs *before* `install-services` would reinstall a stale
plist, so a FAILing reaper check would block a node from self-healing via join:
`reaper-installed` (WARN if the LaunchAgent is absent), `reaper-path` (WARN if the
baked program path no longer exists — the silent-death signature), `reaper-loaded`
(WARN if the plist is present but launchd never loaded the job), and
`reaper-health` (WARN on a `LastExit` of 127 or any other non-zero exit). A
loaded job with `LastExit` 0 (or that has never run yet) is `reaper-health` PASS.

- **`launchctl list | grep orphan-sweep` shows exit 127**, log full of
  `No such file or directory` → the baked path was deleted. Re-point from the
  pristine clone (Installation above). This is the CTL-1306 failure mode.
- **Debris not shrinking** → SAFE removals are capped per run
  (`maxRemovalsPerRun`, default 10). For a one-shot drain raise it:
  `SWEEP_MAX_REMOVALS=50 orphan-sweep.sh`. Remaining trees are protected
  SALVAGE/dirty — triage by hand, never `rm -rf` (that also leaves stale
  `.git/worktrees` admin entries; use `git worktree remove` + `git worktree prune`).

## Relationship to Other Components

- **CTL-657** (Done) — Fixed the real-time reaper in execution-core. The orphan sweep is a belt-and-suspenders complement that catches resources the reaper missed, or those that accumulate when the daemon is not running.
- **CTL-691** (Backlog) — Trunk daemon kill (`pkill trunk daemon launch`) is explicitly out of scope here.
- **CTL-692** (Research) — `claude agents` invocation timeout is explicitly out of scope here.
- **`/teardown`** skill — The preferred cleanup path for interactive sessions; the sweep handles the automatic-cleanup case for unattended hosts.

## Log

All output goes to `~/catalyst/orphan-sweep.log` (configured in the plist). Each line is prefixed with `[orphan-sweep <run-id>]` for correlation.
