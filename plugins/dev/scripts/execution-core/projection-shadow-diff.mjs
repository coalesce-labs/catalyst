// projection-shadow-diff.mjs — CTL-1489: the shadow-diff drift harness for the
// durable-projection read cutover. Compares the LOCAL signals (readWorkerSignals
// off workers/*.json) against the PROJECTION signals (readWorkerSignalsFromProjection
// off the broker DB) per ticket and reports drift, so an operator can prove
// zero-drift before flipping a node to `enforce` (see the Rollout Gate).
//
// Mirrors orchestrate-shadow-diff's contract:
//   exit 0 — all compared tickets match (or only projection-only tickets, non-strict)
//   exit 1 — drift on ≥1 ticket (or --strict and a signal-only ticket)
//   exit 2 — no broker DB / no workers dir (nothing to compare)
//
// The comparison normalizes out the OQ4 divergences (layout, signalPath,
// updatedAt, host, liveness.kind) that are structural, not real drift.

import { existsSync } from "node:fs";
import { readWorkerSignals } from "./signal-reader.mjs";
import { readWorkerSignalsFromProjection } from "./projection-reader.mjs";
import { openBrokerStateDb } from "../broker/broker-state.mjs";

// normalizeForDiff — reduce a WorkerSignal (local or projection) to the
// decision-relevant fields the CTL-1475 read paths actually consume, dropping
// the structurally-divergent volatile fields.
export function normalizeForDiff(sig) {
  return {
    ticket: sig.ticket ?? null,
    phase: sig.phase ?? null,
    status: sig.status ?? "",
    worktreePath: sig.worktreePath ?? null,
    pr: sig.pr ?? null,
    // liveness compared by its bg identity only (local flat pid vs projection
    // null pid is a structural divergence, not drift).
    bgJobId: sig.liveness?.kind === "bg" ? sig.liveness.value ?? null : sig.raw?.bg_job_id ?? null,
    generation: sig.raw?.generation ?? null,
    artifact: sig.raw?.artifact ?? null,
  };
}

// diffProjectionVsLocal — PURE: given the two signal arrays, compute the drift
// report. `strict` promotes a signal-only ticket (present locally, absent in the
// projection) to drift.
export function diffProjectionVsLocal({ localSignals = [], projectionSignals = [], strict = false } = {}) {
  const projByTicket = new Map();
  for (const s of projectionSignals) projByTicket.set(s.ticket, s);

  let checked = 0;
  const driftTickets = [];
  const missingTickets = []; // present locally, no projection row yet
  for (const local of localSignals) {
    checked++;
    const proj = projByTicket.get(local.ticket);
    if (!proj) {
      missingTickets.push(local.ticket);
      continue;
    }
    const a = JSON.stringify(normalizeForDiff(local));
    const b = JSON.stringify(normalizeForDiff(proj));
    if (a !== b) driftTickets.push(local.ticket);
  }

  const match = checked - driftTickets.length - missingTickets.length;
  const drift = driftTickets.length;
  const missing = missingTickets.length;
  const exitCode = drift > 0 || (strict && missing > 0) ? 1 : 0;
  return { checked, match, drift, missing, driftTickets, missingTickets, exitCode };
}

// runProjectionShadowDiff — resolve the readers against a real orchDir + broker
// DB and return the drift report. exitCode 2 when there is nothing to compare.
export function runProjectionShadowDiff(orchDir, { dbPath = null, strict = false } = {}) {
  const workersDir = `${orchDir}/workers`;
  if (!existsSync(workersDir)) {
    return { checked: 0, match: 0, drift: 0, missing: 0, driftTickets: [], missingTickets: [], exitCode: 2, error: "no workers dir" };
  }
  if (dbPath && !existsSync(dbPath)) {
    return { checked: 0, match: 0, drift: 0, missing: 0, driftTickets: [], missingTickets: [], exitCode: 2, error: "no broker DB" };
  }
  if (dbPath) openBrokerStateDb(dbPath);
  const localSignals = readWorkerSignals(orchDir);
  const projectionSignals = readWorkerSignalsFromProjection(orchDir);
  return diffProjectionVsLocal({ localSignals, projectionSignals, strict });
}

// CLI: projection-shadow-diff [--json] [--strict] <orchId-or-orch-dir>
export function main(argv = process.argv.slice(2)) {
  let json = false;
  let strict = false;
  let arg = "";
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--strict") strict = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: projection-shadow-diff [--json] [--strict] <orchId-or-orch-dir>\n");
      return 0;
    } else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag: ${a}\n`);
      return 1;
    } else if (!arg) arg = a;
  }
  if (!arg) {
    process.stderr.write("ERROR: orchestrator id or directory required\n");
    return 1;
  }
  const orchDir = existsSync(`${arg}/workers`)
    ? arg
    : `${process.env.CATALYST_RUNS_DIR || `${process.env.CATALYST_DIR || `${process.env.HOME}/catalyst`}/runs`}/${arg}`;
  const dbPath = process.env.CATALYST_BROKER_DB || `${process.env.CATALYST_DIR || `${process.env.HOME}/catalyst`}/filter-state.db`;
  const r = runProjectionShadowDiff(orchDir, { dbPath, strict });
  if (json) {
    process.stdout.write(JSON.stringify({ orchDir, ...r }) + "\n");
  } else {
    process.stdout.write(
      `projection-shadow-diff: ${orchDir}\n  checked: ${r.checked}\n  match:   ${r.match}\n  drift:   ${r.drift}\n  missing: ${r.missing}\n` +
        (r.error ? `  error:   ${r.error}\n` : "") +
        (r.drift ? `  drift tickets:\n${r.driftTickets.map((t) => `    - ${t}`).join("\n")}\n` : "")
    );
  }
  return r.exitCode;
}

// Direct-exec guard (bun/node): run main() and exit with its code.
if (import.meta.main || (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("projection-shadow-diff.mjs"))) {
  process.exit(main());
}
