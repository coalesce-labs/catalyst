// memory-sampler-signal.mjs — CTL-685. Best-effort worker signal writer for
// the OOM-kill path. Kept separate from memory-sampler.mjs so the sampler
// core test never touches the filesystem.
//
// resolveSignalPath scans workers/<ticket>/phase-*.json in getExecutionCoreDir()
// to find the signal for the killed agent. Primary match: signal.worktreePath
// === agent.cwd. Secondary: meta.ticket + meta.phase → direct path lookup.
// (Does NOT use indexSignalsByBgJobId — research §11.)

import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { getExecutionCoreDir, log } from "./config.mjs";

/**
 * defaultMarkWorkerOom — flip a worker's signal file to status:"failed",
 * failureReason:"worker-oom". Atomic via tmp + rename. Best-effort: returns
 * false (never throws) when no matching signal is found or the write fails.
 */
export function defaultMarkWorkerOom(
  agent,
  meta = {},
  { coreDir = getExecutionCoreDir() } = {}
) {
  const path = resolveSignalPath(agent, meta, coreDir);
  if (!path || !existsSync(path)) return false;
  try {
    const sig = JSON.parse(readFileSync(path, "utf8"));
    sig.status = "failed";
    sig.failureReason = "worker-oom";
    sig.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(sig, null, 2));
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log.warn({ err: err?.message, path }, "memory-sampler: signal write failed");
    return false;
  }
}

/**
 * resolveSignalPath — find the phase signal file for the given agent.
 *
 * Primary: if meta.ticket + meta.phase are known, try that direct path first
 * and verify worktreePath matches (or agent.cwd is absent).
 * Fallback: scan all workers/<T>/phase-*.json for a signal with
 * worktreePath === agent.cwd.
 *
 * @param {object} agent  the live `claude agents` entry ({ cwd, sessionId })
 * @param {object} meta   { ticket, phase } from resolveMeta
 * @param {string} coreDir  the execution-core directory
 * @returns {string|null}
 */
export function resolveSignalPath(agent, meta, coreDir) {
  // Fast path: meta has ticket + phase → try the direct signal file
  if (meta?.ticket && meta?.phase) {
    const direct = join(coreDir, "workers", meta.ticket, `phase-${meta.phase}.json`);
    if (existsSync(direct)) {
      try {
        const sig = JSON.parse(readFileSync(direct, "utf8"));
        if (!agent.cwd || sig.worktreePath === agent.cwd) return direct;
      } catch {}
    }
  }

  // Scan fallback: match by worktreePath === agent.cwd
  if (!agent.cwd) return null;
  const workersDir = join(coreDir, "workers");
  let tickets;
  try {
    tickets = readdirSync(workersDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of tickets) {
    if (!e.isDirectory()) continue;
    const ticketDir = join(workersDir, e.name);
    let phases;
    try {
      phases = readdirSync(ticketDir);
    } catch {
      continue;
    }
    for (const name of phases) {
      if (!name.startsWith("phase-") || !name.endsWith(".json") || name.includes("-yield-"))
        continue;
      const path = join(ticketDir, name);
      try {
        const sig = JSON.parse(readFileSync(path, "utf8"));
        if (sig.worktreePath === agent.cwd) return path;
      } catch {}
    }
  }
  return null;
}
