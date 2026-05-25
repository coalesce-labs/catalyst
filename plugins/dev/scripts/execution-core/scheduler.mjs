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

import { readdirSync, readFileSync, writeFileSync, existsSync, watch, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { analyzeDependencyGraph, referencedBlockerIds } from "../lib/dependency-graph.mjs";
// PHASES is still imported for deriveAdvancement; CTL-565 note: PHASES[0]
// ("triage") is intentionally NO LONGER the new-work entry phase — new work
// enters at NEW_WORK_ENTRY_PHASE ("research"), see schedulerTick.
import { PHASES, transition, isTerminal } from "../lib/phase-fsm.mjs";
import { rankTickets } from "./scheduler-rank.mjs";
import { defaultDispatch, dispatchTicket, teamOf } from "./dispatch.mjs";
import { fetchTicketState } from "./linear-query.mjs";
import { getProjectConfig, listProjects } from "./registry.mjs";
import { teardownWorktree as defaultTeardownWorktree } from "./worktree.mjs";
import { readWorkerSignals } from "./signal-reader.mjs";
// CTL-574: per-tick reclaim of dead-but-work-done phase workers. The default
// is the real recovery-module function; tests inject a fake. See
// reclaimDeadWorkIfPossible in recovery.mjs for the decision tree.
import { reclaimDeadWorkIfPossible as defaultReclaimDeadWork } from "./recovery.mjs";
// CTL-558: the deterministic Linear status/label write seam. The whole module
// is injected as `writeStatus` so tests pass fakes; production uses the real
// module (best-effort — every write swallows its own failures).
import * as linearWrite from "./linear-write.mjs";
import { log, getEligibleDir, getEventLogPath } from "./config.mjs";

// The last pipeline phase — its `done` signal means the whole pipeline
// finished. `done` is otherwise phase-dependent: a `triage: done` signal still
// occupies a slot (the ticket is mid-pipeline), so isTicketInFlight checks the
// phase, not just the status.
const TERMINAL_PHASE = "monitor-deploy";

// New work enters the pipeline at `research`: a Ready ticket has already been
// triaged (the →Triage watcher dispatched its triage agent — monitor.mjs). The
// scheduler never dispatches `triage`. CTL-565 Part B. Deliberately NOT
// PHASES[0] ("triage"); the FSM still owns chaining research → plan → … .
const NEW_WORK_ENTRY_PHASE = "research";

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
// (monitor-deploy done) nor failed/stalled/aborted. A ticket mid-advance (plan
// done, no later signal yet) is still in-flight — correct slot accounting
// through the advance window.
//
// CROSS-REFERENCE (CTL-565): the failed/stalled/aborted set here is NOT the
// same as SETTLED_STATUSES in abort-worker.mjs — a non-terminal `done` is
// settled-as-a-signal there but still in-flight here. The divergence is
// intentional; do not collapse the two into one shared constant.
export function isTicketInFlight(signals) {
  const phases = Object.keys(signals ?? {});
  if (phases.length === 0) return false;
  for (const [phase, status] of Object.entries(signals)) {
    if (status === "failed" || status === "stalled" || status === "aborted") return false;
    // CTL-512: monitor-deploy `skipped` is terminal-success — the producer
    // emits it when no deployment_status event arrived before the timeout
    // (phase-monitor-deploy/SKILL.md). Only recognized for TERMINAL_PHASE;
    // a `skipped` on any other phase keeps the slot held so a producer bug
    // can't silently leak it.
    if (phase === TERMINAL_PHASE && (status === "done" || status === "skipped")) return false;
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
// orchestrate-dispatch-next:176). Defaults to 1 when unset/unreadable. ENOENT is
// expected and stays silent; any other read error or a JSON parse failure would
// otherwise silently cap the run to one slot forever, so it is logged loudly
// before the fallback to keep the cause operator-visible.
export function readMaxParallel(orchDir) {
  let raw;
  try {
    raw = readFileSync(join(orchDir, "state.json"), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.error(
        { err: err.message, code: err.code, orchDir },
        "scheduler: state.json unreadable — defaulting maxParallel to 1"
      );
    }
    return 1;
  }
  let n;
  try {
    n = JSON.parse(raw)?.maxParallel;
  } catch (err) {
    log.error(
      { err: err.message, orchDir },
      "scheduler: state.json is not valid JSON — defaulting maxParallel to 1"
    );
    return 1;
  }
  if (Number.isInteger(n) && n > 0) return n;
  log.warn(
    { maxParallel: n, orchDir },
    "scheduler: state.json has no valid maxParallel — defaulting to 1"
  );
  return 1;
}

// computeFreeSlots — never negative (an over-subscribed run yields 0).
export function computeFreeSlots(maxParallel, inFlightCount) {
  return Math.max(0, maxParallel - inFlightCount);
}

// A blocker fetch that failed (or any non-terminal hydrated state) holds the
// dependent back. The sentinel is a deliberately non-terminal placeholder
// state so a failed `linearis issues read` fails safe — the dependent is
// treated as blocked, never silently dispatched. CTL-565 D5.
const UNFETCHED_BLOCKER_STATE = "__unfetched__";

// hydrateOutOfSetBlockers — find every blocker referenced by an eligible
// ticket's blocked-by edge that is NOT itself in the eligible set, fetch its
// live Linear state once, and return a { identifier: stateName } map. A failed
// fetch yields the non-terminal UNFETCHED_BLOCKER_STATE sentinel so the
// dependent is held back — failing safe. CTL-565 D5.
export function hydrateOutOfSetBlockers(
  eligibleTickets,
  { exec, fetchState = fetchTicketState } = {},
) {
  const list = eligibleTickets ?? [];
  const inSet = new Set(list.map((t) => t?.identifier).filter(Boolean));
  const externalBlockers = referencedBlockerIds(list).filter((id) => !inSet.has(id));
  const blockerStates = {};
  for (const id of externalBlockers) {
    const state = fetchState(id, { exec });
    blockerStates[id] = state ?? UNFETCHED_BLOCKER_STATE; // non-terminal → fails safe
  }
  return blockerStates;
}

// computeReadyTickets — eligible tickets with no open blocker, priority-ranked.
// analyzeDependencyGraph returns ready identifier strings; map back to the full
// ticket objects (selection and dispatch need priority/createdAt) and rank.
//
// CTL-565 D5: options.blockerStates is threaded into the readiness filter so a
// dependent blocked by a non-terminal out-of-set blocker is held back.
export function computeReadyTickets(eligibleTickets, { blockerStates } = {}) {
  const list = eligibleTickets ?? [];
  const readyIds = new Set(analyzeDependencyGraph(list, { blockerStates }).ready);
  return rankTickets(list.filter((t) => readyIds.has(t.identifier)));
}

// selectDispatchable — the top `freeSlots` ready tickets not in the given
// exclude set (the tick passes already-started tickets, Phase 4).
export function selectDispatchable(rankedReady, excludeTickets, freeSlots) {
  if (freeSlots <= 0) return [];
  const exclude = excludeTickets ?? new Set();
  return (rankedReady ?? []).filter((t) => !exclude.has(t.identifier)).slice(0, freeSlots);
}

// ─── Phase 4: dispatch and FSM-driven phase advancement ───
//
// The dispatch adapter (defaultDispatch / dispatchTicket) lives in dispatch.mjs
// (CTL-565) so the monitor's →Triage one-shot dispatch shares the same seam.

// listStartedTickets — every ticket that already has a worker dir, in any
// status. The pull step excludes these so a finished/failed ticket is never
// re-pulled as new work (revive of a failed ticket is a separate owner's job).
export function listStartedTickets(orchDir) {
  try {
    return new Set(
      readdirSync(join(orchDir, "workers"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    );
  } catch {
    return new Set();
  }
}

// readAllEligibleTickets — concatenate every per-project eligible projection
// (~/catalyst/execution-core/eligible/*.json — the CTL-535 monitor's output).
// ENOENT on the dir is expected and stays silent; any other read error or a
// malformed projection is logged — a persistent upstream bug (the monitor
// writing bad JSON every reconcile) must not look like a healthy idle scheduler.
export function readAllEligibleTickets() {
  let files;
  try {
    files = readdirSync(getEligibleDir());
  } catch (err) {
    if (err.code !== "ENOENT") {
      log.warn(
        { err: err.message, code: err.code, dir: getEligibleDir() },
        "scheduler: eligible dir unreadable — treating as empty"
      );
    }
    return []; // eligible dir not created yet
  }
  const all = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const proj = JSON.parse(readFileSync(join(getEligibleDir(), f), "utf8"));
      if (Array.isArray(proj?.tickets)) all.push(...proj.tickets);
    } catch (err) {
      log.warn(
        { err: err.message, file: f },
        "scheduler: malformed eligible projection — skipping"
      );
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
    { type: "complete" }
  );
  if (isTerminal(next)) return null; // pipeline reached monitor-deploy → done
  if (next.phase in sig) return null; // successor already dispatched
  return next.phase;
}

// safeWrite — run a best-effort Linear-write call (CTL-558). A write failure
// must never abort the tick: a thrown error is logged and swallowed. `ctx` is
// merged into the log line so the failing { ticket, phase } stays visible.
function safeWrite(fn, ctx) {
  try {
    fn();
  } catch (err) {
    log.warn({ ...ctx, err: err.message }, "scheduler: Linear write-back threw — continuing tick");
  }
}

// labelOnce — apply a Linear label to a ticket at most once for the run's
// lifetime (CTL-558, CTL-585). `linearis` label-add has no read-compare,
// so without a guard the scheduler would re-hit the API on every tick.
//
// Two marker files at workers/<T>/.linear-label-<label>.{applied,skipped}
// (restart-safe — persist with the worker dir) record terminal outcomes:
//   .applied — applyLabel returned applied:true. Happy path.
//   .skipped — applyLabel returned reason:"missing-label". The workspace
//              lacks the label; retrying inside this daemon's lifetime
//              would just storm the Linear API (CTL-585). An operator
//              creates the label in the Linear UI and deletes this
//              marker to re-arm the apply.
//
// Transient failures (reason:"rate-limited", "transient", undefined) write
// no marker so the next tick retries — CTL-558's recovery contract.
function labelOnce(orchDir, ticket, label, writeStatus) {
  const base = join(orchDir, "workers", ticket, `.linear-label-${label}`);
  if (existsSync(`${base}.applied`) || existsSync(`${base}.skipped`)) return;
  try {
    const res = writeStatus.applyLabel({ ticket, label });
    // A fake that returns undefined (test stubs) is treated as success so
    // the once-semantics stay testable without a real result.
    if (res === undefined || res?.applied) {
      writeFileSync(`${base}.applied`, "");
    } else if (res?.reason === "missing-label") {
      writeFileSync(`${base}.skipped`, "");
      log.warn(
        { ticket, label },
        "scheduler: label missing in workspace — skipping retries for this run",
      );
    }
  } catch (err) {
    log.warn(
      { ticket, label, err: err.message },
      "scheduler: label write-back threw — continuing tick",
    );
  }
}

// CTL-624: dispatch cool-down marker. Conceptually mirrors the labelOnce
// once-marker (workers/<T>/.linear-label-*), but with two deliberate
// differences: (1) the marker carries a timestamp and the guard is time-based —
// re-dispatch is suppressed only while now - failedAt < DISPATCH_COOLDOWN_MS, so
// the window self-heals once the upstream artifact appears (unlike labelOnce's
// permanent .skipped marker); (2) the marker lives in a dedicated
// orchDir/.dispatch-cooldowns/ dir, NOT under workers/<T>/. A new-work ticket
// refused at the entry phase has no worker dir yet; writing a marker into
// workers/<T>/ would manufacture one, and listStartedTickets (dir-existence)
// would then exclude the ticket from the new-work pull *forever* — dropping it
// silently instead of merely throttling re-dispatch. Keeping the marker off the
// workers/ tree leaves listStartedTickets / listInFlightTickets / readWorkerSignals
// semantics untouched, so the ticket stays eligible and re-dispatches after the window.
export function dispatchCooldownPath(orchDir, ticket, phase) {
  return join(orchDir, ".dispatch-cooldowns", `${ticket}-${phase}.json`);
}

export function inDispatchCooldown(orchDir, ticket, phase, now) {
  const p = dispatchCooldownPath(orchDir, ticket, phase);
  let failedAt;
  try {
    failedAt = JSON.parse(readFileSync(p, "utf8"))?.failedAt;
  } catch {
    return false; // absent / malformed → treat as no cool-down
  }
  if (typeof failedAt !== "number") return false;
  return now - failedAt < DISPATCH_COOLDOWN_MS;
}

export function recordDispatchFailure(orchDir, ticket, phase, code, now) {
  const dir = join(orchDir, ".dispatch-cooldowns");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      dispatchCooldownPath(orchDir, ticket, phase),
      JSON.stringify({ phase, code, failedAt: now }),
    );
  } catch (err) {
    // Never let a marker write crash the tick — worst case is the next tick
    // retries (the pre-CTL-624 behavior).
    log.warn(
      { ticket, phase, err: err.message },
      "scheduler: dispatch cool-down marker write failed — continuing",
    );
  }
}

export function clearDispatchCooldown(orchDir, ticket, phase) {
  try {
    rmSync(dispatchCooldownPath(orchDir, ticket, phase), { force: true });
  } catch {
    // best-effort — a stale marker just means one suppressed re-dispatch
  }
}

// REQUIRED_WORKSPACE_LABELS — the flat labels the CTL-558 coordinator sweep
// writes. Both must pre-exist in the Linear workspace; linearis has no
// `labels create`. CTL-585's preflight warns once at daemon start if either
// is missing, so an operator sees the contract gap before the per-tick label
// sweep starts (and so the missing-label short-circuit in labelOnce does not
// surprise a fresh operator).
const REQUIRED_WORKSPACE_LABELS = ["triaged", "needs-human"];

// preflightWorkspaceLabels — best-effort daemon-start check. For each team,
// list the team's labels and warn once per missing expected label. `exec`
// defaults to a spawnSync wrapper that normalises the result shape; `log`
// defaults to the module logger. Never throws — a broken linearis (missing
// binary, network outage) logs a single info line and returns.
export function preflightWorkspaceLabels({
  teams,
  exec = defaultPreflightExec,
  log: logger = log,
} = {}) {
  if (!Array.isArray(teams) || teams.length === 0) return;
  for (const team of teams) {
    try {
      const { code, stdout, stderr } = exec("linearis", [
        "labels", "list", "--team", team,
      ]);
      if (code !== 0) {
        logger.info(
          { team, code, stderr },
          "scheduler: workspace-label preflight skipped — linearis labels list failed",
        );
        continue;
      }
      // linearis labels list emits JSON ({nodes: [{name, ...}, ...]}) — match
      // the parsing used in linear-query.mjs:100-106. A non-JSON stdout is
      // treated as a soft preflight skip, not a throw.
      let names = [];
      try {
        const parsed = JSON.parse(String(stdout || "{}"));
        names = (parsed?.nodes ?? []).map((n) => n?.name).filter(Boolean);
      } catch (err) {
        logger.info(
          { team, err: err.message },
          "scheduler: workspace-label preflight skipped — linearis stdout is not JSON",
        );
        continue;
      }
      const present = new Set(names);
      for (const label of REQUIRED_WORKSPACE_LABELS) {
        if (!present.has(label)) {
          logger.warn(
            { team, label },
            "scheduler: Linear workspace is missing required label — create it in the Linear UI; the label sweep will skip this label for this run",
          );
        }
      }
    } catch (err) {
      logger.info(
        { team, err: err.message },
        "scheduler: workspace-label preflight threw — swallowed",
      );
    }
  }
}

function defaultPreflightExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// teardownWorktreeOnce — remove a ticket's git worktree once it reaches
// terminal Done (CTL-582 Phase 4). The terminal sweep revisits every started
// ticket each tick, so a once-marker at workers/<T>/.worktree-removed makes
// teardown fire a single time. repoRoot is resolved from the central registry
// by the ticket's team. Best-effort: an unresolvable team or a thrown teardown
// is swallowed — never aborts the tick. The marker is written only on a
// confirmed teardown (worktree gone), so a transient git failure retries.
function teardownWorktreeOnce(orchDir, ticket, teardownWorktree) {
  const marker = join(orchDir, "workers", ticket, ".worktree-removed");
  if (existsSync(marker)) return;
  const entry = getProjectConfig(teamOf(ticket));
  if (!entry?.repoRoot) {
    // The codebase favors loud failures: a Done ticket whose team is absent
    // from the registry can never have its worktree resolved here — surface it
    // rather than silently leaking the worktree. No marker is written, so a
    // restored registry entry is retried on a later tick.
    log.warn(
      { ticket },
      "scheduler: worktree teardown deferred — ticket's team has no registry entry",
    );
    return;
  }
  try {
    if (teardownWorktree({ repoRoot: entry.repoRoot, ticket })) {
      writeFileSync(marker, "");
    }
  } catch (err) {
    log.warn(
      { ticket, err: err.message },
      "scheduler: worktree teardown threw — continuing tick",
    );
  }
}

// terminalDoneOnce — write the terminal `Done` Linear state for a ticket at
// most once for the run's lifetime (CTL-597). The terminal sweep revisits every
// started worker dir each tick, and applyTerminalDone → linear-transition.sh
// does an unconditional `linearis issues read` before it can decide the state
// already matches — so without a guard every terminal dir burns one Linear API
// read per tick, exhausting the rate-limit cap. A once-marker at
// workers/<T>/.terminal-done.applied (restart-safe — persists with the worker
// dir) records a confirmed apply, mirroring labelOnce / teardownWorktreeOnce.
// Best-effort: any throw is logged and swallowed, never aborting the tick.
function terminalDoneOnce(orchDir, ticket, writeStatus) {
  const marker = join(orchDir, "workers", ticket, ".terminal-done.applied");
  if (existsSync(marker)) return;
  try {
    const res = writeStatus.applyTerminalDone({ ticket });
    // Write the marker only on a confirmed apply — a failed write is retried
    // next tick. Note applyTerminalDone returns applied:true even for the
    // already-Done `action:"skipped"` outcome, so the marker lands on the first
    // confirming tick. A fake that returns undefined (test stubs) is treated as
    // success so the once-semantics stay testable without a real result.
    if (res === undefined || res?.applied) {
      writeFileSync(marker, "");
    }
  } catch (err) {
    log.warn(
      { ticket, err: err.message },
      "scheduler: terminal-Done write-back threw — continuing tick",
    );
  }
}

// schedulerTick — one pull cycle: (1) advancement sweep, (2) new-work pull,
// (3) terminal-Done sweep (CTL-558) + worktree teardown (CTL-582). Idempotent
// and restart-safe — derives every action from filesystem state. `exec` is the
// injectable seam for the D5 out-of-set blocker-state fetch; `writeStatus` is
// the injectable Linear-write seam (CTL-558); `teardownWorktree` is the
// injectable worktree-teardown seam (CTL-582) — both default to the real module.
export function schedulerTick(
  orchDir,
  {
    readEligible,
    dispatch = defaultDispatch,
    exec,
    writeStatus = linearWrite,
    teardownWorktree = defaultTeardownWorktree,
    reclaimDeadWork = defaultReclaimDeadWork,
    now = Date.now, // CTL-624: injectable clock for the dispatch cool-down
  } = {},
) {
  // (0) Reclaim-dead-work sweep (CTL-574) — close phase signals whose bg worker
  // died but whose work was committed before the death. Runs BEFORE the
  // advancement sweep so a reclaimed phase advances the same tick. Iterates
  // every active worker signal (readWorkerSignals returns one per ticket — the
  // active, non-terminal-first phase) and asks reclaimDeadWork to decide.
  // Reclaim is a strict superset of "do nothing": only the dead+work-done case
  // mutates the signal; all other classes (terminal/running/unknown/not-done/
  // not-applicable) are zero-action no-ops.
  // CTL-587: reclaimDeadWork now returns up to 7 discriminators. The four
  // that callers can act on (HUD, daemon log) populate parallel arrays; the
  // other three (noop, not-done, not-applicable, reclaim-failed) are silent
  // because they describe "no externally-visible change" — the next tick
  // will re-evaluate. The 'reviveSuppressed' bucket is the storm-breaker
  // marker; 'escalated' fires `needs-human` via the per-phase recovery path.
  const reclaimed = [];
  const revived = [];
  const reviveSuppressed = [];
  const escalated = [];
  for (const sig of readWorkerSignals(orchDir)) {
    const team = teamOf(sig.ticket);
    const repoRoot = team ? (getProjectConfig(team)?.repoRoot ?? null) : null;
    const r = reclaimDeadWork(orchDir, sig, { repoRoot });
    const entry = { ticket: sig.ticket, phase: sig.phase };
    switch (r) {
      case "reclaimed":
        reclaimed.push(entry);
        break;
      case "revived":
        revived.push(entry);
        break;
      case "revive-suppressed":
        reviveSuppressed.push(entry);
        break;
      case "escalated":
        escalated.push(entry);
        break;
      default:
        // noop | not-done | not-applicable | reclaim-failed → invisible.
        break;
    }
  }

  // (1) Advancement sweep — dispatch the FSM-owed next phase per in-flight ticket.
  const advanced = [];
  for (const ticket of listInFlightTickets(orchDir)) {
    const next = deriveAdvancement(readPhaseSignals(orchDir, ticket));
    if (!next) continue;
    if (inDispatchCooldown(orchDir, ticket, next, now())) continue; // CTL-624: throttle refused re-dispatch
    const r = dispatchTicket(orchDir, ticket, next, { dispatch });
    if (r.code === 0) {
      clearDispatchCooldown(orchDir, ticket, next); // CTL-624: success clears any prior cool-down
      advanced.push({ ticket, phase: next });
      // CTL-558: write the dispatched phase's mapped Linear status. Idempotent
      // (linear-transition.sh read-compares first); never aborts the tick.
      safeWrite(() => writeStatus.applyPhaseStatus({ ticket, phase: next }), {
        ticket,
        phase: next,
      });
    } else {
      recordDispatchFailure(orchDir, ticket, next, r.code, now()); // CTL-624: arm the cool-down window
      log.warn({ ticket, phase: next, code: r.code }, "scheduler: advance dispatch failed");
    }
  }

  // (2) New-work pull — fill free slots with top-ranked ready tickets. D5:
  // hydrate the live state of every out-of-set blocker first so a Ready ticket
  // blocked by a non-terminal out-of-set ticket is held back.
  const eligible = readEligible ? readEligible() : readAllEligibleTickets();
  const blockerStates = hydrateOutOfSetBlockers(eligible, { exec });
  const ready = computeReadyTickets(eligible, { blockerStates });
  const inFlightCount = listInFlightTickets(orchDir).size; // recomputed post-sweep
  const freeSlots = computeFreeSlots(readMaxParallel(orchDir), inFlightCount);
  const selected = selectDispatchable(ready, listStartedTickets(orchDir), freeSlots);

  const dispatched = [];
  for (const t of selected) {
    if (inDispatchCooldown(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, now())) continue; // CTL-624: throttle refused re-dispatch
    const r = dispatchTicket(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, { dispatch });
    if (r.code === 0) {
      clearDispatchCooldown(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE); // CTL-624: success clears any prior cool-down
      dispatched.push(t.identifier);
      // CTL-558: write the entry-phase (`research`) status for the new ticket.
      safeWrite(
        () =>
          writeStatus.applyPhaseStatus({
            ticket: t.identifier,
            phase: NEW_WORK_ENTRY_PHASE,
          }),
        { ticket: t.identifier, phase: NEW_WORK_ENTRY_PHASE },
      );
    } else {
      recordDispatchFailure(orchDir, t.identifier, NEW_WORK_ENTRY_PHASE, r.code, now()); // CTL-624: arm the cool-down window
      log.warn({ ticket: t.identifier, code: r.code }, "scheduler: dispatch failed");
    }
  }

  // (3) Terminal-Done + label sweep (CTL-558) — one pass over every started
  // ticket. deriveAdvancement returns null once monitor-deploy completes, so
  // terminal `Done` is not a dispatch — it needs this dedicated sweep. In the
  // same pass: apply the `triaged` label on triage completion, and the flat
  // `needs-human` label when any phase signal is `stalled` (D7 — the worker
  // keeps its phase state, it does not bounce to Triage). Status writes are
  // idempotent via linear-transition.sh; label writes are guarded once-per-run
  // by labelOnce's marker file.
  for (const ticket of listStartedTickets(orchDir)) {
    const signals = readPhaseSignals(orchDir, ticket);
    // CTL-589 (CTL-512 followup): `skipped` is the second terminal status for
    // monitor-deploy — emitted when no GitHub Deployments arrive within the
    // probe timeout (the skipDeployVerification path). It must trigger the
    // same Linear Done write + worktree teardown as `done`, matching the
    // isTicketInFlight gate at line ~93. Without this, the ticket lingers
    // at `PR` in Linear and the worktree leaks on disk indefinitely.
    if (signals["monitor-deploy"] === "done" || signals["monitor-deploy"] === "skipped") {
      // CTL-597: once-marker guards the per-tick Linear read (was safeWrite-only).
      terminalDoneOnce(orchDir, ticket, writeStatus);
      // CTL-582: the ticket reached terminal Done — tear down its worktree.
      teardownWorktreeOnce(orchDir, ticket, teardownWorktree);
    }
    if (signals.triage === "done") {
      labelOnce(orchDir, ticket, "triaged", writeStatus);
    }
    if (Object.values(signals).some((s) => s === "stalled")) {
      labelOnce(orchDir, ticket, "needs-human", writeStatus);
    }
  }

  return {
    reclaimed,
    revived,
    reviveSuppressed,
    escalated,
    advanced,
    dispatched,
    freeSlots,
    ready: ready.map((t) => t.identifier),
  };
}

// ─── Phase 5: the pull-loop daemon ───

// Periodic tick interval — the correctness backstop. The event fast path makes
// the daemon react sooner; this guarantees forward progress if events are missed.
const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_TICK_INTERVAL_MS) || 30_000;
// Debounce window — a burst of event-log appends coalesces into one tick.
const TICK_DEBOUNCE_MS = Number(process.env.SCHEDULER_DEBOUNCE_MS) || 2_000;

// CTL-624: per-(ticket,phase) dispatch cool-down. When a dispatch is refused
// (e.g. prior_artifact_missing → phase-agent-dispatch exit 2) the dispatcher
// writes no signal file, so isTicketInFlight frees the slot and the next
// debounced tick re-dispatches immediately — a 2–4 events/sec storm. A
// timestamped marker under workers/<T>/ throttles re-dispatch of the same
// (ticket,phase) to one attempt per window. Time-based (not a permanent
// .skipped marker like labelOnce) so it self-heals once the artifact appears.
const DISPATCH_COOLDOWN_MS = Number(process.env.SCHEDULER_DISPATCH_COOLDOWN_MS) || 60_000;

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
      exec: runningOpts.exec,
      writeStatus: runningOpts.writeStatus,
      teardownWorktree: runningOpts.teardownWorktree,
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
// start the event-log fast path. `dispatch` / `readEligible` / `exec` /
// `writeStatus` / `teardownWorktree` are injectable so a test drives a hermetic
// daemon (`exec` is the D5 blocker-state fetch seam, CTL-565; `writeStatus` is
// the CTL-558 Linear-write seam; `teardownWorktree` is the CTL-582 worktree
// seam — each undefined here defaults to the real module in schedulerTick).
export function startScheduler({
  orchDir,
  dispatch,
  readEligible,
  exec,
  writeStatus,
  teardownWorktree,
  preflight = preflightWorkspaceLabels, // CTL-585
  tickIntervalMs = TICK_INTERVAL_MS,
  debounceMs = TICK_DEBOUNCE_MS,
} = {}) {
  if (!orchDir) throw new Error("startScheduler: orchDir is required");
  runningOpts = { orchDir, dispatch, readEligible, exec, writeStatus, teardownWorktree };

  // CTL-585: warn once at startup if the Linear workspace lacks the labels
  // the CTL-558 sweep writes. Best-effort — never blocks startup.
  try {
    const teams = listProjects().map((p) => p.team).filter(Boolean);
    preflight({ teams });
  } catch (err) {
    log.info({ err: err.message }, "scheduler: preflight wrapper threw — swallowed");
  }

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
