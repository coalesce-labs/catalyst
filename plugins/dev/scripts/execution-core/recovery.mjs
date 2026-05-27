// recovery.mjs — execution-core crash-recovery & startup reconstruction (CTL-539).
//
// The recovery contract CTL-554's composing daemon calls on boot. Reconstructs
// routing state (eligible sets, via reconcileAll) and dispatch/worker state
// (via the canonical signal reader), and classifies every in-flight claude --bg
// worker's liveness so a restart resumes mid-run with no lost workers.

import {
  statSync,
  readFileSync,
  readdirSync,
  openSync,
  fstatSync,
  closeSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { getJobsRoot, getEventLogPath, log } from "./config.mjs";
import { phaseIndex } from "../lib/phase-fsm.mjs";
import { readWorkerSignals, TERMINAL, listDispatchedPhases } from "./signal-reader.mjs";
import { reconcileAll } from "./monitor.mjs";
import { listProjects } from "./registry.mjs";
import { emitReapIntent } from "./reap-intent.mjs";
import { loadCursor, resolveStartOffset } from "./event-cursor.mjs";
import { WORK_DONE_PROBES, hasProbe } from "./work-done-probes.mjs";
import { defaultDispatch } from "./dispatch.mjs";
import { applyLabel as defaultApplyLabel } from "./linear-write.mjs";
// CTL-638: pull the once-marker + per-(ticket, phase) cool-down primitives
// from the shared leaf module. labelOnce is the same guard CTL-585 introduced
// for scheduler.mjs's `needs-human` path — pre-CTL-638 the recovery sweep's
// escalation call bypassed it entirely.
import {
  labelOnce,
  inEscalationCooldown as defaultInEscalationCooldown,
  recordEscalation as defaultRecordEscalation,
} from "./label-guard.mjs";
import {
  countReviveEvents as defaultCountReviveEvents,
  countDistinctRevivingTickets as defaultCountDistinctRevivingTickets,
} from "./event-scan.mjs";

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

// buildEventEnvelope — shared canonical-event builder for the reclaim,
// revive, escalated, and revive-suppressed audit events (CTL-574 + CTL-587).
// Shape mirrors lib/canonical-event.sh. Centralizing it here keeps the four
// per-action helpers tiny and prevents shape drift between actions.
function buildEventEnvelope({ phase, ticket, orchId, action, reason, payloadExtras = {} }) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
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
        "event.name": `phase.${phase}.${action}.${ticket}`,
        "event.entity": "phase",
        "event.action": action,
        "event.label": ticket,
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
      },
      body: { payload: { phase, ticket, status: action, reason, ...payloadExtras } },
    }) + "\n"
  );
}

// appendEnvelopeBestEffort — try to append; return true on success, false on
// any failure. Revive event callers gate the dispatch on this return value:
// the per-ticket revive counter lives in events.jsonl, so a missed append
// means countReviveEvents undercounts on the next tick and the budget cannot
// be enforced. Better to skip the dispatch than to lose the counter.
function appendEnvelopeBestEffort(line, kind) {
  const logPath = getEventLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    // log.error (not warn) — a daemon-health-critical failure: the audit log
    // is unwriteable. Disk full, EACCES, EROFS during incident response.
    log.error({ err: err.message, kind }, "recovery: event append failed");
    return false;
  }
}

// defaultAppendReclaimEvent — phase.<phase>.reclaim.<ticket>. The CTL-574 path:
// the worker died but its work committed, so the scheduler can advance.
// Returns true iff the audit append succeeded (CTL-587 contract — callers may
// gate on success; today the reclaim caller does not).
function defaultAppendReclaimEvent({ phase, ticket, orchId }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "reclaim",
      reason: "work-done-despite-dead-bg",
    }),
    "reclaim",
  );
}

// defaultAppendBootResumeEvent — phase.<phase>.boot-resume.<ticket>. The
// CTL-654 path: a cold-start reboot re-dispatches an in-flight ticket whose
// worktree has no live bg worker. The `boot-resume` action is deliberately
// distinct from `revive`/`reclaim` so countReviveEvents (event-scan.mjs,
// implement-only `phase.implement.revive.<ticket>`) is unaffected and the
// broker's PHASE_EVENT_PATTERN (complete|failed|turn-cap-exhausted|skipped)
// ignores it — audit-only, like the other CTL-587 helpers. Exported so the
// round-trip test can confirm the envelope shape, and so boot-resume.mjs imports
// it as the default appendEvent seam.
export function defaultAppendBootResumeEvent({ phase, ticket, orchId }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "boot-resume",
      reason: "cold-start-no-live-worker",
    }),
    "boot-resume",
  );
}

// CTL-587: three new audit-only event helpers. The broker's PHASE_EVENT_PATTERN
// in router.mjs only matches complete|failed|turn-cap-exhausted|skipped, so
// revive/escalated/revive-suppressed events are deliberately ignored by the
// orchestrator and exist purely for operator forensics + the per-ticket
// revive counter (event-scan.mjs::countReviveEvents).

// defaultAppendReviveEvent — returns true iff the audit append succeeded.
// reclaimDeadWorkIfPossible gates the dispatch on this so a failed append
// does not lose the budget counter (next tick would repeat attempt N instead
// of advancing to N+1). Exported so the round-trip test can confirm the
// envelope shape this writes matches what countReviveEvents reads.
export function defaultAppendReviveEvent({
  phase,
  ticket,
  orchId,
  attempt,
  reason,
  prev_state_json_mtime,
  prev_bg_job_id,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "revive",
      reason,
      payloadExtras: { attempt, prev_state_json_mtime, prev_bg_job_id },
    }),
    "revive",
  );
}

function defaultAppendEscalatedEvent({ phase, ticket, orchId, reason, final_attempt_count }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "escalated",
      reason,
      payloadExtras: { final_attempt_count },
    }),
    "escalated",
  );
}

// reason defaults to the storm-breaker case; the audit-append-failed branch
// passes its own discriminator so operators can filter the two suppression
// causes apart in events.jsonl.
function defaultAppendReviveSuppressedEvent({
  phase,
  ticket,
  orchId,
  window_distinct_tickets,
  reason = "storm-breaker-open",
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "revive-suppressed",
      reason,
      payloadExtras: { window_distinct_tickets, window_ms: STORM_WINDOW_MS },
    }),
    "revive-suppressed",
  );
}

// CTL-587 default seams — all overridable for tests, all best-effort for prod.

// defaultReviveDispatch — reset the signal to status: "stalled" first (to bypass
// the phase-agent-dispatch idempotency guard at lines 374-395; `stalled` is the
// single status that falls through), then call defaultDispatch. Mirrors the
// orchestrate-revive precedent (orchestrate-revive:577-611).
//
// The reset is load-bearing: without flipping to `stalled` the dispatcher's
// idempotency guard rejects the spawn for any non-failed signal. A missing
// signal file is therefore treated as an error — falling through to dispatch
// without a signal would silently no-op and burn the revive budget.
//
// Exported with an injectable `dispatch` seam so the default behaviour itself
// can be unit-tested (every test in recovery.test.mjs that overrides the
// outer `reviveDispatch` would otherwise leave the signal-reset logic — the
// load-bearing half — uncovered).
export function defaultReviveDispatch({ orchDir, ticket, phase }, { dispatch = defaultDispatch } = {}) {
  const signalPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  if (!existsSync(signalPath)) {
    log.warn(
      { ticket, phase, signalPath },
      "revive: signal file missing — cannot reset to stalled, refusing dispatch",
    );
    return { code: 1, stdout: "", stderr: "signal-missing" };
  }
  // CTL-615: capture the previously-dispatched worktreePath so dispatch can
  // cross-check the registry-resolved path against the canonical cwd before
  // launching the bg worker. Pre-CTL-615 signals lack the field; in that case
  // we omit expectedWorktreePath and fall through to legacy behaviour.
  let expectedWorktreePath;
  try {
    const sig = JSON.parse(readFileSync(signalPath, "utf8"));
    if (typeof sig.worktreePath === "string" && sig.worktreePath.length > 0) {
      expectedWorktreePath = sig.worktreePath;
    }
    sig.status = "stalled";
    sig.attentionReason = "ctl-587-revive-reset";
    sig.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    // Atomic write — mirrors abort-worker.mjs:77-79 ("the signal is the source
    // of truth"). A bare writeFileSync would let a concurrent reader observe a
    // partially-written file and misclassify the worker as 'unknown'.
    const tmp = `${signalPath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(sig, null, 2));
    renameSync(tmp, signalPath);
  } catch (err) {
    log.warn({ ticket, phase, err: err.message }, "revive: signal reset failed");
    return { code: 1, stdout: "", stderr: err.message };
  }
  const dispatchArgs = { orchDir, ticket, phase };
  if (expectedWorktreePath) dispatchArgs.expectedWorktreePath = expectedWorktreePath;
  return dispatch(dispatchArgs);
}

// defaultApplyStalledLabel — apply the flat `needs-human` label through the
// CTL-585 `labelOnce` guard (CTL-638). The pre-CTL-638 implementation called
// `applyLabel` directly; the comment then claimed "the next scheduler tick
// re-runs this function via labelOnce semantics" but no labelOnce wrapper
// existed on this path — the recovery sweep's escalation call sites
// (no-probe-for-phase, revive-budget-exhausted; non-implement-not-done was
// removed in CTL-604 when research/plan gained probes) all
// bypassed CTL-585's marker-file guard. On a rate-limit, applyLabel returned
// applied:false → no marker written → every scheduler tick (debounced to 2s
// by the event-log fast path) re-fired the write, exhausting Linear's 2,500/hr
// quota at ~28 writes/min.
//
// Routing through labelOnce gives this path the same once-per-daemon-lifetime
// semantics as scheduler.mjs:653's stalled-signal label sweep:
//   • On applied:true → writes workers/<T>/.linear-label-needs-human.applied.
//     The next tick short-circuits before touching Linear.
//   • On reason:"missing-label" → writes .skipped (operator creates the label
//     manually + deletes the marker to re-arm).
//   • On any transient failure (rate-limited, undefined, throw) → no marker,
//     next tick retries. CTL-638's per-(ticket, phase) escalation cool-down
//     (in label-guard.mjs) is the SECOND layer of protection for this case:
//     even if labelOnce keeps retrying the write, the cool-down suppresses
//     the audit-event + label-call pair entirely so the scheduler's own
//     event-log fast path stops self-feeding.
function defaultApplyStalledLabel({ orchDir, ticket }) {
  return labelOnce(orchDir, ticket, "needs-human", { applyLabel: defaultApplyLabel });
}

// defaultKillBgJob — best-effort `kill -9` of a lingering bg pid. Gated by the
// caller on KILL_RECENT_ACTIVITY_MS so we never SIGKILL a worker whose
// state.json was touched recently. The bg-job pid lives in
// ~/.claude/jobs/<id>/pid (Claude Code job-state convention); a missing pid
// file is the normal case for a reaped job. We verify the pid still maps to a
// `claude` process before signalling to defensively avoid SIGKILL'ing a
// recycled pid (~5+ minutes after the worker exited the PID space is fair
// game for unrelated processes).
//
// `spawn` and `jobsRoot` are injectable for tests; production defaults call
// the real spawnSync against the real ~/.claude/jobs.
export function defaultKillBgJob(
  { bgJobId },
  { spawn = spawnSync, jobsRoot = getJobsRoot } = {},
) {
  if (!bgJobId) return;
  try {
    const pidPath = join(jobsRoot(), bgJobId, "pid");
    if (!existsSync(pidPath)) return;
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1) return;
    // Verify the pid still belongs to a claude process before SIGKILL'ing.
    // `ps -p <pid> -o comm=` prints just the command; exit 1 means the pid
    // is gone. On any verification doubt, skip the kill (best-effort).
    const ps = spawn("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    if (ps.status !== 0 || !(ps.stdout || "").toLowerCase().includes("claude")) {
      log.info(
        { bgJobId, pid, comm: (ps.stdout || "").trim() },
        "revive: defensive kill skipped — pid does not belong to a claude process",
      );
      return;
    }
    const k = spawn("kill", ["-9", String(pid)], { encoding: "utf8" });
    log.info(
      { bgJobId, pid, code: k.status },
      "revive: defensive kill issued",
    );
  } catch (err) {
    log.warn({ bgJobId, err: err.message }, "revive: defensive kill failed");
  }
}

// defaultPidAlive — positive keep-alive check (CTL-610). Returns true iff the
// bg job's recorded pid is still a live `claude` process. This is the inverse
// use of the same primitive defaultKillBgJob uses to gate its SIGKILL: read
// ~/.claude/jobs/<id>/pid, verify via `ps -p <pid> -o comm=` that the pid maps
// to a claude process. It signals "alive, do not revive", never kills.
// Best-effort: any doubt (missing pid file, unreadable, recycled pid, falsy
// id, throwing seam) returns false so the caller falls through to its existing
// revive path. Critically, the production seam returning false on a missing
// pid file keeps every pre-CTL-610 revive test (which uses bgJobId "bg-9"
// with no real pid file) green when the alive-quiet guard goes live.
// `spawn` and `jobsRoot` are injectable for tests; production defaults call
// the real spawnSync against the real ~/.claude/jobs.
export function defaultPidAlive(
  { bgJobId },
  { spawn = spawnSync, jobsRoot = getJobsRoot } = {},
) {
  if (!bgJobId) return false;
  try {
    const pidPath = join(jobsRoot(), bgJobId, "pid");
    if (!existsSync(pidPath)) return false;
    const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1) return false;
    const ps = spawn("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return ps.status === 0 && (ps.stdout || "").toLowerCase().includes("claude");
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CTL-655: daemon-boot marker. The daemon writes this once at startup
// (writeBootMarker, below) and reclaimDeadWorkIfPossible reads it
// (readBootSince) to window the per-ticket revive budget to the CURRENT daemon
// run, so a clean restart resets a budget burned by a prior crash storm. This
// is deliberately NOT the CTL-640 cold-start epoch (OS boot / claude-daemon
// start) — that boundary would not reset on a daemon-only restart.
// ──────────────────────────────────────────────────────────────────────────

// bootMarkerPath — the single source of the marker location, shared by the
// reader and writer. Lives alongside daemon.pid / state.json / cursor.json.
export function bootMarkerPath(orchDir) {
  return join(orchDir, "daemon-boot.json");
}

// readBootSince — the ISO-8601 boot timestamp to pass as countReviveEvents'
// `since`, or undefined. Fail-open: a missing / unparseable / wrong-typed
// marker returns undefined → the counter counts all events (the pre-CTL-655
// behavior, the conservative direction — the budget can still exhaust).
export function readBootSince(orchDir) {
  try {
    const raw = readFileSync(bootMarkerPath(orchDir), "utf8");
    const bootedAt = JSON.parse(raw)?.bootedAt;
    return typeof bootedAt === "string" && bootedAt ? bootedAt : undefined;
  } catch {
    return undefined;
  }
}

// writeBootMarker — record this daemon process's start time. Atomic tmp+rename,
// fail-open: a write failure logs and the daemon continues (the budget simply
// won't reset this run — the safe degradation). Injectable `now` for tests.
export function writeBootMarker(orchDir, { now = () => new Date().toISOString() } = {}) {
  try {
    const p = bootMarkerPath(orchDir);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ bootedAt: now() }));
    renameSync(tmp, p);
  } catch (err) {
    log.warn({ err }, "ctl-655: failed to write daemon-boot.json (revive budget will not reset this run)");
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CTL-640: cold-start detection. The reference epoch = max(OS boot, claude-daemon
// start). If that epoch is newer than EVERY ~/.claude/jobs/<id>/state.json mtime,
// every recorded --bg worker pre-dates the epoch and is provably dead → COLD
// START. A false COLD is dangerous (unlocks aggressive recovery → storm risk),
// so every reader fails open to 0 (the conservative floor) and the verdict biases
// toward WARM. CTL-640 produces this signal only; consuming it is downstream.
// ──────────────────────────────────────────────────────────────────────────

// readBootEpoch — OS boot time in epoch-ms, or 0 if unobtainable.
//   darwin: `sysctl -n kern.boottime` → "{ sec = <n>, usec = ... } <date>"
//   linux:  /proc/stat line "btime <n>" (absolute boot epoch seconds; stable,
//           unlike /proc/uptime which drifts with clock adjustments).
// Injectable platform/spawn/readFile for deterministic tests. Never throws.
export function readBootEpoch({
  platform = process.platform,
  spawn = spawnSync,
  readFile = (p) => readFileSync(p, "utf8"),
} = {}) {
  try {
    if (platform === "darwin") {
      const res = spawn("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
      if (res.status !== 0) return 0;
      const m = /sec\s*=\s*(\d+)/.exec(res.stdout || "");
      return m ? Number(m[1]) * 1000 : 0;
    }
    if (platform === "linux") {
      const m = /^btime\s+(\d+)/m.exec(readFile("/proc/stat") || "");
      return m ? Number(m[1]) * 1000 : 0;
    }
  } catch {
    /* fall through to 0 */
  }
  return 0;
}

// readDaemonEpoch — claude-daemon instance start in epoch-ms, or 0. The
// per-instance socket dir /tmp/cc-daemon-<uid>/<instance>/ is recreated on each
// daemon restart, so the newest immediate-subdir mtime IS the current instance's
// start. (roster.json `updatedAt` is a heartbeat and is deliberately not used.)
export function readDaemonEpoch({
  socketRoot = `/tmp/cc-daemon-${process.getuid?.() ?? ""}`,
  readDir = (p) => readdirSync(p),
  statDir = (p) => statSync(p),
} = {}) {
  try {
    let newest = 0;
    for (const name of readDir(socketRoot)) {
      try {
        const m = statDir(join(socketRoot, name)).mtimeMs;
        if (typeof m === "number" && m > newest) newest = m;
      } catch {
        /* skip unreadable entry */
      }
    }
    return newest;
  } catch {
    return 0; // socket root absent
  }
}

// defaultReadRuntimeEpoch — the cold-start reference epoch = max(boot, daemon).
// epochSource names the winner for forensics; "none" when neither is readable.
export function defaultReadRuntimeEpoch({
  readBoot = readBootEpoch,
  readDaemon = readDaemonEpoch,
} = {}) {
  const bootEpoch = readBoot();
  const daemonEpoch = readDaemon();
  const epoch = Math.max(bootEpoch, daemonEpoch);
  let epochSource = "none";
  if (epoch > 0) epochSource = daemonEpoch >= bootEpoch ? "daemon" : "boot";
  return { epoch, epochSource, bootEpoch, daemonEpoch };
}

// detectColdStart — proves every prior claude --bg worker is dead by comparing
// each job's state.json mtime against the runtime epoch (max OS boot, daemon
// start). COLD when the epoch is newer than ALL job mtimes (vacuously true with
// zero jobs). The single hard invariant: an UNREADABLE epoch (0 / "none") can
// prove nothing, so it is NEVER cold — the conservative CTL-588 stale-wait
// remains the fallback. Enumerates ALL dirs under getJobsRoot() (not just
// signalled bg_job_ids) so a live sibling-orchestrator worker can veto the
// verdict. Pure aside from injected seams; never throws.
export function detectColdStart({
  jobsRoot = getJobsRoot(),
  readDir = readdirSync,
  statJob = defaultStatJob,
  readEpoch = defaultReadRuntimeEpoch,
} = {}) {
  const { epoch, epochSource } = readEpoch();

  let ids = [];
  try {
    ids = readDir(jobsRoot);
  } catch {
    ids = []; // jobs root absent → zero jobs
  }

  let jobsChecked = 0;
  let newestJobMtime = 0;
  for (const id of ids) {
    const job = statJob(id);
    if (!job || typeof job.mtimeMs !== "number") continue; // no usable evidence
    jobsChecked += 1;
    if (job.mtimeMs > newestJobMtime) newestJobMtime = job.mtimeMs;
  }

  // Unreadable epoch proves nothing. Otherwise cold iff every job mtime predates
  // the epoch (vacuously true when jobsChecked === 0).
  const coldStart = epoch > 0 && newestJobMtime < epoch;

  return { coldStart, epoch, epochSource, jobsChecked, newestJobMtime };
}

// defaultWriteReviveMarker — write workers/<ticket>/.revive-<N>.applied as an
// operator-friendly forensic crumb. The authoritative counter is in
// events.jsonl; the marker is just a quick `ls`-able count for operators.
function defaultWriteReviveMarker({ orchDir, ticket, attempt }) {
  try {
    const path = join(orchDir, "workers", ticket, `.revive-${attempt}.applied`);
    writeFileSync(path, new Date().toISOString());
  } catch (err) {
    log.warn({ ticket, attempt, err: err.message }, "revive: marker write failed");
  }
}

// STALE_MS — a healthy claude --bg worker updates ~/.claude/jobs/<id>/state.json
// every few seconds (heartbeats, output appends, scan offsets). A state.json
// untouched longer than this is conclusive evidence the worker stopped (CTL-588).
// 5 minutes is a generous gap that won't false-positive a worker idling on a
// long tool call.
const STALE_MS = 5 * 60 * 1000;

// CTL-587 — auto-revival constants. MAX_REVIVES is the per-ticket budget
// (counted from events.jsonl). STORM_WINDOW_MS + STORM_THRESHOLD form the
// breaker that suppresses revives when too many tickets are reviving at once
// (a Linear-side or fleet-wide outage). KILL_RECENT_ACTIVITY_MS gates the
// defensive SIGKILL: only fire when the bg state.json has been quiet for that
// long — i.e. the worker really is gone, not just idling on a long tool call.
const MAX_REVIVES = 2;
const STORM_WINDOW_MS = 10 * 60 * 1000;
const STORM_THRESHOLD = 3;
const KILL_RECENT_ACTIVITY_MS = 30 * 1000;

// CTL-610 — hung cutoff for the alive-quiet keep-alive guard. A worker flagged
// effectively-dead by stale state.json mtime but whose bg pid is still a live
// `claude` process is alive-but-blocked-on-a-long-tool-call (a research/plan
// sub-agent fan-out, or a long synchronous Edit/Bash inside implement), not
// crashed — so we suppress its revive up to this bound. Past it, even a live
// pid is treated as genuinely hung and revived as before. 15 minutes matches
// the legacy STALE_BG_SECONDS the original ticket cites — a live worker gets
// the full original grace before we conclude it is hung.
const HUNG_CUTOFF_MS = 15 * 60 * 1000;

// reclaimDeadWorkIfPossible — one signal in, one decision out. CTL-587 widens
// the return set from CTL-574's five values to seven, transforming the two
// silent dead-ends ('not-applicable' and 'not-done') into actionable outcomes:
//
//   'noop'                not effectively dead (terminal / unknown / live).
//                         No action.
//   'reclaimed'           effectively dead + work IS done. CTL-574 happy path
//                         — canonical reclaim audit appended, emit-complete
//                         flipped the signal, session ended.
//   'reclaim-failed'      effectively dead + work IS done BUT emit-complete
//                         exited non-zero. Signal NOT mutated (atomic rename);
//                         next tick retries.
//   'revived'             effectively dead + probe says work NOT done + revive
//                         budget available + storm-breaker closed. Signal was
//                         reset to 'stalled' to bypass the dispatcher's
//                         idempotency guard; defaultDispatch was invoked; the
//                         worker-dir .revive-N.applied marker was written.
//                         CTL-604: implement/research/plan (every probed phase)
//                         share this path — a probed worker that died before
//                         writing its artifact is re-dispatched, not escalated.
//   'revive-suppressed'   effectively dead + work NOT done + storm-breaker
//                         OPEN (>3 distinct tickets reviving in last 10min).
//                         No dispatch; suppress event audited; next tick
//                         re-evaluates the window.
//   'escalated'           effectively dead + (revive budget exhausted OR no
//                         work-done probe registered for this phase — i.e. a
//                         probe-less phase: verify/review/pr/monitor-*).
//                         needs-human label applied (via the CTL-587 verified
//                         applyLabel); ticket stays where it is for human triage.
//   'superseded-noop'     effectively dead BUT the signal's phase precedes the
//                         ticket's latest-dispatched phase (CTL-606). The ticket
//                         has already advanced; the dead signal is a leftover
//                         predecessor (left at `running`, never flipped to
//                         `done`) that readWorkerSignals→byActivePhase ranked
//                         ahead of the genuinely-active terminal phase. No
//                         escalate/revive/reclaim — acting would spuriously flag
//                         needs-human or spawn a duplicate worker at a past phase.
//   'alive-quiet-suppressed' effectively dead by state.json mtime AND probe says
//                         work NOT done BUT the bg pid is still a live `claude`
//                         process within HUNG_CUTOFF_MS (CTL-610). The worker
//                         is alive-blocked-on-a-long-tool-call (the pre-first-
//                         output window for research/plan, or a long sync
//                         Edit/Bash inside implement), not crashed. Suppress
//                         the revive: no duplicate spawn, no budget consumed,
//                         no .revive-N.applied marker, no defensive kill, no
//                         events.jsonl append — log-only (to avoid the CTL-638
//                         self-feeding storm). A dead pid (real crash) or a
//                         live pid past the cutoff (genuinely hung) falls
//                         through to the existing revive path.
//
// CTL-588 still defines "effectively dead" as classifyWorker:'dead' OR a
// 'running' signal whose bg state.json mtime is older than staleMs.
//
// The function stays pure given its injected seams: statJob / probes /
// emitComplete / appendEvent (pre-CTL-587) plus the six CTL-587 seams
// (appendReviveEvent, appendEscalatedEvent, appendReviveSuppressedEvent,
// reviveDispatch, applyStalledLabel, killBgJob, countReviveEvents,
// countDistinctRevivingTickets, writeReviveMarker). All have real defaults
// for prod; tests override every one.
export function reclaimDeadWorkIfPossible(
  orchDir,
  signal,
  {
    repoRoot,
    statJob = defaultStatJob,
    probes = WORK_DONE_PROBES,
    emitComplete = defaultEmitComplete,
    appendEvent = defaultAppendReclaimEvent,
    appendReviveEvent = defaultAppendReviveEvent,
    appendEscalatedEvent = defaultAppendEscalatedEvent,
    appendReviveSuppressedEvent = defaultAppendReviveSuppressedEvent,
    reviveDispatch = defaultReviveDispatch,
    applyStalledLabel = defaultApplyStalledLabel,
    killBgJob = defaultKillBgJob,
    countReviveEvents = defaultCountReviveEvents,
    // CTL-655 — boot-time window reader. Reads <orchDir>/daemon-boot.json and
    // returns its `bootedAt` (or undefined) so the revive budget counts only
    // revives from the current daemon run. Named ...Fn to avoid shadowing the
    // module-level readBootSince used as the default.
    readBootSince: readBootSinceFn = readBootSince,
    countDistinctRevivingTickets = defaultCountDistinctRevivingTickets,
    writeReviveMarker = defaultWriteReviveMarker,
    // CTL-638 — per-(ticket, phase) escalation cool-down. Defaults read/write
    // markers under orchDir/.escalation-cooldowns/; tests can inject fakes to
    // run multiple escalations against the same scenario without filesystem
    // I/O, or to drive the cool-down clock independently of `now`.
    inEscalationCooldownFn = defaultInEscalationCooldown,
    recordEscalationFn = defaultRecordEscalation,
    // CTL-606 — supersede guard. Returns the ticket's dispatched phase names so
    // the guard can detect a dead signal the pipeline has already advanced past.
    listTicketPhases = (t) => listDispatchedPhases(orchDir, t),
    // CTL-610 — alive-quiet keep-alive guard. pidAlive is the positive
    // inverse of defaultKillBgJob's ps-verify: "is bg pid a live `claude`
    // process?" Returning true within hungCutoffMs suppresses the revive
    // entirely (the worker is alive on a long tool call, not crashed).
    // Production defaults: pidAlive reads ~/.claude/jobs/<bg>/pid; the cutoff
    // matches the legacy 15-min STALE_BG_SECONDS.
    pidAlive = defaultPidAlive,
    hungCutoffMs = HUNG_CUTOFF_MS,
    now = Date.now,
    staleMs = STALE_MS,
  } = {},
) {
  const klass = classifyWorker(signal, { statJob });
  let effectivelyDead = klass === "dead";
  // CTL-587: capture the bg state.json mtime so the defensive kill + the revive
  // audit payload can both reference it without re-statting.
  let prevStateJsonMtime = null;
  if (klass === "running" && signal?.liveness?.value) {
    const job = statJob(signal.liveness.value);
    if (job && typeof job.mtimeMs === "number") {
      prevStateJsonMtime = job.mtimeMs;
      if (now() - job.mtimeMs > staleMs) effectivelyDead = true;
    }
  }
  if (!effectivelyDead) return "noop";

  const { ticket, phase } = signal;

  // CTL-606 — supersede guard. The reclaim sweep is fed ONE signal per ticket by
  // readWorkerSignals→byActivePhase, which ranks by status+recency, NOT phase
  // order. A stale predecessor left at `running` (never flipped to `done`) can
  // therefore shadow the real, already-advanced phase and be handed here. If the
  // dead signal's phase precedes the ticket's latest-dispatched phase, the ticket
  // has moved on — escalating or reviving it would spuriously flag needs-human or
  // spawn a duplicate worker at a past phase. No-op. Runs only after the dead
  // check above, so live signals pay no filesystem read.
  const dispatched = listTicketPhases(ticket);
  const latestIdx = dispatched.reduce((max, p) => {
    const i = phaseIndex(p);
    return i > max ? i : max;
  }, -1);
  if (phaseIndex(phase) < latestIdx) {
    // CTL-649: emit a reap-intent so the daemon reaper can stop the lingering
    // bg worker (pre-CTL-649 the supersede-noop branch did nothing and the
    // stale worker kept running). Fire-and-forget — the periodic orphan
    // reaper picks up anything the reconciler missed.
    if (signal.raw?.bg_job_id) {
      emitReapIntent("phase.supersede.reap-requested", {
        ticket,
        phase,
        bgJobId: signal.raw.bg_job_id,
        worktreePath: signal.raw.worktreePath,
        dominantPhase: dispatched[dispatched.length - 1],
        reason: "ctl-606-superseded",
      }).catch(() => {});
    }
    log.info({ ticket, phase, latestPhaseIndex: latestIdx }, "ctl-606: superseded phase, no-op");
    return "superseded-noop";
  }

  const orchId = signal.raw?.orchestrator;
  const prevBgJobId = signal.raw?.bg_job_id ?? null;

  // CTL-638 — escalation helper. Wraps the appendEscalatedEvent + applyStalledLabel
  // pair in a per-(ticket, phase) cool-down. Pre-CTL-638 the three escalation
  // call sites duplicated the same 9-line block, and each one re-emitted the
  // audit event on every tick — feeding the scheduler's own event-log watcher
  // back into the next tick (28/min sustained storm). Returning
  // "escalation-suppressed" lets schedulerTick bucket the suppression as
  // invisible (the original escalation event was already emitted).
  function escalateOnce(reason, finalAttemptCount) {
    if (inEscalationCooldownFn(orchDir, ticket, phase, now())) {
      return "escalation-suppressed";
    }
    appendEscalatedEvent({
      phase,
      ticket,
      orchId,
      reason,
      final_attempt_count: finalAttemptCount,
    });
    applyStalledLabel({ orchDir, ticket });
    recordEscalationFn(orchDir, ticket, phase, reason, now());
    log.warn({ ticket, phase, reason }, "ctl-587: escalated");
    return "escalated";
  }

  // (A) No probe registered for this phase → escalate. The pre-CTL-587 silent
  //     'not-applicable' return is now an actionable outcome: the worker is
  //     dead, we cannot prove its work landed, and no automation can recover
  //     — so the human needs to look. needs-human label applied (verified by
  //     the CTL-587 applyLabel read-back). CTL-638 routes through escalateOnce
  //     so the same (ticket, phase) cannot re-fire within the cool-down window.
  if (!hasProbe(phase)) {
    return escalateOnce("no-probe-for-phase", 0);
  }

  // (B) Probe says work IS done → CTL-574 reclaim. CTL-641 threads orchDir
  //     (already this function's first param) so worker-dir / worktree probes
  //     can locate their artifact; implementProbe ignores the extra key.
  const probe = probes[phase];
  if (probe({ ticket, repoRoot, orchDir })) {
    appendEvent({ phase, ticket, orchId });
    const r = emitComplete({ orchDir, signal });
    if (r.code !== 0) {
      log.warn(
        { ticket, phase, code: r.code, stderr: r.stderr },
        "reclaim-dead-work: emit-complete failed; will retry next tick",
      );
      return "reclaim-failed";
    }
    log.info({ ticket, phase }, "reclaim-dead-work: dead worker reclaimed (work was committed)");
    return "reclaimed";
  }

  // (C) Probe says work is NOT done → CTL-587 revive territory. CTL-604: every
  //     phase that reaches here has a probe (branch (A) already returned for the
  //     probe-less phases), so implement/research/plan all share the bounded
  //     revive/re-dispatch path below. A worker that died before writing its
  //     artifact is re-dispatched fresh rather than dead-ended at needs-human.
  //     defaultReviveDispatch is phase-agnostic (resets the signal to `stalled`
  //     and re-launches via phase-agent-dispatch).

  // (C0) CTL-610 — alive-quiet keep-alive guard. The worker is effectively-dead
  //     by state.json mtime and its probe reads not-done, but if its bg pid is
  //     still a live `claude` process within the hung cutoff, it is alive-
  //     blocked on a long synchronous tool call (the pre-first-output window
  //     for research/plan, or a long Edit/Bash inside implement), not crashed.
  //     Suppress the revive — no duplicate spawn, no budget spent, no marker,
  //     no kill, no events.jsonl append (log-only, to avoid the CTL-638
  //     self-feeding storm). A dead pid (real crash) or a live pid past the
  //     cutoff (genuinely hung) falls through to the existing revive path
  //     below. Runs BEFORE priorRevives so a live worker is never falsely
  //     escalated to needs-human just because two prior false-revives consumed
  //     its budget; runs BEFORE the storm-breaker so liveness wins over
  //     fleet-wide noise. The first conjunct (prevStateJsonMtime !== null)
  //     fails-closed on the classifyWorker:'dead' path (job dir gone — a real
  //     crash) so the guard cannot mask one.
  if (
    prevStateJsonMtime !== null &&
    now() - prevStateJsonMtime < hungCutoffMs &&
    pidAlive({ bgJobId: prevBgJobId })
  ) {
    log.info(
      { ticket, phase, prevBgJobId, prevStateJsonMtime },
      "ctl-610: revive suppressed — bg pid alive within hung cutoff (worker is quiet, not dead)",
    );
    return "alive-quiet-suppressed";
  }

  // Per-ticket revive budget from events.jsonl. The events file is the
  // authoritative counter — more truthful than the signal file (which the
  // dispatcher rewrites each spawn). CTL-655: window the count to the current
  // daemon run via the boot marker, so a clean restart resets a budget burned
  // by a prior crash storm. `since` is undefined when the marker is absent →
  // the count is unwindowed (the pre-CTL-655 behavior).
  const since = readBootSinceFn(orchDir);
  const priorRevives = countReviveEvents({ ticket, orchId, since });
  if (priorRevives >= MAX_REVIVES) {
    return escalateOnce("revive-budget-exhausted", priorRevives);
  }

  // Storm-breaker: if many distinct tickets are reviving inside the window,
  // assume something is wrong fleet-wide and suppress (do nothing this tick).
  const distinctStormTickets = countDistinctRevivingTickets({
    windowMs: STORM_WINDOW_MS,
    now,
  });
  if (distinctStormTickets > STORM_THRESHOLD) {
    appendReviveSuppressedEvent({
      phase,
      ticket,
      orchId,
      window_distinct_tickets: distinctStormTickets,
    });
    log.warn(
      { ticket, phase, distinctStormTickets },
      "ctl-587: revive suppressed (storm-breaker open)",
    );
    return "revive-suppressed";
  }

  // Defensive kill: if state.json has been quiet long enough we're confident
  // the bg process is gone, so a SIGKILL on its pid is harmless and prevents
  // a zombie holding a worktree lock. The kill is best-effort and pid-file-gated
  // — if no pid file exists (the normal post-exit state) it's a no-op.
  //
  // CTL-649: also emit a reap-intent so the daemon reaper has authoritative
  // visibility and can issue `claude stop` on the supervisor entry (kill -9
  // hits the OS pid but the claude supervisor lingers as idle/dead-pid). The
  // inline kill stays so behaviour cannot regress.
  if (
    prevStateJsonMtime !== null &&
    now() - prevStateJsonMtime > KILL_RECENT_ACTIVITY_MS &&
    prevBgJobId
  ) {
    emitReapIntent("phase.revive.reap-requested", {
      ticket,
      phase,
      bgJobId: prevBgJobId,
      worktreePath: signal.raw?.worktreePath,
      quietMs: now() - prevStateJsonMtime,
    }).catch(() => {});
    killBgJob({ bgJobId: prevBgJobId });
  }

  const attempt = priorRevives + 1;
  // Emit BEFORE the dispatch so a daemon crash mid-revive leaves the event
  // behind. The next tick's count(events) sees attempt N — correctly entering
  // attempt N+1 instead of repeating N forever.
  //
  // The audit emit can fail (disk full, EROFS, permissions during incident).
  // The per-ticket revive counter LIVES in events.jsonl, so a missed append
  // means the next tick will undercount and the budget cannot be enforced.
  // Safer to skip this dispatch and retry next tick than to spawn a worker
  // we cannot account for.
  const eventLanded = appendReviveEvent({
    phase,
    ticket,
    orchId,
    attempt,
    reason: "work-not-done-after-stale-bg",
    prev_state_json_mtime: prevStateJsonMtime,
    prev_bg_job_id: prevBgJobId,
  });
  if (eventLanded === false) {
    log.error(
      { ticket, phase, attempt },
      "ctl-587: revive event append failed — aborting dispatch to preserve budget counter (will retry next tick)",
    );
    // Best-effort suppression audit so operators see SOMETHING in events.jsonl
    // (if the audit log is writeable for this kind even though the revive
    // kind failed — e.g. a transient EAGAIN on the prior write). The
    // suppressed event uses a distinct reason so it can be filtered from the
    // storm-breaker case.
    appendReviveSuppressedEvent({
      phase,
      ticket,
      orchId,
      window_distinct_tickets: 0, // not applicable — audit failure, not storm
      reason: "audit-append-failed",
    });
    return "revive-suppressed";
  }
  const dispatchRes = reviveDispatch({ orchDir, ticket, phase });
  if (dispatchRes.code === 0) {
    writeReviveMarker({ orchDir, ticket, attempt });
    log.info({ ticket, phase, attempt }, "ctl-587: revived");
  } else {
    // Dispatch failed; the next tick will retry. The marker is intentionally
    // NOT written so the marker-file count stays an accurate "successful
    // revives" record (audit-vs-marker drift is fine: the event is the truth).
    log.warn(
      { ticket, phase, attempt, code: dispatchRes.code, stderr: dispatchRes.stderr },
      "ctl-587: revive dispatch failed; will retry next tick",
    );
  }
  return "revived";
}

// recoverStartup — the boot-time reconstruction CTL-554's daemon calls. Rebuilds
// routing state (reconcileAll — authoritative Linear poll), loads the durable
// event-log cursor, and classifies every in-flight worker. Returns a
// RecoveryReport; throws nothing the daemon must handle (reconcile is internally
// best-effort, worker scan is filesystem-pure).
export function recoverStartup({ orchDir, exec, statJob, detectCold = detectColdStart } = {}) {
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

  // (4) Cold-start verdict (CTL-640) — does every prior --bg worker pre-date the
  //     runtime epoch? Surfaced for a downstream consumer (CTL-639) to gate the
  //     STALE_MS stale-wait. Pass statJob so a test-redirected jobs root flows
  //     through both the worker reconstruction and the cold-start scan.
  const coldStart = detectCold({ statJob });

  return {
    recoveredAt: new Date().toISOString(),
    routing: { projects, projectCount: projects.length },
    cursor: { logPath, byteOffset: startOffset, resumed: startOffset !== fileSize },
    workers,
    coldStart,
  };
}
