// respond-ticket.mjs — the read-model's SECOND write endpoint (CTL-924, BFF12).
//
// HOME5's Inbox `Answer / Unblock` verb needs a read-model WRITE that does three
// things to a HELD ticket and then hands control back to the daemon:
//
//   1. RECORD the operator's response (their answer / unblock note) so the human's
//      input is durable — written as a `.respond-<phase>.json` artifact in the
//      ticket's worker dir AND carried in the resume event's payload (the unified
//      event log is the system-wide record).
//   2. CLEAR the `needs-human` label + the `.linear-label-needs-human.applied`
//      once-marker. This is the exact inverse of the daemon's labelOnce guard
//      (execution-core/label-guard.mjs clearStalledLabel, CTL-646): the label is
//      removed from Linear AND the marker deleted, together, so the daemon's apply
//      guard re-arms and a stale-label / stale-marker split-brain can't form.
//   3. TRIGGER re-dispatch — CTL-876's resume loop. The daemon already resumes a
//      parked (`status:"needs-input"`) worker on a `linear.comment.created` event
//      for the ticket (execution-core/daemon.mjs handleCommentWake, CTL-549): it
//      removes the held label and re-dispatches the parked phase with its handoff.
//      So this endpoint emits ONE canonical `linear.comment.created` event into
//      the unified event log carrying the operator's response as the comment body.
//      The monitor NEVER calls dispatchTicket directly — it stays on the
//      "UI triggers, the daemon dispatches" side of the boundary (the same shape
//      BFF8's stop endpoint keeps: it issues the kill, it does not own the daemon).
//
// SHARED MUTATION FOUNDATION with BFF8 (stop-worker.mjs): this endpoint reuses
// stop-worker's typed-confirm gate + fence-check scaffolding verbatim
// (runFenceCheck / readClusterHostCount are imported, not re-implemented) so the
// two web writes never diverge. The optimistic-rollback contract is identical —
// the endpoint returns the verbatim { ticket, phase } identity + a `resuming`
// status the client marks optimistically and rolls back against the next board
// frame (the held label/row should clear within the rollback window).
//
// FENCE-AWARE (multi-node requirement, CTL-863/864): before mutating, the
// endpoint passes the run signal's generation through the cross-host fence-check.
// A request whose generation is behind the current fence (fence-check exit 10 =
// stale) is REJECTED and NOTHING is mutated — a partitioned / stale node cannot
// unblock a ticket the cluster has taken over. SINGLE-HOST (hosts.json absent /
// length <= 1) is an identity NO-OP pass: the fence-check never spawns, the
// response is recorded and the ticket resumed normally with zero added latency.
//
// READ-then-ACT, fail-safe: no held run signal for the ticket → 404 (nothing to
// answer); a verified-stale fence → 409 fenced; an indeterminate multi-host fence
// → 409 (do NOT mutate on an unconfirmed fence — the conservative answer for a
// write). All collaborators (signal read, fence-check, label clear, response
// record, event emit) are injectable so the route + unit tests drive every branch
// without a real worker dir, a real hosts.json, a real `linearis`, or a real
// event log.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readClusterHostCount, runFenceCheck } from "./stop-worker.mjs";
import { PHASE_ORDER } from "./board-data.mjs";
import { nodeClass } from "./canonical-event-shared.ts";

// The execution-core worker tree root — ~/catalyst/execution-core/workers/<T>/.
// Byte-identical to ticket-runs.mjs::DEFAULT_WORKERS_DIR and board-data.mjs's
// WORKERS_DIR (the on-disk home of both the phase-*.json signals AND the
// .linear-label-needs-human.applied marker the daemon's labelOnce writes there).
const HOME = homedir();
const DEFAULT_WORKERS_DIR = join(HOME, "catalyst", "execution-core", "workers");

// The held marker the daemon's labelOnce (label-guard.mjs) writes when it applies
// the flat `needs-human` label. clearStalledLabel deletes BOTH this and the
// `.skipped` sibling on a confirmed removal; we mirror that exactly.
const NEEDS_HUMAN_LABEL = "needs-human";

// re-export the shared fence primitives so the endpoint + tests resolve one
// fence implementation (DRY with BFF8 — never a second copy that can drift).
export { readClusterHostCount, runFenceCheck };

// ── the unified-event-log resume trigger ─────────────────────────────────────
// getEventLogPath — the canonical monthly event log path. UTC month to match the
// orch-monitor event-writer (event-writer.ts uses getUTCFullYear/getUTCMonth) and
// the execution-core tailer (config.mjs::getEventLogPath), so the event we append
// lands on the SAME file the daemon's monitor follows. CATALYST_DIR override is
// honored (tests + non-default roots) exactly like config.mjs::catalystDir.
export function eventLogPath({ env = process.env, now = new Date() } = {}) {
  const root = env.CATALYST_DIR ? env.CATALYST_DIR : join(HOME, "catalyst");
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(root, "events", `${ym}.jsonl`);
}

// buildResumeEvent — a canonical `linear.comment.created` event carrying the
// operator's response as the comment body. This is the shape the daemon's
// monitor.mjs::parseCommentCreatedEvent reads (event.name + body.payload.{ticket,
// body, authorId, ...}) and handleCommentWake acts on. authorId is left null: the
// daemon's self-echo guard (_isBotId) is fail-open on an unset/non-bot author, so
// an operator-originated resume event is never mistaken for the bot's own comment.
export function buildResumeEvent({ ticket, response, now = new Date() }) {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: {
      "service.name": "catalyst.orch-monitor",
      "service.namespace": "catalyst",
      // CTL-1368: node CLASS (developer|worker|monitor). host fields are
      // deliberately omitted here (this bare resource never carried them);
      // node.class is the only added key, sourced from nodeClass(), kept LAST.
      "catalyst.node.class": nodeClass(),
    },
    attributes: {
      "event.name": "linear.comment.created",
      "event.entity": "linear",
      "event.action": "comment.created",
      "event.label": ticket,
      "linear.issue.identifier": ticket,
    },
    body: {
      payload: {
        ticket,
        // The operator's answer/unblock note IS the comment body — the durable
        // system-wide record of the human's response (the daemon re-dispatches on
        // ANY ticket comment; the body is the recorded answer, not a trigger flag).
        body: typeof response === "string" ? response : "",
        commentId: null,
        issueId: null,
        // Null author → the daemon's self-echo guard is fail-open (not the bot).
        authorId: null,
        authorName: "operator (web)",
        // Mark the provenance so an operator can tell a web-resume from a real
        // Linear comment when scanning the unified log.
        source: "orch-monitor/respond",
      },
    },
  };
}

// emitResumeEvent — append the resume event to the unified event log (best-effort
// disk write; the daemon's monitor tails the file and resumes). Returns the path
// written so the caller can surface it. The `append`/`pathFor` seams are injected
// in tests so nothing touches the real log.
export function emitResumeEvent(
  { ticket, response },
  { append = appendFileSync, pathFor = eventLogPath, mkdir = mkdirSync, now = new Date() } = {},
) {
  const event = buildResumeEvent({ ticket, response, now });
  const path = pathFor({ now });
  mkdir(dirname(path), { recursive: true });
  append(path, JSON.stringify(event) + "\n");
  return { path, event };
}

// ── clear the needs-human label + marker (inverse of labelOnce) ──────────────
// clearNeedsHumanMarker — delete the `.linear-label-needs-human.{applied,skipped}`
// once-marker(s) under the ticket's worker dir, re-arming the daemon's labelOnce
// guard. Mirrors label-guard.mjs::clearStalledLabel's marker half exactly. The
// Linear LABEL removal itself rides on the daemon's handleCommentWake (it strips
// the held label as it re-dispatches), so this endpoint owns only the local
// marker — clearing it WITHOUT the daemon also clearing the label would re-arm
// the apply, which is the safe direction (the daemon re-applies if still held).
// Best-effort, never throws. Returns the list of markers actually removed.
export function clearNeedsHumanMarker(
  { ticket, label = NEEDS_HUMAN_LABEL },
  { workersDir = DEFAULT_WORKERS_DIR, rm = unlinkSync } = {},
) {
  const base = join(workersDir, ticket, `.linear-label-${label}`);
  const removed = [];
  for (const suffix of [".applied", ".skipped"]) {
    const p = `${base}${suffix}`;
    try {
      rm(p);
      removed.push(p);
    } catch {
      /* absent / unreadable → nothing to clear for this suffix */
    }
  }
  return removed;
}

// ── record the operator's response ───────────────────────────────────────────
// recordResponse — durably write the operator's answer/unblock note as a
// `.respond-<phase>.json` artifact in the ticket's worker dir, alongside the
// phase signal it answers. Best-effort; never throws (the resume event in the
// unified log is the authoritative record, this is the local breadcrumb).
export function recordResponse(
  { ticket, phase, response, now = new Date() },
  { workersDir = DEFAULT_WORKERS_DIR, write = writeFileSync, mkdir = mkdirSync } = {},
) {
  const dir = join(workersDir, ticket);
  const path = join(dir, `.respond-${phase}.json`);
  const record = {
    ticket,
    phase,
    response: typeof response === "string" ? response : "",
    respondedAt: now.toISOString(),
    source: "orch-monitor/respond",
  };
  try {
    mkdir(dir, { recursive: true });
    write(path, JSON.stringify(record, null, 2));
    return { path, record };
  } catch {
    return { path: null, record };
  }
}

// ── find the held run for a ticket ───────────────────────────────────────────
// findHeldRun — scan the ticket's worker dir for the phase signal that is held
// awaiting an operator: parked for input (status "needs-input") OR a stalled
// escalation (status "stalled") the daemon flagged needs-human (CTL-1067).
// Returns { phase, signal } for the first held run in PHASE_ORDER, or null.
export function findHeldRun(
  ticket,
  { workersDir = DEFAULT_WORKERS_DIR, readDir = readdirSync, read = readFileSync } = {},
) {
  let files;
  try {
    files = readDir(join(workersDir, ticket));
  } catch {
    return null; // no worker dir → nothing held
  }
  const phaseFiles = new Set(
    files.filter((f) => f.startsWith("phase-") && f.endsWith(".json")),
  );
  for (const phase of PHASE_ORDER) {
    const fname = `phase-${phase}.json`;
    if (!phaseFiles.has(fname)) continue;
    let sig;
    try {
      sig = JSON.parse(read(join(workersDir, ticket, fname), "utf8"));
    } catch {
      continue;
    }
    if (
      sig &&
      typeof sig === "object" &&
      (sig.status === "needs-input" || sig.status === "stalled")
    ) {
      return { phase, signal: sig };
    }
  }
  return null;
}

// ── orchestration: the endpoint body ─────────────────────────────────────────
// respondTicket — drive the full BFF12 contract for
// `POST /api/ticket/<ticket>/respond`. Outcome is a discriminated result the route
// maps to an HTTP status:
//   { status: "not_held" }                          → 404: no parked or stalled
//                                                      run for the ticket — nothing
//                                                      to answer / unblock.
//   { status: "confirm_mismatch", expected }         → 400: typed confirm wrong.
//   { status: "fenced", ticket, phase }              → 409: a verified-stale fence
//                                                      (exit 10) — a partitioned
//                                                      node is rejected, NOTHING
//                                                      mutated.
//   { status: "fence_indeterminate", ticket, phase } → 409: multi-host fence could
//                                                      not be confirmed — refuse.
//   { status: "resuming", ticket, phase, fenceNoop } → 200: response recorded,
//                                                      marker cleared, resume event
//                                                      emitted; the UI marks the row
//                                                      `resuming` optimistically and
//                                                      arms its rollback timer.
//
// confirm is the typed-confirm token (the operator types the ticket id back), the
// same gate BFF8 uses; mismatch is a hard 400 BEFORE any mutation. All
// collaborators are injectable so tests cover every branch deterministically.
export function respondTicket(
  { ticket, response, confirm },
  {
    findHeld = findHeldRun,
    fenceCheck = runFenceCheck,
    record = recordResponse,
    clearMarker = clearNeedsHumanMarker,
    emit = emitResumeEvent,
  } = {},
) {
  // Read first — the held run is BOTH the existence check and the source of the
  // generation we fence-check + the phase we record/resume. 404 when nothing held.
  const held = findHeld(ticket);
  if (!held) {
    return { status: "not_held" };
  }
  const { phase, signal } = held;

  // Typed confirm: the operator must type the ticket id back, exactly. Gate BEFORE
  // any mutation (mirrors BFF8 stop-worker).
  if (confirm !== ticket) {
    return { status: "confirm_mismatch", expected: ticket };
  }

  // Fence-aware guard (single-host no-op pass; multi-host CLI). The generation we
  // fence-check is the held run signal's own generation (surfaced by BFF10).
  const generation =
    typeof signal.generation === "number" && Number.isFinite(signal.generation)
      ? signal.generation
      : null;
  const fence = fenceCheck({ ticket, generation });
  if (!fence.ok) {
    return fence.stale
      ? { status: "fenced", ticket, phase }
      : { status: "fence_indeterminate", ticket, phase };
  }

  // Fence current (or single-host no-op): mutate. Record the human's response,
  // clear the needs-human marker (re-arm the daemon's apply guard), then emit the
  // resume event that drives CTL-876's loop (handleCommentWake re-dispatches).
  record({ ticket, phase, response });
  clearMarker({ ticket });
  emit({ ticket, response });

  return { status: "resuming", ticket, phase, fenceNoop: fence.noop === true };
}
