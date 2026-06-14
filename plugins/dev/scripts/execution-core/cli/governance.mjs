// cli/governance.mjs — CTL-1062. Operator-facing readout of which governance
// modes the local daemon is actually running, sourced from the latest
// node.heartbeat the daemon wrote (heartbeat carries the snapshot, CTL-1062 Phase 2).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getEventLogPath, getHostName } from "../config.mjs";

const HEARTBEAT_EVENT = "node.heartbeat";

export function readLatestGovernance({ logPath = getEventLogPath(), host = getHostName() } = {}) {
  let raw;
  try { raw = readFileSync(logPath, "utf8"); }
  catch { return { found: false, host }; }
  let best = null;
  for (const line of raw.split("\n")) {
    if (!line || !line.includes(HEARTBEAT_EVENT)) continue;
    let evt; try { evt = JSON.parse(line); } catch { continue; }
    if (evt?.attributes?.["event.name"] !== HEARTBEAT_EVENT) continue;
    const h = evt?.body?.payload?.["host.name"] ?? evt?.resource?.["host.name"];
    if (h !== host) continue;
    const ts = evt?.ts;
    const gov = evt?.body?.payload?.governance;
    if (typeof ts !== "string" || !gov) continue;
    if (!best || ts > best.ts) best = { ts, governance: gov };
  }
  return best ? { found: true, host, ts: best.ts, governance: best.governance } : { found: false, host };
}

export function renderGovernance(res, { json } = {}) {
  if (json) return JSON.stringify(res, null, 2);
  if (!res.found) {
    return `No heartbeat found for host "${res.host}". Is the daemon running? ` +
      `(catalyst-execution-core status)`;
  }
  const lines = [`governance modes for "${res.host}" (as of ${res.ts}):`];
  for (const [k, v] of Object.entries(res.governance)) {
    const val = v && typeof v === "object" && "mode" in v ? v.mode : v;
    lines.push(`  ${k.padEnd(22)} ${val}`);
  }
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const res = readLatestGovernance();
  process.stdout.write(renderGovernance(res, { json }) + "\n");
  process.exitCode = res.found ? 0 : 2;
}

const isEntry =
  import.meta.main === true ||
  (typeof import.meta.url === "string" &&
    fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) {
  main();
}
