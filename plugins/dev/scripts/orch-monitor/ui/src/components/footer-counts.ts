// footer-counts.ts — PURE, DOM-free derivation of the app-footer live-status
// strip's categorical counts (CTL-1032). The strip used to read a single
// `nav.workerCount` "N active" number that lumped dead/stale background jobs in
// with genuinely-working slots. This module replaces that with an honest, four
// category readout — active · dead · free · waiting — derived from the SAME
// board snapshot the control tower (CTL-1015) reads, using the SAME shared
// classification utilities so the strip and the control tower can never disagree.
//
// No React, no DOM: the footer composes this and renders the result. Unit-tested
// under `bun test` (footer-counts.test.ts), matching the queue-model.ts pattern.
import type { BoardWorker, BoardTicket } from "../board/types";
import { assignSlots, deadWorkers, groupHoldingBuckets } from "./queue/queue-model";

/** The four honest fleet categories the live-status strip reports. */
export interface FooterCounts {
  /** Genuinely-working slots — live workers occupying a capacity slot. Dead
   *  workers are EXCLUDED (assignSlots filters them). Never includes
   *  over-capacity workers — those exceed the slot deck. */
  active: number;
  /** Dead / stale background jobs — listed for forensics, holding NO slots. */
  dead: number;
  /** Empty capacity slots (maxParallel minus the workers occupying slots). */
  free: number;
  /** CTL-764 Phase 8: tickets on the admission gate (queued disposition), not in flight.
   *  Renamed from "waiting" — back-compat via groupHoldingBuckets.queued fallback. */
  queued: number;
}

/**
 * Derive the strip's categorical counts from a board snapshot. Imports the
 * CTL-1015 classification utilities (assignSlots / deadWorkers /
 * groupHoldingBuckets) verbatim — there is NO second implementation of
 * dead/stale classification or slot bucketing here.
 *
 *  - active  = occupied live slots (assignSlots.occupied.length)
 *  - dead    = dead/stale workers (deadWorkers.length)
 *  - free    = empty capacity slots (assignSlots.emptyCount)
 *  - waiting = admission-gate-held tickets not in flight (waiting bucket)
 */
export function deriveFooterCounts(
  workers: readonly BoardWorker[],
  tickets: readonly BoardTicket[],
  maxParallel: number
): FooterCounts {
  const { occupied, emptyCount } = assignSlots(workers, maxParallel);
  const dead = deadWorkers(workers).length;
  const queued = groupHoldingBuckets(tickets, workers, maxParallel).queued.items.length;
  return {
    active: occupied.length,
    dead,
    free: emptyCount,
    queued,
  };
}
