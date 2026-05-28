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
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  getJobsRoot,
  getEventLogPath,
  log,
  IDLE_CONFIRM_TICKS,
  BUSY_CEILING_MS,
} from "./config.mjs";
import { phaseIndex, isKnownPhase } from "../lib/phase-fsm.mjs";
import { readWorkerSignals, TERMINAL, listDispatchedPhases } from "./signal-reader.mjs";
import { reconcileAll } from "./monitor.mjs";
import { listProjects } from "./registry.mjs";
import { emitReapIntent as emitReapIntentDefault } from "./reap-intent.mjs";
import { livenessForBgJob, claudeStop } from "./claude-agents.mjs";
import { shortIdFromSessionId } from "./claude-ids.mjs";
import { loadCursor, resolveStartOffset } from "./event-cursor.mjs";
import { WORK_DONE_PROBES, hasProbe, describeProbe } from "./work-done-probes.mjs";
import { defaultDispatch } from "./dispatch.mjs";
import { applyLabel as defaultApplyLabel } from "./linear-write.mjs";
import { linearBreaker } from "./linear-breaker.mjs";
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

// resolvePhaseSessionId — JS port of orchestrate-revive's resolve_phase_session_id
// (orchestrate-revive:160-177). Resolves a `claude --resume`-compatible session
// UUID from a dead worker's bg_job_id by reading the job's state.json linkScanPath.
// Returns null on any miss (no bgJobId, no state.json, no/!.jsonl linkScanPath).
// MUST stay in sync with the bash resolver — they read the same on-disk contract
// and honour the same CATALYST_REVIVE_JOBS_DIR override (NOT getJobsRoot's
// CATALYST_HEALTHCHECK_JOBS_ROOT) so a test overriding one env var matches bash.
export function resolvePhaseSessionId(
  bgJobId,
  { jobsDir = process.env.CATALYST_REVIVE_JOBS_DIR || join(homedir(), ".claude", "jobs") } = {},
) {
  if (!bgJobId) return null;
  const stateFile = join(jobsDir, bgJobId, "state.json");
  if (!existsSync(stateFile)) return null;
  let linkPath;
  try {
    linkPath = JSON.parse(readFileSync(stateFile, "utf8"))?.linkScanPath;
  } catch {
    return null;
  }
  if (typeof linkPath !== "string" || !linkPath.endsWith(".jsonl")) return null;
  const sid = basename(linkPath, ".jsonl");
  return sid || null;
}

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
//
// CTL-664: the payload is enriched beyond the original {phase,ticket,reason}.
// All extra fields arrive as named params (single options object so existing
// callers are unaffected by field order) and flow through buildEventEnvelope's
// payloadExtras seam — the same mechanism the revive emitter uses. `title` /
// `body` make the HUD reclaim row's DETAILS cell render with no HUD code change
// (the format.ts fallback reads body.payload.title/body). Exported so the
// round-trip test can confirm the envelope shape.
export function defaultAppendReclaimEvent({
  phase,
  ticket,
  orchId,
  death_signal,
  prev_state_json_mtime = null,
  probe_passed = true,
  probe_checked,
  completion_origin = "inferred",
  reclaimed_bg_job_id = null,
  stopped_bg_job_ids = [],
  title,
  body,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "reclaim",
      reason: "work-done-despite-dead-bg",
      payloadExtras: {
        death_signal,
        prev_state_json_mtime,
        probe_passed,
        probe_checked,
        completion_origin,
        reclaimed_bg_job_id,
        stopped_bg_job_ids,
        title,
        body,
      },
    }),
    "reclaim",
  );
}

// CTL-664: post the reclaim Linear mirror the skill End block would have posted
// had the worker survived. Marker-guarded by the SHARED .linear-mirror-<phase>
// (first-writer-wins: if the skill already mirrored, the marker exists and we
// skip — exactly the desired idempotency). Fail-open: a linearis failure logs
// and returns without throwing, never breaking the reclaim. Seams injected for
// recovery.test.mjs (no filesystem/network I/O).
export function defaultPostReclaimMirror(
  { orchDir, ticket, phase, deathSignal, probeChecked, reclaimedBgJobId },
  {
    existsSync: exists = existsSync,
    writeMarker = (p) => writeFileSync(p, ""),
    runLinearis = (t, bodyText) =>
      spawnSync("linearis", ["issues", "discuss", t, "--body", bodyText], { encoding: "utf8" }),
  } = {},
) {
  const marker = `${orchDir}/workers/${ticket}/.linear-mirror-${phase}`;
  if (exists(marker)) return; // first-writer-wins
  const bodyText = [
    "**Phase Reclaim**",
    "",
    `- **Phase**: ${phase}`,
    `- **Reason**: work-done-despite-dead-bg`,
    `- **Death signal**: ${deathSignal}`,
    `- **Probe verified**: ${probeChecked}`,
    `- **Reclaimed bg_job_id**: \`${reclaimedBgJobId ?? "unknown"}\``,
    "",
    "_Posted automatically by the daemon reclaim sweep (CTL-664)._",
  ].join("\n");
  try {
    const r = runLinearis(ticket, bodyText);
    if (r && r.status === 0) {
      writeMarker(marker);
    } else {
      log.warn({ ticket, phase }, "reclaim-mirror: linearis discuss failed (continuing)");
    }
  } catch (err) {
    log.warn({ ticket, phase, err: err?.message }, "reclaim-mirror: post threw (continuing)");
  }
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

// defaultAppendYieldFileSkipEvent — phase.scheduler.yield-file-skip.<ticket>.
// CTL-702: emitted once per observed yield tombstone per daemon lifetime so
// yield rate is queryable from the event log. `phase` is "scheduler" — the
// yielded phase lives inside body.payload.filename. See
// website/src/content/docs/observability/event-flow.md#yield-tombstones.
export function defaultAppendYieldFileSkipEvent({ ticket, orchId, filename }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "scheduler",
      ticket,
      orchId,
      action: "yield-file-skip",
      reason: "yield_tombstone_filtered",
      payloadExtras: { filename },
    }),
    "yield-file-skip",
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

// CTL-611: dispatch-failed audit event. Fires whenever the scheduler observes
// a dispatch attempt that did not produce a live successor worker (Gap 1
// silent demotion: rc=0 but no bg_job_id signal; Gap 2: rc!=0). Routes via
// the broker's PHASE_EVENT_PATTERN as phase.dispatch.failed.<TICKET> (phase
// slot is the literal "dispatch", action slot is "failed"); the actual phase
// being dispatched is carried in payload.target_phase so operators can filter.
// Best-effort like every other audit emitter — return value lets the caller
// log (no current caller gates on it; matches recordDispatchFailure shape).
export function defaultAppendDispatchFailedEvent({
  orchId,
  ticket,
  target_phase,
  code,
  reason,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "dispatch",
      ticket,
      orchId,
      action: "failed",
      reason,
      payloadExtras: { target_phase, code },
    }),
    "dispatch-failed",
  );
}

// CTL-660: success-path dispatch lifecycle events — the complement to
// defaultAppendDispatchFailedEvent. The daemon already emits on the dispatch
// FAILURE path (above) and on phase COMPLETION, but nothing when it DECIDES to
// dispatch a phase or when the `claude --bg` worker LAUNCHES, so the
// "daemon-saw-Ready → worker-launched" latency is not derivable from the
// unified event log. These two emitters close that gap. Like every audit
// emitter they are best-effort (no caller gates on the return); the phase slot
// is the literal "dispatch" and the real phase rides in payload.target_phase,
// matching the dispatch.failed shape. They are deliberately NOT in the broker's
// PHASE_EVENT_PATTERN (complete|failed|turn-cap-exhausted|skipped) — the HUD
// reads the unified log directly, so no broker routing is required.

// defaultAppendDispatchRequestedEvent — phase.dispatch.requested.<TICKET>.
// Emitted when the scheduler/recovery DECIDES to dispatch a phase, before the
// `claude --bg` spawn. reason ∈ {new-work, advance, revive}.
export function defaultAppendDispatchRequestedEvent({ orchId, ticket, target_phase, reason }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "dispatch",
      ticket,
      orchId,
      action: "requested",
      reason,
      payloadExtras: { target_phase },
    }),
    "dispatch-requested",
  );
}

// defaultAppendDispatchLaunchedEvent — phase.dispatch.launched.<TICKET>.
// Emitted after `claude --bg` returns and the signal is verified, carrying the
// bg-job shortId (the de-facto session discriminator) + worktree path so the
// launched↔complete wall-clock can be computed downstream.
export function defaultAppendDispatchLaunchedEvent({
  orchId,
  ticket,
  target_phase,
  bg_job_id,
  worktree_path,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "dispatch",
      ticket,
      orchId,
      action: "launched",
      payloadExtras: { target_phase, bg_job_id, worktree_path },
    }),
    "dispatch-launched",
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
export function defaultReviveDispatch(
  { orchDir, ticket, phase, resumeSession },
  {
    dispatch = defaultDispatch,
    // CTL-660: success-path lifecycle emitters, injectable for tests. Default
    // to the real best-effort helpers so production emits requested→launched
    // on the revive path too (the failed path was already covered by CTL-611).
    appendRequested = defaultAppendDispatchRequestedEvent,
    appendLaunched = defaultAppendDispatchLaunchedEvent,
  } = {},
) {
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
  // CTL-660: orchId for the lifecycle emits, read from the same parse. Falls
  // back to undefined → buildEventEnvelope defaults it to the ticket.
  let orchId;
  try {
    const sig = JSON.parse(readFileSync(signalPath, "utf8"));
    if (typeof sig.worktreePath === "string" && sig.worktreePath.length > 0) {
      expectedWorktreePath = sig.worktreePath;
    }
    if (typeof sig.orchestrator === "string" && sig.orchestrator.length > 0) {
      orchId = sig.orchestrator;
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
  // CTL-658: forward the resolved resume UUID so defaultDispatch → runPhaseAgent
  // spawns `claude --bg --resume <uuid>`. Only present on the resume path; a
  // cold/unresumable revive omits it and falls through to a fresh dispatch.
  if (resumeSession) dispatchArgs.resumeSession = resumeSession;
  // CTL-660: record the revive DECISION before the spawn (reason="revive"),
  // then the verified launch after a clean dispatch. Both best-effort — the
  // default emitters swallow IO errors (appendEnvelopeBestEffort); the revive
  // proceeds regardless of either return value.
  appendRequested({ orchId, ticket, target_phase: phase, reason: "revive" });
  const res = dispatch(dispatchArgs);
  if (res && res.code === 0) {
    // Re-read the signal the dispatcher just rewrote (status dispatched/running
    // + bg_job_id + worktreePath) so launched carries the live worker's id.
    let sig2 = null;
    try {
      sig2 = JSON.parse(readFileSync(signalPath, "utf8"));
    } catch {
      sig2 = null;
    }
    appendLaunched({
      orchId,
      ticket,
      target_phase: phase,
      bg_job_id: sig2?.bg_job_id,
      worktree_path: sig2?.worktreePath,
    });
  }
  return res;
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

// defaultKillBgJob — terminate a dead/abandoned bg worker (CTL-657). Pre-CTL-657
// this SIGKILL'd a pid read from ~/.claude/jobs/<id>/pid — a guaranteed no-op on
// Claude Code 2.1.152 (no per-job pid file, so `existsSync(pidPath)` was always
// false). Now it issues `claude stop <shortId>`, the primitive that actually
// deregisters the session and frees its RAM. Best-effort; never throws. A
// malformed id is a no-op (and never shells out — keeps the "bg-9" revive
// fixtures deterministic). `stop` is injectable for tests; the production
// default calls the real `claude stop`.
export function defaultKillBgJob({ bgJobId }, { stop = claudeStop } = {}) {
  if (!bgJobId) return;
  let shortId;
  try {
    shortId = shortIdFromSessionId(bgJobId);
  } catch {
    return;
  }
  const res = stop(shortId);
  if (res?.ok) {
    log.info({ bgJobId, shortId }, "revive: claude stop issued for dead bg worker");
  } else {
    log.warn({ bgJobId, shortId, err: res?.error }, "revive: claude stop failed");
  }
}

// CTL-662 removed defaultPidAlive (the CTL-610/657 positive keep-alive seam).
// Its sole consumer was the alive-quiet gate's `pidAlive` injection, which is
// gone: reclaim eligibility no longer asks "is the bg pid alive?" (a binary
// presence check) but "what is the worker's `claude agents` status?" (the
// three-valued busy|idle|absent reader livenessForBgJob). Presence is now
// subsumed by `absent` (not listed → dead), so a separate pidAlive helper is
// redundant.

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

// readExecCoreBootEpoch — daemon-boot.json's bootedAt as epoch-ms, or 0 if
// missing/malformed. CTL-701: the third cold-start epoch source. Unlike
// readDaemonEpoch (claude-daemon socket dir mtime, fragile across socket
// refreshes), this is THIS exec-core instance's own start time — written
// atomically by writeBootMarker at startDaemon line 1, before detectColdStart
// runs. Any --bg worker whose state.json mtime predates it is provably dead.
export function readExecCoreBootEpoch(orchDir, { read = (p) => readFileSync(p, "utf8") } = {}) {
  if (!orchDir) return 0;
  try {
    const raw = read(bootMarkerPath(orchDir));
    const bootedAt = JSON.parse(raw)?.bootedAt;
    if (typeof bootedAt !== "string" || !bootedAt) return 0;
    const ms = Date.parse(bootedAt);
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return 0;
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
//
// Three epochs feed the cold-start verdict: (1) OS boot, (2) claude-daemon
// socket dir, (3) exec-core daemon-boot.json. The latest wins. Adding the
// exec-core epoch (CTL-701) catches manual daemon restarts where the socket
// dir mtime was refreshed between the OS boot and the new daemon launch.
export function detectColdStart({
  jobsRoot = getJobsRoot(),
  readDir = readdirSync,
  statJob = defaultStatJob,
  readEpoch = defaultReadRuntimeEpoch,
  orchDir = undefined,                       // CTL-701: enables exec-core epoch
  readExecCoreEpoch = readExecCoreBootEpoch, // CTL-701: injectable seam
} = {}) {
  const { epoch: runtimeEpoch, epochSource: runtimeSource } = readEpoch();
  const execCoreEpoch = readExecCoreEpoch(orchDir);

  let epoch = runtimeEpoch;
  let epochSource = runtimeSource;
  if (execCoreEpoch > epoch) {
    epoch = execCoreEpoch;
    epochSource = "exec-core";
  }

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

// CTL-662 — the reclaim death-trigger is now the worker's `claude agents`
// status (busy/idle/absent via livenessForBgJob), NOT state.json mtime. The
// three pre-CTL-662 time triggers (the 5-min mtime-staleness death flag, the
// CTL-587 defensive-kill quiet-window gate, and the CTL-610 keep-alive ceiling)
// are all gone: an in-process sub-agent fan-out keeps the parent's turn `busy`
// while state.json mtime goes stale, so mtime is a false death signal (the
// proven worker-10d6f123 failure). Reclaim eligibility is driven by status + an
// idle-confirmation streak (IDLE_CONFIRM_TICKS) and bounded only by the high
// BUSY_CEILING_MS no-progress human-flag backstop — both env-overridable
// tunables imported from config.mjs.

// CTL-587 — auto-revival constants. MAX_REVIVES is the per-ticket budget
// (counted from events.jsonl). STORM_WINDOW_MS + STORM_THRESHOLD form the
// breaker that suppresses revives when too many tickets are reviving at once
// (a Linear-side or fleet-wide outage).
const MAX_REVIVES = 2;
const STORM_WINDOW_MS = 10 * 60 * 1000;
const STORM_THRESHOLD = 3;

// CTL-662 — idle-confirmation streak markers. The consecutive-idle-observation
// counter is persisted as a per-(ticket, phase) worker-dir marker
// (`.idle-streak-<phase>`), the same durable-state mechanism as the CTL-587
// .revive-N.applied markers and the CTL-638 escalation cool-downs — a PERSISTED
// counter, NOT an mtime window (the invariant the plan requires). A re-dispatch
// recreates the worker dir, so the streak naturally resets on revive.
function idleStreakMarkerPath(orchDir, ticket, phase) {
  return join(orchDir, "workers", ticket, `.idle-streak-${phase}`);
}
function defaultReadIdleStreak(orchDir, ticket, phase) {
  try {
    const n = parseInt(readFileSync(idleStreakMarkerPath(orchDir, ticket, phase), "utf8"), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0; // marker absent → no prior idle observation
  }
}
// defaultBumpIdleStreak — increment + persist the counter, returning the NEW
// count. Fail-open: a write failure returns the would-be count so a transient
// fs error never wedges the streak (worst case: one extra idle tick before
// reclaim, harmless).
function defaultBumpIdleStreak(orchDir, ticket, phase) {
  const next = defaultReadIdleStreak(orchDir, ticket, phase) + 1;
  try {
    writeFileSync(idleStreakMarkerPath(orchDir, ticket, phase), String(next));
  } catch (err) {
    log.warn({ ticket, phase, err: err.message }, "ctl-662: idle-streak write failed");
  }
  return next;
}
function defaultResetIdleStreak(orchDir, ticket, phase) {
  try {
    const path = idleStreakMarkerPath(orchDir, ticket, phase);
    if (existsSync(path)) rmSync(path);
  } catch {
    /* best-effort — a stale streak marker only delays the next reclaim by ticks */
  }
}

// reclaimDeadWorkIfPossible — one signal in, one decision out. CTL-662 swaps the
// death TRIGGER from state.json mtime (the false signal: an in-process sub-agent
// fan-out keeps the parent's turn busy while mtime goes stale) to the worker's
// `claude agents` status via livenessForBgJob → busy|idle|absent. Every
// CTL-587/606/610/661 behavioral guarantee on the reclaim-eligible path below is
// preserved; only what makes a worker reclaim-eligible changes. The return set:
//
//   'noop'                classifyWorker says terminal (phase finished) or
//                         unknown (no bg_job_id). No action.
//   'alive-busy-suppressed' worker is `busy` (a live session with an open turn —
//                         including the in-process sub-agent fan-out that keeps
//                         the parent busy while state.json mtime goes stale: the
//                         CTL-662 false-reclaim fix). NEVER auto-reclaimed at any
//                         elapsed time. Resets the idle streak. The sole permitted
//                         action is the BUSY_CEILING_MS no-progress backstop.
//   'idle-pending'        worker is `idle` (live, between turns) but has not yet
//                         reached idleConfirmTicks consecutive idle observations.
//                         Streak incremented + persisted; no reclaim this tick.
//   'reclaimed'           reclaim-eligible (absent, or idle-confirmed) + work IS
//                         done. Canonical reclaim audit appended, emit-complete
//                         flipped the signal, session ended.
//   'reclaim-failed'      reclaim-eligible + work IS done BUT emit-complete exited
//                         non-zero. Signal NOT mutated (atomic rename); retries.
//   'revived'             reclaim-eligible + probe says work NOT done + revive
//                         budget available + storm-breaker closed. Signal reset to
//                         'stalled', defaultDispatch invoked, .revive-N.applied
//                         marker written. CTL-604: every probed phase shares this.
//   'revive-suppressed'   reclaim-eligible + work NOT done + storm-breaker OPEN
//                         (>3 distinct tickets reviving in last 10min). No
//                         dispatch; suppress event audited; next tick re-evaluates.
//   'escalated'           reclaim-eligible + (revive budget exhausted OR no
//                         work-done probe for this phase: verify/review/pr/
//                         monitor-*) OR a `busy` worker past BUSY_CEILING_MS with
//                         no committed work. needs-human label applied (CTL-587
//                         verified applyLabel); ticket stays put for human triage.
//   'superseded-noop'     reclaim-eligible BUT the signal's phase precedes the
//                         ticket's latest-dispatched phase (CTL-606). A stale
//                         predecessor left at `running`; acting would spuriously
//                         flag needs-human or spawn a duplicate at a past phase.
//                         A reap-intent is emitted so the reaper stops the bg.
//
// CTL-662: a worker is reclaim-eligible iff livenessForBgJob is `absent` (not a
// live `claude agents` session) OR `idle` for idleConfirmTicks consecutive
// observations. state.json mtime is no longer a decision input on ANY branch.
//
// The function stays pure given its injected seams: statJob / probes /
// emitComplete / appendEvent (pre-CTL-587) plus the CTL-587 seams
// (appendReviveEvent, appendEscalatedEvent, appendReviveSuppressedEvent,
// reviveDispatch, applyStalledLabel, killBgJob, countReviveEvents,
// countDistinctRevivingTickets, writeReviveMarker) plus the CTL-662 liveness +
// idle-streak seams. All have real defaults for prod; tests override every one.
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
    // CTL-662 — three-valued liveness reader (replaces the pre-CTL-662 mtime
    // staleness check + the CTL-610 keep-alive pair). "busy" → never
    // auto-reclaim; "idle" → reclaim-eligible only after an
    // idle-confirmation streak; "absent" (not a live `claude agents` session) →
    // reclaim-eligible immediately.
    liveness = livenessForBgJob,
    // CTL-662 — idle-confirmation streak seams. The consecutive-idle counter is
    // a per-(ticket, phase) worker-dir marker, NOT an mtime window.
    bumpIdleStreak = defaultBumpIdleStreak,
    resetIdleStreak = defaultResetIdleStreak,
    idleConfirmTicks = IDLE_CONFIRM_TICKS,
    // CTL-662 — busy-forever backstop ceiling (measured from signal.startedAt).
    // The SOLE long backstop now that the mtime triggers are gone: a busy worker
    // past it with no committed work is flagged for human, never silent-reclaimed.
    busyCeilingMs = BUSY_CEILING_MS,
    // CTL-658 — resume-session resolver. Maps the dead worker's bg_job_id to a
    // `claude --resume`-compatible UUID (or null) so the revive can continue the
    // dead session instead of re-walking from phase 0. Default reads the real
    // ~/.claude/jobs/<bg>/state.json; tests inject a stub. A null result (no
    // bg_job_id, no state.json, no .jsonl linkScanPath) preserves the pre-CTL-658
    // fresh-dispatch behaviour exactly.
    resolveSession = resolvePhaseSessionId,
    // CTL-661 — reap-intent emitter seam. Defaults to the module producer; the
    // supersede guard, the branch-(B) reclaim reap, and the branch-(C) revive
    // reap all route through this so a test can inject a spy. Aliased default
    // (emitReapIntentDefault) keeps the production wiring identical.
    emitReapIntent = emitReapIntentDefault,
    // CTL-664 — reclaim Linear mirror seam. Called on the successful reclaim
    // path (branch (B), after emitComplete returns code 0) to post the
    // "Phase Reclaim" comment the dead worker's skill End block never ran.
    // Marker-guarded + fail-open; tests inject a spy to assert call order.
    postReclaimMirror = defaultPostReclaimMirror,
    // CTL-679 — the process-wide Linear rate-limit breaker. escalateOnce defers
    // the needs-human apply while the breaker is open so a transient 429 is
    // never treated as a human-intervention condition (and never adds to the
    // write storm). Injected for tests; defaults to the shared singleton.
    breaker = linearBreaker,
    now = Date.now,
  } = {},
) {
  const klass = classifyWorker(signal, { statJob });
  // CTL-662: terminal (phase finished) and unknown (no bg_job_id) still
  // short-circuit — boot-classification gating is unchanged. Everything else
  // (running, OR dead-by-missing-job-dir) is routed through the status trigger
  // below; the job dir's existence/mtime is no longer the death signal.
  if (klass === "terminal" || klass === "unknown") return "noop";

  const { ticket, phase } = signal;
  const orchId = signal.raw?.orchestrator;
  const prevBgJobId = signal.raw?.bg_job_id ?? null;

  // CTL-587: capture the bg state.json mtime for the revive AUDIT payload only.
  // CTL-662 removed it from every DECISION branch — it is telemetry, not a
  // trigger. Best-effort: a missing job dir (real crash) just leaves it null.
  let prevStateJsonMtime = null;
  if (signal?.liveness?.value) {
    const job = statJob(signal.liveness.value);
    if (job && typeof job.mtimeMs === "number") prevStateJsonMtime = job.mtimeMs;
  }

  // CTL-638 — escalation helper (unchanged): wraps appendEscalatedEvent +
  // applyStalledLabel in a per-(ticket, phase) cool-down so the same escalation
  // cannot re-fire within the window (the pre-CTL-638 self-feeding storm).
  function escalateOnce(reason, finalAttemptCount) {
    // CTL-679 — while the Linear breaker is open we are rate-limited; the
    // needs-human apply would 429 and write no marker, re-firing every tick.
    // Defer: skip the audit event + label write entirely (no cool-down record,
    // so a genuine escalation re-fires cleanly once the breaker closes). A
    // transient 429 is not a human-intervention condition.
    if (breaker.isOpen(now())) {
      log.warn(
        { ticket, phase, reason },
        "ctl-679: escalation deferred — Linear breaker open"
      );
      return "rate-limited-deferred";
    }
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

  // CTL-662 — THE DEATH TRIGGER. The worker's `claude agents` status, not its
  // state.json mtime. busy → alive (never auto-reclaim); idle → reclaim-eligible
  // after a confirmation streak; absent → reclaim-eligible immediately.
  const live = liveness(prevBgJobId);

  // ── busy: NEVER auto-reclaimed at any elapsed time. This is the CTL-662 fix:
  //    a phase worker's in-process Task sub-agent fan-out keeps the parent turn
  //    `busy` while state.json mtime goes stale, so the pre-CTL-662 mtime trigger
  //    false-reclaimed it (the proven worker-10d6f123 failure). The only action
  //    permitted on a busy worker is the high-ceiling no-progress backstop: a
  //    worker busy past BUSY_CEILING_MS whose work-done probe is STILL false is
  //    flagged for human (escalateOnce) — never a silent reclaim-and-advance. A
  //    busy worker that has already committed work is left to emit its own
  //    authoritative complete. A single busy observation resets any in-progress
  //    idle-confirmation streak.
  if (live === "busy") {
    resetIdleStreak(orchDir, ticket, phase);
    const startedAtMs = Date.parse(signal.raw?.startedAt ?? "");
    if (Number.isFinite(startedAtMs) && now() - startedAtMs > busyCeilingMs) {
      const workDone = hasProbe(phase) && probes[phase]({ ticket, repoRoot, orchDir });
      if (!workDone) {
        log.warn(
          { ticket, phase, prevBgJobId, busyForMs: now() - startedAtMs },
          "ctl-662: busy worker past BUSY_CEILING_MS with no committed work — escalating (never silent reclaim)",
        );
        return escalateOnce("busy-ceiling-exceeded", 0);
      }
    }
    log.info({ ticket, phase, prevBgJobId }, "ctl-662: busy worker — reclaim suppressed");
    return "alive-busy-suppressed";
  }

  // ── idle | absent share the reclaim-eligible path below.
  // CTL-606 — supersede guard. The reclaim sweep is fed ONE signal per ticket by
  // readWorkerSignals→byActivePhase, which ranks by status+recency, NOT phase
  // order. A stale predecessor left at `running` (never flipped to `done`) can
  // shadow the real, already-advanced phase. If the dead signal's phase precedes
  // the ticket's latest-dispatched phase, the ticket has moved on — escalating or
  // reviving it would spuriously flag needs-human or spawn a duplicate worker at
  // a past phase. Runs only once a worker is reclaim-eligible (not busy).
  // CTL-702: defensive — listTicketPhases is read off the filesystem; if a
  // future on-disk variant slips past signal-reader's filter (e.g. yield
  // tombstone, manual operator file), isKnownPhase skips it instead of
  // throwing. See website/src/content/docs/observability/event-flow.md#yield-tombstones.
  const dispatched = listTicketPhases(ticket);
  const latestIdx = dispatched.reduce((max, p) => {
    if (!isKnownPhase(p)) return max; // CTL-702: defensive — skip unknown names
    const i = phaseIndex(p);
    return i > max ? i : max;
  }, -1);
  if (phaseIndex(phase) < latestIdx) {
    // CTL-649: emit a reap-intent so the daemon reaper can stop the lingering
    // bg worker. Fire-and-forget — the periodic orphan reaper picks up anything
    // the reconciler missed.
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

  // ── idle requires an idle-confirmation streak before it is reclaim-eligible: a
  //    couple of CONSECUTIVE idle observations confirm the worker is genuinely
  //    between-turns done, not momentarily idle between sub-agent fan-out rounds.
  //    `absent` skips this — absence is unambiguous. The streak is a persisted
  //    per-(ticket, phase) counter (NOT an mtime window). Once we proceed to act
  //    (reclaim/revive below), the streak is cleared.
  if (live === "idle") {
    const streak = bumpIdleStreak(orchDir, ticket, phase);
    if (streak < idleConfirmTicks) {
      log.info(
        { ticket, phase, streak, idleConfirmTicks },
        "ctl-662: idle worker pending confirmation — not yet reclaim-eligible",
      );
      return "idle-pending";
    }
  }
  resetIdleStreak(orchDir, ticket, phase);

  // (A) No probe registered for this phase → escalate. The pre-CTL-587 silent
  //     'not-applicable' return is now an actionable outcome: the worker is
  //     dead, we cannot prove its work landed, and no automation can recover
  //     — so the human needs to look. needs-human label applied (verified by
  //     the CTL-587 applyLabel read-back). CTL-638 routes through escalateOnce
  //     so the same (ticket, phase) cannot re-fire within the cool-down window.
  //     CTL-662: a `busy` worker on a probe-less phase no longer reaches here —
  //     the status trigger above suppresses it first, so this branch only
  //     escalates a genuinely reclaim-eligible (absent/idle-confirmed) worker.
  if (!hasProbe(phase)) {
    return escalateOnce("no-probe-for-phase", 0);
  }

  // (B) Probe says work IS done → CTL-574 reclaim. CTL-641 threads orchDir
  //     (already this function's first param) so worker-dir / worktree probes
  //     can locate their artifact; implementProbe ignores the extra key.
  const probe = probes[phase];
  if (probe({ ticket, repoRoot, orchDir })) {
    // CTL-661 hole #3: a worker reaching branch (B) is reclaim-eligible, so it
    // is either `absent` (nothing live to stop) or `idle`-confirmed (between
    // turns → safe to stop). Emit a fire-and-forget reap-intent BEFORE
    // emitComplete so the reaper stops any lingering session rather than letting
    // it keep running past its own reclaim. No-op when no bg_job_id was recorded
    // — mirrors the CTL-606 supersede-guard guard above.
    if (prevBgJobId) {
      emitReapIntent("phase.reclaim.reap-requested", {
        ticket,
        phase,
        bgJobId: prevBgJobId,
        worktreePath: signal.raw?.worktreePath,
        reason: "ctl-661-reclaim-happy-path",
      }).catch(() => {});
    }
    // CTL-664/CTL-662: derive the reclaim observability fields from values
    // already computed above. Post-CTL-662 this reclaim branch is reached ONLY
    // for an `absent` bg job or an idle-confirmed one — `busy` returns at
    // alive-busy-suppressed and an unconfirmed `idle` returns at idle-pending
    // above, and mtime is no longer a reclaim trigger. So the death signal
    // reflects the liveness verdict the trigger actually acted on, never the
    // obsolete "mtime". Kept as a single const so the mirror body reuses it.
    const death_signal = live === "absent" ? "absent" : "idle-confirmed";
    const probe_checked = describeProbe(phase);
    appendEvent({
      phase,
      ticket,
      orchId,
      death_signal,
      prev_state_json_mtime: prevStateJsonMtime,
      probe_passed: true,
      probe_checked,
      completion_origin: "inferred",
      reclaimed_bg_job_id: prevBgJobId,
      stopped_bg_job_ids: [], // CTL-661 will source the reconciled stopped set
      title: `phase ${phase} reclaimed (work-done-despite-dead-bg)`,
      body: `Daemon reclaimed dead ${phase} worker for ${ticket}: ${death_signal} death signal, probe verified ${probe_checked}. bg_job_id=${prevBgJobId ?? "?"}.`,
    });
    const r = emitComplete({ orchDir, signal });
    if (r.code !== 0) {
      log.warn(
        { ticket, phase, code: r.code, stderr: r.stderr },
        "reclaim-dead-work: emit-complete failed; will retry next tick",
      );
      return "reclaim-failed";
    }
    // CTL-664: mirror the reclaim to Linear (after emit-complete succeeds, so a
    // reclaim-failed never posts). Reuses the Phase 2 consts — no recomputation.
    postReclaimMirror({
      orchDir,
      ticket,
      phase,
      deathSignal: death_signal,
      probeChecked: probe_checked,
      reclaimedBgJobId: prevBgJobId,
    });
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

  // CTL-662: by the time control reaches branch (C) the worker is reclaim-
  // eligible — either `absent` (a real crash: no live `claude agents` session)
  // or `idle`-confirmed (live but idle for idleConfirmTicks consecutive ticks,
  // genuinely between-turns with no committed work). A `busy` worker can never
  // reach here (the busy branch above returns first), so the revive/re-dispatch
  // path below is correct for both reclaim-eligible cases.

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

  // CTL-658: resolve a `claude --resume`-compatible session id from the dead
  // worker's bg_job_id BEFORE the defensive kill. When a UUID resolves we are
  // CONTINUING this session, not retiring it — so we skip the kill + reap-intent
  // (stopping a session we're about to resume is the ordering hazard the plan
  // resolves) and thread the id into reviveDispatch so phase-agent-dispatch runs
  // `claude --bg --resume <uuid>` instead of a fresh phase-0 start. A null result
  // (no bg_job_id, no state.json, no .jsonl linkScanPath) is the unchanged path:
  // defensive kill + fresh dispatch. Resolving here (after the budget/storm gates
  // pass) means only an actually-reviving worker pays the one state.json read.
  const resumeSession = prevBgJobId ? resolveSession(prevBgJobId) : null;
  log.info(
    { ticket, phase, prevBgJobId, resumeSession },
    "ctl-658: revive resume id resolved",
  );

  // Defensive stop: the worker is reclaim-eligible (absent or idle-confirmed),
  // so we stop it to free RAM and release any worktree lock before re-dispatch.
  // CTL-657: killBgJob issues `claude stop <shortId>` (the pre-CTL-657 pid-file
  // SIGKILL was a guaranteed no-op on CC 2.1.152 — no per-job pid file); an
  // `absent` worker has no live session so the stop is a harmless no-op.
  //
  // CTL-649: also emit a reap-intent so the daemon reaper has authoritative
  // visibility and stops the same session via its own `claude stop`. The inline
  // stop stays so a standalone reconcile (no reaper consuming the log) cannot
  // regress to leaking the worker.
  //
  // CTL-658: gated on !resumeSession — when we're resuming we must NOT stop the
  // session (its linkScanPath jsonl must stay intact for `--resume`).
  // CTL-662: the pre-CTL-662 mtime quiet-window kill gate is gone — `idle`-
  // confirmation already proved the worker is not mid-turn, so stopping it is
  // safe without a separate quiet-window check.
  if (!resumeSession && prevBgJobId) {
    emitReapIntent("phase.revive.reap-requested", {
      ticket,
      phase,
      bgJobId: prevBgJobId,
      worktreePath: signal.raw?.worktreePath,
      prevStateJsonMtime,
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
  const dispatchRes = reviveDispatch({ orchDir, ticket, phase, resumeSession });
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
  //     boot-time stale-wait. Pass statJob so a test-redirected jobs root flows
  //     through both the worker reconstruction and the cold-start scan.
  // CTL-701: forward orchDir so detectColdStart can read daemon-boot.json as
  // the third cold-start epoch (exec-core restart without OS/daemon socket reboot).
  const coldStart = detectCold({ statJob, orchDir });

  return {
    recoveredAt: new Date().toISOString(),
    routing: { projects, projectCount: projects.length },
    cursor: { logPath, byteOffset: startOffset, resumed: startOffset !== fileSize },
    workers,
    coldStart,
  };
}
