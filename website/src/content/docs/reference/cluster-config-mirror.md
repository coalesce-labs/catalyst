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

For the two-layer config model (`.catalyst/config.json` vs the three Layer-2 siblings:
`cluster-secrets.json`, `node.json`, `config.json`)
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
[`config.mjs` `getLivenessAnchorIssue`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/execution-core/config.mjs#L1069-L1078)
(SHARED).

| Config item | File / key | Class | On mirror |
|---|---|---|---|
| Bot OAuth orchestrator token | `~/.config/catalyst/cluster-secrets.json` → `catalyst.linear.bot.orchestrator.*` | **SHARED** | Written by `cluster-sync` from `cluster-bots.sops.json`; one Linear app per workspace, identical across nodes. Falls back to `config.json` on nodes that haven't run cluster-sync yet. |
| Bot OAuth worker token | `~/.config/catalyst/cluster-secrets.json` → `catalyst.linear.bot.worker.*` | **SHARED** | Same file — worker and orchestrator tokens are workspace-scoped, not host-scoped |
| Cluster roster | `catalyst-cluster` repo → `cluster.json` `roster[]` | **SHARED** | Add the new node's name to `cluster.json.roster` and push. `cluster-sync` pulls it and the next scheduler tick honors it — no restart. *(The legacy committed `.catalyst/hosts.json` roster was retired in CTL-1274; the daemon no longer reads it.)* |
| Layer-1 project config | `.catalyst/config.json` | **SHARED** | Committed to git; present after `git clone` |
| Liveness anchor issue | `~/.config/catalyst/cluster-secrets.json` → `catalyst.cluster.livenessAnchorIssue` | **SHARED** | Written by `catalyst-join` from the bundle; one Linear ticket identifier per fleet. Falls back to `config.json`. The configured anchor is infrastructure, not work: do not close, archive, or delete it. `catalyst doctor`'s `liveness-anchor` check FAILs if it is archived or missing. To move it, see [Moving the liveness anchor](#moving-the-liveness-anchor). |
| Cloud token (`CATALYST_CLOUD_TOKEN`) | `catalyst-cluster` repo → `secrets/cluster-cloud.sops.json` `catalyst.cloud.token` | **SHARED** | One shared catalyst-cloud service credential (CTL-1307). Add it once to the cluster repo (SOPS); `cluster-sync` decrypts it to `~/.config/catalyst/cluster-cloud.json` and `cloud-token-env.mjs` projects it to the machine-level env (`cluster.env` + `~/.zshenv` guard) on every node. **Intentionally unread by catalyst core** — a prerequisite for the opt-in cloud path, not a switch that turns it on. |
| Plugin source | `~/catalyst/plugin-source/` | **SHARED** | Pull from the same git remote; `setup-plugin-source.sh` does this |
| Linear team/state map | Layer-1 `catalyst.linear.teamKey` / `stateMap` | **SHARED** | Present after `git clone` via `.catalyst/config.json` |
| `catalyst.host.name` | `~/.config/catalyst/node.json` → `catalyst.host.name` | **PER-NODE** | Written by `catalyst-join` (non-clobber). Set to the new node's unique roster entry (must match an entry in the `catalyst-cluster` repo's `cluster.json.roster`; a name that isn't in the roster owns zero tickets under HRW). Falls back to `config.json`. |
| `repoRoot` | `~/catalyst/execution-core/registry.json` → `repoRoot` | **PER-NODE** | The absolute path on the new host; written by `catalyst-execution-core register` |
| Claude Code account login | macOS Keychain or `~/.claude/.credentials.json` | **PER-NODE** | Run `claude` interactively on the new host; each node uses its own account |
| OTel endpoints | `~/.config/catalyst/config.json` → OTel keys | **PER-NODE** | Tailscale addresses differ per node; set in Layer-2 on each host |
| `execution-core.env` | `~/catalyst/execution-core/execution-core.env` | **PER-NODE** | Proxy / tuning overrides are host-specific |
| Event log | `~/catalyst/events/<period>.jsonl` | **PER-NODE** | Each node writes to its own log; nodes never share log files |
| SQLite databases | `~/catalyst/*.db` (4 files) | **PER-NODE** | Host-local state; not replicated |
| Worktree trust | `~/.claude.json` per worktree path | **PER-NODE** | Paths differ; re-trust on each host |
| Linear personal token | `~/.config/catalyst/config-<key>.json` → `linear.apiKey` | **PER-NODE** | Personal token is user-scoped; each operator provides their own |
| Webhook secrets | `~/.config/catalyst/config-<key>.json` → webhook keys | **PER-NODE** | Regenerate or copy securely; not managed by the mirror process |

## Moving the liveness anchor

The anchor is the Linear issue every host upserts its `catalyst://heartbeat/<host>` attachment onto.
It is **SHARED** config: while hosts disagree about which issue it is, they cannot see each other's
heartbeats, so dispatch degrades to the full roster and cross-host failover stops (it does not stop
dispatching — see _Cross-host ticket ownership_ in
[`docs/architecture.md`](https://github.com/coalesce-labs/catalyst/blob/main/docs/architecture.md)).

Move it only when necessary, and move every host in one sitting:

1. Create or pick the replacement issue. Put "this is the cluster liveness anchor — do not close"
   in its body, and leave it open.
2. On **every** host in the roster: `catalyst-cluster set-anchor <TICKET>` — this writes
   `catalyst.cluster.livenessAnchorIssue` into Layer-2 and reports `restartRequired: true`.
3. On **every** host: `catalyst-stack restart`. The publisher reads the anchor at arm time, so an
   un-restarted host keeps publishing to the old issue.
4. Verify on each host: `catalyst doctor` → the `liveness-anchor` check reads **PASS**, and
   `catalyst-cluster status` shows every peer `live` within one publish interval
   (`EXECUTION_CORE_LIVENESS_PUBLISH_INTERVAL_MS`, default 120 s).
5. Leave the old anchor issue **open** until step 4 passes everywhere; only then may it be closed.

A host reading liveness from Loki (`CATALYST_LIVENESS_READ_SOURCE=loki`) is unaffected by the anchor
— `catalyst doctor` grades its `liveness-anchor` check INFO rather than PASS/FAIL.

> **Why bot OAuth is SHARED:** `catalyst.linear.bot.orchestrator` and `catalyst.linear.bot.worker`
> are credentials for a Linear OAuth application that is registered once per workspace. Every node in
> the fleet acts on behalf of the same app. The tokens live in machine-global
> `~/.config/catalyst/cluster-secrets.json` (written by `cluster-sync` from `cluster-bots.sops.json`;
> falls back to `config.json` on nodes that haven't run cluster-sync yet) so all nodes can
> share them without per-project duplication.

> **Why the cloud token is SHARED + machine-level (CTL-1307):** `CATALYST_CLOUD_TOKEN` is a single
> service credential (the catalyst-cloud `ADMIN_TOKEN`, interim per CTC-27 / ADR-0006) that must be
> **identical on every node**, so it lives once in the `catalyst-cluster` repo's
> `secrets/cluster-cloud.sops.json` (a *separate* SOPS file from `cluster-bots` so its rotation/GC
> lifecycle is independent — it is superseded by per-tenant org-scoped keys per CTC-46). `cluster-sync`
> decrypts it to `~/.config/catalyst/cluster-cloud.json`; `cloud-token-env.mjs` (run by `catalyst-stack`
> at boot + keep-alive, or on demand via `catalyst-stack sync-cloud-env`) projects it into the
> **machine-level environment**: the secret is written to a `0600` `~/.config/catalyst/cluster.env`,
> and a single non-secret guard line in `~/.zshenv` sources it — so every login shell, and any cloud
> daemon (re)started in a shell context (this fleet's convention for env-key pickup), inherits
> `CATALYST_CLOUD_TOKEN`. **Default behavior is unchanged:** nothing in catalyst reads the variable;
> a node stays fully local-only until the operator separately opts into cloud services.

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

---

## Account status-transition event (CTL-1653)

Event name: `account.status.changed` (v2 OTel envelope, `event.entity: "account"`, severity INFO).

**Edge-triggered, not per-sample.** Unlike `account.ratelimit.sampled` (which is emitted every poll
tick from the interactive-login `/api/oauth/usage` probe), `account.status.changed` is appended by
the orch-monitor's periodic probe **only** on the ACTIVE account's `ok`↔`rejected` transition — one
event per edge, never on a same-status repeat. It is sourced from the CTL-1650 durable-token header
probe ([`claude-accounts-usage.mjs`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/claude-accounts-usage.mjs)),
a different path from the CTL-812 usage sampler; the two coexist. A transport `error` (sensor
failure) is distinct from `rejected` (account exhausted) and does **not** trip the transition.

| Attribute key | Type | Meaning |
|---|---|---|
| `account.handle` | string | The account label (`acctN`) that transitioned |
| `account.email` | string | The account email (from the env-file inline comment) |
| `account.status` | string | The new status — `"rejected"` (exhausted) or `"ok"` (recovered) |
| `account.binding_window` | string | The binding window driving the status — `"five_hour"` \| `"seven_day"` |
| `node.name` | string | The node whose active account transitioned |

The node identity is also carried on the envelope's `resource["host.name"]`. The edge is latched
durably at `~/catalyst/account-status-latch.json` (atomic write, emit-then-advance) so a monitor
restart mid-episode does not re-emit. Consumers must treat absent keys as unknown, not as a value.

The same posture is available as a pull surface — the token-free `GET /api/accounts` endpoint and
its `GET /api/accounts/stream` SSE (see the [orch-monitor API](/reference/orch-monitor-api/)).
