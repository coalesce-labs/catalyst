---
title: Cluster config mirror contract
description: Canonical SHARED vs PER-NODE classification for every config item, plus the quota field-name schema consumed by heartbeat and monitoring code.
sidebar:
  order: 20
---

This page is the single source of truth for two contracts consumed by cluster setup and
monitoring code (M1 mirror tickets, CTL-1192 heartbeat quota):

1. **Config-mirror contract** — every config item classified SHARED (copy verbatim to a new node)
   or PER-NODE (regenerate on each host), with exact file and key locations.
2. **Quota field-name schema** — the dotted event-log keys emitted by `ratelimit-event.mjs`,
   pinned here so heartbeat and quota consumers (CTL-1192) share one field-name contract.

For the two-layer config model (`.catalyst/config.json` vs `~/.config/catalyst/config-{key}.json`)
see the [configuration reference](/reference/configuration/).

---

## Config-mirror contract

When you provision a second node, copy everything marked **SHARED** verbatim and regenerate
everything marked **PER-NODE**. The classification is encoded in
[`config.mjs` `getHostName`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/execution-core/config.mjs#L199-L212)
(PER-NODE),
[`config.mjs` `resolveClusterHosts`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/execution-core/config.mjs#L278-L302)
(the roster — SHARED, resolved live from the `catalyst-cluster` repo via
[`readClusterConfig`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/execution-core/config.mjs#L183)),
and
[`config.mjs` `getLivenessAnchorIssue`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/execution-core/config.mjs#L335-L348)
(SHARED).

| Config item | File / key | Class | On mirror |
|---|---|---|---|
| Bot OAuth orchestrator token | `~/.config/catalyst/config.json` → `catalyst.linear.bot.orchestrator.*` | **SHARED** | Copy the whole `catalyst.linear.bot` block (one Linear app per workspace; identical across nodes) |
| Bot OAuth worker token | `~/.config/catalyst/config.json` → `catalyst.linear.bot.worker.*` | **SHARED** | Same block — worker and orchestrator tokens are workspace-scoped, not host-scoped |
| Cluster roster | `catalyst-cluster` repo → `cluster.json` `roster[]` | **SHARED** | Add the new node's name to `cluster.json.roster` and push. `cluster-sync` pulls it and the next scheduler tick honors it — no restart. *(The legacy committed `.catalyst/hosts.json` roster was retired in CTL-1274; the daemon no longer reads it.)* |
| Layer-1 project config | `.catalyst/config.json` | **SHARED** | Committed to git; present after `git clone` |
| Liveness anchor issue | `~/.config/catalyst/config.json` → `catalyst.cluster.livenessAnchorIssue` | **SHARED** | Copy from the seed node; one Linear ticket identifier per fleet |
| Plugin source | `~/catalyst/plugin-source/` | **SHARED** | Pull from the same git remote; `setup-plugin-source.sh` does this |
| Linear team/state map | Layer-1 `catalyst.linear.teamKey` / `stateMap` | **SHARED** | Present after `git clone` via `.catalyst/config.json` |
| `catalyst.host.name` | `~/.config/catalyst/config.json` → `catalyst.host.name` | **PER-NODE** | Set to the new node's unique roster entry (must match an entry in the `catalyst-cluster` repo's `cluster.json.roster`; a name that isn't in the roster owns zero tickets under HRW) |
| `repoRoot` | `~/catalyst/execution-core/registry.json` → `repoRoot` | **PER-NODE** | The absolute path on the new host; written by `catalyst-execution-core register` |
| Claude Code account login | macOS Keychain or `~/.claude/.credentials.json` | **PER-NODE** | Run `claude` interactively on the new host; each node uses its own account |
| OTel endpoints | `~/.config/catalyst/config.json` → OTel keys | **PER-NODE** | Tailscale addresses differ per node; set in Layer-2 on each host |
| `execution-core.env` | `~/catalyst/execution-core/execution-core.env` | **PER-NODE** | Proxy / tuning overrides are host-specific |
| Event log | `~/catalyst/events/YYYY-MM.jsonl` | **PER-NODE** | Each node writes to its own log; nodes never share log files |
| SQLite databases | `~/catalyst/*.db` (4 files) | **PER-NODE** | Host-local state; not replicated |
| Worktree trust | `~/.claude.json` per worktree path | **PER-NODE** | Paths differ; re-trust on each host |
| Linear personal token | `~/.config/catalyst/config-<key>.json` → `linear.apiKey` | **PER-NODE** | Personal token is user-scoped; each operator provides their own |
| Webhook secrets | `~/.config/catalyst/config-<key>.json` → webhook keys | **PER-NODE** | Regenerate or copy securely; not managed by the mirror process |

> **Why bot OAuth is SHARED:** `catalyst.linear.bot.orchestrator` and `catalyst.linear.bot.worker`
> are credentials for a Linear OAuth application that is registered once per workspace. Every node in
> the fleet acts on behalf of the same app. The tokens live in machine-global
> `~/.config/catalyst/config.json` (not in the per-project `config-<key>.json`) so all nodes can
> share them without per-project duplication.

---

## Canonical quota field-name schema

**Single source of truth:** [`ratelimit-event.mjs:63-70`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/execution-core/ratelimit-event.mjs#L63-L70)
(line 62 emits the `account.email` identity key, which is not part of the quota schema below).

Event name: `account.ratelimit.sampled` (severity INFO, emitted every poll tick).

The table below documents the eight dotted attribute keys emitted by `buildRatelimitEnvelope`.
Consumers (orch-monitor, HUD, CTL-1192 heartbeat quota) **must** reference these names, not the
camelCase params used internally by `ratelimit-poller.mjs`.

| Attribute key | Type | Meaning |
|---|---|---|
| `ratelimit.five_hour_pct` | number | 5-hour rolling usage as a percentage of the window limit (0–100+) |
| `ratelimit.seven_day_pct` | number | 7-day rolling usage as a percentage of the window limit |
| `ratelimit.five_hour_resets_at` | string (ISO-8601) | When the 5-hour window resets |
| `ratelimit.seven_day_resets_at` | string (ISO-8601) | When the 7-day window resets |
| `ratelimit.seven_day_opus_pct` | number | 7-day Opus usage as a percentage — the **binding limit on Max 20x plans** (exhausts before `ratelimit.seven_day_pct` on Opus-heavy allocations) |
| `ratelimit.seven_day_sonnet_pct` | number | 7-day Sonnet usage as a percentage |
| `subscription.type` | string | Claude subscription tier (e.g. `"max"`) |
| `rate_limit.tier` | string | API rate-limit tier identifier |

All eight keys are conditional: a key is omitted from the attributes map when its source value is
`null` or `undefined`. Consumers must treat absent keys as unknown, not as zero.

### Internal-only camelCase params

[`ratelimit-poller.mjs:257-262`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/execution-core/ratelimit-poller.mjs#L257-L262)
passes values to `emitRatelimitEvent` using camelCase parameter names (`fiveHourPct`,
`sevenDayPct`, `opusPct`, `sonnetPct`, etc.). These camelCase names are **internal-only** and must
not appear in consumer code or heartbeat schemas. The dotted keys in the table above are the
contract; the camelCase params are an implementation detail of the emitter.

### CTL-1192 heartbeat `quota{}` shape (proposed)

When CTL-1192 extends the heartbeat Linear attachment with a `quota{}` block, it should map the
dotted event keys directly:

```json
{
  "quota": {
    "five_hour_pct": 42,
    "seven_day_pct": 18,
    "seven_day_opus_pct": 67,
    "seven_day_sonnet_pct": 12,
    "five_hour_resets_at": "2026-06-16T06:00:00Z",
    "seven_day_resets_at": "2026-06-20T00:00:00Z",
    "subscription_type": "max",
    "rate_limit_tier": "usage_tier_2"
  }
}
```

Use the snake_case field names (strip the `ratelimit.` prefix) so the heartbeat attachment stays
human-readable. The source event keys remain the canonical names — this shape is a derived view.
