// recovery.mjs — execution-core crash-recovery & startup reconstruction (CTL-539).
//
// The recovery contract CTL-554's composing daemon calls on boot. Reconstructs
// routing state (eligible sets, via reconcileAll) and dispatch/worker state
// (via the canonical signal reader), and classifies every in-flight claude --bg
// worker's liveness so a restart resumes mid-run with no lost workers.

import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getJobsRoot, log } from "./config.mjs";
import { readWorkerSignals, TERMINAL } from "./signal-reader.mjs";

// defaultStatJob — stat ~/.claude/jobs/<bgJobId>/state.json. Returns null when
// the job dir is gone (the worker's process no longer exists), else its mtime
// and parsed .state. Injectable so tests never touch real Claude job state.
export function defaultStatJob(bgJobId) {
  const file = join(getJobsRoot(), bgJobId, "state.json");
  let st;
  try {
    st = statSync(file);
  } catch {
    return null; // job dir missing → worker is gone
  }
  let state = null;
  try {
    state = JSON.parse(readFileSync(file, "utf8"))?.state ?? null;
  } catch {
    /* state.json unreadable — liveness still proven by the dir existing */
  }
  return { exists: true, mtimeMs: st.mtimeMs, state };
}

// classifyWorker — PURE given statJob. One WorkerSignal (from readWorkerSignals)
// → a liveness class:
//   'terminal' — signal status is terminal; the phase finished, nothing to attach
//   'running'  — non-terminal + the bg job dir exists → re-attached
//   'dead'     — non-terminal + the bg job dir is gone → a lost worker
//   'unknown'  — no bg_job_id (legacy pid signal, or an orphan `dispatched`
//                signal written before claude --bg was spawned)
export function classifyWorker(signal, { statJob = defaultStatJob } = {}) {
  if (TERMINAL.has(signal?.status)) return "terminal";
  const live = signal?.liveness;
  if (live?.kind !== "bg" || !live?.value) return "unknown";
  return statJob(live.value) ? "running" : "dead";
}

// reconstructWorkerState — scan ${orchDir}/workers/ via the canonical reader and
// bucket every worker by classifyWorker. Pure given statJob + the filesystem.
export function reconstructWorkerState(orchDir, { statJob = defaultStatJob } = {}) {
  const buckets = { running: [], dead: [], terminal: [], unknown: [] };
  for (const sig of readWorkerSignals(orchDir)) {
    buckets[classifyWorker(sig, { statJob })].push({
      ticket: sig.ticket,
      phase: sig.phase,
      status: sig.status,
      bgJobId: sig.liveness?.kind === "bg" ? sig.liveness.value : null,
      signalPath: sig.signalPath,
    });
  }
  if (buckets.dead.length || buckets.unknown.length) {
    log.warn(
      { dead: buckets.dead.length, unknown: buckets.unknown.length },
      "recovery: workers need attention (dead = lost process, unknown = orphan dispatch)",
    );
  }
  return buckets;
}
