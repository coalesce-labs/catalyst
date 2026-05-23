// recovery.mjs — execution-core crash-recovery & startup reconstruction (CTL-539).
//
// The recovery contract CTL-554's composing daemon calls on boot. Reconstructs
// routing state (eligible sets, via reconcileAll) and dispatch/worker state
// (via the canonical signal reader), and classifies every in-flight claude --bg
// worker's liveness so a restart resumes mid-run with no lost workers.

import {
  statSync,
  readFileSync,
  openSync,
  fstatSync,
  closeSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { getJobsRoot, getEventLogPath, log } from "./config.mjs";
import { readWorkerSignals, TERMINAL } from "./signal-reader.mjs";
import { reconcileAll } from "./monitor.mjs";
import { listProjects } from "./registry.mjs";
import { loadCursor, resolveStartOffset } from "./event-cursor.mjs";
import { WORK_DONE_PROBES, hasProbe } from "./work-done-probes.mjs";

// phase-agent-emit-complete sits two directories up from execution-core/.
const EMIT_COMPLETE_BIN = fileURLToPath(
  new URL("../phase-agent-emit-complete", import.meta.url),
);

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

// ─── CTL-574: reclaim-dead-work sweep ───────────────────────────────────────
//
// A phase-implement worker can finish its real work (commits land, tree clean)
// then die without emitting `phase.implement.complete` — a known class of bugs
// in the worker's End block (see memory project_phase_implement_state_json_stale).
// Pre-CTL-574 the resulting `phase-implement.json: status=running` + dead bg job
// stalled the pipeline indefinitely: `classifyWorker` returned 'dead' but
// nothing acted on it.
//
// `reclaimDeadWorkIfPossible` is called per signal by `schedulerTick`'s new
// step (0). For the `dead` class only, it asks the per-phase work-done probe
// whether the work IS committed. If so, it (a) emits a canonical
// `phase.<phase>.reclaim.<ticket>` audit event, then (b) invokes the existing
// `phase-agent-emit-complete` script with explicit `--orch-dir` + `--session-
// id` flags so the script's signal-flip + canonical-complete + session-end
// steps all run — exactly the same closer a healthy worker would have run.
// Downstream consumers (scheduler advancement, HUD, Linear write-back) see a
// normal `phase.<phase>.complete` and advance.
//
// PURE given the injected statJob / probes / emitComplete / appendEvent — no
// fs / spawn of its own.

function defaultEmitComplete({ orchDir, signal }, { spawn = spawnSync } = {}) {
  const args = [
    "--phase", signal.phase,
    "--ticket", signal.ticket,
    "--status", "complete",
    "--orch-dir", orchDir,
    "--orch-id", signal.raw?.orchestrator ?? signal.ticket,
  ];
  const sessionId = signal.raw?.catalystSessionId;
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  const res = spawn(EMIT_COMPLETE_BIN, args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// defaultAppendReclaimEvent — append a canonical phase.<phase>.reclaim.<ticket>
// envelope to the event log. Shape mirrors lib/canonical-event.sh; only one
// caller needs it, so we inline rather than wrap the bash builder. Best-effort:
// a write failure is logged but does not abort the reclaim (the next
// phase.<phase>.complete event still tells the story).
function defaultAppendReclaimEvent({ phase, ticket, orchId }) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const eventName = `phase.${phase}.reclaim.${ticket}`;
  const line =
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "WARN",
      severityNumber: 13,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: {
        "service.name": "catalyst.execution-core",
        "service.namespace": "catalyst",
      },
      attributes: {
        "event.name": eventName,
        "event.entity": "phase",
        "event.action": "reclaim",
        "event.label": ticket,
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
      },
      body: {
        payload: {
          phase,
          ticket,
          status: "reclaim",
          reason: "work-done-despite-dead-bg",
        },
      },
    }) + "\n";
  const logPath = getEventLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
  } catch (err) {
    log.warn({ err: err.message }, "reclaim-dead-work: failed to append reclaim event");
  }
}

// reclaimDeadWorkIfPossible — one signal in, one decision out. The five-way
// return discriminates the cases an operator might need to investigate:
//
//   'noop'             not 'dead' (terminal / running / unknown). No action.
//   'not-applicable'   'dead' but the phase has no registered work-done probe.
//                      Out of scope for CTL-574; CTL-587's territory.
//   'not-done'         'dead' + probe says the work is NOT committed. The
//                      worker really did die mid-implement. CTL-587 will
//                      re-dispatch when that lands.
//   'reclaimed'        'dead' + work IS done. Reclaim succeeded — the canonical
//                      audit + complete events were appended, the signal was
//                      flipped, the session was ended.
//   'reclaim-failed'   'dead' + work IS done BUT emit-complete exited non-zero.
//                      The signal is NOT mutated (the emit-complete script
//                      writes via atomic rename); the next tick retries.
export function reclaimDeadWorkIfPossible(
  orchDir,
  signal,
  {
    repoRoot,
    statJob = defaultStatJob,
    probes = WORK_DONE_PROBES,
    emitComplete = defaultEmitComplete,
    appendEvent = defaultAppendReclaimEvent,
  } = {},
) {
  const klass = classifyWorker(signal, { statJob });
  if (klass !== "dead") return "noop";
  if (!hasProbe(signal.phase)) return "not-applicable";

  const probe = probes[signal.phase];
  if (!probe({ ticket: signal.ticket, repoRoot })) {
    log.info(
      { ticket: signal.ticket, phase: signal.phase },
      "reclaim-dead-work: dead worker, work NOT done — left for CTL-587",
    );
    return "not-done";
  }

  appendEvent({
    phase: signal.phase,
    ticket: signal.ticket,
    orchId: signal.raw?.orchestrator,
  });

  const r = emitComplete({ orchDir, signal });
  if (r.code !== 0) {
    log.warn(
      { ticket: signal.ticket, phase: signal.phase, code: r.code, stderr: r.stderr },
      "reclaim-dead-work: emit-complete failed; will retry next tick",
    );
    return "reclaim-failed";
  }
  log.info(
    { ticket: signal.ticket, phase: signal.phase },
    "reclaim-dead-work: dead worker reclaimed (work was committed)",
  );
  return "reclaimed";
}

// recoverStartup — the boot-time reconstruction CTL-554's daemon calls. Rebuilds
// routing state (reconcileAll — authoritative Linear poll), loads the durable
// event-log cursor, and classifies every in-flight worker. Returns a
// RecoveryReport; throws nothing the daemon must handle (reconcile is internally
// best-effort, worker scan is filesystem-pure).
export function recoverStartup({ orchDir, exec, statJob } = {}) {
  if (!orchDir) throw new Error("recoverStartup: orchDir is required");

  // (1) Routing state — reconcileAll re-reads the registry + polls Linear per
  //     team; reconcileProject internally swallows poll/write failures.
  reconcileAll({ exec });
  const projects = listProjects().map((p) => p.team);

  // (2) Durable event-log cursor — what the monitor's fast path will resume at.
  const logPath = getEventLogPath();
  let fileSize = 0;
  try {
    const fd = openSync(logPath, "r");
    fileSize = fstatSync(fd).size;
    closeSync(fd);
  } catch {
    /* no event log yet — poll-only mode */
  }
  const cursor = loadCursor();
  const startOffset = resolveStartOffset({ cursor, logPath, fileSize });

  // (3) Dispatch/worker state — classify in-flight claude --bg workers.
  const workers = reconstructWorkerState(orchDir, { statJob });

  return {
    recoveredAt: new Date().toISOString(),
    routing: { projects, projectCount: projects.length },
    cursor: { logPath, byteOffset: startOffset, resumed: startOffset !== fileSize },
    workers,
  };
}
