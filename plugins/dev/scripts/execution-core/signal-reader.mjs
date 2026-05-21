// signal-reader.mjs — execution-core unified worker-signal reader (CTL-533).
//
// Resolves BOTH orchestrator signal layouts under ${ORCH_DIR}/workers/ —
// the flat legacy oneshot signal (workers/<T>.json) and the nested
// phase-agent signal (workers/<T>/phase-<p>.json) — into one canonical
// WorkerSignal shape. Subsumes CTL-505: a single reader, so the flat-only
// globs in orchestrate/SKILL.md and orchestrate-dispatch-next can never
// again diverge from orchestrate-healthcheck Pass 2.
//
// Pure given a filesystem directory: no clock, no network.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./config.mjs";

// Files inside workers/<T>/ that are phase OUTPUTS, not signals.
const ARTIFACT_NAMES = new Set([
  "triage.json",
  "verify.json",
  "review.json",
  "phase-monitor-deploy.json",
]);

// Terminal worker statuses — exported so decision modules share one set.
const TERMINAL = new Set(["done", "failed", "stalled", "turn-cap-exhausted"]);

// readWorkerSignals — glob both layouts under ${orchDir}/workers/ and return
// a canonical WorkerSignal per worker:
//   { ticket, layout:'flat'|'nested', signalPath, phase, status,
//     liveness:{kind:'pid'|'bg', value}, updatedAt, pr, raw }
export function readWorkerSignals(orchDir) {
  const workersDir = join(orchDir, "workers");
  const out = [];
  let entries;
  try {
    entries = readdirSync(workersDir, { withFileTypes: true });
  } catch {
    return out; // no workers/ dir yet → []
  }

  for (const e of entries) {
    if (
      e.isFile() &&
      e.name.endsWith(".json") &&
      !e.name.endsWith(".json.projected")
    ) {
      const sig = parseSignal(join(workersDir, e.name), "flat");
      if (sig) out.push(sig);
    } else if (e.isDirectory() && e.name !== "output") {
      const nested = readNestedDir(join(workersDir, e.name));
      if (nested) out.push(nested);
    }
  }
  return out;
}

// isPhaseSignalFile — a nested phase signal is phase-<name>.json and is NOT a
// phase-output artifact (those are listed in ARTIFACT_NAMES).
function isPhaseSignalFile(name) {
  if (!name.endsWith(".json")) return false;
  if (ARTIFACT_NAMES.has(name)) return false;
  return name.startsWith("phase-");
}

// readNestedDir — collect workers/<T>/phase-*.json, drop artifacts, and pick
// the active phase: the latest updatedAt, preferring a non-terminal status so
// a freshly-written terminal signal never shadows an in-flight phase.
function readNestedDir(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }

  const candidates = [];
  for (const name of names) {
    if (!isPhaseSignalFile(name)) continue;
    const sig = parseSignal(join(dir, name), "nested");
    if (sig) candidates.push(sig);
  }
  if (candidates.length === 0) return null;

  return candidates.sort(byActivePhase)[0];
}

// byActivePhase — rank nested phase signals so the active one sorts first:
// non-terminal status beats terminal, then most-recent updatedAt wins.
function byActivePhase(a, b) {
  const aTerminal = TERMINAL.has(a.status);
  const bTerminal = TERMINAL.has(b.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
  return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
}

// parseSignal — the single JSON-parse site. Reads a signal file and normalizes
// it onto the canonical shape. A malformed file is logged and skipped (null).
function parseSignal(path, layout) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    log.warn({ path, err: err.message }, "skipping malformed signal");
    return null;
  }
  return {
    ticket: raw.ticket ?? null,
    layout,
    signalPath: path,
    // phase: number (flat) or string (nested) — kept as-is, divergence is real.
    phase: raw.phase ?? null,
    status: raw.status ?? "",
    liveness:
      layout === "flat"
        ? { kind: "pid", value: raw.pid ?? null }
        : { kind: "bg", value: raw.bg_job_id ?? null },
    updatedAt: raw.updatedAt ?? null,
    pr: raw.pr ?? null,
    raw,
  };
}

export { TERMINAL };
