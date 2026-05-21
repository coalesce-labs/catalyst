// monitor.mjs — execution-core monitor core (CTL-535 Phase 4).
//
// The orchestration layer of the Linear Todo-state monitor: event parsing
// (canonical OTel + legacy flat shapes), per-project and all-project
// reconcile, the event-driven fast path (confident removal + debounced
// reconcile), the byte-offset event-log tailer, the periodic reconcile timer,
// and the startMonitor/stopMonitor lifecycle.
//
// Event-vs-poll division of labour: a linear.issue.state_changed event can
// only CONFIRM A REMOVAL (the new state left the eligible state) or TRIGGER A
// RECONCILE (it may have entered) — the payload carries no project/label/
// priority, so additions and scoping are resolved exclusively by the poll.

import { watch, openSync, fstatSync, readSync, closeSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import {
  getEventLogPath,
  RECONCILE_INTERVAL_MS,
  EVENT_DEBOUNCE_MS,
  log,
} from "./config.mjs";
import { listEnrolledProjects, loadProjectConfig } from "./enrollment.mjs";
import { runEligibleQuery } from "./linear-query.mjs";
import { setProjectEligible, removeTicket, dropProject } from "./eligible-set.mjs";
import { loadCursor, saveCursor, resolveStartOffset } from "./event-cursor.mjs";
import { dispatchTicket } from "./dispatch.mjs";
import { abortWorker as defaultAbortWorker } from "./abort-worker.mjs";

// --- Event parsing -------------------------------------------------------

// parseStateChangedEvent — accept both the canonical OTel envelope
// (attributes['event.name'] + body.payload) and the legacy flat shape
// (event.event + event.detail). Returns null for anything that is not a
// linear.issue.state_changed event with an extractable ticket identifier.
export function parseStateChangedEvent(event) {
  const name = event?.attributes?.["event.name"] ?? event?.event;
  if (name !== "linear.issue.state_changed") return null;
  const payload = event?.body?.payload ?? event?.detail ?? {};
  const identifier =
    event?.attributes?.["linear.issue.identifier"] ??
    payload.ticket ??
    payload.identifier ??
    null;
  if (!identifier) return null;
  return {
    identifier,
    teamKey: payload.teamKey ?? null,
    toState: payload.toState ?? null,
  };
}

// --- Reconcile -----------------------------------------------------------

// Projects that have been reconciled at least once — used by reconcileAll to
// detect un-enrolled projects that must be dropProject'd.
const knownProjects = new Set();

// reconcileProject — the authoritative per-project rebuild. A failed poll
// THROWS inside runEligibleQuery; we log and return, preserving the prior
// eligible set rather than flattening it to empty.
export function reconcileProject(projectKey, repoRoot, { exec } = {}) {
  const query = loadProjectConfig(repoRoot);
  if (!query) {
    log.warn(
      { projectKey },
      "enrolled but no executionCore.eligibleQuery — skipping",
    );
    return;
  }
  let tickets;
  try {
    tickets = runEligibleQuery(query, { exec });
  } catch (err) {
    log.error(
      { projectKey, err: err.message },
      "reconcile poll failed — preserving prior eligible set",
    );
    return;
  }
  try {
    setProjectEligible(projectKey, tickets, { source: "reconcile", query });
  } catch (err) {
    // A projection write/rename failure (disk full, permissions) must NOT
    // crash the daemon: reconcileProject runs inside reconcileAll, itself
    // driven by the setInterval reconcile timer, so an uncaught throw here
    // would kill the process. The in-memory eligible set is already current
    // (setProjectEligible updates the Map before persisting), so the next
    // reconcile tick retries the disk write.
    log.error(
      { projectKey, err: err.message },
      "eligible-set projection write failed — daemon continues, retry next reconcile",
    );
  }
}

// reconcileAll — full reconcile of every enrolled project (the missed-webhook
// backstop). Re-globs the enrollment directory each call so newly enrolled
// projects are picked up and un-enrolled ones are dropped within one tick.
export function reconcileAll({ exec } = {}) {
  const enrolled = listEnrolledProjects();
  const seen = new Set(enrolled.map((p) => p.projectKey));
  for (const p of enrolled) reconcileProject(p.projectKey, p.repoRoot, { exec });
  for (const stale of knownProjects) {
    if (!seen.has(stale)) {
      dropProject(stale);
      log.info({ projectKey: stale }, "project no longer enrolled — dropped");
    }
  }
  knownProjects.clear();
  for (const k of seen) knownProjects.add(k);
}

// --- Event-driven fast path ---------------------------------------------

// projectKey -> pending debounce timer handle.
const dirtyTimers = new Map();

// handleStateChangedEvent — fold one state_changed event into the eligible
// sets of every project whose query team matches the event's team.
//
// CTL-565 two-state trigger: the toState branch is a three-way split.
//   →triageStatus  one-shot-dispatches the triage phase agent (NOT the
//                  eligible set — a Triage ticket is never scheduler-pulled).
//   →status (Ready) reconciles into the scheduler-eligible set.
//   anything else   the leave-path — a confident immediate removal.
export function handleStateChangedEvent(
  event,
  {
    exec,
    debounceMs = EVENT_DEBOUNCE_MS,
    dispatch,
    orchDir,
    abortWorker = defaultAbortWorker,
  } = {},
) {
  const parsed = parseStateChangedEvent(event);
  if (!parsed) return;
  for (const p of listEnrolledProjects()) {
    const query = loadProjectConfig(p.repoRoot);
    if (!query || query.team !== parsed.teamKey) continue;

    if (parsed.toState === query.triageStatus) {
      // →Triage — one-shot dispatch the triage phase agent. NOT the eligible
      // set: a Triage ticket is never scheduler-pulled. Idempotent downstream
      // (phase-agent-dispatch no-ops an existing signal file).
      dispatchTriage(parsed.identifier, { dispatch, orchDir });
    } else if (!parsed.toState || parsed.toState === query.status) {
      // →Ready (or an unknown new state) — the event cannot confirm
      // project/label/priority scoping, so a full poll is required. Debounce
      // it so a burst of events coalesces into one reconcile.
      scheduleDirtyReconcile(p.projectKey, p.repoRoot, { exec, debounceMs });
    } else {
      // Left both watched states (→Backlog/→Canceled). Confident immediate
      // removal, then abort any in-flight worker and tear down its worktree.
      // removeTicket persists the projection itself; removing a non-member is
      // a safe no-op. abortWorker no-ops when the ticket was never dispatched.
      removeTicket(p.projectKey, parsed.identifier);
      if (orchDir) {
        abortWorker(orchDir, parsed.identifier, {
          projectKey: p.projectKey,
          repoRoot: p.repoRoot,
        });
      }
    }
  }
}

// dispatchTriage — fire the triage phase agent for a →Triage transition. Guards
// a missing orchDir (a standalone monitor with no daemon wiring) and logs —
// never throws — a non-zero dispatch.
function dispatchTriage(identifier, { dispatch, orchDir }) {
  if (!orchDir) {
    log.warn({ identifier }, "→Triage seen but monitor has no orchDir — skipping dispatch");
    return;
  }
  const r = dispatchTicket(orchDir, identifier, "triage", { dispatch });
  if (r.code !== 0) {
    log.warn({ identifier, code: r.code }, "monitor: triage dispatch failed");
  }
}

function scheduleDirtyReconcile(projectKey, repoRoot, { exec, debounceMs }) {
  clearTimeout(dirtyTimers.get(projectKey));
  dirtyTimers.set(
    projectKey,
    setTimeout(() => {
      dirtyTimers.delete(projectKey);
      reconcileProject(projectKey, repoRoot, { exec });
    }, debounceMs),
  );
}

// --- Byte-offset event-log tailer ---------------------------------------
// Mirrors broker/tailer.mjs: follow ~/catalyst/events/YYYY-MM.jsonl via
// fs.watch, reading only the bytes appended since the last call.

let lastByteOffset = 0;
let lastLogPath = "";
let leftoverBuf = "";
let watcher = null;
let reconcileTimer = null;
let tailerOpts = {};

// fileSizeOrZero — current byte size of a file, or 0 when it does not exist
// (the poll-only state). Shared by both tailer seeders.
function fileSizeOrZero(path) {
  try {
    const fd = openSync(path, "r");
    const { size } = fstatSync(fd);
    closeSync(fd);
    return size;
  } catch {
    return 0; // log file does not exist yet — poll-only mode
  }
}

// seedTailerAtEof — pin the tailer to the current end of the event log so the
// startup reconcile poll (not a log replay) is the authoritative rebuild.
export function seedTailerAtEof() {
  lastLogPath = getEventLogPath();
  leftoverBuf = "";
  lastByteOffset = fileSizeOrZero(lastLogPath);
}

// seedTailerFromCursor — pin the tailer to the durable cursor's saved offset so
// a daemon restart resumes the fast path mid-stream. resolveStartOffset falls
// back to EOF for a missing/stale/rotated cursor; the periodic reconcile is the
// correctness backstop either way. CTL-539.
export function seedTailerFromCursor() {
  lastLogPath = getEventLogPath();
  leftoverBuf = "";
  lastByteOffset = resolveStartOffset({
    cursor: loadCursor(),
    logPath: lastLogPath,
    fileSize: fileSizeOrZero(lastLogPath),
  });
}

// readNewEvents — drain bytes appended since the last call, parse each
// complete line, and feed it to handleStateChangedEvent. A leftover buffer
// carries partial lines; on month rollover the new file is re-seeded at its
// current size (its tail is not replayed).
//
// Exported for deterministic test drives + the CTL-539 startup gap-drain; the
// index.mjs barrel deliberately does not re-export it.
export function readNewEvents() {
  const logPath = getEventLogPath();
  if (logPath !== lastLogPath) {
    lastLogPath = logPath;
    leftoverBuf = "";
    try {
      const fd = openSync(logPath, "r");
      lastByteOffset = fstatSync(fd).size;
      closeSync(fd);
    } catch {
      lastByteOffset = 0;
    }
    return;
  }
  try {
    const fd = openSync(logPath, "r");
    const { size } = fstatSync(fd);
    if (size <= lastByteOffset) {
      closeSync(fd);
      return;
    }
    const newByteCount = size - lastByteOffset;
    const buf = Buffer.alloc(newByteCount);
    readSync(fd, buf, 0, newByteCount, lastByteOffset);
    closeSync(fd);
    lastByteOffset = size;
    // CTL-539: persist the durable cursor so a restart resumes here. saveCursor
    // is best-effort — it swallows and logs its own write failures.
    saveCursor({ logPath: lastLogPath, byteOffset: lastByteOffset });

    const text = leftoverBuf + buf.toString("utf8");
    const lines = text.split("\n");
    leftoverBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // skip a malformed line, keep tailing
      }
      handleStateChangedEvent(event, tailerOpts);
    }
  } catch {
    // log file not yet created or a transient read error — best-effort
  }
}

// startTailing — fs.watch the events dir; on change, drain new bytes. The
// tailer is best-effort: if the event log never appears the watcher simply
// never fires and the reconcile poll alone maintains the eligible set.
export function startTailing() {
  const eventsDir = dirname(getEventLogPath());
  mkdirSync(eventsDir, { recursive: true });
  watcher = watch(eventsDir, (eventType, filename) => {
    if (eventType !== "change") return;
    if (filename !== null && filename !== basename(getEventLogPath())) return;
    readNewEvents();
  });
  return watcher;
}

// --- Lifecycle -----------------------------------------------------------

// startMonitor — immediate reconcileAll (authoritative initial rebuild), seed
// the tailer, start tailing, then arm the periodic reconcile timer. With
// resumeFromCursor (default, CTL-539) the tailer resumes from the durable
// cursor and the cursor→EOF downtime gap is drained immediately; otherwise it
// seeds at EOF (the legacy poll-only-on-startup behavior).
export function startMonitor({
  exec,
  debounceMs = EVENT_DEBOUNCE_MS,
  reconcileIntervalMs = RECONCILE_INTERVAL_MS,
  resumeFromCursor = true,
  orchDir,
  dispatch,
  abortWorker,
} = {}) {
  // CTL-565: orchDir + dispatch + abortWorker are stored in tailerOpts so the
  // tailer-driven readNewEvents → handleStateChangedEvent path can one-shot-
  // dispatch triage and abort a dragged-out worker. When abortWorker is left
  // undefined, handleStateChangedEvent falls back to its real default.
  tailerOpts = { exec, debounceMs, orchDir, dispatch, abortWorker };
  reconcileAll({ exec });
  if (resumeFromCursor) {
    seedTailerFromCursor();
    readNewEvents(); // drain the cursor→EOF downtime gap immediately
  } else {
    seedTailerAtEof();
  }
  startTailing();
  reconcileTimer = setInterval(() => reconcileAll({ exec }), reconcileIntervalMs);
}

// stopMonitor — clear the reconcile interval, all pending debounce timers,
// and the file watcher. Idempotent and safe to call when nothing is running.
export function stopMonitor() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  for (const t of dirtyTimers.values()) clearTimeout(t);
  dirtyTimers.clear();
  watcher?.close();
  watcher = null;
}

// __tailerOffset — the tailer's current byte offset. Test-only, for
// deterministic cursor-seeding assertions; kept out of the index.mjs barrel.
export function __tailerOffset() {
  return lastByteOffset;
}

// __resetForTests — clear all module-level state between unit tests. Not part
// of the public monitor contract; index.mjs does not re-export it.
export function __resetForTests() {
  stopMonitor();
  knownProjects.clear();
  lastByteOffset = 0;
  lastLogPath = "";
  leftoverBuf = "";
  tailerOpts = {};
}
