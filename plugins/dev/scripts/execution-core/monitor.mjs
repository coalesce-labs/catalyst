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
import { listProjects, getProjectConfig, resolveEligibleQuery } from "./registry.mjs";
import { runEligibleQuery } from "./linear-query.mjs";
import { setProjectEligible, removeTicket, dropProject } from "./eligible-set.mjs";
import { loadCursor, saveCursor, resolveStartOffset } from "./event-cursor.mjs";
import { dispatchTicket } from "./dispatch.mjs";
import { abortWorker as defaultAbortWorker } from "./abort-worker.mjs";

// DRAG_OUT_STATES — the Linear workflow states that signal "stop work on this
// ticket". The monitor classifies these as a kill: remove the ticket from the
// eligible projection and abort any in-flight worker. CTL-584: any other
// non-Triage/non-Ready state — including the daemon's own CTL-558 write-backs
// (Research/Plan/Implement/Validate/PR/Done) — is a NO-OP, not a kill. The
// design (2026-05-21-linear-state-machine-trigger-model.md, "Human Override /
// Kill") names Backlog/Canceled; Duplicate is included because Linear ships it
// by default and users sometimes pick it instead of Canceled. Conservative
// enumeration: a missed kill is recoverable (the next reconcile drops the
// ticket from the eligible set anyway), a wrong kill destroys live work.
const DRAG_OUT_STATES = new Set(["Backlog", "Canceled", "Duplicate"]);

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

// Teams that have been reconciled at least once — used by reconcileAll to
// detect teams dropped from the registry that must be dropProject'd.
const knownProjects = new Set();

// reconcileProject — the authoritative per-project rebuild, keyed by Linear
// team (CTL-582: the eligible projection and reconcile both key on `team`).
// Re-resolves the team's registry entry each call so an operator's registry
// edit is picked up without a daemon restart. A failed poll THROWS inside
// runEligibleQuery; we log and return, preserving the prior eligible set
// rather than flattening it to empty.
export function reconcileProject(team, { exec } = {}) {
  const entry = getProjectConfig(team);
  if (!entry) {
    log.warn({ team }, "reconcile: no registry entry for team — skipping");
    return;
  }
  const query = resolveEligibleQuery(entry);
  let tickets;
  try {
    tickets = runEligibleQuery(query, { exec });
  } catch (err) {
    log.error(
      { team, err: err.message },
      "reconcile poll failed — preserving prior eligible set",
    );
    return;
  }
  try {
    setProjectEligible(team, tickets, { source: "reconcile", query });
  } catch (err) {
    // A projection write/rename failure (disk full, permissions) must NOT
    // crash the daemon: reconcileProject runs inside reconcileAll, itself
    // driven by the setInterval reconcile timer, so an uncaught throw here
    // would kill the process. The in-memory eligible set is already current
    // (setProjectEligible updates the Map before persisting), so the next
    // reconcile tick retries the disk write.
    log.error(
      { team, err: err.message },
      "eligible-set projection write failed — daemon continues, retry next reconcile",
    );
  }
}

// reconcileAll — full reconcile of every registered team (the missed-webhook
// backstop). Re-reads registry.json each call so a team added to the registry
// is picked up and one removed is dropped within one tick.
export function reconcileAll({ exec } = {}) {
  const projects = listProjects();
  const seen = new Set(projects.map((p) => p.team));
  for (const p of projects) reconcileProject(p.team, { exec });
  for (const stale of knownProjects) {
    if (!seen.has(stale)) {
      dropProject(stale);
      log.info({ team: stale }, "team no longer in the registry — dropped");
    }
  }
  knownProjects.clear();
  for (const t of seen) knownProjects.add(t);
}

// --- Event-driven fast path ---------------------------------------------

// team -> pending debounce timer handle.
const dirtyTimers = new Map();

// handleStateChangedEvent — fold one state_changed event into the eligible
// sets of every project whose query team matches the event's team.
//
// CTL-565 + CTL-584 — the toState branch is a four-way split:
//   →triageStatus              one-shot-dispatches the triage phase agent
//                              (NOT the eligible set — a Triage ticket is
//                              never scheduler-pulled).
//   →status (Ready)            reconciles into the scheduler-eligible set
//                              (debounced).
//   →DRAG_OUT_STATES           the leave-path — confident immediate removal
//                              + abortWorker on the in-flight worker.
//   anything else (pipeline)   no-op. Research/Plan/Implement/Validate/PR/
//                              Done are the daemon's own CTL-558 write-backs
//                              echoed back; an unknown state is conservatively
//                              treated as a hand-edit we don't recognize.
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
  for (const p of listProjects()) {
    const query = resolveEligibleQuery(p);
    if (query.team !== parsed.teamKey) continue;

    if (parsed.toState === query.triageStatus) {
      // →Triage — one-shot dispatch the triage phase agent. NOT the eligible
      // set: a Triage ticket is never scheduler-pulled. Idempotent downstream
      // (phase-agent-dispatch no-ops an existing signal file).
      dispatchTriage(parsed.identifier, { dispatch, orchDir });
    } else if (!parsed.toState || parsed.toState === query.status) {
      // →Ready (or an unknown new state) — the event cannot confirm
      // project/label/priority scoping, so a full poll is required. Debounce
      // it so a burst of events coalesces into one reconcile.
      scheduleDirtyReconcile(p.team, { exec, debounceMs });
    } else if (DRAG_OUT_STATES.has(parsed.toState)) {
      // Drag-out to Backlog/Canceled/Duplicate — kill signal. Confident
      // immediate removal, then abort any in-flight worker and tear down its
      // worktree. removeTicket persists the projection itself; removing a
      // non-member is a safe no-op. abortWorker no-ops when the ticket was
      // never dispatched.
      removeTicket(p.team, parsed.identifier);
      if (orchDir) {
        abortWorker(orchDir, parsed.identifier, { repoRoot: p.repoRoot });
      }
    } else {
      // Pipeline state (the daemon's own CTL-558 write-back —
      // Research/Plan/Implement/Validate/PR/Done) or an unknown state. No-op:
      // the daemon must never kill its own worker on hearing its own write-
      // back echoed through the broker, and an unknown state is conservatively
      // treated as a hand-edit we don't recognize (let the next reconcile sort
      // it out — a missed kill is safe, a wrong kill destroys live work).
      // CTL-584.
      log.debug(
        { ticket: parsed.identifier, toState: parsed.toState },
        "monitor: non-trigger toState — no-op",
      );
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

function scheduleDirtyReconcile(team, { exec, debounceMs }) {
  clearTimeout(dirtyTimers.get(team));
  dirtyTimers.set(
    team,
    setTimeout(() => {
      dirtyTimers.delete(team);
      reconcileProject(team, { exec });
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
