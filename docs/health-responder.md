# Cloud-Sync Health Responder

`health-responder.sh` is a launchd-scheduled bash script that runs every 3 minutes (configurable)
and performs a **bounded, local ACT step** for the supervised cloud-sync replica writer:
catalyst-doctor only *detects* a dead/wedged writer; the responder *kickstarts* it — at most a few
times per window — then escalates loudly and stops (CTL-1509).

## Why a Periodic Sweep, Not a Daemon

The responder guards long-lived daemons against exactly the failure class long-lived daemons
suffer: silent wedging. A watcher **daemon** can zombie the same way its patient does; a
short-lived launchd `StartInterval` job (the orphan-sweep pattern) is a fresh process every
interval and cannot. All detection is **local** — plist on disk, `pgrep`, `writer.lock` mtime, the
CTL-1508 breadcrumb file — never Linear, never Loki, so the responder keeps working through
exactly the outages it exists to respond to.

## What It Watches (Three Conditions)

| # | Condition | Detection | Why it fires |
|---|-----------|-----------|--------------|
| 1 | dead-writer | cloud-sync plist installed (`~/Library/LaunchAgents/ai.coalesce.catalyst-cloud-sync.plist`) but no `cloud-sync.mjs` process (`pgrep -f`) | `KeepAlive={SuccessfulExit:false}` should have relaunched a crashed writer; if it didn't, the launchd job is wedged |
| 2 | stale-writer | process EXISTS but `<db>.writer.lock` mtime older than `RESPONDER_LOCK_STALE_SECS` (900s) | the SDK rewrites the lock ~5s, **feed-independently** — a quiet Linear feed never stales the lock; only a dead SDK heartbeat does. Doctor WARNs at 60s; the responder ACTS only at 900s (act-threshold ≫ detect-threshold, so heartbeat jitter is never kickstarted) |
| 3 | no-respawn | cloud-sync plist installed, `~/catalyst/cloud-sync.selfheal.json` has `expectRestart:true`, no process, and the breadcrumb `ts` (or file mtime) is older than `RESPONDER_SELFHEAL_GRACE_SECS` (120s) | the CTL-1508 self-heal exit expected a launchd relaunch that never came. **File absent = the normal case** (CTL-1508 ships in parallel); absent/malformed is silently ignored |

All three conditions are **installed-gated** — a node without the cloud-sync plist is not on the
replica tier and is never acted on, even if a stale breadcrumb is lying around.

**Settling hold:** a breadcrumb *within* the grace window suppresses **all** action (including
dead-writer) and heartbeats `status=settling` — the writer exited on purpose expecting a launchd
relaunch, and a `kickstart -k` during that window would race and kill the legitimately-settling
instance. The breadcrumb either clears (relaunch landed) or ages into condition 3.

**Fail-safe cap:** if the attempt marker cannot be written (unwritable state dir), the responder
refuses to kickstart at all (`status=degraded`, loud ERROR each sweep) — an uncountable attempt
would make the cap unenforceable, degrading into exactly the unbounded restart storm the cap
exists to prevent. `--dry-run` is read-only end to end: no state dir creation, no marker pruning,
no re-arm — only `would-…` log lines.

An **absent** `writer.lock` is *not* stale (guard disabled / writer never started / older SDK —
doctor makes the same call); only a **present-but-old** lock is the strong "SDK heartbeat died"
signal. A node without the cloud-sync plist is not on the replica tier and is simply left alone.

## What It Does (Bounded Kickstart)

On any condition: `launchctl kickstart -k gui/$(id -u)/ai.coalesce.catalyst-cloud-sync`, capped at
`RESPONDER_MAX_ATTEMPTS` (3) per `RESPONDER_ATTEMPT_WINDOW_SECS` (3600). Attempts are timestamped
marker files under `~/catalyst/.health-responder/`, pruned past the window on every run. After a
kickstart the responder waits ~10s, re-probes, and logs `recovered` or `still-down`. A failed
`launchctl` call is logged and **still counted** — the responder never crash-loops launchctl.

## Escalation Contract

When the cap is exhausted and the condition persists:

1. Write the one-shot marker `~/catalyst/.health-responder/ESCALATED.cloud-sync`.
2. Emit `catalyst.responder.escalated` via `emit-otel-event.sh` (fail-open — a telemetry failure
   never fails the responder).
3. Log an `ERROR: escalated …` line (Alloy ships `~/catalyst/health-responder.log` conventions to
   Loki for alerting).
4. **Stop kickstarting.** While the marker exists and the condition persists, every run is a
   heartbeat-only hold.

The condition clearing (a healthy probe) removes the marker and the attempt files — the responder
re-arms itself with a fresh budget for the next incident.

## Heartbeat (a Dead Responder Must Be Distinguishable From a Quiet One)

Every run — healthy, acting, escalated, disabled, dry-run — ends with exactly one grep-stable line:

```
[health-responder <run-id>] heartbeat status=<healthy|recovered|still-down|escalated|disabled|dry-run> installed=… alive=… dead_writer=… stale_lock=… no_respawn=… attempts=N/M escalated=…
```

Silence in `~/catalyst/health-responder.log` for longer than the interval means the **responder**
is down (the stale-copy-reports-healthy rule), not that everything is fine.

## Configuration (env overrides)

| Variable | Default | Purpose |
|----------|---------|---------|
| `RESPONDER_ENABLED` | `1` | Kill-switch; `0` = heartbeat-only no-op |
| `RESPONDER_LOCK_STALE_SECS` | `900` | Stale-writer act threshold (doctor's detect threshold is 60s) |
| `RESPONDER_SELFHEAL_GRACE_SECS` | `120` | Grace after a CTL-1508 self-heal exit before no-respawn fires |
| `RESPONDER_MAX_ATTEMPTS` | `3` | Kickstarts per window before escalating |
| `RESPONDER_ATTEMPT_WINDOW_SECS` | `3600` | Attempt-cap window |
| `RESPONDER_KICKSTART_WAIT_SECS` | `10` | Post-kickstart settle before the re-probe |
| `RESPONDER_STATE_DIR` | `~/catalyst/.health-responder` | Attempt + ESCALATED marker dir |
| `RESPONDER_SELFHEAL_FILE` | `~/catalyst/cloud-sync.selfheal.json` | CTL-1508 breadcrumb path |
| `RESPONDER_DRY_RUN` | unset | Set to `1` or use `--dry-run` (log would-kickstart, do nothing) |
| `RESPONDER_RUN_ID` | timestamp | Tags log lines + telemetry for one run |
| `CATALYST_REPLICA_DB` | `~/catalyst/catalyst-replica.db` | Lock = `<db>.writer.lock` (mirrors `getReplicaDbPath`) |
| `CATALYST_LAUNCHAGENTS_DIR` | `~/Library/LaunchAgents` | Plist dir (mirrors doctor.mjs) |

The launchd schedule comes from `.catalyst/config.json` → `catalyst.responder.intervalSeconds`
(default 180, clamped 60–900) at install time.

## Installation

> **Golden rule (CTL-1306): install from the pristine clone, never a worktree.** The LaunchAgent
> bakes an absolute path to `health-responder.sh` and that path is permanent. A worktree/temp path
> can be deleted, after which the job exit-127s silently every interval — and the fleet loses its
> cloud-sync self-healer exactly when nobody is watching.

Normally installed automatically by `catalyst-stack install-services` (same delegated,
non-fatal block as the orphan-sweep reaper). To (re)install manually, run **from the pristine
clone**:

```bash
bash ~/catalyst/plugin-source/plugins/dev/scripts/install-health-responder.sh
launchctl list | grep health-responder   # LastExit must be 0
```

`install-health-responder.sh` is idempotent, prefers the registered `pluginDirs` clone, and
**refuses** to bake a linked-worktree or `/tmp` path. Preview with `--print-only`; remove with
`--uninstall`.

```bash
# Dry-run — logs intended actions without performing any
bash plugins/dev/scripts/health-responder.sh --dry-run

tail -f ~/catalyst/health-responder.log
```

## Health Check

`catalyst-doctor` asserts the responder is healthy (`checkHealthResponder`, mirroring
`checkReaper`). Every check is a **WARN**, never a FAIL — doctor's exit code gates the
`catalyst-join` activation gate, which runs *before* `install-services` would reinstall a stale
plist, so a FAILing responder check would block a node from self-healing via join:
`responder-installed` (plist absent/malformed), `responder-path` (baked program path gone — the
CTL-1306 silent-death signature), `responder-killswitch` (installed script lacks the
`RESPONDER_ENABLED` marker — stale install), `responder-loaded` (present but never bootstrapped),
and `responder-health` (`LastExit` 127 / non-zero). Loaded + exit 0 (or never run yet) is PASS.

## Relationship to Other Components

- **doctor `checkCloudSync`** — the detect side (60s lock-stale WARN, agent-installed,
  process-alive). The responder deliberately re-implements the same probes in bash with a far more
  conservative act threshold; it never changes doctor behavior.
- **CTL-1508 self-heal breadcrumb** — built in parallel; the responder treats file-absent as the
  normal case. `expectRestart:true` relaunches within the grace window are *expected* and never
  counted against the attempt cap.
- **`catalyst-stack adopt-cloud-sync`** — the install/repair path for the writer itself; the
  responder only kickstarts the existing LaunchAgent, never bootstraps or reconfigures it (and
  never runs `bun cloud-sync.mjs` directly — that would fight the SDK single-writer lock and
  bypass token sourcing).
- **orphan-sweep (`docs/orphan-sweep.md`)** — the structural template: same installer contract,
  same launchd pattern, same fail-open telemetry idiom.

## Log

All output goes to `~/catalyst/health-responder.log` (configured in the plist). Each line is
prefixed with `[health-responder <run-id>]` for correlation.
