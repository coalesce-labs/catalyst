// SINGLE SOURCE OF TRUTH for every emit-side OTel attribute classification.
// Edit this file to update the audit; run `bun run audit:gen` to regenerate
// docs/otel-attribute-audit.md. Do NOT edit the generated doc directly.
// See CTL-1009 for the research that produced these classifications.

export type Classification = "conforming" | "rename-to" | "legitimately-custom";
export type EmitterType = "ts" | "sh" | "mjs" | "legacy-sh";
export type RemediationCluster = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

export interface AttributeAuditEntry {
  key: string;
  emitter: EmitterType;
  source: string;
  classification: Classification;
  targetName?: string;
  remediationCluster?: RemediationCluster;
  where?: "emit" | "collector" | "both";
  note?: string;
}

export const AUDIT_MANIFEST: AttributeAuditEntry[] = [
  // ── TS emitter — Resource interface (canonical-event.ts) ─────────────────
  // §4a: Resource attributes — OTel Resource semconv
  { key: "service.name",      emitter: "ts", source: "canonical-event.ts:43", classification: "conforming" },
  { key: "service.namespace", emitter: "ts", source: "canonical-event.ts:44", classification: "conforming" },
  { key: "service.version",   emitter: "ts", source: "canonical-event.ts:45", classification: "conforming" },
  { key: "host.name",         emitter: "ts", source: "canonical-event.ts:47", classification: "conforming" },
  { key: "host.id",           emitter: "ts", source: "canonical-event.ts:48", classification: "conforming" },
  // CTL-636 optional resource context
  { key: "project",                 emitter: "ts", source: "canonical-event.ts:52", classification: "rename-to",            targetName: "catalyst.project",        remediationCluster: "H", where: "both" },
  { key: "linear.key",              emitter: "ts", source: "canonical-event.ts:53", classification: "legitimately-custom" },
  { key: "catalyst.orchestration",  emitter: "ts", source: "canonical-event.ts:54", classification: "legitimately-custom" },

  // ── TS emitter — Attributes interface (canonical-event.ts) ───────────────
  // §4b: Event classifier family
  { key: "event.name",    emitter: "ts", source: "canonical-event.ts:59", classification: "conforming" },
  { key: "catalyst.event.entity",  emitter: "ts", source: "canonical-event.ts:60", classification: "conforming" },
  { key: "catalyst.event.action",  emitter: "ts", source: "canonical-event.ts:61", classification: "conforming" },
  { key: "catalyst.event.label",   emitter: "ts", source: "canonical-event.ts:62", classification: "conforming" },
  { key: "catalyst.event.value",   emitter: "ts", source: "canonical-event.ts:63", classification: "conforming" },
  { key: "catalyst.event.channel", emitter: "ts", source: "canonical-event.ts:64", classification: "conforming" },

  // §4c: Catalyst internal — legitimately-custom (catalyst.* namespace)
  { key: "catalyst.orchestrator.id", emitter: "ts", source: "canonical-event.ts:67", classification: "legitimately-custom" },
  { key: "catalyst.worker.ticket",   emitter: "ts", source: "canonical-event.ts:68", classification: "legitimately-custom" },
  { key: "catalyst.session.id",      emitter: "ts", source: "canonical-event.ts:69", classification: "legitimately-custom" },
  { key: "catalyst.phase",           emitter: "ts", source: "canonical-event.ts:70", classification: "legitimately-custom" },

  // §4d: VCS semconv
  { key: "vcs.repository.name", emitter: "ts", source: "canonical-event.ts:73", classification: "conforming" },
  { key: "vcs.pr.number",       emitter: "ts", source: "canonical-event.ts:74", classification: "conforming" },
  { key: "vcs.ref.name",        emitter: "ts", source: "canonical-event.ts:75", classification: "conforming" },
  { key: "vcs.ref.revision",    emitter: "ts", source: "canonical-event.ts:76", classification: "conforming" },

  // §4e: CI/CD semconv
  { key: "cicd.pipeline.run.id",         emitter: "ts", source: "canonical-event.ts:79", classification: "conforming" },
  { key: "cicd.pipeline.run.status",     emitter: "ts", source: "canonical-event.ts:80", classification: "conforming" },
  { key: "cicd.pipeline.run.result",     emitter: "ts", source: "canonical-event.ts:81", classification: "conforming" },
  { key: "cicd.pipeline.name",           emitter: "ts", source: "canonical-event.ts:82", classification: "conforming" },

  // Linear — legitimately-custom (no OTel semconv; linear.* vendor namespace)
  { key: "linear.issue.identifier", emitter: "ts", source: "canonical-event.ts:85", classification: "legitimately-custom" },
  { key: "linear.issue.id",         emitter: "ts", source: "canonical-event.ts:86", classification: "legitimately-custom" },
  { key: "linear.team.key",         emitter: "ts", source: "canonical-event.ts:87", classification: "legitimately-custom" },
  { key: "linear.actor.id",         emitter: "ts", source: "canonical-event.ts:88", classification: "legitimately-custom" },

  // §4f: Deployment semconv
  { key: "deployment.environment.name", emitter: "ts", source: "canonical-event.ts:91", classification: "conforming" },
  { key: "deployment.id",          emitter: "ts", source: "canonical-event.ts:92", classification: "conforming", note: "type should be string per OTel semconv; currently number" },

  // §4g: Claude Code metadata (CTL-374) — legitimately-custom (claude.* vendor namespace)
  { key: "claude.session.id",       emitter: "ts", source: "canonical-event.ts:97",  classification: "legitimately-custom" },
  { key: "claude.model",            emitter: "ts", source: "canonical-event.ts:98",  classification: "legitimately-custom" },
  { key: "claude.context.used_pct", emitter: "ts", source: "canonical-event.ts:99",  classification: "legitimately-custom" },
  { key: "claude.context.tokens",   emitter: "ts", source: "canonical-event.ts:100", classification: "legitimately-custom" },
  { key: "claude.turn",             emitter: "ts", source: "canonical-event.ts:101", classification: "legitimately-custom" },

  // ── SH emitter — bash-specific attributes (canonical-event.sh) ───────────
  // §4g continuation: claude.ratelimit.* (CTL-760/763) — bash-only, legitimately-custom
  { key: "claude.ratelimit.five_hour_pct",      emitter: "sh", source: "canonical-event.sh:343", classification: "legitimately-custom", note: "CTL-760" },
  { key: "claude.ratelimit.seven_day_pct",      emitter: "sh", source: "canonical-event.sh:344", classification: "legitimately-custom", note: "CTL-760" },
  { key: "claude.ratelimit.seven_day_opus_pct", emitter: "sh", source: "canonical-event.sh:345", classification: "legitimately-custom", note: "CTL-763" },
  { key: "claude.ratelimit.seven_day_sonnet_pct", emitter: "sh", source: "canonical-event.sh:346", classification: "legitimately-custom", note: "CTL-763" },

  // §4h: Phase attempt tracking (CTL-761) — rename-to cluster F
  { key: "catalyst.phase.attempt",      emitter: "sh", source: "canonical-event.sh:347", classification: "conforming" },
  { key: "catalyst.phase.revive_count", emitter: "sh", source: "canonical-event.sh:348", classification: "conforming" },

  // CTL-1023: work-type dimension — legitimately-custom (catalyst.* namespace)
  { key: "catalyst.ticket.type", emitter: "sh", source: "canonical-event.sh:349", classification: "legitimately-custom", note: "CTL-1023" },

  // ── MJS emitter — execution-core/ratelimit-event.mjs ─────────────────────
  // §4i: Account rate-limit cluster B — rename-to
  { key: "account.email",               emitter: "mjs", source: "ratelimit-event.mjs:62", classification: "rename-to", targetName: "catalyst.account.email",               remediationCluster: "B", where: "both" },
  { key: "ratelimit.five_hour_pct",     emitter: "mjs", source: "ratelimit-event.mjs:64", classification: "rename-to", targetName: "catalyst.ratelimit.five_hour_pct",     remediationCluster: "B", where: "both" },
  { key: "ratelimit.seven_day_pct",     emitter: "mjs", source: "ratelimit-event.mjs:65", classification: "rename-to", targetName: "catalyst.ratelimit.seven_day_pct",     remediationCluster: "B", where: "both" },
  { key: "ratelimit.five_hour_resets_at", emitter: "mjs", source: "ratelimit-event.mjs:66", classification: "rename-to", targetName: "catalyst.ratelimit.five_hour_resets_at", remediationCluster: "B", where: "both" },
  { key: "ratelimit.seven_day_resets_at", emitter: "mjs", source: "ratelimit-event.mjs:67", classification: "rename-to", targetName: "catalyst.ratelimit.seven_day_resets_at", remediationCluster: "B", where: "both" },
  { key: "ratelimit.seven_day_opus_pct",   emitter: "mjs", source: "ratelimit-event.mjs:68", classification: "rename-to", targetName: "catalyst.ratelimit.seven_day_opus_pct",   remediationCluster: "B", where: "both" },
  { key: "ratelimit.seven_day_sonnet_pct", emitter: "mjs", source: "ratelimit-event.mjs:69", classification: "rename-to", targetName: "catalyst.ratelimit.seven_day_sonnet_pct", remediationCluster: "B", where: "both" },
  { key: "subscription.type", emitter: "mjs", source: "ratelimit-event.mjs:70", classification: "rename-to", targetName: "catalyst.subscription.type", remediationCluster: "B", where: "both" },
  { key: "rate_limit.tier",   emitter: "mjs", source: "ratelimit-event.mjs:71", classification: "rename-to", targetName: "catalyst.ratelimit.tier",    remediationCluster: "B", where: "both" },

  // ── MJS emitter — catalyst-agent/host.mjs ────────────────────────────────
  // §4j: Host system metrics cluster C — rename-to (host.* → system.*)
  { key: "host.cpu_pct",      emitter: "mjs", source: "host.mjs:273", classification: "rename-to", targetName: "system.cpu.utilization",       remediationCluster: "C", where: "both", note: "unit: ÷100 → 0.0–1.0" },
  { key: "host.cpu_count",    emitter: "mjs", source: "host.mjs:274", classification: "rename-to", targetName: "system.cpu.logical_count",     remediationCluster: "C", where: "both" },
  { key: "host.load1",        emitter: "mjs", source: "host.mjs:275", classification: "rename-to", targetName: "system.linux.cpu.load_1m",     remediationCluster: "C", where: "both" },
  { key: "host.mem_used_mb",  emitter: "mjs", source: "host.mjs:276", classification: "rename-to", targetName: "system.memory.usage",          remediationCluster: "C", where: "both", note: "unit: ×1048576 → bytes, state=used" },
  { key: "host.mem_total_mb", emitter: "mjs", source: "host.mjs:277", classification: "rename-to", targetName: "system.memory.limit",          remediationCluster: "C", where: "both", note: "unit: ×1048576 → bytes" },
  { key: "host.mem_used_pct", emitter: "mjs", source: "host.mjs:278", classification: "rename-to", targetName: "system.memory.utilization",    remediationCluster: "C", where: "both", note: "unit: ÷100 → 0.0–1.0" },
  { key: "host.disk_used_gb", emitter: "mjs", source: "host.mjs:279", classification: "rename-to", targetName: "system.filesystem.usage",      remediationCluster: "C", where: "both", note: "unit: ×1073741824 → bytes, state=used" },
  { key: "host.disk_total_gb",emitter: "mjs", source: "host.mjs:280", classification: "rename-to", targetName: "system.filesystem.capacity",   remediationCluster: "C", where: "both", note: "unit: ×1073741824 → bytes" },
  { key: "host.disk_used_pct",emitter: "mjs", source: "host.mjs:281", classification: "rename-to", targetName: "system.filesystem.utilization",remediationCluster: "C", where: "both", note: "unit: ÷100 → 0.0–1.0" },

  // ── MJS emitter — catalyst-agent/processes.mjs ───────────────────────────
  // §4k: Process metrics — partially conforming, cluster D
  { key: "process.command",  emitter: "mjs", source: "processes.mjs:283", classification: "conforming" },
  { key: "process.cpu.utilization",  emitter: "mjs", source: "processes.mjs:284", classification: "conforming" },
  { key: "process.memory.usage",     emitter: "mjs", source: "processes.mjs:285", classification: "conforming" },
  { key: "catalyst.process.ticket",  emitter: "mjs", source: "processes.mjs:286", classification: "conforming" },
  { key: "catalyst.process.phase",   emitter: "mjs", source: "processes.mjs:287", classification: "conforming" },

  // ── Legacy SH emitter — emit-otel-event.sh (OTLP direct) ─────────────────
  // §4l: Legacy bare attributes cluster G — rename-to
  { key: "outcome",    emitter: "legacy-sh", source: "emit-otel-event.sh:130", classification: "rename-to", targetName: "catalyst.outcome",   remediationCluster: "G", where: "emit" },
  { key: "session_id", emitter: "legacy-sh", source: "emit-otel-event.sh:131", classification: "rename-to", targetName: "claude.session.id",  remediationCluster: "G", where: "emit" },
  { key: "reason",     emitter: "legacy-sh", source: "emit-otel-event.sh:135", classification: "rename-to", targetName: "catalyst.reason",    remediationCluster: "G", where: "emit" },
  { key: "phase",      emitter: "legacy-sh", source: "emit-otel-event.sh:141", classification: "rename-to", targetName: "catalyst.phase",     remediationCluster: "G", where: "emit" },
];
