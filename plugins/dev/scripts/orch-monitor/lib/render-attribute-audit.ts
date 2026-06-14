// Renders AUDIT_MANIFEST into a deterministic markdown audit document.
// Imported by the golden test and by bin/gen-attribute-audit.ts.
// Output is stable-sorted (emitter order then key alphabetically) so the
// golden diff is robust across manifest edits.

import type { AttributeAuditEntry, Classification, EmitterType, RemediationCluster } from "./otel-attribute-audit.ts";

const EMITTER_ORDER: EmitterType[] = ["ts", "sh", "mjs", "legacy-sh"];
const EMITTER_LABELS: Record<EmitterType, string> = {
  "ts":        "TypeScript (`canonical-event.ts`)",
  "sh":        "Bash (`canonical-event.sh`)",
  "mjs":       "MJS (execution-core / catalyst-agent)",
  "legacy-sh": "Legacy Bash (`emit-otel-event.sh`)",
};
const CLUSTER_LABELS: Record<RemediationCluster, string> = {
  A: "event.* non-name fields",
  B: "ratelimit.* / account.* / subscription.*",
  C: "host.* system metrics",
  D: "process.* non-conforming fields",
  E: "vcs.revision / cicd.conclusion / deployment.environment",
  F: "phase.* unnamespaced fields",
  G: "emit-otel-event.sh legacy bare attributes",
  H: "resource project field",
};
const CLASS_BADGE: Record<Classification, string> = {
  "conforming":           "✓ conforming",
  "rename-to":            "→ rename-to",
  "legitimately-custom":  "● custom",
};

function mdTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  const sep = header.map(() => "---");
  return [header, sep, ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** Renders the full audit markdown from the given manifest entries. */
export function renderAuditMarkdown(entries: AttributeAuditEntry[]): string {
  const lines: string[] = [
    "<!-- GENERATED — edit lib/otel-attribute-audit.ts, run `bun run audit:gen` to regenerate -->",
    "",
    "# OTel Attribute Audit — Conformance Manifest",
    "",
    "Single source of truth for every emit-side attribute's classification against",
    "OTel semantic conventions. Generated from `lib/otel-attribute-audit.ts` (CTL-1009).",
    "Do **not** edit this file directly.",
    "",
    "## Classification Summary",
    "",
  ];

  // Summary counts
  const total = entries.length;
  const counts: Record<Classification, number> = {
    "conforming": 0,
    "rename-to": 0,
    "legitimately-custom": 0,
  };
  for (const e of entries) counts[e.classification]++;
  lines.push(
    mdTable([
      ["Classification", "Count"],
      ["✓ Conforming", String(counts["conforming"])],
      ["→ Rename-to", String(counts["rename-to"])],
      ["● Legitimately Custom", String(counts["legitimately-custom"])],
      ["**Total**", String(total)],
    ]),
    "",
  );

  // Per-emitter classification tables
  lines.push("## Classification by Emitter", "");

  for (const emitter of EMITTER_ORDER) {
    const emitterEntries = entries
      .filter((e) => e.emitter === emitter)
      .sort((a, b) => a.key.localeCompare(b.key));
    if (emitterEntries.length === 0) continue;

    lines.push(`### ${EMITTER_LABELS[emitter]}`, "");

    const rows = emitterEntries.map((e) => {
      const badge = CLASS_BADGE[e.classification];
      const target = e.targetName ? `→ \`${e.targetName}\`` : "";
      const cluster = e.remediationCluster ? `Cluster ${e.remediationCluster}` : "";
      const note = e.note ?? "";
      return [
        `\`${e.key}\``,
        `\`${e.source}\``,
        badge,
        target,
        cluster,
        note,
      ];
    });
    lines.push(
      mdTable([["Key", "Source", "Classification", "Target", "Cluster", "Note"], ...rows]),
      "",
    );
  }

  // Remediation map
  lines.push("## Remediation Map (CTL-1008 Handoff)", "");
  lines.push(
    "Each cluster below is a unit of work for CTL-1008. Emit-side files are",
    "derived from the manifest. Per the operator decision (Ryan, 2026-06-11),",
    "every rename uses a **hard-cutover** — no dual-emit period, no deprecated-name",
    "emission. Each cluster ships emit-side rename + all consumer updates in ONE PR,",
    "validated against live Loki.",
    "",
  );

  const clusters: RemediationCluster[] = ["A", "B", "C", "D", "E", "F", "G", "H"];
  for (const cluster of clusters) {
    const clusterEntries = entries
      .filter((e) => e.remediationCluster === cluster)
      .sort((a, b) => a.key.localeCompare(b.key));
    if (clusterEntries.length === 0) continue;

    const label = CLUSTER_LABELS[cluster];
    lines.push(`### Cluster ${cluster} — ${label}`, "");

    // Collect emit-side files and rename placement. Migration is always
    // hard-cutover (operator decision, Ryan 2026-06-11) — no dual-emit window.
    const sources = [...new Set(clusterEntries.map((e) => e.source.split(":")[0]))];
    const where = [...new Set(clusterEntries.map((e) => e.where).filter(Boolean))];
    lines.push(
      `- **Emit-side files**: ${sources.map((s) => `\`${s}\``).join(", ")}`,
      `- **Where**: ${where.join(", ") || "emit"}`,
      `- **Migration**: hard-cutover (no dual-emit)`,
      `- **Consumer-update checklist** (all in ONE PR, validated against live Loki):`,
      `  - [ ] emit-side rename in the file(s) above`,
      `  - [ ] Grafana dashboard JSON updates`,
      `  - [ ] orch-monitor otel-queries updates`,
      `- **Historical-data note**: queries spanning the rename date must use an old-name-OR-new-name clause (2y Prometheus retention keeps the old name)`,
      "",
    );

    const rows = clusterEntries.map((e) => [
      `\`${e.key}\``,
      `\`${e.targetName ?? "(none)"}\``,
      e.note ?? "",
    ]);
    lines.push(
      mdTable([["Current key", "Target name", "Note"], ...rows]),
      "",
    );
  }

  lines.push("---", "", "_Generated by CTL-1009. Do not edit manually._", "");
  return lines.join("\n");
}
