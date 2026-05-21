// scheduler.mjs — pull-loop scheduler for the execution core (CTL-536).
//
// Replaces wave-based push dispatch with a continuous pull loop: on every tick
// it computes a fresh ready set (eligible ∩ no-open-blocker), priority-ranks
// it, and dispatches the top ticket whenever a worker slot is free. In-flight
// tickets are advanced phase-by-phase through the FSM. Every dispatch is
// idempotent (signal-file existence guard).
//
// Daemon correctness rests on the periodic tick — every action is re-derived
// from filesystem state, so the periodic pass alone guarantees forward
// progress. The event-log watcher is purely a latency optimization.
//
// Composes: lib/dependency-graph.mjs (readiness), scheduler-rank.mjs (ranking),
// lib/phase-fsm.mjs (phase advancement, Phase 4), eligible-set.mjs (candidates).

import { readdirSync, readFileSync, watch, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeDependencyGraph } from "../lib/dependency-graph.mjs";
import { PHASES, transition, isTerminal } from "../lib/phase-fsm.mjs";
import { rankTickets } from "./scheduler-rank.mjs";
import { log, getEligibleDir, getEventLogPath } from "./config.mjs";

// The last pipeline phase — its `done` signal means the whole pipeline
// finished. `done` is otherwise phase-dependent: a `triage: done` signal still
// occupies a slot (the ticket is mid-pipeline), so isTicketInFlight checks the
// phase, not just the status.
const TERMINAL_PHASE = "monitor-deploy";

// readPhaseSignals — { phase: status } for one ticket's workers/<T>/phase-*.json.
export function readPhaseSignals(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  const signals = {};
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return signals; // no worker dir yet
  }
  for (const f of files) {
    const m = /^phase-(.+)\.json$/.exec(f);
    if (!m) continue;
    try {
      signals[m[1]] = JSON.parse(readFileSync(join(dir, f), "utf8"))?.status ?? null;
    } catch {
      // unreadable / malformed signal — skip; treated as absent
    }
  }
  return signals;
}

// isTicketInFlight — true when a ticket still occupies a worker slot. Pure over
// a phase→status map. In-flight = has ≥1 signal AND is neither pipeline-complete
// (monitor-deploy done) nor failed/stalled. A ticket mid-advance (plan done, no
// later signal yet) is still in-flight — correct slot accounting through the
// advance window.
export function isTicketInFlight(signals) {
  const phases = Object.keys(signals ?? {});
  if (phases.length === 0) return false;
  for (const [phase, status] of Object.entries(signals)) {
    if (status === "failed" || status === "stalled") return false;
    if (phase === TERMINAL_PHASE && status === "done") return false;
  }
  return true;
}

// listInFlightTickets — Set of ticket ids currently occupying a worker slot.
export function listInFlightTickets(orchDir) {
  const inFlight = new Set();
  let dirs;
  try {
    dirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return inFlight; // no workers dir yet
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (isTicketInFlight(readPhaseSignals(orchDir, d.name))) inFlight.add(d.name);
  }
  return inFlight;
}

// readMaxParallel — the run's worker-slot ceiling from state.json (parity with
// orchestrate-dispatch-next:176). Defaults to 1 when unset/unreadable.
export function readMaxParallel(orchDir) {
  try {
    const n = JSON.parse(readFileSync(join(orchDir, "state.json"), "utf8"))?.maxParallel;
    return Number.isInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

// computeFreeSlots — never negative (an over-subscribed run yields 0).
export function computeFreeSlots(maxParallel, inFlightCount) {
  return Math.max(0, maxParallel - inFlightCount);
}

// computeReadyTickets — eligible tickets with no open blocker, priority-ranked.
// analyzeDependencyGraph returns ready identifier strings; map back to the full
// ticket objects (selection and dispatch need priority/createdAt) and rank.
export function computeReadyTickets(eligibleTickets) {
  const list = eligibleTickets ?? [];
  const readyIds = new Set(analyzeDependencyGraph(list).ready);
  return rankTickets(list.filter((t) => readyIds.has(t.identifier)));
}

// selectDispatchable — the top `freeSlots` ready tickets not in the given
// exclude set (the tick passes already-started tickets, Phase 4).
export function selectDispatchable(rankedReady, excludeTickets, freeSlots) {
  if (freeSlots <= 0) return [];
  const exclude = excludeTickets ?? new Set();
  return (rankedReady ?? [])
    .filter((t) => !exclude.has(t.identifier))
    .slice(0, freeSlots);
}

// ─── Phase 4: dispatch and FSM-driven phase advancement ───

// orchestrate-dispatch-next sits one directory up from execution-core/.
const DISPATCH_BIN = fileURLToPath(
  new URL("../orchestrate-dispatch-next", import.meta.url),
);

// defaultDispatch — shell out to orchestrate-dispatch-next, which delegates to
// phase-agent-dispatch (idempotent: an existing dispatched/running/done signal
// is a no-op). Injected in tests so no test ever spawns a real worker.
function defaultDispatch({ orchDir, ticket, phase }) {
  const res = spawnSync(
    DISPATCH_BIN,
    ["--orch-dir", orchDir, "--ticket", ticket, "--phase", phase],
    { encoding: "utf8" },
  );
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// dispatchTicket — thin seam over the injectable dispatch function.
export function dispatchTicket(orchDir, ticket, phase, { dispatch = defaultDispatch } = {}) {
  return dispatch({ orchDir, ticket, phase });
}

// listStartedTickets — every ticket that already has a worker dir, in any
// status. The pull step excludes these so a finished/failed ticket is never
// re-pulled as new work (revive of a failed ticket is a separate owner's job).
export function listStartedTickets(orchDir) {
  try {
    return new Set(
      readdirSync(join(orchDir, "workers"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
  } catch {
    return new Set();
  }
}

// readAllEligibleTickets — concatenate every per-project eligible projection
// (~/catalyst/execution-core/eligible/*.json — the CTL-535 monitor's output).
export function readAllEligibleTickets() {
  let files;
  try {
    files = readdirSync(getEligibleDir());
  } catch {
    return []; // eligible dir not created yet
  }
  const all = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const proj = JSON.parse(readFileSync(join(getEligibleDir(), f), "utf8"));
      if (Array.isArray(proj?.tickets)) all.push(...proj.tickets);
    } catch {
      // malformed projection — skip, the next reconcile rewrites it
    }
  }
  return all;
}

// deriveAdvancement — pure. Given a ticket's phase→status signals, return the
// phase the FSM owes next, or null. The next phase is owed when the latest
// known phase is `done` and its transition() successor is a non-terminal phase
// with no signal yet. Advancement goes through phase-fsm.mjs — never a local
// copy of NEXT_PHASE.
export function deriveAdvancement(signals) {
  const sig = signals ?? {};
  let latest = null;
  for (const p of PHASES) if (p in sig) latest = p;
  if (latest === null || sig[latest] !== "done") return null;
  const next = transition(
    { phase: latest, reviveCount: 0, parkedFrom: null },
    { type: "complete" },
  );
  if (isTerminal(next)) return null; // pipeline reached monitor-deploy → done
  if (next.phase in sig) return null; // successor already dispatched
  return next.phase;
}

// schedulerTick — one pull cycle: (1) advancement sweep, (2) new-work pull.
// Idempotent and restart-safe — derives every action from filesystem state.
export function schedulerTick(orchDir, { readEligible, dispatch = defaultDispatch } = {}) {
  // (1) Advancement sweep — dispatch the FSM-owed next phase per in-flight ticket.
  const advanced = [];
  for (const ticket of listInFlightTickets(orchDir)) {
    const next = deriveAdvancement(readPhaseSignals(orchDir, ticket));
    if (!next) continue;
    const r = dispatchTicket(orchDir, ticket, next, { dispatch });
    if (r.code === 0) advanced.push({ ticket, phase: next });
    else log.warn({ ticket, phase: next, code: r.code }, "scheduler: advance dispatch failed");
  }

  // (2) New-work pull — fill free slots with top-ranked ready tickets.
  const eligible = readEligible ? readEligible() : readAllEligibleTickets();
  const ready = computeReadyTickets(eligible);
  const inFlightCount = listInFlightTickets(orchDir).size; // recomputed post-sweep
  const freeSlots = computeFreeSlots(readMaxParallel(orchDir), inFlightCount);
  const selected = selectDispatchable(ready, listStartedTickets(orchDir), freeSlots);

  const dispatched = [];
  for (const t of selected) {
    const r = dispatchTicket(orchDir, t.identifier, PHASES[0], { dispatch });
    if (r.code === 0) dispatched.push(t.identifier);
    else log.warn({ ticket: t.identifier, code: r.code }, "scheduler: dispatch failed");
  }

  return { advanced, dispatched, freeSlots, ready: ready.map((t) => t.identifier) };
}

// ─── Phase 5: the pull-loop daemon ───

// Periodic tick interval — the correctness backstop. The event fast path makes
// the daemon react sooner; this guarantees forward progress if events are missed.
const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_TICK_INTERVAL_MS) || 30_000;
// Debounce window — a burst of event-log appends coalesces into one tick.
const TICK_DEBOUNCE_MS = Number(process.env.SCHEDULER_DEBOUNCE_MS) || 2_000;

// --- daemon module state ---
let tickTimer = null;
let debounceTimer = null;
let watcher = null;
let runningOpts = null;

function runTick() {
  try {
    schedulerTick(runningOpts.orchDir, {
      readEligible: runningOpts.readEligible,
      dispatch: runningOpts.dispatch,
    });
  } catch (err) {
    // A tick must never crash the daemon — log and let the next tick retry.
    log.error({ err: err.message }, "scheduler: tick failed");
  }
}

function scheduleDebouncedTick(debounceMs) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runTick, debounceMs);
}

// startScheduler — immediate authoritative tick, arm the periodic timer, then
// start the event-log fast path. `dispatch` / `readEligible` are injectable so
// a test drives a hermetic daemon.
export function startScheduler({
  orchDir,
  dispatch,
  readEligible,
  tickIntervalMs = TICK_INTERVAL_MS,
  debounceMs = TICK_DEBOUNCE_MS,
} = {}) {
  if (!orchDir) throw new Error("startScheduler: orchDir is required");
  runningOpts = { orchDir, dispatch, readEligible };

  runTick(); // authoritative initial pass
  tickTimer = setInterval(runTick, tickIntervalMs);

  // Event fast path: any change to the event log wakes a debounced tick. No
  // parsing — schedulerTick re-derives every action from filesystem state, so
  // "something changed, re-tick" is both correct and cheap.
  //
  // The event type is deliberately NOT filtered: macOS fs.watch on a directory
  // reports `rename` even for in-place appends, while Linux reports `change`.
  // Reacting to either keeps the fast path working on both platforms; the
  // periodic tick is the correctness backstop regardless.
  const eventsDir = dirname(getEventLogPath());
  mkdirSync(eventsDir, { recursive: true });
  watcher = watch(eventsDir, (_eventType, filename) => {
    if (filename !== null && filename !== basename(getEventLogPath())) return;
    scheduleDebouncedTick(debounceMs);
  });
}

// stopScheduler — clear the timer, the debounce timer, and the watcher.
// Idempotent and safe to call before startScheduler.
export function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  watcher?.close();
  watcher = null;
  runningOpts = null;
}

// __resetForTests — clear daemon state between unit tests. Not part of the
// public contract; the index.mjs barrel does not re-export it.
export function __resetForTests() {
  stopScheduler();
}

// --- standalone entrypoint (operator dry-run / CTL-554 wires the real daemon) ---
function main() {
  const idx = process.argv.indexOf("--orch-dir");
  const orchDir = idx >= 0 ? process.argv[idx + 1] : process.env.CATALYST_ORCHESTRATOR_DIR;
  if (!orchDir) {
    console.error("usage: bun scheduler.mjs --orch-dir <path>");
    process.exit(1);
  }
  log.info({ orchDir }, "execution-core scheduler starting");
  startScheduler({ orchDir });
  const shutdown = (sig) => {
    log.info({ sig }, "execution-core scheduler shutting down");
    stopScheduler();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) main();
