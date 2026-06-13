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
import { hostName, hostId } from "./lib/host-identity.mjs";
import {
  getJobsRoot,
  getEventLogPath,
  getClusterHosts,
  getHostName,
  getLivenessAnchorIssue,
  log,
  BUSY_CEILING_MS,
  REVIVE_MAX_AGE_MS,
  GHOST_GRACE_MS,
  HEARTBEAT_GRACE_MS,
  ZOMBIE_STALE_FLOOR_MS,
  NEVER_STARTED_MS,
} from "./config.mjs";
import { readPeerHeartbeatsSync } from "./cluster-heartbeat-sync.mjs";
import { HEARTBEAT_EVENT } from "./heartbeat-event.mjs"; // CTL-859: node.heartbeat reader
import { resolveTicketType, UNKNOWN_TICKET_TYPE } from "./ticket-type.mjs"; // CTL-1023: work-type dimension
import { phaseIndex, isKnownPhase } from "../lib/phase-fsm.mjs";
import { readWorkerSignals, TERMINAL, listDispatchedPhases } from "./signal-reader.mjs";
import { reconcileAll } from "./monitor.mjs";
import { listProjects } from "./registry.mjs";
import { emitReapIntent as emitReapIntentDefault } from "./reap-intent.mjs";
import { claudeStop, getAgentsCached, agentForShortId, claudeLogs } from "./claude-agents.mjs";
import { shortIdFromSessionId } from "./claude-ids.mjs";
import { findTranscript, defaultProjectsDir } from "./session-recency.mjs";
import { loadCursor, resolveStartOffset } from "./event-cursor.mjs";
import {
  WORK_DONE_PROBES,
  hasProbe,
  describeProbe,
  defaultProgressMark,
} from "./work-done-probes.mjs";
import { STAGE_RANK, NEW_WORK_ENTRY_PHASE } from "../lib/workflow-descriptor.mjs";
import { ownerForTicket } from "./hrw.mjs";
import { claimDispatchSync } from "./cluster-claim-sync.mjs";
import { dispatchTicket, defaultDispatch } from "./dispatch.mjs";
import { createWorktree } from "./worktree.mjs";
import { fenceGuard } from "./fence-guard.mjs";
import { applyLabel as defaultApplyLabel } from "./linear-write.mjs";
import { linearBreaker } from "./linear-breaker.mjs";
// CTL-642: the SHARED terminal-state predicate. The recovery short-circuit reuses
// the scheduler's fetchTicketState + cache (threaded via reclaimOpts) so a
// terminal/merged ticket adds ≤1 cached read; it is INERT when no reader is
// threaded (the default for every legacy unit test).
import { isTicketTerminalOrMerged } from "./terminal-state.mjs";
// CTL-638: pull the once-marker + per-(ticket, phase) cool-down primitives
// from the shared leaf module. labelOnce is the same guard CTL-585 introduced
// for scheduler.mjs's `needs-human` path — pre-CTL-638 the recovery sweep's
// escalation call bypassed it entirely.
import {
  labelOnce,
  inEscalationCooldown as defaultInEscalationCooldown,
  recordEscalation as defaultRecordEscalation,
} from "./label-guard.mjs";
import { countReviveEvents as defaultCountReviveEvents, hasCompleteEvent } from "./event-scan.mjs";

// phase-agent-emit-complete sits two directories up from execution-core/.
const EMIT_COMPLETE_BIN = fileURLToPath(
  new URL("../phase-agent-emit-complete", import.meta.url),
);

// resolvePhaseSessionId — extracted to session-resolve.mjs (CTL-729) so
// transcript-silence.mjs can import it without pulling in recovery.mjs's
// heavy dependency graph. Imported for local use + re-exported for callers.
import { resolvePhaseSessionId } from "./session-resolve.mjs";
export { resolvePhaseSessionId };
import { coerceExplanation } from "./escalation-explanation.mjs";

// defaultStatJob — stat ~/.claude/jobs/<bgJobId>/state.json. Returns null when
// the job dir is gone (the worker's process no longer exists), else its mtime,
// parsed .state, and .firstTerminalAt. Injectable so tests never touch real
// Claude job state.
//
// CTL-736 Phase 2: firstTerminalAt is the state-name-agnostic death signal —
// Claude stamps it the moment a job reaches a terminal lifecycle state, so
// jobLifecycle can declare death even when the .state string is one we don't
// enumerate. Null for a live/non-terminal job (and when state.json is unreadable).
//
// CTL-932: also parse tempo / detail / needs — the CC supervisor's self-report.
// On 2026-06-09 every wedged-never-started worker's state.json read
// state:"working" (alive forever) while tempo:"blocked" + detail:"stuck on a
// startup dialog" + needs:"open this session to continue setup" sat UNREAD in
// the same file all day. They are observability fields (logged by the reclaim
// sweep), deliberately NOT a death trigger — the turn-zero gate keys on the
// transcript + fresh agents-snapshot state instead.
export function defaultStatJob(bgJobId) {
  const file = join(getJobsRoot(), bgJobId, "state.json");
  let st;
  try {
    st = statSync(file);
  } catch {
    return null; // job dir missing → worker is gone
  }
  let state = null;
  let firstTerminalAt = null;
  let tempo = null;
  let detail = null;
  let needs = null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    state = parsed?.state ?? null;
    firstTerminalAt = parsed?.firstTerminalAt ?? null;
    tempo = parsed?.tempo ?? null;
    detail = parsed?.detail ?? null;
    needs = parsed?.needs ?? null;
  } catch {
    /* state.json unreadable — liveness still proven by the dir existing */
  }
  return { exists: true, mtimeMs: st.mtimeMs, state, firstTerminalAt, tempo, detail, needs };
}

// CTL-736 Phase 2 — the authoritative job-lifecycle terminal states. These are
// the `state` values Claude writes into ~/.claude/jobs/<id>/state.json when a
// `claude --bg` job reaches a terminal lifecycle (empirically: stopped/failed/
// done/blocked; `working` is the sole non-terminal value). DISTINCT from the
// worker-SIGNAL `TERMINAL` set imported from signal-reader.mjs (phase signal
// status like done/skipped) — do not conflate the two.
export const TERMINAL_JOB_STATES = new Set(["stopped", "failed", "done", "blocked"]);

// CTL-927 — doc/long-fan-out phases whose forward-progress is an artifact-byte
// progressMark (research/plan/triage/verify/review — see work-done-probes.mjs). Their
// `claude --bg` state.json legitimately goes untouched for many minutes during an
// in-process sub-agent fan-out, so the CTL-868 cold-snapshot mtime zombie-floor (2h)
// would false-kill a LIVE worker on a host where `claude agents --json` is unreliable
// (CTL-829, the headless mini) — the proximate trigger of a fleet-wide no-progress
// storm. These phases use BUSY_CEILING_MS (6h) for the cold-snapshot mtime guess; by
// then the busy-ceiling escalation (escalateOnce "busy-ceiling-exceeded" → needs-human)
// already bounds a genuinely-stuck doc worker — escalate, never silent kill.
// implement/remediate are NOT exempt: their commits/state.json churn make a 2h-stale
// state.json a true corpse. Keep this set in sync with the artifact-byte progressMark
// phases in work-done-probes.mjs.
export const MTIME_ZOMBIE_EXEMPT_PHASES = new Set([
  "research",
  "plan",
  "triage",
  "verify",
  "review",
]);

// jobLifecycle — CTL-736 Phase 2's deterministic, LOCAL death verdict from a
// `claude --bg` job's state.json, replacing the eventually-consistent `claude
// agents` snapshot (livenessForBgJob) in the reclaim death trigger:
//   'dead-gone'     — the job dir is gone (statJob null): the worker is gone.
//   'dead-terminal' — firstTerminalAt is set OR .state ∈ TERMINAL_JOB_STATES:
//                     Claude marked the job terminal. Definitive — no grace
//                     window or idle-confirmation streak needed.
//   'alive'         — any other readable state (notably 'working', or an
//                     unreadable state.json whose dir still exists). mtime is
//                     NOT consulted: a multi-minute in-process sub-agent fan-out
//                     keeps .state non-terminal while mtime ages, and the
//                     pre-CTL-662 mtime trigger false-reclaimed exactly that
//                     (the worker-10d6f123 failure). Pure given statJob.
export function jobLifecycle(bgJobId, { statJob = defaultStatJob } = {}) {
  const job = statJob(bgJobId);
  if (!job) return "dead-gone";
  if (job.firstTerminalAt || TERMINAL_JOB_STATES.has(job.state)) return "dead-terminal";
  return "alive";
}

// classifyWorker — PURE given statJob. One WorkerSignal (from readWorkerSignals)
// → a liveness class:
//   'terminal' — signal status is terminal; the phase finished, nothing to attach
//   'running'  — non-terminal signal + the bg job is alive (state.json non-terminal)
//   'dead'     — non-terminal signal + the bg job is terminal OR its dir is gone
//   'unknown'  — no bg_job_id (legacy pid signal, or an orphan `dispatched`
//                signal written before claude --bg was spawned)
//
// CTL-736 Phase 2: consults the job LIFECYCLE (jobLifecycle → state.json), not
// mere job-dir existence. A never-cleaned-up dir whose .state is terminal
// (stopped/failed/done/blocked) now classifies 'dead' instead of 'running' —
// the discard the plan called out (16,462 retained job dirs, 0 pid files).
export function classifyWorker(signal, { statJob = defaultStatJob } = {}) {
  if (TERMINAL.has(signal?.status)) return "terminal";
  const live = signal?.liveness;
  if (live?.kind !== "bg" || !live?.value) return "unknown";
  return jobLifecycle(live.value, { statJob }) === "alive" ? "running" : "dead";
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
//
// CTL-1023: every event carries `catalyst.ticket.type` (work-type dimension).
// `ticketType` is resolved by the caller from triage.json (resolveTicketType);
// when omitted it defaults to UNKNOWN_TICKET_TYPE so the attribute is ALWAYS
// present, never inconsistently missing (the gherkin contract).
function buildEventEnvelope({ phase, ticket, orchId, action, reason, payloadExtras = {}, severityText = "WARN", severityNumber = 13, ticketType = UNKNOWN_TICKET_TYPE }) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText,
      severityNumber,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: {
        "service.name": "catalyst.execution-core",
        "service.namespace": "catalyst",
        "host.name": hostName(),
        "host.id": hostId(),
      },
      attributes: {
        "event.name": `phase.${phase}.${action}.${ticket}`,
        "event.entity": "phase",
        "event.action": action,
        "event.label": ticket,
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
        "catalyst.ticket.type": ticketType ?? UNKNOWN_TICKET_TYPE,
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
  orchDir,
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
      ticketType: resolveTicketType(orchDir, ticket), // CTL-1023
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

// CTL-868 — defaultAppendOrphanDetectedEvent — phase.<phase>.orphan-detected.<ticket>.
// Route (B) of the orphan-reconcile sweep: a worker stranded `stalled` with no
// automatic recovery left (the reclaim sweep has already stopped it + applied
// needs-human). This canonical event is the OBSERVABILITY complement so the
// orch-monitor dashboard surfaces the orphan instead of it hiding behind a buried
// needs-human label. Best-effort (never gates the tick). Exported for the
// round-trip envelope test.
export function defaultAppendOrphanDetectedEvent({
  phase,
  ticket,
  orchId,
  reason = "stalled-no-recovery",
  stalled_phases = [],
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "orphan-detected",
      reason,
      payloadExtras: { stalled_phases },
    }),
    "orphan-detected",
  );
}

// ─── CTL-932: turn-zero gate primitives ─────────────────────────────────────
//
// A wedged-never-started worker registered with CC but never resolved its
// slash-command prompt ("Unknown command: /catalyst-dev:phase-*") — it idles
// forever at an empty input prompt holding a concurrency slot while every
// existing guard reads it "alive" (state.json state:"working"; LISTED in the
// agents snapshot, so the ghost breaker suppresses). The gate's evidence is
// the conjunction the 2026-06-09 incident proved: dispatch age past
// NEVER_STARTED_MS ∧ NO transcript file ∧ FRESH agents-snapshot state
// "blocked". See thoughts/shared/research/
// 2026-06-09-execution-core-fable-root-cause-and-architecture.md (A1/A2 +
// Appendix 2 "minimal turn-zero gate").

// How many stop+replace attempts the gate makes before declaring the
// environment broken (marketplace wedge, plugin-registration race) and
// escalating needs-human instead of looping. Replacement N+1 only happens if
// replacement N ALSO wedged, so 2 ineffective replacements = 3 wedged spawns.
export const NEVER_STARTED_ATTEMPT_CAP = 2;

// Captures stored in the durable attempt marker are truncated so the marker
// (and the final escalation payload aggregating all of them) stays bounded.
const NEVER_STARTED_CAPTURE_CAP = 2_000;

// neverStartedAttemptsPath — the durable per-(ticket, phase) attempt marker,
// living in the worker dir like the .revive-N / .progress-<phase> crumbs.
export function neverStartedAttemptsPath(orchDir, ticket, phase) {
  return join(orchDir, "workers", ticket, `.never-started-${phase}.json`);
}

// defaultReadNeverStartedAttempts — {count, captures[]}. Fail-open to zero
// attempts on a missing/corrupt marker (the conservative direction: the gate
// retries a replacement rather than falsely escalating).
export function defaultReadNeverStartedAttempts(orchDir, ticket, phase) {
  try {
    const parsed = JSON.parse(
      readFileSync(neverStartedAttemptsPath(orchDir, ticket, phase), "utf8"),
    );
    const count = Number.isInteger(parsed?.count) && parsed.count > 0 ? parsed.count : 0;
    const captures = Array.isArray(parsed?.captures)
      ? parsed.captures.filter((c) => typeof c === "string")
      : [];
    return { count, captures };
  } catch {
    return { count: 0, captures: [] };
  }
}

// defaultRecordNeverStartedAttempt — increment the durable count and retain the
// (truncated) screen capture so the final escalation can carry the captures
// from ALL attempts. Atomic tmp+rename; fail-open (a write failure costs one
// extra replacement attempt, never a throw out of the reclaim sweep).
export function defaultRecordNeverStartedAttempt(orchDir, ticket, phase, capture) {
  try {
    const prev = defaultReadNeverStartedAttempts(orchDir, ticket, phase);
    const p = neverStartedAttemptsPath(orchDir, ticket, phase);
    mkdirSync(dirname(p), { recursive: true });
    const next = {
      count: prev.count + 1,
      captures: [
        ...prev.captures,
        String(capture ?? "").slice(0, NEVER_STARTED_CAPTURE_CAP),
      ],
      updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, p);
  } catch (err) {
    log.warn({ ticket, phase, err: err.message }, "ctl-932: never-started attempt marker write failed");
  }
}

// defaultClearNeverStartedAttempts — unlink the durable per-(ticket, phase)
// attempt marker once a replacement worker SUCCEEDS (the phase reclaims as
// work-done, or a revive observes forward progress). Without this the count is
// sticky forever: a much-later legitimate re-dispatch of the same (ticket, phase)
// that wedges once on a transient blip would read the stale count>=cap and
// escalate needs-human with ZERO fresh replacement attempts — contradicting the
// gate's "retry a replacement rather than falsely escalate" intent. Idempotent
// (ENOENT is the common, expected case) and fail-open (a stuck marker only costs
// a too-early escalation on a future wedge, never a throw out of the sweep).
export function defaultClearNeverStartedAttempts(orchDir, ticket, phase, { rm = rmSync } = {}) {
  try {
    rm(neverStartedAttemptsPath(orchDir, ticket, phase), { force: true });
  } catch (err) {
    log.warn({ ticket, phase, err: err.message }, "ctl-932: never-started attempt marker clear failed");
  }
}

// defaultTranscriptExists — does the session's transcript JSONL exist? A
// healthy session creates it ~0.3s after its first turn (session-recency.mjs);
// absence minutes after dispatch means the prompt was never processed — the
// cleanest never-started detector (research Appendix 2).
export function defaultTranscriptExists(sessionId, { projectsDir = defaultProjectsDir() } = {}) {
  if (!sessionId) return false;
  return findTranscript(sessionId, projectsDir) !== null;
}

// defaultCaptureWedgeLogs — `claude logs <shortId>`: the rendered screen, the
// only surface that shows WHY the session idles (the "Unknown command" banner).
// Captured BEFORE the stop (stopping destroys the buffer) and embedded in the
// escalation event so the cause is visible without archaeology. Best-effort:
// "" on any failure.
export function defaultCaptureWedgeLogs(bgJobId, { logs = claudeLogs } = {}) {
  if (!bgJobId) return "";
  let shortId;
  try {
    shortId = shortIdFromSessionId(bgJobId);
  } catch {
    return "";
  }
  const res = logs(shortId);
  return res?.ok ? res.output : "";
}

// defaultAppendWedgedNeverStartedEvent —
// phase.<phase>.wedged-never-started.<TICKET>. The per-attempt escalation
// event: carries the captured screen (captured_logs), the attempt ordinal, and
// the state.json/agents-snapshot self-reports the diagnosis keyed on. Audit-
// only (not in the broker's PHASE_EVENT_PATTERN). Exported for the round-trip
// envelope test.
export function defaultAppendWedgedNeverStartedEvent({
  phase,
  ticket,
  orchId,
  attempt,
  bg_job_id = null,
  agents_state = null,
  tempo = null,
  detail = null,
  needs = null,
  captured_logs = "",
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "wedged-never-started",
      reason: "no-transcript-and-agents-blocked",
      payloadExtras: {
        attempt,
        bg_job_id,
        agents_state,
        tempo,
        detail,
        needs,
        captured_logs,
        title: `phase ${phase} worker wedged at turn zero (attempt ${attempt})`,
        body: `Worker for ${ticket} ${phase} registered but never started its first turn (no transcript; agents state=blocked). Stopped and replaced via the revive path. Captured screen:\n\n${captured_logs}`,
      },
    }),
    "wedged-never-started",
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
    runCommentPost = (t, bodyText) => {
      const helperPath = join(dirname(fileURLToPath(import.meta.url)), "../lib/linear-comment-post.sh");
      return spawnSync(helperPath, [t, bodyText], { encoding: "utf8" });
    },
    multiHost = false,
  } = {},
) {
  const marker = `${orchDir}/workers/${ticket}/.linear-mirror-${phase}`;
  if (exists(marker)) return; // first-writer-wins
  // CTL-863: zombie guard — a post-takeover paused host must not post a mirror comment.
  if (!fenceGuard({ ticket, orchDir, multiHost })) {
    log.warn({ ticket, phase }, "ctl-863: stale fence — suppressing postReclaimMirror comment (zombie guard)");
    return;
  }
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
    const r = runCommentPost(ticket, bodyText);
    if (r && r.status === 0) {
      writeMarker(marker);
    } else {
      // Surface the helper's own diagnostic (e.g. the CTL-835 token-mint HTTP
      // status / invalid_scope) instead of swallowing it, so a credential or
      // scope failure is no longer silent. Still fail-open (no throw).
      const detail = String(r?.stderr ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .pop();
      log.warn(
        { ticket, phase, status: r?.status, detail },
        "reclaim-mirror: linear-comment-post failed (continuing)",
      );
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

// defaultAppendBootResumeGatedEvent — phase.<phase>.boot-resume-gated.<ticket>.
// CTL-644: emitted once when an expensive phase is gated behind operator approval.
// Deliberately distinct from boot-resume so the broker ignores it (audit-only,
// like defaultAppendBootResumeEvent). Exported so boot-resume.mjs imports it as
// the default appendGatedEvent seam.
export function defaultAppendBootResumeGatedEvent({ phase, ticket, orchId }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "boot-resume-gated",
      reason: "cold-start-expensive-phase-awaiting-approval",
    }),
    "boot-resume-gated",
  );
}

// defaultAppendBootResumePhaseRegressionEvent —
// phase.<phase>.boot-resume-phase-regression.<ticket>. CTL-1006 Scenario 2:
// emitted when boot-resume would have re-dispatched an EARLIER phase whose ticket
// already has a LATER terminal phase signal (e.g. research=stalled while an older
// triage signal is still `running`). Audit-only — distinct action (broker-ignored,
// not in PHASE_EVENT_PATTERN) and NOT counted by countReviveEvents (event-scan
// matches only `phase.implement.revive.<ticket>`), so a regression never consumes
// the chronic-failure revive budget (the Scenario-4 invariant). Surfaces the
// regression for operator forensics INSTEAD of spawning a fresh earlier-phase
// worker. Exported so boot-resume.mjs imports it as the default appender seam and
// the round-trip test can confirm the envelope shape.
export function defaultAppendBootResumePhaseRegressionEvent({ phase, ticket, dominantPhase, orchId }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "boot-resume-phase-regression",
      reason: "later-terminal-phase-supersedes-resume-candidate",
      payloadExtras: { dominantPhase },
    }),
    "boot-resume-phase-regression",
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
  orchDir,
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
      ticketType: resolveTicketType(orchDir, ticket), // CTL-1023
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

// CTL-932: `extras` rides into the payload so an escalation can carry evidence
// (the wedged-never-started cap escalation embeds the screen captures from all
// attempts). Absent for every pre-existing caller — shape unchanged.
function defaultAppendEscalatedEvent({ phase, ticket, orchId, reason, final_attempt_count, extras = {} }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "escalated",
      reason,
      payloadExtras: { final_attempt_count, ...extras },
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
// CTL-1004/CTL-1056 Bug 2: stderr_tail / spawn_error / signal carry the captured
// dispatch-failure diagnostics (last ~500 chars of the worker's stderr, the
// spawn error code e.g. ETIMEDOUT, the kill signal e.g. SIGKILL) so the failure
// is diagnosable from the unified event log. Each is included in payloadExtras
// only when present (an empty/absent diagnostic produces no key — no noise).
export function defaultAppendDispatchFailedEvent({
  orchId,
  ticket,
  target_phase,
  code,
  reason,
  expiresAt,
  consecutiveFailures,
  stderr_tail,
  spawn_error,
  signal,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "dispatch",
      ticket,
      orchId,
      action: "failed",
      reason,
      payloadExtras: {
        target_phase,
        code,
        ...(expiresAt !== undefined && { expiresAt }),
        ...(consecutiveFailures !== undefined && { consecutiveFailures }),
        ...(stderr_tail !== undefined && stderr_tail !== "" && { stderr_tail }),
        ...(spawn_error !== undefined && spawn_error !== "" && { spawn_error }),
        ...(signal !== undefined && signal !== null && signal !== "" && { signal }),
      },
    }),
    "dispatch-failed",
  );
}

// CTL-671: runaway-loop alert event. Fires once-per-window from schedulerTick
// when a single ticket's per-ticket event rate dominates the unified log
// (>= SCHEDULER_RUNAWAY_THRESHOLD events in SCHEDULER_RUNAWAY_WINDOW_MS). This
// is OBSERVABILITY ONLY — it does not itself quarantine (the phantom sweep +
// circuit breaker handle enforcement); a real but noisy ticket gets surfaced,
// not killed. Routes via the broker's PHASE_EVENT_PATTERN as
// phase.dispatch.runaway.<TICKET> (phase slot "dispatch", action "runaway").
// Best-effort, mirroring every other audit emitter.
export function defaultAppendRunawayEvent({ ticket, orchId, count, window_ms }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "dispatch",
      ticket,
      orchId,
      action: "runaway",
      reason: "event-rate-domination",
      payloadExtras: { count, window_ms },
    }),
    "runaway",
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
export function defaultAppendDispatchRequestedEvent({ orchId, orchDir, ticket, target_phase, reason }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "dispatch",
      ticket,
      orchId,
      action: "requested",
      reason,
      payloadExtras: { target_phase },
      severityText: "INFO",
      severityNumber: 9,
      // CTL-1023: resolves to "unknown" pre-triage (no triage.json yet) — correct.
      ticketType: resolveTicketType(orchDir, ticket),
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
  orchDir,
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
      severityText: "INFO",
      severityNumber: 9,
      // CTL-1023: "unknown" until triage.json lands; full type post-triage.
      ticketType: resolveTicketType(orchDir, ticket),
    }),
    "dispatch-launched",
  );
}

// CTL-705: preemption and resume-after-preemption event emitters.

// defaultAppendPreemptedEvent — phase.<phase>.preempted.<TICKET>.
// Emitted when the scheduler stops a lower-priority in-flight worker to free a
// slot for a higher-priority queued ticket. The `phase` slot is the real phase
// being preempted (not the literal "dispatch"). Best-effort, never throws.
export function defaultAppendPreemptedEvent({ orchId, ticket, phase, preemptedBy, bgJobId }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "preempted",
      payloadExtras: { preempted_by: preemptedBy, bg_job_id: bgJobId },
    }),
    "preempted",
  );
}

// defaultAppendResumedAfterPreemptionEvent — phase.<phase>.resumed-after-preemption.<TICKET>.
// Emitted when a previously-preempted worker is re-dispatched at its parkedFrom
// phase. resumeSession is null when the UUID could not be resolved (cold re-dispatch).
// Best-effort, never throws.
export function defaultAppendResumedAfterPreemptionEvent({ orchId, ticket, phase, resumeSession }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase,
      ticket,
      orchId,
      action: "resumed-after-preemption",
      payloadExtras: { resume_session: resumeSession ?? null },
    }),
    "resumed-after-preemption",
  );
}

// defaultAppendHeldStoppedEvent — phase.<phase>.held-stopped.<TICKET>. Emitted
// when the scheduler stops an idle needs-input worker to free its capacity slot
// (CTL-768). bg_job_id preserved so the revive path resolves --resume. Never throws.
export function defaultAppendHeldStoppedEvent({ orchId, ticket, phase, bgJobId }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({ phase, ticket, orchId, action: "held-stopped",
      payloadExtras: { bg_job_id: bgJobId } }),
    "held-stopped",
  );
}

// CTL-755: triage→research admission-hold event — phase.advance.held.<ticket>.
// Emitted by the scheduler's STEP-A admission gate when a triage-complete ticket
// is NOT promoted to research this tick. `reason` distinguishes the two hold
// classes:
//   "blocked-by-open-dependency"     — ≥1 blocked_by dependency is non-terminal
//                                       (the candidate is not in readyIds).
//   "awaiting-capacity-or-priority"  — deps satisfied (in readyIds) but the
//                                       candidate lost the priority/capacity
//                                       selection this tick.
// `blockers` carries the unmet blocker identifiers (empty for the capacity case).
// Best-effort, never throws — mirrors defaultAppendDispatchRequestedEvent. The
// scheduler emits it only-on-state-change to bound log volume.
export function defaultAppendPhaseAdvanceHeldEvent({ orchId, ticket, reason, blockers }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "advance",
      ticket,
      orchId,
      action: "held",
      reason,
      payloadExtras: { blockers: blockers ?? [] },
    }),
    "advance-held",
  );
}

// CTL-713: cooldown GC event — phase.scheduler.cooldown-gc.<ticket>.
// Emitted once per reaped cooldown marker so GC activity is queryable from the
// unified event log.
export function defaultAppendCooldownGcEvent({ ticket, orchId, target_phase }) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "scheduler",
      ticket,
      orchId,
      action: "cooldown-gc",
      reason: "expired-and-ineligible",
      payloadExtras: { target_phase },
    }),
    "cooldown-gc",
  );
}

// CTL-713: dispatch escalation event — phase.dispatch.escalated.<ticket>.
// Emitted when needs-human is applied after N consecutive same-code dispatch failures.
export function defaultAppendCooldownEscalatedEvent({
  ticket,
  orchId,
  target_phase,
  code,
  consecutiveFailures,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "dispatch",
      ticket,
      orchId,
      action: "escalated",
      reason: "consecutive-dispatch-failures",
      payloadExtras: { target_phase, code, consecutiveFailures },
    }),
    "cooldown-escalated",
  );
}

// CTL-684: auto-tuner parallelism-sampled event — phase.scheduler.parallelism-sampled.<label>.
// Emitted once per sample while background workers are active. `label` is "execution-core"
// for host-wide tuning; payload carries the full pressure snapshot.
export function defaultAppendParallelismSampledEvent({
  label = "execution-core",
  load1,
  load5,
  load15,
  memFreePct,
  bgCount,
  maxParallelCurrent,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "scheduler",
      ticket: label,
      orchId: label,
      action: "parallelism-sampled",
      reason: "sample",
      payloadExtras: { load1, load5, load15, mem_free_pct: memFreePct, bg_count: bgCount, maxParallel_current: maxParallelCurrent },
    }),
    "parallelism-sampled",
  );
}

// CTL-684: auto-tuner parallelism-adjusted event — phase.scheduler.parallelism-adjusted.<label>.
// Emitted only when maxParallel actually changes (write-on-change).
export function defaultAppendParallelismAdjustedEvent({
  label = "execution-core",
  oldMaxParallel,
  newMaxParallel,
  reason,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "scheduler",
      ticket: label,
      orchId: label,
      action: "parallelism-adjusted",
      reason,
      payloadExtras: { old_maxParallel: oldMaxParallel, new_maxParallel: newMaxParallel },
    }),
    "parallelism-adjusted",
  );
}

// CTL-770/CTL-771: auto-tuner setpoint gauge event —
// phase.scheduler.autotune-gauge.<label>. Emitted UNCONDITIONALLY once per tick
// (unlike parallelism-adjusted, which is write-on-change) so the OTel dashboard
// renders the effective/target/load/mem gauges every sample interval. Mirrors
// defaultAppendParallelismSampledEvent's transport: a CanonicalEvent envelope
// appended best-effort to the unified event log, which otel-forward tails and
// translates to OTLP. The metric VALUES live as flat scalars inside body.payload
// (via the payloadExtras seam), exactly as the parallelism-sampled precedent
// does. Best-effort — never throws (appendEnvelopeBestEffort).
export function defaultAppendAutotuneGaugeEvent({
  label = "execution-core",
  maxParallelEffective,
  maxParallelTarget,
  runningWorkers,
  load1,
  loadPerCore,
  memFreePct,
  reason,
}) {
  return appendEnvelopeBestEffort(
    buildEventEnvelope({
      phase: "scheduler",
      ticket: label,
      orchId: label,
      action: "autotune-gauge",
      reason,
      payloadExtras: {
        max_parallel_effective: maxParallelEffective,
        max_parallel_target: maxParallelTarget,
        running_workers: runningWorkers,
        load1,
        load_per_core: loadPerCore,
        mem_free_pct: memFreePct,
        decision_reason: reason,
      },
    }),
    "autotune-gauge",
  );
}

// CTL-1044: generic operator-event appender. The scheduler's `appendIntentEvent`
// seam (scheduler.mjs:4300, threaded into the advance-shadow comparator, CTL-936
// reconcileIntents, and executeEscalations) consumes a RAW operator-event object:
//   { "event.name": string, payload: object }
// This does NOT fit buildEventEnvelope's phase.<phase>.<action>.<ticket> schema
// (those events are phase-keyed; operator telemetry is name-keyed), so it gets a
// dedicated envelope builder here. The envelope carries `evt["event.name"]`
// VERBATIM as attributes["event.name"] and `evt.payload` under body.payload —
// matching the unified-event-log line shape every other daemon emitter writes
// (ts/id/observedTs/severity/resource{service.name,namespace,host}/attributes/body).
// Production wires this at daemon.mjs's schedulerFn({ appendIntentEvent }) call;
// startScheduler keeps its null default (CTL-936 chose silence for legacy/tests).
// Best-effort: a malformed evt or an unwriteable log never throws — operator
// telemetry must never break a tick (the shadow contract). The broker's
// shouldSkipEvent (broker/router.mjs:1395) does NOT skip beliefs.* names and no
// handler keys off them, so these land in the log as inert telemetry — no loop.
export function defaultAppendOperatorEvent(evt) {
  try {
    const name = evt?.["event.name"];
    if (typeof name !== "string" || name.length === 0) return false;
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const line =
      JSON.stringify({
        ts,
        id: randomBytes(8).toString("hex"),
        observedTs: ts,
        // Operator telemetry (shadow disagreements, intent.ineffective,
        // escalations) is INFO — it records evidence; it is NOT a daemon-health
        // warning. Matches the dispatch-lifecycle precedent (CTL-700 Item B).
        severityText: "INFO",
        severityNumber: 9,
        traceId: randomBytes(16).toString("hex"),
        spanId: randomBytes(8).toString("hex"),
        resource: {
          "service.name": "catalyst.execution-core",
          "service.namespace": "catalyst",
          "host.name": hostName(),
          "host.id": hostId(),
        },
        attributes: {
          "event.name": name,
        },
        body: { payload: evt?.payload ?? null },
      }) + "\n";
    return appendEnvelopeBestEffort(line, "operator-event");
  } catch {
    // Best-effort — a serialization failure (e.g. a circular payload) must
    // never break the tick. The caller's own try/catch is a second backstop.
    return false;
  }
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
  { orchDir, ticket, phase, resumeSession, attempt },
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
  if (attempt != null) dispatchArgs.attempt = attempt; // CTL-761
  // CTL-660: record the revive DECISION before the spawn (reason="revive"),
  // then the verified launch after a clean dispatch. Both best-effort — the
  // default emitters swallow IO errors (appendEnvelopeBestEffort); the revive
  // proceeds regardless of either return value.
  appendRequested({ orchId, orchDir, ticket, target_phase: phase, reason: "revive" });
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
      orchDir,
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

// clearProgressMarks — CTL-736 Phase 3: delete every per-(ticket, phase) progress
// high-water marker (`workers/<ticket>/.progress-<phase>`). Called at daemon boot
// (alongside writeBootMarker) so a stale high-water left by a PRIOR daemon run
// cannot false-STOP the FIRST death of this run (the progress gate's "a first
// death always gets one revive" guarantee is per-run, windowed the same way the
// revive ATTEMPT count is windowed by daemon-boot.json). Best-effort + fail-open:
// a missing workers dir or an unlink error just leaves the marker, costing at
// most one extra revive evaluation. Injectable rm for tests.
export function clearProgressMarks(orchDir, { rm = rmSync } = {}) {
  let entries;
  try {
    entries = readdirSync(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return; // no workers dir yet — nothing to clear
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const dir = join(orchDir, "workers", d.name);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.startsWith(".progress-")) {
        try {
          rm(join(dir, f), { force: true });
        } catch {
          /* best-effort — a leftover marker only costs one extra revive eval */
        }
      }
    }
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

// CTL-736 — the reclaim death-trigger is the authoritative LOCAL state.json
// lifecycle (jobLifecycle → alive | dead-terminal | dead-gone), NOT the
// eventually-consistent `claude agents` snapshot and NOT state.json mtime. An
// in-process sub-agent fan-out keeps .state=working while mtime goes stale, so
// mtime was a false death signal (the proven worker-10d6f123 failure) and the
// snapshot showed a fresh worker `absent` before it registered (the CTL-735
// storm). The single long backstop that survives is the BUSY_CEILING_MS
// no-committed-work human-flag escalation on an `alive` worker — an
// env-overridable tunable imported from config.mjs.

// CTL-736 Phase 3: the MAX_REVIVES per-ticket budget and the STORM_THRESHOLD
// fleet-wide storm-breaker are DELETED — the progress gate (revive only while a
// worker makes forward progress; stop on zero progress) plus the Phase-1 O_EXCL
// claim bound retries structurally, no heuristic budget needed. STORM_WINDOW_MS
// is retained ONLY as the `window_ms` field of the revive-suppressed audit event
// emitted on the audit-append-failure path below.
const STORM_WINDOW_MS = 10 * 60 * 1000;

// CTL-736 Phase 2: the CTL-662 idle-confirmation streak markers
// (`.idle-streak-<phase>` + idleStreakMarkerPath / read / bump / reset) are
// DELETED. They existed to confirm an eventually-consistent `claude agents`
// `idle` reading across consecutive ticks before reclaiming. The authoritative
// local state.json lifecycle (jobLifecycle) has no such ambiguity — `working`
// is alive, terminal is dead — so no streak is needed.

// CTL-736 Phase 3 — progress high-water mark. Persisted per-(ticket, phase) as a
// worker-dir marker (`.progress-<phase>`), the same durable-state mechanism as
// the CTL-587 .revive-N.applied markers. The reclaim path compares the CURRENT
// progressMark (commits-ahead / artifact bytes) against this stored high-water to
// decide revive (progressed) vs stop (zero progress). defaultReadProgressMark
// returns -1 when absent so a first death always gets one revive.
function progressMarkPath(orchDir, ticket, phase) {
  return join(orchDir, "workers", ticket, `.progress-${phase}`);
}
function defaultReadProgressMark(orchDir, ticket, phase) {
  try {
    const n = parseInt(readFileSync(progressMarkPath(orchDir, ticket, phase), "utf8"), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1; // marker absent → no prior progress observation
  }
}
// defaultWriteProgressMark — persist the new high-water mark. Fail-open: a write
// failure only costs one extra revive evaluation next tick (harmless).
function defaultWriteProgressMark(orchDir, ticket, phase, value) {
  try {
    writeFileSync(progressMarkPath(orchDir, ticket, phase), String(value));
  } catch (err) {
    log.warn({ ticket, phase, err: err.message }, "ctl-736: progress-mark write failed");
  }
}

// reclaimDeadWorkIfPossible — one signal in, one decision out. CTL-736 swaps the
// death TRIGGER from the eventually-consistent `claude agents` snapshot to the
// authoritative LOCAL state.json lifecycle (jobLifecycle → alive | dead-terminal
// | dead-gone), and replaces the ~14 heuristic revive-storm guards with two
// deterministic primitives: the Phase-1 O_EXCL claim + fencing generation (no
// duplicate spawn) and the Phase-3 progress gate (revive only while forward
// progress advances; stop, never respawn, on zero progress). The return set:
//
//   'noop'                classifyWorker says terminal (phase finished) or
//                         unknown (no bg_job_id). No action.
//   'alive-suppressed'    jobLifecycle is `alive` (state.json non-terminal, e.g.
//                         working — INCLUDING a multi-minute in-process sub-agent
//                         fan-out with stale mtime: the CTL-662 false-reclaim fix).
//                         NEVER auto-reclaimed. The sole permitted action is the
//                         BUSY_CEILING_MS no-committed-work escalation backstop.
//   'reclaimed'           reclaim-eligible (dead-terminal / dead-gone) + work IS
//                         done. Canonical reclaim audit appended, emit-complete
//                         flipped the signal, session ended.
//   'reclaim-failed'      reclaim-eligible + work IS done BUT emit-complete exited
//                         non-zero. Signal NOT mutated (atomic rename); retries.
//   'revived'             reclaim-eligible + probe says work NOT done + progress
//                         ADVANCED since the last attempt. Signal reset to
//                         'stalled', defaultDispatch invoked (bumps the fencing
//                         generation), high-water mark + .revive-N.applied marker
//                         written. CTL-604: every probed phase shares this.
//   'no-progress-stopped' reclaim-eligible + work NOT done + ZERO forward progress
//                         since the last attempt (the futile idle-respawn loop).
//                         The dead worker is stopped and needs-human applied;
//                         NEVER respawned. (Phase-3 replacement for the deleted
//                         MAX_REVIVES budget + storm-breaker.)
//   'rate-limited-deferred' a no-progress STOP whose needs-human escalation is
//                         deferred because the Linear breaker is open (CTL-679);
//                         the worker is still stopped, the label retries next tick.
//   'revive-suppressed'   reclaim-eligible + work NOT done BUT the revive audit
//                         event could not be persisted (disk error) — dispatch
//                         skipped to preserve the attempt counter; retries.
//   'inert-stale'         reclaim-eligible + work NOT done + the signal is older
//                         than reviveMaxAgeMs — an abandoned historical dir, left
//                         inert (no revive, no escalate). (CTL-735, kept.)
//   'wedged-redispatched' CTL-932 turn-zero gate: an `alive` worker past
//                         NEVER_STARTED_MS with NO transcript and a FRESH
//                         agents-snapshot state of "blocked" never started its
//                         first turn. Screen captured into the wedged event,
//                         session stopped, signal flipped through reviveDispatch
//                         (replacement worker). Durable attempt marker bumped;
//                         past NEVER_STARTED_ATTEMPT_CAP the gate escalates
//                         needs-human ('escalated', reason
//                         wedged-never-started-exhausted) instead of looping.
//   'escalated' / 'escalation-suppressed'
//                         an `alive` worker past BUSY_CEILING_MS with no committed
//                         work (the backstop), behind the CTL-638 cool-down — or
//                         the CTL-932 wedge cap above.
//   'superseded-noop'     reclaim-eligible BUT the signal's phase precedes the
//                         ticket's latest-dispatched phase (CTL-606). A reap-intent
//                         is emitted so the reaper stops the bg.
//
// The function stays pure given its injected seams: statJob / jobLifecycle (the
// death trigger) / probes / progressMark + read/writeProgressMark (the Phase-3
// progress gate) / emitComplete / the CTL-587 revive+escalate seams
// (appendReviveEvent, appendEscalatedEvent, reviveDispatch, applyStalledLabel,
// killBgJob, countReviveEvents, writeReviveMarker) + the CTL-638 cool-down +
// CTL-679 breaker. All have real defaults for prod; tests override every one.
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
    // CTL-736 Phase 3: countReviveEvents now supplies the revive ATTEMPT NUMBER
    // for the audit event + `.revive-N.applied` marker only (telemetry) — it is
    // no longer a budget gate (the progress gate bounds retries).
    countReviveEvents = defaultCountReviveEvents,
    // CTL-655 — boot-time window reader. Reads <orchDir>/daemon-boot.json and
    // returns its `bootedAt` (or undefined) so the attempt count windows to the
    // current daemon run. Named ...Fn to avoid shadowing the module-level
    // readBootSince used as the default.
    readBootSince: readBootSinceFn = readBootSince,
    writeReviveMarker = defaultWriteReviveMarker,
    // CTL-736 Phase 3 — progress probe seams. progressMark returns a monotonic-ish
    // non-negative forward-progress token (commits-ahead / artifact bytes);
    // read/writeProgressMark persist the per-(ticket, phase) high-water mark under
    // workers/<ticket>/.progress-<phase>. Replace the MAX_REVIVES budget, the
    // storm-breaker, and the per-tick cap: revive only while progress advances,
    // stop (never respawn) on zero progress.
    progressMark = defaultProgressMark,
    readProgressMark = defaultReadProgressMark,
    writeProgressMark = defaultWriteProgressMark,
    // CTL-638 — per-(ticket, phase) escalation cool-down. Defaults read/write
    // markers under orchDir/.escalation-cooldowns/; tests can inject fakes to
    // run multiple escalations against the same scenario without filesystem
    // I/O, or to drive the cool-down clock independently of `now`.
    inEscalationCooldownFn = defaultInEscalationCooldown,
    recordEscalationFn = defaultRecordEscalation,
    // CTL-606 — supersede guard. Returns the ticket's dispatched phase names so
    // the guard can detect a dead signal the pipeline has already advanced past.
    listTicketPhases = (t) => listDispatchedPhases(orchDir, t),
    // CTL-736 — THE death trigger: the authoritative LOCAL state.json lifecycle
    // (alive | dead-terminal | dead-gone). Aliased ...Fn to avoid shadowing the
    // module-level jobLifecycle used as the default. This fully replaces the
    // eventually-consistent `claude agents` snapshot reader (livenessForBgJob),
    // which is no longer consulted by the reclaim/death path at all.
    jobLifecycle: jobLifecycleFn = jobLifecycle,
    // CTL-809 — GHOST BREAKER seams. agentsSnapshot returns the FRESH `claude
    // agents` snapshot {agents,isFresh,ageMs}; production reads the warm
    // getAgentsCached, tests inject a fake. ghostGraceMs is the just-dispatched
    // grace window. Consulted ONLY to break the jobLifecycle-alive-but-process-gone
    // tie in the alive branch below, strictly gated on isFresh (CTL-731/657-safe)
    // and on a worker older than ghostGraceMs (no false-reclaim of a not-yet-
    // registered fresh spawn — CTL-662-safe; a busy fan-out worker stays LISTED).
    agentsSnapshot = getAgentsCached,
    ghostGraceMs = GHOST_GRACE_MS,
    // CTL-932 — TURN-ZERO GATE seams. A jobLifecycle-alive worker past
    // neverStartedMs whose session has NO transcript AND whose FRESH agents-
    // snapshot state is "blocked" never started its first turn: stop it,
    // capture `claude logs` into the escalation event, and replace it through
    // the normal revive/redispatch path — bounded by a durable per-(ticket,
    // phase) attempt marker; past the cap, escalate needs-human instead of
    // looping. All injectable; production defaults are the real primitives.
    neverStartedMs = NEVER_STARTED_MS,
    transcriptExists = defaultTranscriptExists,
    captureWedgeLogs = defaultCaptureWedgeLogs,
    appendWedgedEvent = defaultAppendWedgedNeverStartedEvent,
    readNeverStartedAttempts = defaultReadNeverStartedAttempts,
    recordNeverStartedAttempt = defaultRecordNeverStartedAttempt,
    clearNeverStartedAttempts = defaultClearNeverStartedAttempts,
    wedgeAttemptCap = NEVER_STARTED_ATTEMPT_CAP,
    // CTL-868 — zombie state.json staleness floor (the GHOST BREAKER's fallback
    // for when no FRESH `claude agents` snapshot is available, e.g. the headless
    // mini where CTL-829 makes `claude agents` unreliable). A `working` job whose
    // state.json mtime is older than this is a corpse and falls through to reclaim.
    // Subordinate to a fresh snapshot (a LISTED worker is busy, never reclaimed
    // here regardless of mtime — CTL-662-safe). Injectable; defaults to the const.
    zombieStaleFloorMs = ZOMBIE_STALE_FLOOR_MS,
    // CTL-735 — revival age ceiling. An absent/idle, work-not-done worker whose
    // signal has not been touched in this long is an abandoned historical dir,
    // not a fresh crash: treated as inert (no revive, no escalate). Injectable for
    // tests; defaults to the env-overridable config const.
    reviveMaxAgeMs = REVIVE_MAX_AGE_MS,
    // CTL-662 — busy-forever backstop ceiling (measured from signal.startedAt).
    // The SOLE long backstop now that the mtime triggers are gone: a busy worker
    // past it with no committed work is flagged for human, never silent-reclaimed.
    busyCeilingMs = BUSY_CEILING_MS,
    // CTL-778 — has the worker already emitted phase.<phase>.complete.<ticket>?
    // THE disambiguator between a done-but-idle alive worker (reclaim) and a busy
    // fan-out worker (suppress). Defaults to the incremental event-scan query;
    // tests inject a stub. Production wiring is correct by default since
    // hasCompleteEvent reads the real event log.
    completeEventSeen = ({ ticket: t, phase: p }) => hasCompleteEvent({ ticket: t, phase: p }),
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
    // CTL-642: the SHARED TTL state cache + fetchState + prAdapter for the
    // terminal short-circuit (below). fetchState defaults to UNDEFINED (not the
    // real linear-query helper) so the short-circuit is INERT unless a caller
    // explicitly threads a reader: production wires fetchState: fetchTicketState +
    // cache via the scheduler's reclaimOpts (scheduler.mjs:~1672), while every
    // legacy unit test that omits it is byte-for-byte unchanged (no surprise
    // network read, no false short-circuit). isTicketTerminalOrMerged no-ops when
    // fetchState is not a function.
    fetchState,
    cache,
    prAdapter,
    now = Date.now,
    // CTL-936: closed-loop intent layer. When a beliefs.db handle is provided,
    // kill actions record intents with a "session left agents" postcondition and
    // are suppressed once the intent goes ineffective — stopping the stop-storm
    // class. Default null → legacy behavior unchanged (all existing tests unaffected).
    // The intentDb is obtained from beliefs.db (CATALYST_BELIEFS_SHADOW=1 gate);
    // it is threaded in from the scheduler's reclaimOpts alongside fetchState/cache.
    intentDb = null,
  } = {},
) {
  const klass = classifyWorker(signal, { statJob });
  // CTL-662: terminal (phase finished) and unknown (no bg_job_id) still
  // short-circuit — boot-classification gating is unchanged. Everything else
  // (running, OR dead-by-missing-job-dir) is routed through the status trigger
  // below; the job dir's existence/mtime is no longer the death signal.
  if (klass === "terminal" || klass === "unknown") return "noop";

  // CTL-549: needs-input signals are intentionally parked awaiting a human
  // comment. Neither reclaim nor escalate — the comment-wake path in daemon.mjs
  // handles re-dispatch. Treat as noop so the per-tick sweep never interferes.
  if (signal?.status === "needs-input") {
    log.debug({ ticket: signal.ticket }, "reclaimDeadWork: skipping needs-input (parked for human)");
    return "noop";
  }

  const { ticket, phase } = signal;
  const orchId = signal.raw?.orchestrator;
  const prevBgJobId = signal.raw?.bg_job_id ?? null;

  // CTL-936: intent-aware kill helper. Wraps killBgJob with:
  //   1. isIntentEffective guard — when CATALYST_INTENTS_ENFORCE=1 and the kill
  //      intent for this (ticket, phase) has already gone ineffective, skip the
  //      claude stop call (stops the stop-storm after N failed attempts).
  //   2. recordIntent — record the kill intent the first time we issue the stop
  //      so the next-tick reconciler can check whether the session left the
  //      agents listing.
  // Falls back to plain killBgJob({ bgJobId }) when intentDb is null (all
  // existing tests are unaffected — intentDb defaults to null).
  function intentAwareKill({ bgJobId: killBgJobId }) {
    if (!intentDb || !killBgJobId) {
      killBgJob({ bgJobId: killBgJobId });
      return;
    }
    const subject = `${ticket}/${phase}`;
    let maxAttempts = 2;
    try {
      const cfgRow = intentDb.query("SELECT value_int FROM cfg WHERE key = 'max_attempts'").get();
      if (typeof cfgRow?.value_int === "number") maxAttempts = cfgRow.value_int;
    } catch { /* fall through — use default */ }

    // Enforce: suppress kill when the intent has already gone ineffective.
    if ((process.env.CATALYST_INTENTS_ENFORCE ?? "0") === "1") {
      try {
        const ineffective = intentDb
          .query(
            `SELECT 1 FROM intent
              WHERE kind = 'kill' AND subject = ?
                AND (outcome = 'ineffective'
                  OR (outcome IS NULL AND attempts >= ?))
              LIMIT 1`,
          )
          .get(subject, maxAttempts);
        if (ineffective) {
          log.warn(
            { ticket, phase, bgJobId: killBgJobId, subject },
            "ctl-936: kill intent ineffective — skipping claude stop (stop-storm prevention)",
          );
          return;
        }
      } catch (err) {
        log.warn({ err: err?.message }, "ctl-936: isIntentEffective check threw — continuing kill");
      }
    }

    // Record the intent if not already open.
    try {
      const open = intentDb
        .query("SELECT 1 FROM intent WHERE kind = 'kill' AND subject = ? AND outcome IS NULL LIMIT 1")
        .get(subject);
      if (!open) {
        const tickRow = intentDb.query("SELECT tick_id FROM tick ORDER BY tick_id DESC LIMIT 1").get();
        if (tickRow) {
          // CTL-936 H1: pin bgJobId so resolvePostcondition can distinguish
          // the targeted session from a newly-revived worker on the same
          // subject slot (a revive allocates a new bgJobId, so the old kill
          // intent does not falsely satisfy against it).
          intentDb.run(
            `INSERT INTO intent (tick_id, kind, subject, belief_id, postcondition, attempts, outcome)
             VALUES (?, 'kill', ?, NULL, ?, 0, NULL)`,
            [tickRow.tick_id, subject, JSON.stringify({ kind: "kill", subject, bgJobId: killBgJobId, sessionNotRegistered: true })],
          );
        }
      }
    } catch (err) {
      log.warn({ err: err?.message, ticket, phase }, "ctl-936: recordIntent threw — continuing kill");
    }
    killBgJob({ bgJobId: killBgJobId });
  }

  // CTL-587: capture the bg state.json mtime for the revive AUDIT payload only.
  // CTL-662 removed it from every DECISION branch — it is telemetry, not a
  // trigger. Best-effort: a missing job dir (real crash) just leaves it null.
  let prevStateJsonMtime = null;
  // CTL-932: keep the FULL statJob read so the supervisor's self-report fields
  // (tempo/detail/needs — previously never read) reach the logs below.
  let jobStat = null;
  if (signal?.liveness?.value) {
    jobStat = statJob(signal.liveness.value);
    if (jobStat && typeof jobStat.mtimeMs === "number") prevStateJsonMtime = jobStat.mtimeMs;
  }

  // CTL-638 — escalation helper (unchanged): wraps appendEscalatedEvent +
  // applyStalledLabel in a per-(ticket, phase) cool-down so the same escalation
  // cannot re-fire within the window (the pre-CTL-638 self-feeding storm).
  // CTL-932: `extras` (optional) rides evidence into the escalated event
  // payload (e.g. the wedge screen captures). Cool-down/breaker behaviour is
  // untouched.
  // reasonToWhyGaveUp — central map so per-reason phrasing is testable.
  function reasonToWhyGaveUp(r, n) {
    switch (r) {
      case "busy-ceiling-exceeded":
        return "worker was alive past the busy ceiling with no committed work";
      case "no-progress":
        return `no forward progress after ${n} attempt(s) — stop-and-escalate`;
      case "no-probe-for-phase":
        return "no probe available for this phase — cannot verify work is done";
      case "wedged-never-started-exhausted":
        return `wedged-never-started replacement budget exhausted after ${n} attempt(s)`;
      default:
        return `escalation reason: ${r} (after ${n} attempt(s))`;
    }
  }

  function escalateOnce(reason, finalAttemptCount, extras) {
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
    // CTL-1065: build a coerced explanation and attach it to extras so the
    // escalated event payload carries structured, decision-shaped context.
    const explanation = coerceExplanation(
      {
        what_failed: `${phase} escalated after ${finalAttemptCount} attempt(s): ${reason}`,
        observed: { final_attempt_count: finalAttemptCount, ...(extras?.observed ?? {}) },
        attempts: extras?.attempts ?? [],
        why_gave_up: reasonToWhyGaveUp(reason, finalAttemptCount),
        human_question: extras?.human_question ?? "",
      },
      { ticket, phase },
    );
    const enrichedExtras = { ...(extras ?? {}), explanation };
    appendEscalatedEvent({
      phase,
      ticket,
      orchId,
      reason,
      final_attempt_count: finalAttemptCount,
      extras: enrichedExtras,
    });
    applyStalledLabel({ orchDir, ticket });
    recordEscalationFn(orchDir, ticket, phase, reason, now());
    log.warn({ ticket, phase, reason }, "ctl-587: escalated");
    return "escalated";
  }

  // CTL-642 — TERMINAL SHORT-CIRCUIT. Placed BEFORE the lifecycle/alive branch so
  // it DOMINATES all three escalateOnce sites (alive busy-ceiling, no-probe,
  // no-progress): a ticket the pipeline (or a human) has already finished
  // (Linear state Done/Canceled) or whose PR already merged must NEVER be
  // escalated to needs-human nor revived — those are the CTL-624/625
  // merged-but-running-zombie and CTL-549/550 false-escalation storms. Runs for
  // BOTH alive (the merged-but-still-running zombie) AND dead workers (a
  // crashed-after-merge worker). On terminal/merged: flip the signal to `done`
  // via emitComplete (so the scheduler drops it from the attention set next tick),
  // audit it (completion_origin:"terminal-short-circuit"), and return the new
  // outcome `terminal-short-circuit` (the scheduler treats it like reclaimed/noop
  // — NO escalated event). Best-effort: a non-zero emitComplete falls through to
  // the normal lifecycle path (re-evaluated next tick), never strands the ticket.
  //
  // The check is cheap-first (terminal-state.isTicketTerminalOrMerged): the cached
  // Linear read runs first; the `gh` PR view runs ONLY when non-terminal AND a PR
  // number exists. A null/unreadable read fails safe to NOT-terminal (D5), so a
  // transient linearis outage never manufactures a false completion.
  const terminalCheck = isTicketTerminalOrMerged({
    ticket,
    signal,
    fetchState,
    cache,
    prAdapter,
  });
  if (terminalCheck.terminal) {
    appendEvent({
      phase,
      ticket,
      orchId,
      orchDir,
      death_signal: "terminal-short-circuit",
      prev_state_json_mtime: prevStateJsonMtime,
      probe_passed: false,
      probe_checked: terminalCheck.reason,
      completion_origin: "terminal-short-circuit",
      reclaimed_bg_job_id: prevBgJobId,
      stopped_bg_job_ids: [],
      title: `phase ${phase} short-circuited (ticket already terminal)`,
      body: `Daemon short-circuited ${ticket} ${phase}: ${terminalCheck.reason} (state=${terminalCheck.state ?? "?"}). Flipping signal to done; no escalation.`,
    });
    const sc = emitComplete({ orchDir, signal });
    if (sc.code !== 0) {
      log.warn(
        { ticket, phase, code: sc.code, stderr: sc.stderr, reason: terminalCheck.reason },
        "ctl-642: terminal short-circuit emit-complete failed; falling through to lifecycle path (retry next tick)",
      );
    } else {
      log.info(
        { ticket, phase, reason: terminalCheck.reason },
        "ctl-642: terminal short-circuit — ticket already terminal/merged, signal flipped to done (no escalation)",
      );
      return "terminal-short-circuit";
    }
  }

  // CTL-736 — THE DEATH TRIGGER. The authoritative LOCAL state.json lifecycle
  // (jobLifecycle → alive | dead-terminal | dead-gone), NOT the eventually-
  // consistent `claude agents` snapshot. Deterministic and fan-out-safe: a
  // multi-minute in-process sub-agent fan-out keeps .state=working (alive) while
  // mtime ages, so mtime is never read. A terminal .state / firstTerminalAt is
  // definitively dead; a missing job dir is dead-gone.
  //
  // (The earlier draft of this work added LIVENESS_SOURCE `snapshot`/`shadow`
  // rollback modes. They were removed: both re-broke on the deleted idle-streak/
  // grace/cold-skip machinery — `snapshot` reclaimed a live idle worker on the
  // first tick, and a cold snapshot re-introduced the CTL-731 per-worker
  // synchronous `claude agents` starvation. A degraded rollback that misfires in
  // the very incident it would be used for is a footgun; the real rollback for a
  // state.json regression is reverting this change.)
  const lifecycle = jobLifecycleFn(prevBgJobId, { statJob });

  // ── alive: NEVER auto-reclaimed. The job's state.json lifecycle is
  //    non-terminal (`working`, or an unreadable-but-present state.json). The
  //    fan-out-safe replacement for the CTL-662 busy short-circuit: no idle
  //    streak, no grace window — `working` is immediately authoritative. The
  //    sole permitted action is the no-committed-work backstop: an alive worker
  //    past busyCeilingMs whose work-done probe is STILL false is flagged for
  //    human (escalateOnce), never a silent reclaim-and-advance. (CTL-736
  //    Phase 3 generalizes this ceiling into the progress probe.)
  if (lifecycle === "alive") {
    // CTL-778 step 3 — alive-but-idle reconcile. An alive worker that has ALREADY
    // emitted phase.<phase>.complete AND whose work-done probe passes is done, not
    // busy: flip the stuck `running` signal to `done` from the on-disk artifact and
    // stop the idle worker. Gated on the complete EVENT (not the probe alone) so a
    // busy in-process fan-out worker — which never emitted complete — is untouched
    // (CTL-662/736/809-safe). Mirrors the dead-worker branch (B) below.
    if (
      hasProbe(phase) &&
      completeEventSeen({ ticket, phase }) &&
      probes[phase]({ ticket, repoRoot, orchDir })
    ) {
      if (prevBgJobId) {
        emitReapIntent("phase.reclaim.reap-requested", {
          ticket,
          phase,
          bgJobId: prevBgJobId,
          worktreePath: signal.raw?.worktreePath,
          reason: "ctl-778-alive-probe-reclaim",
        }).catch(() => {});
      }
      appendEvent({
        phase,
        ticket,
        orchId,
        orchDir,
        death_signal: "alive-probe-done",
        prev_state_json_mtime: null,
        probe_passed: true,
        probe_checked: describeProbe(phase),
        completion_origin: "alive-probe-reclaim",
        reclaimed_bg_job_id: prevBgJobId,
        stopped_bg_job_ids: [],
        title: `phase ${phase} reclaimed (alive worker probe done)`,
        body: `Daemon reclaimed alive ${phase} worker for ${ticket}: still alive but complete event + probe verified work done. bg_job_id=${prevBgJobId ?? "?"}.`,
      });
      const r = emitComplete({ orchDir, signal });
      if (r.code !== 0) {
        log.warn(
          { ticket, phase, code: r.code, stderr: r.stderr },
          "ctl-778 alive-probe-reclaim: emit-complete failed; will retry next tick",
        );
        return "reclaim-failed";
      }
      postReclaimMirror({
        orchDir,
        ticket,
        phase,
        deathSignal: "alive-probe-done",
        probeChecked: describeProbe(phase),
        reclaimedBgJobId: prevBgJobId,
      });
      log.info({ ticket, phase }, "ctl-778: alive-but-idle worker reclaimed (complete event + probe)");
      return "reclaimed";
    }

    const startedAtMs = Date.parse(signal.raw?.startedAt ?? "");

    // ── CTL-932 — TURN-ZERO GATE. A worker can register with CC but never
    // resolve its slash-command prompt ("Unknown command:
    // /catalyst-dev:phase-*"): it idles forever at an empty input prompt. Every
    // other guard is blind to this class — state.json stays state:"working"
    // (jobLifecycle alive forever), the session IS listed (ghost breaker
    // suppresses), and the 6h busy-ceiling is label-only. Evidence conjunction
    // (all three required; any doubt → fall through, no-op):
    //   1. dispatch age > neverStartedMs (default 120s; a healthy session
    //      creates its transcript ~0.3s after the first turn);
    //   2. NO transcript file for the session (the cleanest wedge detector);
    //   3. FRESH agents-snapshot state === "blocked" (the listing's signature
    //      of registered-but-prompt-never-resolved).
    // INVARIANT: the committed-work probe runs BEFORE any kill — a worker with
    // committed work is never touched here (existing paths own it). Dead
    // workers never reach this branch (lifecycle === "alive" only), and a
    // worker WITH a transcript falls through untouched.
    if (
      prevBgJobId &&
      Number.isFinite(startedAtMs) &&
      now() - startedAtMs > neverStartedMs
    ) {
      let wedgeShortId = null;
      try {
        wedgeShortId = shortIdFromSessionId(prevBgJobId);
      } catch {
        wedgeShortId = null; // malformed bg_job_id → cannot prove → no-op
      }
      if (wedgeShortId) {
        const snap = agentsSnapshot();
        const agent = snap?.isFresh ? agentForShortId(wedgeShortId, snap.agents) : null;
        if (agent && agent.state === "blocked") {
          const sessionId = resolveSession(prevBgJobId);
          if (!transcriptExists(sessionId)) {
            // Committed-work probe BEFORE any kill (the invariant): committed
            // work means this is NOT a never-started worker — leave it to the
            // existing alive-branch paths.
            const workCommitted = hasProbe(phase) && probes[phase]({ ticket, repoRoot, orchDir });
            if (!workCommitted) {
              // Capture the rendered screen BEFORE stopping (stop destroys it)
              // so the escalation event shows the cause without archaeology.
              const captured = captureWedgeLogs(prevBgJobId);
              const attempts = readNeverStartedAttempts(orchDir, ticket, phase);
              if (attempts.count >= wedgeAttemptCap) {
                // Replacements keep wedging — the environment is broken
                // (marketplace wedge / plugin-registration race). Stop the
                // corpse (it holds a slot) and page a human with the screen
                // captures from ALL attempts instead of looping.
                //
                // CTL-932 fix: make this corpse terminally NOT-revivable before
                // returning. Without the next two steps the kill alone is not
                // enough — next tick the stopped worker reads `dead`, branch (C)
                // runs, and its no-progress gate (currentProgress 0 > stored -1
                // on a never-observed phase) PASSES, reviving a futile 4th
                // worker that re-wedges and re-escalates. Pre-seed the progress
                // high-water mark to the worker's current (zero) progress so
                // branch (C) reads `0 <= 0` and STOPS via its own terminal
                // no-progress path — the exact mechanism the sibling stop uses,
                // no new state. needs-human is already applied by escalateOnce,
                // so that terminal stop's escalation is cool-down-suppressed; net
                // = zero post-escalation respawns.
                const exhaustedProgress = progressMark({ ticket, phase, repoRoot, orchDir });
                writeProgressMark(orchDir, ticket, phase, exhaustedProgress);
                // Reap-intent BEFORE the inline kill (the authoritative backup if
                // the inline stop fails), mirroring the no-progress + gate-
                // redispatch stop paths which both pair emitReapIntent + kill.
                emitReapIntent("phase.terminal.reap-requested", {
                  ticket,
                  phase,
                  bgJobId: prevBgJobId,
                  worktreePath: signal.raw?.worktreePath,
                  reason: "ctl-932-wedged-never-started-exhausted",
                }).catch(() => {});
                intentAwareKill({ bgJobId: prevBgJobId });
                log.warn(
                  { ticket, phase, prevBgJobId, attempts: attempts.count, exhaustedProgress, tempo: jobStat?.tempo, detail: jobStat?.detail, needs: jobStat?.needs },
                  "ctl-932: wedged-never-started replacement budget exhausted — escalating needs-human (not looping)",
                );
                return escalateOnce("wedged-never-started-exhausted", attempts.count, {
                  bg_job_id: prevBgJobId,
                  captured_logs_all_attempts: [
                    ...attempts.captures,
                    String(captured ?? "").slice(0, 2_000),
                  ],
                });
              }
              const attempt = attempts.count + 1;
              appendWedgedEvent({
                phase,
                ticket,
                orchId,
                attempt,
                bg_job_id: prevBgJobId,
                agents_state: agent.state,
                tempo: jobStat?.tempo ?? null,
                detail: jobStat?.detail ?? null,
                needs: jobStat?.needs ?? null,
                captured_logs: captured,
              });
              recordNeverStartedAttempt(orchDir, ticket, phase, captured);
              // Stop the wedged session (reap-intent for the reaper + inline
              // best-effort stop, mirroring the no-progress STOP path), then
              // flip the signal through the normal revive/redispatch path
              // (reset-to-stalled + fresh dispatch, gen+1). Backoff is
              // structural: the replacement's fresh startedAt keeps the gate
              // silent for another neverStartedMs window.
              emitReapIntent("phase.terminal.reap-requested", {
                ticket,
                phase,
                bgJobId: prevBgJobId,
                worktreePath: signal.raw?.worktreePath,
                reason: "ctl-932-wedged-never-started",
              }).catch(() => {});
              intentAwareKill({ bgJobId: prevBgJobId });
              const dr = reviveDispatch({ orchDir, ticket, phase, resumeSession: null, attempt: attempt + 1 });
              if (dr.code === 0) {
                log.warn(
                  { ticket, phase, prevBgJobId, attempt, ageMs: now() - startedAtMs, tempo: jobStat?.tempo, detail: jobStat?.detail, needs: jobStat?.needs },
                  "ctl-932: wedged-never-started worker stopped and replaced (no transcript + agents blocked)",
                );
              } else {
                log.warn(
                  { ticket, phase, attempt, code: dr.code, stderr: dr.stderr },
                  "ctl-932: wedged replacement dispatch failed; will retry next tick",
                );
              }
              return "wedged-redispatched";
            }
          }
        }
      }
    }

    if (Number.isFinite(startedAtMs) && now() - startedAtMs > busyCeilingMs) {
      const workDone = hasProbe(phase) && probes[phase]({ ticket, repoRoot, orchDir });
      if (!workDone) {
        log.warn(
          { ticket, phase, prevBgJobId, aliveForMs: now() - startedAtMs },
          "ctl-736: alive worker past BUSY_CEILING_MS with no committed work — escalating (never silent reclaim)",
        );
        return escalateOnce("busy-ceiling-exceeded", 0);
      }
    }
    // CTL-809 — GHOST BREAKER. jobLifecycle reads ONLY the local state.json, which
    // on CC 2.x is never rewritten terminal for a crashed/wedged --bg worker — so a
    // corpse stuck at state:"working" (e.g. wedged on the bypass-permissions startup
    // dialog) reads "alive" forever and is suppressed every tick. Cross-check the
    // now-reliable (CTL-790/792) `claude agents` snapshot: a worker ABSENT from a
    // FRESH snapshot, past the just-dispatched grace window, is genuinely gone — so
    // fall through to the reclaim-eligible path below instead of suppressing forever.
    //   • CTL-662-safe: a busy in-process sub-agent fan-out worker is STILL LISTED in
    //     `claude agents` (active/idle), never absent → never reclaimed here.
    //   • CTL-731/657-safe: STRICTLY gated on snap.isFresh — a stale/cold snapshot
    //     skips the cross-check and suppresses exactly as before (no cold storm).
    //   • just-spawned-safe: ghostGraceMs gate (reusing startedAtMs parsed above)
    //     keeps a worker that has not yet registered in `claude agents` from being
    //     false-reclaimed.
    let ghostAbsent = false;
    if (Number.isFinite(startedAtMs) && now() - startedAtMs > ghostGraceMs) {
      let shortId = null;
      if (prevBgJobId) {
        try {
          shortId = shortIdFromSessionId(prevBgJobId);
        } catch {
          shortId = null; // malformed bg_job_id → unresolvable → suppress (no throw)
        }
      }
      if (shortId) {
        const snap = agentsSnapshot();
        if (snap?.isFresh) {
          // CTL-809: a FRESH snapshot is authoritative — absent = ghost (reclaim),
          // present = busy in-process fan-out (suppress, CTL-662). mtime is NOT
          // consulted on this path: the snapshot is the better liveness signal.
          if (agentForShortId(shortId, snap.agents) === null) {
            ghostAbsent = true;
            log.warn(
              { ticket, phase, prevBgJobId, snapshotAgeMs: snap.ageMs },
              "ctl-809: jobLifecycle-alive but ABSENT from fresh claude-agents snapshot — treating as dead (ghost breaker)",
            );
          }
        } else {
          // CTL-868: no FRESH snapshot to consult (CTL-829: `claude agents --json`
          // is unreliable headless on the mini, so it is stale/cold here). Fall back
          // to the state.json mtime floor: a `working` job whose state.json has not
          // been rewritten in zombieStaleFloorMs is a corpse (Claude rewrites it far
          // more often than 2h during real work). The high floor keeps an in-process
          // fan-out safe (CTL-662), and this branch only runs when the fresh-agents
          // cross-check cannot — so it never overrides a fresh "present" verdict.
          const job = statJob(prevBgJobId);
          // CTL-927: doc/long-fan-out phases keep state.json untouched during a
          // multi-minute sub-agent fan-out, so the 2h mtime guess would false-kill a
          // live worker on this cold-snapshot branch. Give them the 6h busy ceiling
          // (the busy-ceiling escalation above already routes a genuinely-stuck doc
          // worker to needs-human at 6h — escalate, never silent kill).
          const mtimeFloorMs = MTIME_ZOMBIE_EXEMPT_PHASES.has(phase)
            ? busyCeilingMs
            : zombieStaleFloorMs;
          if (job && Number.isFinite(job.mtimeMs) && now() - job.mtimeMs > mtimeFloorMs) {
            ghostAbsent = true;
            log.warn(
              { ticket, phase, prevBgJobId, staleForMs: now() - job.mtimeMs, mtimeFloorMs },
              "ctl-868: jobLifecycle-alive but state.json mtime stale beyond zombie floor (no fresh agents snapshot) — treating as dead (zombie breaker)",
            );
          }
        }
      }
    }
    if (!ghostAbsent) {
      // CTL-932: surface the supervisor's self-report (tempo/detail/needs) —
      // the fields that contained the 2026-06-09 diagnosis but were never read.
      log.info(
        { ticket, phase, prevBgJobId, tempo: jobStat?.tempo, detail: jobStat?.detail, needs: jobStat?.needs },
        "ctl-736: alive worker — reclaim suppressed",
      );
      return "alive-suppressed";
    }
    // ghostAbsent → fall through to the dead-eligible reclaim path below (supersede
    // guard → no-probe escalate (A) / probe-done reclaim (B) / revive).
  }

  // ── dead-terminal | dead-gone share the reclaim-eligible path below.
  // CTL-606 — supersede guard. The reclaim sweep is fed ONE signal per ticket by
  // readWorkerSignals→byActivePhase, which ranks by status+recency, NOT phase
  // order. A stale predecessor left at `running` (never flipped to `done`) can
  // shadow the real, already-advanced phase. If the dead signal's phase precedes
  // the ticket's latest-dispatched phase, the ticket has moved on — escalating or
  // reviving it would spuriously flag needs-human or spawn a duplicate worker at
  // a past phase. Runs only once a worker is reclaim-eligible (not alive).
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

  // CTL-736 Phase 2: a dead-terminal/dead-gone worker is reclaim-eligible
  // immediately — the idle-confirmation streak (and its `.idle-streak-<phase>`
  // markers) are deleted; the state.json lifecycle is unambiguous.

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
    // CTL-755 STEP D (CORRECTED): a dead-but-work-done `triage` worker is
    // reclaimed normally — emitComplete flips its signal to `triage:done`. This
    // does NOT bypass the admission gate: the gate lives DOWNSTREAM at the
    // scheduler's STEP-B advancement guard (scheduler.mjs:2096), which holds the
    // triage→research promotion for ANY `triage:done` worker not in
    // `admittedThisTick` — regardless of HOW the signal reached `done` (live
    // complete, reclaim, or post-boot). The earlier non-mutating `reclaim-held`
    // outcome STRANDED such a worker: a dead triage worker only reaches branch B
    // with a NON-terminal signal (a `done` signal short-circuits to `noop` at the
    // `klass === "terminal"` gate above), so holding it left the signal at
    // `running`, and STEP A's `s.triage === "done"` pool requirement then skipped
    // it forever. Flipping to `done` lands it exactly where STEP A expects it, so
    // the gate re-evaluates deps/priority/capacity next tick (and STEP B holds the
    // research dispatch until admitted). No phase is special-cased here.
    //
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
    // CTL-736 Phase 2 / CTL-664: derive the reclaim observability field from the
    // jobLifecycle verdict the trigger acted on. This branch is reached ONLY for
    // a reclaim-eligible worker (`dead-terminal` — Claude marked the job
    // stopped/failed/done/blocked — or `dead-gone` — the job dir vanished); an
    // `alive` worker returns at alive-suppressed above. Kept as a single const so
    // the mirror body reuses it. (`prev_state_json_mtime` stays as telemetry.)
    const death_signal = lifecycle;
    const probe_checked = describeProbe(phase);
    appendEvent({
      phase,
      ticket,
      orchId,
      orchDir,
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
    // CTL-932 fix #3: the phase SUCCEEDED (work committed) — clear any stale
    // never-started attempt marker so a much-later legitimate re-dispatch of the
    // same (ticket, phase) starts the wedge budget fresh instead of inheriting a
    // count>=cap that would escalate on the first transient blip.
    clearNeverStartedAttempts(orchDir, ticket, phase);
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

  // CTL-736 Phase 2: by the time control reaches branch (C) the worker is
  // reclaim-eligible — `dead-terminal` (Claude marked the job
  // stopped/failed/done/blocked) or `dead-gone` (the job dir vanished). Both are
  // definitive local verdicts, so the revive/re-dispatch path below is correct.
  //
  // The CTL-735 post-dispatch grace window (Guard 1, `revive-pending`) is DELETED:
  // it existed only because the eventually-consistent `claude agents` snapshot
  // showed a freshly-spawned worker as `absent`/`idle` before it registered. The
  // local state.json has no such lag — a just-(re)dispatched worker writes
  // state=working immediately, so jobLifecycle reads `alive` and never reaches
  // branch (C) until the job is genuinely terminal. No grace window is needed.

  // CTL-735 Guard 3 — inert stale tickets (KEPT in CTL-736: orthogonal to the
  // liveness mechanism). By here the worker is reclaim-eligible (dead-terminal or
  // dead-gone), work NOT done. If its signal has not been touched in reviveMaxAgeMs
  // it is an abandoned historical dir (isTicketInFlight keeps any non-terminal
  // signal in-flight forever, so a worker that crashed at `running` and never
  // flipped terminal is swept every tick). This gate runs BEFORE the progress gate
  // so the ~85 day-stale debris dirs are treated as inert (no revive, no escalate,
  // no event) rather than each getting a one-shot no-progress escalation →
  // needs-human storm. Branch (B) reclaim already ran above, so a genuinely
  // work-done old worker was cleaned up; only no-work abandoned dirs reach here.
  // A signal with no parseable timestamp (legacy) falls through unchanged.
  const lastActiveMs = Math.max(
    Date.parse(signal.raw?.updatedAt ?? "") || 0,
    Date.parse(signal.raw?.startedAt ?? "") || 0,
  );
  if (lastActiveMs > 0 && now() - lastActiveMs > reviveMaxAgeMs) {
    log.info(
      { ticket, phase, prevBgJobId, ageMs: now() - lastActiveMs, reviveMaxAgeMs },
      "ctl-735: signal too old to revive — abandoned historical dir, inert",
    );
    return "inert-stale";
  }

  // CTL-736 Phase 3 — THE progress gate. Replaces the MAX_REVIVES per-ticket
  // budget, the fleet-wide storm-breaker, and the per-tick revive cap with ONE
  // local, deterministic rule: a worker that ADVANCED its progress mark since the
  // last attempt is resumably revived (gen+1 — duplicate spawn is structurally
  // impossible via the Phase-1 O_EXCL claim + fencing generation, so no heuristic
  // budget is needed); a worker with ZERO new forward progress is a futile
  // respawn (the CTL-728/729 idle-never-takes-a-turn loop, research §3) → STOP +
  // flag needs-human, NEVER respawn. progressMark is monotonic-ish (commits-ahead
  // for code phases, artifact byte-size for doc/JSON phases); readProgressMark
  // returns -1 when no prior mark exists, so a first death always gets one revive
  // (a genuine early crash is retry-worthy) and a SECOND no-progress death stops.
  //
  // The gate is `<=` (stop on flat OR lower), NOT `===`. progressMark falls open
  // to 0 on a read failure (git error, worktree lock) — `<=` then errs toward a
  // STOP (a bounded, recoverable needs-human flag), whereas `===` would treat a
  // transient low read as "changed" and revive forever (the very storm this
  // retires). A legitimate decrease (origin/main advanced past the worker's
  // commits) likewise stops → needs-human, which is the correct conservative
  // outcome for a worker that is no longer ahead.
  const currentProgress = progressMark({ ticket, phase, repoRoot, orchDir });
  const lastProgress = readProgressMark(orchDir, ticket, phase);
  if (currentProgress <= lastProgress) {
    // Stop the dead worker (the reaper + an inline best-effort stop) and flag for
    // human — do NOT spawn another worker that would also make no progress. The
    // no-progress STOP is terminal (needs-human, no successor dispatch), so it
    // routes through the CTL-695 `phase.terminal.reap-requested` single-target
    // (busy-OK) reap path the reaper already handles — NOT a bespoke event type.
    if (prevBgJobId) {
      emitReapIntent("phase.terminal.reap-requested", {
        ticket,
        phase,
        bgJobId: prevBgJobId,
        worktreePath: signal.raw?.worktreePath,
        reason: "ctl-736-no-progress-stopped",
      }).catch(() => {});
      intentAwareKill({ bgJobId: prevBgJobId });
    }
    log.warn(
      { ticket, phase, prevBgJobId, currentProgress, lastProgress },
      "ctl-736: no forward progress since last attempt — stopping, not respawning",
    );
    // needs-human (cool-down + breaker guarded). When the Linear breaker is open
    // the escalation defers — surface that so the scheduler does not record a
    // clean stop (the worker is killed, but the label retries next tick).
    const esc = escalateOnce("no-progress", currentProgress);
    return esc === "rate-limited-deferred" ? "rate-limited-deferred" : "no-progress-stopped";
  }
  // Forward progress was made → record the new high-water mark and revive below.
  writeProgressMark(orchDir, ticket, phase, currentProgress);
  // CTL-932 fix #3: forward progress proves a replacement actually started and
  // is producing work — clear any never-started attempt marker so a much-later
  // wedge of the same (ticket, phase) earns a fresh replacement budget rather
  // than inheriting a stale count>=cap and escalating with zero retries.
  clearNeverStartedAttempts(orchDir, ticket, phase);

  // Attempt number for the revive audit + `.revive-N.applied` marker. This is now
  // TELEMETRY ONLY (no longer a budget gate — the progress gate bounds retries).
  // CTL-655: window the count to the current daemon run via the boot marker.
  const since = readBootSinceFn(orchDir);
  const priorRevives = countReviveEvents({ ticket, orchId, since });

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
    intentAwareKill({ bgJobId: prevBgJobId });
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
    orchDir,
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
  // CTL-761: forward the DISPATCH ordinal (= revive ordinal + 1; cold=1, first
  // revive=2) so the revived worker's terminal event carries phase.attempt /
  // phase.revive_count. `attempt` here is the revive ordinal (priorRevives+1).
  const dispatchRes = reviveDispatch({ orchDir, ticket, phase, resumeSession, attempt: attempt + 1 });
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

// readClusterHeartbeats — CTL-859. Scan the unified event log for
// `node.heartbeat` events and return the most-recent ISO timestamp seen for
// each host: { [hostName]: lastSeenISO }. DORMANT for now — no caller consumes
// this in PR1; later PRs (takeover/healing) use it to decide "dead" = no
// heartbeat for a generous grace window (see the design doc: 5–10 min).
//
// Reads the host name from the event payload (body.payload["host.name"]),
// falling back to the resource block (resource["host.name"]). Best-effort:
// missing log, unreadable file, and malformed lines are skipped, never thrown.
// `logPath` is injectable for tests; defaults to the same getEventLogPath()
// every emitter uses.
export function readClusterHeartbeats({
  logPath = getEventLogPath(),
  roster = getClusterHosts(),
  anchorIssue = getLivenessAnchorIssue(),
  readPeers = (anchor) => readPeerHeartbeatsSync({ anchorIssue: anchor }),
} = {}) {
  const lastSeen = {};
  let raw;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    // no event log yet — continue to peer merge below if multi-host
  }
  if (raw) {
    for (const line of raw.split("\n")) {
      if (!line) continue;
      if (!line.includes(HEARTBEAT_EVENT)) continue; // cheap pre-filter
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // partial/garbage line
      }
      if (evt?.attributes?.["event.name"] !== HEARTBEAT_EVENT) continue;
      const host =
        evt?.body?.payload?.["host.name"] ?? evt?.resource?.["host.name"];
      const ts = evt?.ts;
      if (typeof host !== "string" || host.length === 0) continue;
      if (typeof ts !== "string" || ts.length === 0) continue;
      // Keep the latest ts per host (ISO-8601 sorts lexicographically).
      if (!lastSeen[host] || ts > lastSeen[host]) lastSeen[host] = ts;
    }
  }

  // CTL-1090: multi-host cross-host merge. Single-host (roster<=1) ⇒ exact no-op.
  if (Array.isArray(roster) && roster.length > 1 && anchorIssue) {
    let peers = {};
    try {
      peers = readPeers(anchorIssue) ?? {};
    } catch {
      peers = {}; // fail-open: a Linear hiccup must never break liveness
    }
    for (const [host, rec] of Object.entries(peers)) {
      const ts = rec?.last_seen;
      if (typeof ts !== "string" || ts.length === 0) continue;
      // Keep freshest ts per host (ISO-8601 lexicographic sort = correct ISO comparison).
      if (!lastSeen[host] || ts > lastSeen[host]) lastSeen[host] = ts;
    }
  }

  return lastSeen;
}

// phaseAlreadyComplete — true when the unified event log already contains a
// `phase.<phase>.complete.<ticket>` event. The resume path checks this before
// re-dispatching so a survivor never re-emits a completion the dead host already
// emitted (dedup). Best-effort: a missing/unreadable log ⇒ false; never throws.
export function phaseAlreadyComplete(
  ticket,
  phase,
  { readLog = () => readFileSync(getEventLogPath(), "utf8") } = {},
) {
  const needle = `phase.${phase}.complete.${ticket}`;
  let raw;
  try {
    raw = readLog();
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (!line || !line.includes(needle)) continue;
    try {
      if (JSON.parse(line)?.attributes?.["event.name"] === needle) return true;
    } catch {
      // partial/malformed line — skip
    }
  }
  return false;
}

// RESUME_PHASE_ORDER — the linear pipeline phases in forward order, derived from
// STAGE_RANK (ancillary `remediate` excluded). Reverse-walked by inferResumePhase.
const RESUME_PHASE_ORDER = Object.entries(STAGE_RANK)
  .filter(([id]) => id !== "remediate")
  .sort((a, b) => a[1] - b[1])
  .map(([id]) => id);

// deadHosts — given last-seen heartbeats, the roster, a grace window, and now,
// return roster hosts whose newest heartbeat is older than (nowMs - graceMs).
// A host ABSENT from lastSeen is NOT flagged dead: with per-host local logs the
// survivor may simply never have seen it (Open Question 1). Conservative: unknown ⇒ alive.
export function deadHosts({ lastSeen, roster, graceMs, nowMs }) {
  const cutoff = nowMs - graceMs;
  return roster.filter((h) => {
    const seen = lastSeen[h];
    if (!seen) return false; // never seen here ⇒ not our call to make
    return Date.parse(seen) < cutoff; // last heartbeat older than grace ⇒ dead
  });
}

// survivingRoster — roster minus the dead hosts. Pure; never mutates the input
// (dead hosts stay in committed hosts.json; this is a transient in-memory subset).
export function survivingRoster(roster, dead) {
  const deadSet = new Set(dead);
  return roster.filter((h) => !deadSet.has(h));
}

// inferResumePhase — walk the pipeline in REVERSE; the first probe that returns
// true is the last completed phase, so resume at the phase after it. Returns the
// entry phase when nothing is done, and null when every phase is complete (terminal).
// The `probes` option accepts the same (ticket, opts) signature as WORK_DONE_PROBES;
// tests inject uniform `async () => bool` fakes.
export async function inferResumePhase(ticket, { probes = WORK_DONE_PROBES, cwd } = {}) {
  for (let i = RESUME_PHASE_ORDER.length - 1; i >= 0; i--) {
    const phase = RESUME_PHASE_ORDER[i];
    const probe = probes[phase];
    if (typeof probe !== "function") continue;
    if (await probe(ticket, { cwd })) {
      const next = RESUME_PHASE_ORDER[i + 1];
      return next ?? null; // last phase done ⇒ terminal
    }
  }
  return NEW_WORK_ENTRY_PHASE; // nothing done ⇒ start at entry
}

// defaultOwnedTicketsForHost — return the in-flight tickets for a dead host.
// Primary path (CTL-1090): read the dead host's published `in_flight_tickets`
// from the cross-host liveness channel (one Linear read = liveness + tickets).
// Fallback: scan the local worker signal directory for non-terminal signals
// dispatched from the dead host (the original local-only behavior, unchanged).
// `anchorIssue`/`readPeers` are injectable for unit tests.
function defaultOwnedTicketsForHost(deadHost, {
  orchDir,
  anchorIssue = getLivenessAnchorIssue(),
  readPeers = (anchor) => readPeerHeartbeatsSync({ anchorIssue: anchor }),
} = {}) {
  if (anchorIssue) {
    try {
      const peerMap = readPeers(anchorIssue);
      const rec = peerMap?.[deadHost];
      if (Array.isArray(rec?.in_flight_tickets) && rec.in_flight_tickets.length > 0) {
        return [...new Set(rec.in_flight_tickets)];
      }
    } catch { /* fail-open → local scan */ }
  }
  // Fallback: local signal scan (original behavior; also runs when anchor unset).
  const signals = readWorkerSignals(orchDir);
  const tickets = new Set();
  for (const sig of signals) {
    if (!sig.raw?.host?.name || sig.raw.host.name !== deadHost) continue;
    // Only include non-terminal tickets — terminal ones are already done.
    if (TERMINAL.has(sig.status)) continue;
    tickets.add(sig.ticket);
  }
  return [...tickets];
}

// reclaimDeadHostWork — takeover sweep (CTL-863, Part A).
//
// When a host goes silent (heartbeat silence > graceMs), surviving hosts detect it,
// re-own its tickets via HRW over the surviving roster, claim (gen+1) via CAS, infer
// the last-completed phase from durable artifacts, and dispatch the next phase —
// skipping any phase already present in the event log.
//
// SINGLE-HOST INSTALLS ARE AN EXACT NO-OP: the function short-circuits immediately
// when `roster.length <= 1`. Every new behavior is gated on multiHost.
//
// All collaborators are injectable for unit tests (no network, fs, or subprocess
// in tests — they inject fakes for every seam).
export async function reclaimDeadHostWork(
  { orchDir },
  {
    readHeartbeats = () => readClusterHeartbeats({}),
    roster = getClusterHosts(),
    self = getHostName(),
    graceMs = HEARTBEAT_GRACE_MS,
    nowMs = Date.now(),
    ownedTicketsForHost = (deadHost) => defaultOwnedTicketsForHost(deadHost, { orchDir }),
    ownerForTicket: ownerFn = ownerForTicket,
    claim = (ticket, phase) => claimDispatchSync({ ticket, hostName: self, phase }),
    inferResume = (ticket, cwd) => inferResumePhase(ticket, { cwd }),
    alreadyComplete = (ticket, phase) => phaseAlreadyComplete(ticket, phase),
    rebuildWorktree = (ticket) => {
      const result = defaultRebuildWorktree(ticket, { orchDir });
      return result;
    },
    thoughtsPull = (cwd) => defaultThoughtsPull(cwd),
    dispatch = (od, ticket, phase, cwd) =>
      dispatchTicket(od, ticket, phase, { dispatch: defaultDispatch }),
  } = {},
) {
  const taken = [];

  // Single-host no-op (every new behavior gated on multiHost).
  if (!Array.isArray(roster) || roster.length <= 1) return { taken };

  const lastSeen = readHeartbeats();
  const dead = deadHosts({ lastSeen, roster, graceMs, nowMs });
  if (dead.length === 0) return { taken };

  const survivors = survivingRoster(roster, dead);

  for (const deadHost of dead) {
    const tickets = ownedTicketsForHost(deadHost) ?? [];
    for (const ticket of tickets) {
      // HRW check: are we the new owner over the surviving roster?
      if (ownerFn(ticket, survivors) !== self) continue;

      // Soft-CAS claim: bump generation to take ownership.
      const claimRes = claim(ticket, NEW_WORK_ENTRY_PHASE);
      if (!claimRes?.won) continue;

      // Rebuild the worktree on the ticket branch.
      const wt = rebuildWorktree(ticket);
      if (!wt?.ok) continue;

      // CTL-866: refresh thoughts/ before the artifact probes read it, so a
      // takeover host sees the dead host's pushed research/plan docs.
      // Fail-open: a failed pull must not abort reclaim (worst case the probe
      // re-dispatches, the prior behavior).
      try { thoughtsPull(wt.cwd); } catch { /* fail-open */ }

      // Infer the next phase to dispatch from durable artifacts.
      const phase = await inferResume(ticket, wt.cwd);
      if (!phase) continue; // terminal — nothing to resume

      // Dedup: skip if the dead host already emitted this phase's complete event.
      if (alreadyComplete(ticket, phase)) continue;

      const r = dispatch(orchDir, ticket, phase, wt.cwd);
      if (r?.code === 0) {
        taken.push({ ticket, phase, generation: claimRes.generation });
      }
    }
  }

  return { taken };
}

// defaultThoughtsPull — refresh the thoughts/ git repo inside the rebuilt
// worktree before artifact probes read it. Best-effort; `humanlayer thoughts
// sync` is the available primitive (no `thoughts pull` subcommand exists).
// Returns { ok }. Never throws (caller also guards).
function defaultThoughtsPull(cwd) {
  try {
    const res = spawnSync("humanlayer", ["thoughts", "sync"], { cwd, stdio: "ignore" });
    return { ok: res.status === 0 };
  } catch {
    return { ok: false };
  }
}

// defaultRebuildWorktree — fetch the ticket branch and add/reuse the worktree.
// Best-effort; returns { ok, cwd }. Fail-open: errors produce { ok: false, cwd: null }.
function defaultRebuildWorktree(ticket, { orchDir }) {
  try {
    const repoRoot = join(orchDir, "..", "..");
    const res = createWorktree({ ticket, repoRoot });
    if (res?.code === 0 && res.worktreePath) return { ok: true, cwd: res.worktreePath };
    return { ok: false, cwd: null };
  } catch {
    return { ok: false, cwd: null };
  }
}
