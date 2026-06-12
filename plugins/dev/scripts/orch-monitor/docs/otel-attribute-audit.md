<!-- GENERATED — edit lib/otel-attribute-audit.ts, run `bun run audit:gen` to regenerate -->

# OTel Attribute Audit — Conformance Manifest

Single source of truth for every emit-side attribute's classification against
OTel semantic conventions. Generated from `lib/otel-attribute-audit.ts` (CTL-1009).
Do **not** edit this file directly.

## Classification Summary

| Classification | Count |
| --- | --- |
| ✓ Conforming | 28 |
| → Rename-to | 9 |
| ● Legitimately Custom | 32 |
| **Total** | 69 |

## Classification by Emitter

### TypeScript (`canonical-event.ts`)

| Key | Source | Classification | Target | Cluster | Note |
| --- | --- | --- | --- | --- | --- |
| `catalyst.event.action` | `canonical-event.ts:61` | ✓ conforming |  |  |  |
| `catalyst.event.channel` | `canonical-event.ts:64` | ✓ conforming |  |  |  |
| `catalyst.event.entity` | `canonical-event.ts:60` | ✓ conforming |  |  |  |
| `catalyst.event.label` | `canonical-event.ts:62` | ✓ conforming |  |  |  |
| `catalyst.event.value` | `canonical-event.ts:63` | ✓ conforming |  |  |  |
| `catalyst.orchestration` | `canonical-event.ts:54` | ● custom |  |  |  |
| `catalyst.orchestrator.id` | `canonical-event.ts:67` | ● custom |  |  |  |
| `catalyst.phase` | `canonical-event.ts:70` | ● custom |  |  |  |
| `catalyst.project` | `canonical-event.ts:52` | ● custom |  |  |  |
| `catalyst.session.id` | `canonical-event.ts:69` | ● custom |  |  |  |
| `catalyst.worker.ticket` | `canonical-event.ts:68` | ● custom |  |  |  |
| `cicd.pipeline.name` | `canonical-event.ts:82` | ✓ conforming |  |  |  |
| `cicd.pipeline.run.id` | `canonical-event.ts:79` | ✓ conforming |  |  |  |
| `cicd.pipeline.run.result` | `canonical-event.ts:81` | ✓ conforming |  |  |  |
| `cicd.pipeline.run.status` | `canonical-event.ts:80` | ✓ conforming |  |  |  |
| `claude.context.tokens` | `canonical-event.ts:100` | ● custom |  |  |  |
| `claude.context.used_pct` | `canonical-event.ts:99` | ● custom |  |  |  |
| `claude.model` | `canonical-event.ts:98` | ● custom |  |  |  |
| `claude.session.id` | `canonical-event.ts:97` | ● custom |  |  |  |
| `claude.turn` | `canonical-event.ts:101` | ● custom |  |  |  |
| `deployment.environment.name` | `canonical-event.ts:91` | ✓ conforming |  |  |  |
| `deployment.id` | `canonical-event.ts:92` | ✓ conforming |  |  | type should be string per OTel semconv; currently number |
| `event.name` | `canonical-event.ts:59` | ✓ conforming |  |  |  |
| `host.id` | `canonical-event.ts:48` | ✓ conforming |  |  |  |
| `host.name` | `canonical-event.ts:47` | ✓ conforming |  |  |  |
| `linear.actor.id` | `canonical-event.ts:88` | ● custom |  |  |  |
| `linear.issue.id` | `canonical-event.ts:86` | ● custom |  |  |  |
| `linear.issue.identifier` | `canonical-event.ts:85` | ● custom |  |  |  |
| `linear.key` | `canonical-event.ts:53` | ● custom |  |  |  |
| `linear.team.key` | `canonical-event.ts:87` | ● custom |  |  |  |
| `service.name` | `canonical-event.ts:43` | ✓ conforming |  |  |  |
| `service.namespace` | `canonical-event.ts:44` | ✓ conforming |  |  |  |
| `service.version` | `canonical-event.ts:45` | ✓ conforming |  |  |  |
| `vcs.pr.number` | `canonical-event.ts:74` | ✓ conforming |  |  |  |
| `vcs.ref.name` | `canonical-event.ts:75` | ✓ conforming |  |  |  |
| `vcs.ref.revision` | `canonical-event.ts:76` | ✓ conforming |  |  |  |
| `vcs.repository.name` | `canonical-event.ts:73` | ✓ conforming |  |  |  |

### Bash (`canonical-event.sh`)

| Key | Source | Classification | Target | Cluster | Note |
| --- | --- | --- | --- | --- | --- |
| `catalyst.phase.attempt` | `canonical-event.sh:347` | ✓ conforming |  |  |  |
| `catalyst.phase.revive_count` | `canonical-event.sh:348` | ✓ conforming |  |  |  |
| `catalyst.ticket.type` | `canonical-event.sh:349` | ● custom |  |  | CTL-1023 |
| `claude.ratelimit.five_hour_pct` | `canonical-event.sh:343` | ● custom |  |  | CTL-760 |
| `claude.ratelimit.seven_day_opus_pct` | `canonical-event.sh:345` | ● custom |  |  | CTL-763 |
| `claude.ratelimit.seven_day_pct` | `canonical-event.sh:344` | ● custom |  |  | CTL-760 |
| `claude.ratelimit.seven_day_sonnet_pct` | `canonical-event.sh:346` | ● custom |  |  | CTL-763 |

### MJS (execution-core / catalyst-agent)

| Key | Source | Classification | Target | Cluster | Note |
| --- | --- | --- | --- | --- | --- |
| `catalyst.account.email` | `ratelimit-event.mjs:62` | ● custom |  |  |  |
| `catalyst.process.phase` | `processes.mjs:287` | ✓ conforming |  |  |  |
| `catalyst.process.ticket` | `processes.mjs:286` | ✓ conforming |  |  |  |
| `catalyst.ratelimit.five_hour_pct` | `ratelimit-event.mjs:63` | ● custom |  |  |  |
| `catalyst.ratelimit.five_hour_resets_at` | `ratelimit-event.mjs:65` | ● custom |  |  |  |
| `catalyst.ratelimit.seven_day_opus_pct` | `ratelimit-event.mjs:67` | ● custom |  |  |  |
| `catalyst.ratelimit.seven_day_pct` | `ratelimit-event.mjs:64` | ● custom |  |  |  |
| `catalyst.ratelimit.seven_day_resets_at` | `ratelimit-event.mjs:66` | ● custom |  |  |  |
| `catalyst.ratelimit.seven_day_sonnet_pct` | `ratelimit-event.mjs:68` | ● custom |  |  |  |
| `catalyst.ratelimit.tier` | `ratelimit-event.mjs:70` | ● custom |  |  |  |
| `catalyst.subscription.type` | `ratelimit-event.mjs:69` | ● custom |  |  |  |
| `host.cpu_count` | `host.mjs:274` | → rename-to | → `system.cpu.logical_count` | Cluster C |  |
| `host.cpu_pct` | `host.mjs:273` | → rename-to | → `system.cpu.utilization` | Cluster C | unit: ÷100 → 0.0–1.0 |
| `host.disk_total_gb` | `host.mjs:280` | → rename-to | → `system.filesystem.capacity` | Cluster C | unit: ×1073741824 → bytes |
| `host.disk_used_gb` | `host.mjs:279` | → rename-to | → `system.filesystem.usage` | Cluster C | unit: ×1073741824 → bytes, state=used |
| `host.disk_used_pct` | `host.mjs:281` | → rename-to | → `system.filesystem.utilization` | Cluster C | unit: ÷100 → 0.0–1.0 |
| `host.load1` | `host.mjs:275` | → rename-to | → `system.linux.cpu.load_1m` | Cluster C |  |
| `host.mem_total_mb` | `host.mjs:277` | → rename-to | → `system.memory.limit` | Cluster C | unit: ×1048576 → bytes |
| `host.mem_used_mb` | `host.mjs:276` | → rename-to | → `system.memory.usage` | Cluster C | unit: ×1048576 → bytes, state=used |
| `host.mem_used_pct` | `host.mjs:278` | → rename-to | → `system.memory.utilization` | Cluster C | unit: ÷100 → 0.0–1.0 |
| `process.command` | `processes.mjs:283` | ✓ conforming |  |  |  |
| `process.cpu.utilization` | `processes.mjs:284` | ✓ conforming |  |  |  |
| `process.memory.usage` | `processes.mjs:285` | ✓ conforming |  |  |  |

### Legacy Bash (`emit-otel-event.sh`)

| Key | Source | Classification | Target | Cluster | Note |
| --- | --- | --- | --- | --- | --- |
| `catalyst.outcome` | `emit-otel-event.sh:130` | ● custom |  |  |  |
| `catalyst.reason` | `emit-otel-event.sh:135` | ● custom |  |  |  |

## Remediation Map (CTL-1008 Handoff)

Each cluster below is a unit of work for CTL-1008. Emit-side files are
derived from the manifest. Per the operator decision (Ryan, 2026-06-11),
every rename uses a **hard cutover** — no dual-emit period, no deprecated-name
emission. Each cluster ships emit-side rename + all consumer updates in ONE PR,
validated against live Loki.

### Cluster C — host.* system metrics

- **Emit-side files**: `host.mjs`
- **Where**: both
- **Migration**: hard-cutover (no dual-emit)
- **Consumer-update checklist** (all in ONE PR, validated against live Loki):
  - [ ] emit-side rename in the file(s) above
  - [ ] Grafana dashboard JSON updates
  - [ ] orch-monitor otel-queries updates
- **Historical-data note**: queries spanning the rename date must use an old-name-OR-new-name clause (2y Prometheus retention keeps the old name)

| Current key | Target name | Note |
| --- | --- | --- |
| `host.cpu_count` | `system.cpu.logical_count` |  |
| `host.cpu_pct` | `system.cpu.utilization` | unit: ÷100 → 0.0–1.0 |
| `host.disk_total_gb` | `system.filesystem.capacity` | unit: ×1073741824 → bytes |
| `host.disk_used_gb` | `system.filesystem.usage` | unit: ×1073741824 → bytes, state=used |
| `host.disk_used_pct` | `system.filesystem.utilization` | unit: ÷100 → 0.0–1.0 |
| `host.load1` | `system.linux.cpu.load_1m` |  |
| `host.mem_total_mb` | `system.memory.limit` | unit: ×1048576 → bytes |
| `host.mem_used_mb` | `system.memory.usage` | unit: ×1048576 → bytes, state=used |
| `host.mem_used_pct` | `system.memory.utilization` | unit: ÷100 → 0.0–1.0 |

---

_Generated by CTL-1009. Do not edit manually._
