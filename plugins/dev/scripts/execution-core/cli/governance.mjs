// cli/governance.mjs — CTL-1062. Operator-facing readout of which governance
// modes the local daemon is actually running, sourced from the latest
// node.heartbeat the daemon wrote (heartbeat carries the snapshot, CTL-1062 Phase 2).
import { fileURLToPath } from "node:url";
import { getEventLogPath, getHostName, HEARTBEAT_TAIL_WINDOW_MS } from "../config.mjs";
// CTL-1529: bounded tail instead of readFileSync(logPath,"utf8") of the whole
// monthly log (883 MB on mini ⇒ ~1.9 s and a ~1.7 GB transient just to answer
// "what modes is the daemon running?", and on a node runtime an outright
// ERR_STRING_TOO_LONG that this function's `catch` turned into the misleading
// "No heartbeat found — is the daemon running?"). event-tail.mjs is a leaf module
// (no execution-core deps), so importing it keeps this CLI out of the heavy
// recovery.mjs import graph.
import { scanEventsSince } from "../event-tail.mjs";

const HEARTBEAT_EVENT = "node.heartbeat";

export function readLatestGovernance({
  logPath = getEventLogPath(),
  host = getHostName(),
  nowMs = Date.now(),
  windowMs = HEARTBEAT_TAIL_WINDOW_MS,
} = {}) {
  let best = null;
  try {
    scanEventsSince({
      path: logPath,
      targetSinceMs: nowMs - windowMs,
      lineFilter: (line) => line.includes(HEARTBEAT_EVENT),
      onEvent: (evt) => {
        if (evt?.attributes?.["event.name"] !== HEARTBEAT_EVENT) return;
        const h = evt?.body?.payload?.["host.name"] ?? evt?.resource?.["host.name"];
        if (h !== host) return;
        const ts = evt?.ts;
        const gov = evt?.body?.payload?.governance;
        if (typeof ts !== "string" || !gov) return;
        if (!best || ts > best.ts) best = { ts, governance: gov };
      },
    });
  } catch {
    return { found: false, host };
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
