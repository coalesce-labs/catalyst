---
date: 2026-07-03
author: claude
ticket: CTL-1423
tags: [decision, channel-watcher, supervision, launchd, heartbeat, otel, dead-mans-switch, ppid-guard]
status: accepted
---

# Channel-Watcher Supervision: Decision Record

> Committed alongside the code it describes so the drift-guard test
> (`plugins/dev/scripts/__tests__/channel-watcher-decision-doc.test.sh`) can verify
> doc↔code consistency from a clean checkout / in CI. The canonical human-facing copy
> also lives in the gitignored `thoughts/shared/decisions/` store; this tracked copy is
> the source of truth for the test.

## Context

An operator's ad-hoc bash watcher (`watch-ctc-channels.sh`) tails md-channel files under
`~/catalyst/comms/md-channels/` and dies **silently** when the parent Claude Code session
cycles — reparented to init without a signal, no heartbeat, no supervisor, no alert.

Nine observed launches revealed two distinct phenomena, only one of which is a defect.

---

## Two Phenomena (i and ii)

### Phenomenon (i) — By-design single-shot exit

**What happens:** The watcher fires and exits 0 with message "NEW TURN detected" (6× observed).

**Why:** The watcher is designed as a one-shot signal: detect a new turn → wake the agent → exit.
The agent then re-arms the watcher for the next turn.

**Is this a defect?** **No.** This is the intended behavior. **Do NOT fix it.** Any supervision
strategy must not eliminate this exit path.

### Phenomenon (ii) — Silent orphan teardown

**What happens:** The parent Claude Code session's process transitions (session cycle, restart),
reparenting the detached watcher child to PID 1 without delivering a signal. The hand-rolled bash
watcher has no PPID guard and no heartbeat → it dies (or is later `pkill`'d) silently
(2× "exit code unknown"; 1× exit 144).

**Why:** The bash watcher uses a bare `tail -F` or sleep loop with no `kill -0 "$PPID"` check.
When the parent disappears, the child never detects the orphan-to-init transition.

**Is this a defect?** **Yes.** This is the gap.

---

## Recommendation

### For md-channels (file-based, not JSONL)

**Supervise the watcher with launchd `KeepAlive`.** The watcher runs as the foreground process of
the LaunchAgent job; on death launchd restarts within seconds. The watcher is long-lived
(emits `channel.watcher.turn-detected` events on new turns instead of exiting), distinguishing
observation from process lifecycle.

Reference pattern: `execution-core/cloud-sync/launch.sh` +
`ai.coalesce.catalyst-cloud-sync.plist` (`KeepAlive:{SuccessfulExit:false}`, `RunAtLoad:true`).

### For JSONL channels

**Keep the canonical `catalyst-events` path.** JSONL channels already flow through
`comms.message.posted` into the unified log, so `catalyst-events wait-for` and the Monitor tool
cover them. No new watcher needed.

### Cheap universal fix: PPID guard for `catalyst-comms`

Port the CTL-439 PPID guard (from `catalyst-events:145-169`) to `catalyst-comms poll --wait` and
`catalyst-comms watch`. The guard is `kill -0 "$PPID" 2>/dev/null || exit 0` at the top of each
polling loop. This closes the silent-orphan gap for any hand-rolled comms watcher without
requiring launchd, and is the cheap, high-value prerequisite.

---

## Heartbeat Contract

The long-lived watcher emits a `channel.watcher.heartbeat` event every interval with the
following identity tuple:

| Key | Description |
|-----|-------------|
| `host.name` | Machine running the watcher |
| `watcher.id` | Stable identifier for this watcher instance |
| `watcher.channel` | md-channel filename being watched |
| `watcher.baseline_turn` | Turn count at which the watcher was armed |
| `watcher.current_turn` | Current turn count (delta from baseline = new turns detected) |

**Event name (frozen):** `channel.watcher.heartbeat`
**Service name (frozen):** `catalyst.channel-watcher`

These constants are the single source of truth in
`plugins/dev/scripts/channel-watcher/lib/heartbeat-schema.mjs`. All consumers must import from
there.

Turn-detected events use event name: `channel.watcher.turn-detected`

---

## Dead-Man's-Switch Contract

The broker's ingestion-recency detector tracks `channel.watcher.heartbeat` recency per
(host, watcher id, channel). When heartbeats go silent past N intervals, it emits:

```
catalyst.alert.raised  event_label=`system_down`  source=<host>/<watcher.id>/<watcher.channel>
```

On recovery (heartbeat resumes):

```
catalyst.alert.cleared  event_label=`system_down`
```

This is the in-repo Tier-1 dead-man's-switch: a dead watcher is never silent.

### LogQL for the catalyst-otel Grafana alert rule

The alert rule in catalyst-otel must consume the re-emitted raised/cleared stream (not
`absent_over_time` on the raw heartbeat — per the `read-path-alerts.yaml` architectural
decision):

```logql
sum(count_over_time({service_name=`catalyst.broker`} | event_entity=`alert`
  | event_label=`system_down` | event_action=`raised` [20m]))
-
(sum(count_over_time({service_name=`catalyst.broker`} | event_entity=`alert`
  | event_label=`system_down` | event_action=`cleared` [20m])) or vector(0))
```

Filter by `source` label to scope to channel-watcher alerts specifically (vs other system_down
sources).

---

## catalyst-otel Cross-Repo Handoff Checklist

The following are **out of scope** for this ticket (CTL-1423) and require a follow-up ticket
against the `catalyst-otel` repository:

- [ ] Grafana dashboard tile: `service_name=catalyst.channel-watcher` heartbeat recency panel
- [ ] Grafana alert rule: fire on `event_label=system_down` raised (quoting the LogQL above)
- [ ] Gatus active probe: `channel.watcher.heartbeat` recency check

The `raised`/`cleared` stream and the LogQL contract above are ready to consume once this ticket
merges.

---

## References

- Ticket: CTL-1423
- PPID guard to port: `plugins/dev/scripts/catalyst-events:145-169` (CTL-439)
- Unguarded loops: `plugins/dev/scripts/catalyst-comms:376-404,516`
- Heartbeat envelope pattern: `plugins/dev/scripts/execution-core/heartbeat-event.mjs`
- Dead-man's-switch: `plugins/dev/scripts/broker/ingestion-recency.mjs` + `alert-emit.mjs`
- launchd supervision template: `execution-core/cloud-sync/launch.sh`
- Schema module: `plugins/dev/scripts/channel-watcher/lib/heartbeat-schema.mjs`
