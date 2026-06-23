// admission-state.mjs — CTL-1322. Resolve the daemon's live ADMISSION state —
// is this node accepting new work, and if not, why — from the SAME source fns the
// scheduler's new-work gate enforces, so the heartbeat (which carries this block)
// never lies relative to the enforced gate for the GATE-TRUTH fields — `accepting`
// and `holdReason` are computed from live `isDraining()` + the live agents snapshot.
// (`effectiveCapacity` is the BOOT-snapshot ceiling: it reads the boot-captured
// `concurrency`, so after the CTL-684 auto-tuner hot-reloads maxParallel at runtime it
// can lag the live gate ceiling. It is NOT surfaced in the UI today; the
// effectiveCapacity shift-left follow-up makes it live everywhere.)
//
// The scheduler gate (scheduler.mjs:4680-4698) is:
//   livenessFresh = livenessIsFresh()           // prod default: getAgentsCached().isFresh
//   draining      = isDraining()                 // orchDir/drain flag (CTL-1095)
//   freeSlots     = (livenessFresh && !draining) // accept-work predicate
//                     ? max(0, computeFreeSlots(maxParallel, liveCount) - …) : 0
//   liveCount     = countBackgroundAgents()      // the live `claude agents` bg count
// We recompute the SAME predicates here (the heartbeat runs on its own cadence,
// not inside the tick, so it must recompute — but from identical sources → zero
// drift). DO NOT swap in listInFlightTickets(orchDir): that is a worker-dir scan
// that over-counts leaked workers and diverges from the gate's liveCount.
//
// effectiveCapacity is the admission CAPACITY ceiling: maxParallel when accepting,
// 0 when held (the gate already collapses freeSlots → 0 on a hold) — NOT the
// volatile per-tick freeSlots (which subtracts same-tick resume/promote terms).

import { isDraining } from "./config.mjs";
import { getAgentsCached, countBackgroundAgents } from "./claude-agents.mjs";
import { readMaxParallel } from "./scheduler.mjs";

/**
 * readAdmissionState — compute { accepting, holdReason, effectiveCapacity, activeWorkers }.
 *
 * holdReason precedence: drain takes precedence over liveness-cold. Drain is the
 * persistent operator-intent hold (CTL-1095); liveness-cold is the transient
 * self-healing snapshot-staleness hold (CTL-731). Both can be true in one tick;
 * the single enum reports the operator-meaningful one (drain) first.
 *
 * All four reads are injectable seams (default to the real production fns) so the
 * truth table is unit-testable without real subprocess / fs. The agents snapshot
 * is taken ONCE and shared between the freshness check and the worker count so the
 * two values are mutually consistent within a single resolution.
 *
 * @param {object} [opts]
 * @param {string} [opts.orchDir]
 * @param {object} [opts.concurrency]            committed executionCore knobs (maxParallel)
 * @param {Function} [opts.agentsSnapshotFn]     () => { agents, isFresh, … }  (getAgentsCached)
 * @param {Function} [opts.isDrainingFn]         (orchDir) => boolean          (isDraining)
 * @param {Function} [opts.countWorkersFn]       ({ agents }) => number        (countBackgroundAgents)
 * @param {Function} [opts.maxParallelFn]        (orchDir, concurrency) => int (readMaxParallel)
 * @returns {{ accepting: boolean, holdReason: "drain"|"liveness-cold"|null, effectiveCapacity: number, activeWorkers: number }}
 */
export function readAdmissionState({
  orchDir,
  concurrency = {},
  agentsSnapshotFn = getAgentsCached,
  isDrainingFn = isDraining,
  countWorkersFn = countBackgroundAgents,
  maxParallelFn = readMaxParallel,
} = {}) {
  const snap = agentsSnapshotFn() ?? {};
  const livenessFresh = snap.isFresh === true;
  const draining = isDrainingFn(orchDir) === true;
  const accepting = livenessFresh && !draining;
  const holdReason = accepting ? null : draining ? "drain" : "liveness-cold";
  const activeWorkers = countWorkersFn({ agents: snap.agents ?? [] }) ?? 0;
  const effectiveCapacity = accepting ? maxParallelFn(orchDir, concurrency) : 0;
  return { accepting, holdReason, effectiveCapacity, activeWorkers };
}
