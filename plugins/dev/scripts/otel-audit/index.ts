#!/usr/bin/env bun
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { scanJsonlFile } from "./lib/scan-jsonl.ts";
import { reconcile, type ReconcileRow } from "./lib/reconcile.ts";
import { LokiClient, type ILokiClient } from "./lib/loki.ts";

// Known service streams for Loki queries.
const KNOWN_SERVICES = [
  "catalyst.execution-core",
  "catalyst.broker",
  "catalyst.otel-forward",
];

function parseArgs(argv: string[]): { windowHours: number; out: string; help: boolean } {
  let windowHours = 168; // 7-day default
  let out = "thoughts/shared/observability/otel-event-audit.md";
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--window-hours" && argv[i + 1]) windowHours = Number(argv[++i]);
    else if (argv[i] === "--out" && argv[i + 1]) out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") help = true;
  }
  return { windowHours, out, help };
}

function buildMarkdownTable(rows: ReconcileRow[]): string {
  const header = "| Event Kind | JSONL Count | Loki Count | Status |";
  const sep    = "|------------|-------------|------------|--------|";
  const lines = rows.map(r =>
    `| ${r.kind} | ${r.jsonlCount.toLocaleString()} | ${r.lokiCount.toLocaleString()} | ${r.status} |`
  );
  return [header, sep, ...lines].join("\n");
}

async function main(lokiClient?: ILokiClient): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: bun run index.ts [--window-hours 168] [--out <path>]");
    return;
  }

  const { windowHours, out } = args;

  // 1. Scan JSONL month files in the window
  const eventsDir = process.env.CATALYST_EVENTS_DIR ?? join(homedir(), "catalyst/events");
  const windowStartDate = new Date(Date.now() - windowHours * 3600 * 1000);
  const jsonlCounts = new Map<string, number>();

  let monthFiles: string[] = [];
  try {
    monthFiles = readdirSync(eventsDir)
      .filter(f => f.endsWith(".jsonl"))
      .filter(f => {
        // include if file YYYY-MM.jsonl is within window
        const m = f.match(/^(\d{4})-(\d{2})\.jsonl$/);
        if (!m) return false;
        const fileMonth = new Date(Number(m[1]), Number(m[2]) - 1);
        const windowStart = new Date(windowStartDate.getFullYear(), windowStartDate.getMonth());
        return fileMonth >= windowStart;
      })
      .sort();
  } catch {
    console.error(`Warning: cannot read events dir ${eventsDir}`);
  }

  for (const file of monthFiles) {
    const fileCounts = await scanJsonlFile(join(eventsDir, file));
    for (const [k, v] of fileCounts) {
      jsonlCounts.set(k, (jsonlCounts.get(k) ?? 0) + v);
    }
  }

  // 2. Query Loki per service stream
  const client = lokiClient ?? new LokiClient();
  const lokiCounts = new Map<string, number>();
  for (const service of KNOWN_SERVICES) {
    const serviceCounts = await client.queryEventNames(service, windowHours);
    for (const [k, v] of serviceCounts) {
      lokiCounts.set(k, (lokiCounts.get(k) ?? 0) + v);
    }
  }

  // 3. Reconcile
  const rows = reconcile(jsonlCounts, lokiCounts);

  // 4. Build and write Markdown table
  const statusCounts = { OK: 0, MISSING: 0, DRIFT: 0, LOKI_ONLY: 0 };
  for (const r of rows) statusCounts[r.status]++;

  const table = buildMarkdownTable(rows);
  const lokiAvailable = lokiCounts.size > 0;
  const lokiNote = lokiAvailable
    ? ""
    : "\n> **Note**: Loki was unreachable during this run — all known JSONL kinds show as MISSING.\n";

  const content = `# OTel Event Completeness Audit

Generated: ${new Date().toISOString()}
Window: ${windowHours}h (${Math.round(windowHours / 24)} days)
JSONL files scanned: ${monthFiles.join(", ") || "(none found)"}
Command: \`bun run ${join("plugins/dev/scripts/otel-audit", "index.ts")} --window-hours ${windowHours} --out ${out}\`

## Summary

| Status | Count |
|--------|-------|
| OK | ${statusCounts.OK} |
| MISSING (in JSONL, not in Loki) | ${statusCounts.MISSING} |
| DRIFT (count mismatch > 10%) | ${statusCounts.DRIFT} |
| LOKI_ONLY (in Loki, not in JSONL) | ${statusCounts.LOKI_ONLY} |
${lokiNote}
## Event Kind Reconciliation

${table}

## Proposed Collector-Side Changes (catalyst-otel — manual apply)

The following changes to \`collector-config.yaml\` are proposed. Apply manually or create
an OTL ticket for each:

1. **OTL-7 — \`catalyst.dispatch_mode\` label**: The collector already has a no-op \`set()\`
   waiting for this attribute (OTL-7). Once CTL-1008 Phase 3 ships \`catalyst.dispatch_mode\`
   in \`OTEL_RESOURCE_ATTRIBUTES\`, the existing rule will automatically populate the
   \`catalyst_dispatch_mode\` label in Loki — no collector change required.

2. **Flat reap-intent events** (status MISSING above): After CTL-1008 Phase 2 ships the
   flat→canonical normalizer in the forwarder, these events will appear in Loki under
   \`service_name=catalyst.execution-core\`. No collector change needed; the normalizer
   maps them to the correct service stream.
`;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);
  console.log(`Audit written to ${out}`);
  console.log(`Summary: ${statusCounts.OK} OK, ${statusCounts.MISSING} MISSING, ${statusCounts.DRIFT} DRIFT, ${statusCounts.LOKI_ONLY} LOKI_ONLY`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { main };
