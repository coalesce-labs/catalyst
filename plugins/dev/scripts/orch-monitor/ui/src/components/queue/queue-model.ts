// queue-model.ts — PURE, DOM-free helpers for the /queue control-tower surface
// (CTL-1015). Extracted from the render so the slot-assignment, holding-bucket,
// and ordinal contracts are unit-testable under `bun test` without a renderer,
// matching the queue-grouping.ts / queue-worker-grouping.ts pattern.
//
// None of these import React or touch the DOM. The surface composes them and
// feeds the result to the presentational components (slot-deck, dispatch-queue,
// holding-buckets, dead-strip), which take plain data props (CTL-1016 mountability).
import type { BoardWorker, BoardTicket } from "../../board/types";

/** A live worker is one whose bg-job is not dead. Dead workers hold NO slot
 *  (deriveCapacity excludes them) — they never appear in the deck. */
export function isLiveWorker(w: BoardWorker): boolean {
  return w.activeState !== "dead";
}

// ── ordinal ──────────────────────────────────────────────────────────────────

/**
 * English ordinal for a 1-based position: 1→"1st", 2→"2nd", 3→"3rd", 4→"4th",
 * 11/12/13→"11th"/"12th"/"13th", 21→"21st", 22→"22nd", 23→"23rd". The 11–13
 * exception overrides the last-digit rule.
 */
export function ordinal(n: number): string {
  const v = Math.abs(Math.trunc(n));
  const tens = v % 100;
  const ones = v % 10;
  let suffix = "th";
  if (tens < 11 || tens > 13) {
    if (ones === 1) suffix = "st";
    else if (ones === 2) suffix = "nd";
    else if (ones === 3) suffix = "rd";
  }
  return `${n}${suffix}`;
}

// ── slot assignment ────────────────────────────────────────────────────────────

export interface SlotAssignment {
  /** Live workers occupying slots 1..n, OLDEST first (stable across snapshots). */
  occupied: BoardWorker[];
  /** Number of empty slots to render (0 when fully booked or over capacity). */
  emptyCount: number;
  /** Live workers beyond maxParallel — render as OVER-capacity cards. */
  overCapacity: BoardWorker[];
}

/**
 * Assign live workers to capacity slots in a STABLE order so slot positions don't
 * reshuffle between snapshots. Workers are sorted by `startedAt` ascending (oldest
 * first), tie-broken by `name`. The first `maxParallel` fill slots 1..maxParallel;
 * any remainder are over-capacity. Empty slots fill the gap up to maxParallel.
 *
 * Dead workers (activeState === "dead") are excluded entirely — they hold no slot.
 */
export function assignSlots(
  workers: readonly BoardWorker[],
  maxParallel: number,
): SlotAssignment {
  const live = workers.filter(isLiveWorker);
  const sorted = [...live].sort((a, b) => {
    const sa = a.startedAt ?? 0;
    const sb = b.startedAt ?? 0;
    if (sa !== sb) return sa - sb; // oldest first
    return a.name.localeCompare(b.name);
  });
  const cap = Math.max(0, maxParallel);
  const occupied = sorted.slice(0, cap);
  const overCapacity = sorted.slice(cap);
  const emptyCount = Math.max(0, cap - occupied.length);
  return { occupied, emptyCount, overCapacity };
}

// ── holding buckets ("why work isn't moving") ──────────────────────────────────

export type HoldingBucketKind = "needs-you" | "blocked" | "waiting";

export interface HoldingBucketWorkerItem {
  kind: "worker";
  worker: BoardWorker;
  /** 1-based slot number the worker occupies in the deck (cross-reference tag). */
  slot: number | null;
}

export interface HoldingBucketTicketItem {
  kind: "ticket";
  ticket: BoardTicket;
}

export type HoldingBucketItem = HoldingBucketWorkerItem | HoldingBucketTicketItem;

export interface HoldingBucket {
  kind: HoldingBucketKind;
  /** Item ids in this bucket (ticket id for both kinds), for the ∉ queue invariant. */
  items: HoldingBucketItem[];
}

export interface HoldingBuckets {
  needsYou: HoldingBucket;
  blocked: HoldingBucket;
  waiting: HoldingBucket;
  /** True when all three buckets are empty (render the "nothing blocked" line). */
  allEmpty: boolean;
}

const itemTicketId = (i: HoldingBucketItem): string =>
  i.kind === "worker" ? i.worker.ticket : i.ticket.id;

/**
 * Build the three "why work isn't moving" buckets:
 *
 *  - needs-you: live workers parked on a human prompt (`waitingOnUser === true`)
 *    — these DO hold slots, so each carries its deck slot number — PLUS any ticket
 *    flagged needs-human via its `held`/labels that is NOT in flight.
 *  - blocked:   tickets with `held === "blocked"`, not in flight.
 *  - waiting:   tickets with `held === "waiting"` (admission gate), not in flight.
 *
 * `inFlightTicketIds` is the set of ticket ids a LIVE worker is attached to (so a
 * blocked/waiting label on an in-flight ticket is not double-listed). Slot numbers
 * are resolved from the same stable assignment the deck uses (assignSlots).
 */
export function groupHoldingBuckets(
  tickets: readonly BoardTicket[],
  workers: readonly BoardWorker[],
  maxParallel: number,
): HoldingBuckets {
  // Stable deck assignment → 1-based slot index per worker name.
  const { occupied } = assignSlots(workers, maxParallel);
  const slotByName = new Map<string, number>();
  occupied.forEach((w, i) => slotByName.set(w.name, i + 1));

  // Tickets currently held by a LIVE worker — excluded from the ticket buckets so
  // an in-flight blocked/waiting ticket isn't double-counted.
  const inFlightTicketIds = new Set<string>();
  for (const w of workers) {
    if (isLiveWorker(w)) {
      inFlightTicketIds.add(w.ticket);
      for (const t of w.tickets ?? []) inFlightTicketIds.add(t);
    }
  }

  const needsYou: HoldingBucketItem[] = [];
  for (const w of workers) {
    if (isLiveWorker(w) && w.waitingOnUser === true) {
      needsYou.push({ kind: "worker", worker: w, slot: slotByName.get(w.name) ?? null });
    }
  }

  const blocked: HoldingBucketItem[] = [];
  const waiting: HoldingBucketItem[] = [];
  for (const t of tickets) {
    if (inFlightTicketIds.has(t.id)) continue;
    if (t.held === "blocked") blocked.push({ kind: "ticket", ticket: t });
    else if (t.held === "waiting") waiting.push({ kind: "ticket", ticket: t });
  }

  const allEmpty = needsYou.length === 0 && blocked.length === 0 && waiting.length === 0;
  return {
    needsYou: { kind: "needs-you", items: needsYou },
    blocked: { kind: "blocked", items: blocked },
    waiting: { kind: "waiting", items: waiting },
    allEmpty,
  };
}

/** Flatten all bucket items to their ticket ids — for the bucket ∉ queue test. */
export function holdingTicketIds(b: HoldingBuckets): string[] {
  return [...b.needsYou.items, ...b.blocked.items, ...b.waiting.items].map(itemTicketId);
}

// ── dead / stale ───────────────────────────────────────────────────────────────

/** Dead workers (activeState === "dead"), oldest first — the forensics strip. */
export function deadWorkers(workers: readonly BoardWorker[]): BoardWorker[] {
  return [...workers]
    .filter((w) => w.activeState === "dead")
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.name.localeCompare(b.name));
}
