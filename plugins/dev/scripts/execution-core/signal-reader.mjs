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

// Files inside workers/<T>/ that are phase OUTPUTS ONLY (no phase signal
// collision). Note: `phase-monitor-deploy.json` is intentionally NOT here —
// it's dual-use (signal + artifact), tracked via CTL-701.
const ARTIFACT_NAMES = new Set([
  "triage.json",
  "verify.json",
  "review.json",
]);

// Terminal worker statuses — exported so decision modules share one set.
// CTL-512: 'skipped' is the monitor-deploy terminal when no deployment_status
// event arrived before the timeout (phase-monitor-deploy SKILL.md). Ranked
// the same as 'done' by byActivePhase: a skipped terminal must never shadow
// an in-flight phase.
// CTL-484 / CTL-701: 'turn-cap-exhausted' was excluded while orchestrate-revive
// could dispatch `claude --bg --resume` continuations. CTL-748 (2026-06-02)
// disabled per-phase turn caps — new workers never emit this status and no
// continuation path remains — so it is terminal for all consumers (sessions
// display, boot-resume, reclaim/revive, merge-state, stall-detection). CTL-830.
const TERMINAL = new Set(["done", "failed", "stalled", "skipped", "turn-cap-exhausted"]);

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

// readAllPhaseSignals — like readWorkerSignals, but returns EVERY per-file
// signal rather than one canonical active-phase row per ticket. For flat
// (legacy oneshot) workers this is the single workers/<T>.json (there is no
// per-phase fan-out); for nested phase-agent workers it is every
// workers/<T>/phase-<name>.json (artifacts and yield tombstones excluded).
//
// CTL-934 rationale: the belief rules join obs_signal(T, P, …) per phase, so
// the collector must observe superseded/terminal SIBLING phases (e.g. an
// orphan-takeover where bg_job_id flipped between phases), not just the
// freshest active one byActivePhase picks. readWorkerSignals stays the
// canonical active-phase projection for the scheduler; this is the strictly
// wider observation set the fact collector records.
export function readAllPhaseSignals(orchDir) {
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
      const dir = join(workersDir, e.name);
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!isPhaseSignalFile(name)) continue;
        const sig = parseSignal(join(dir, name), "nested");
        if (sig) out.push(sig);
      }
    }
  }
  return out;
}

// isPhaseSignalFile — a nested phase signal is phase-<name>.json and is NOT a
// phase-output artifact (those are listed in ARTIFACT_NAMES). CTL-702: also
// rejects yield tombstones (phase-*-yield-*.json) — read-only audit files
// written by phase-agent-yield-check. See
// website/src/content/docs/observability/event-flow.md#yield-tombstones.
function isPhaseSignalFile(name) {
  if (!name.endsWith(".json")) return false;
  if (ARTIFACT_NAMES.has(name)) return false;
  if (!name.startsWith("phase-")) return false;
  if (name.includes("-yield-")) return false; // CTL-702
  return true;
}

// listDispatchedPhases — the phase NAMES dispatched for one ticket: every
// workers/<ticket>/phase-<name>.json (artifacts excluded). Pure over the
// filesystem; carries no phase-order knowledge — callers map names→indices via
// phaseIndex (phase-fsm.mjs). The primitive behind the CTL-606 supersede guard.
export function listDispatchedPhases(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no worker dir yet
  }
  const phases = [];
  for (const name of names) {
    if (!isPhaseSignalFile(name)) continue;
    const m = /^phase-(.+)\.json$/.exec(name);
    if (m) phases.push(m[1]);
  }
  return phases;
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
// CTL-654: exported so boot-resume.mjs's activePhaseForTicket reuses the same
// comparator instead of duplicating the tiebreak (single source of truth).
export function byActivePhase(a, b) {
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
    // CTL-615: the absolute worktree path the dispatch landed in. The
    // canonical cwd of record; revive cross-checks against the registry-
    // derived path to catch wrong-cwd redispatch (memory: ADV-1134). Null
    // for pre-CTL-615 signals — revive treats null as "skip check".
    worktreePath: raw.worktreePath ?? null,
    // CTL-852: host identity written at dispatch time. Null for pre-CTL-852
    // signals — read-only for audit/HUD; no scheduling behavior depends on it.
    host: raw.host ?? null,
    raw,
  };
}

export { TERMINAL };
