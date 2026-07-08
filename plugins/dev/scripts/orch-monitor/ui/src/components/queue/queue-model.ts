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

// ── waited-time ────────────────────────────────────────────────────────────────

/**
 * Compact "how long it has waited" label from an elapsed millisecond span, with
 * NO "ago" suffix (it's a duration column, not a timestamp): "2d", "3h", "5m",
 * "<1m". Negative / non-finite → "" (render nothing rather than a bogus age).
 */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** CTL-1066: compact "time until X" countdown: "2h", "18m", "<1m"; non-positive/non-finite → "now". */
export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
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
export function assignSlots(workers: readonly BoardWorker[], maxParallel: number): SlotAssignment {
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

/**
 * The deck slot label for a 1-based slot position: `slotLabel(1) === "SLOT 1"`.
 * CTL-1035: BOTH occupied and vacant slots carry this — the deck reads as N
 * fixed numbered slots, some open. Occupied card i (0-based) is `slotLabel(i+1)`;
 * the j-th empty (0-based) after `occupied.length` filled is
 * `slotLabel(occupied.length + j + 1)`, so an open slot keeps the same number it
 * would carry if it were filled.
 */
export function slotLabel(slot: number): string {
  return `SLOT ${slot}`;
}

// ── holding buckets ("why work isn't moving") ──────────────────────────────────

// CTL-764 Phase 8: "waiting" renamed to "queued"; needsInput/needsHuman added.
export type HoldingBucketKind =
  | "needs-you"
  | "stalled"
  | "blocked"
  | "queued"
  | "needs-input"
  | "needs-human";

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
  /** CTL-1066: tickets with status=stalled — the circuit breaker gave up; human must intervene. */
  stalled: HoldingBucket;
  blocked: HoldingBucket;
  /** CTL-764 Phase 8: renamed from "waiting" → "queued"; back-compat maps legacy held="waiting". */
  queued: HoldingBucket;
  /** CTL-764 Phase 8: tickets paused for worker input (needs-input disposition). */
  needsInput: HoldingBucket;
  /** CTL-764 Phase 8: tickets escalated to needs-human disposition (separate from needs-you). */
  needsHuman: HoldingBucket;
  /** True when all buckets are empty (render the "nothing blocked" line). */
  allEmpty: boolean;
}

const itemTicketId = (i: HoldingBucketItem): string =>
  i.kind === "worker" ? i.worker.ticket : i.ticket.id;

/**
 * Build the "why work isn't moving" holding buckets. CTL-764 Phase 8 adds
 * queued/needsInput/needsHuman driven by workerStatus with held back-compat.
 *
 *  - needs-you:   live workers parked on a human prompt (waitingOnUser) PLUS
 *                 not-in-flight tickets with attention=needs-human (CTL-1180).
 *  - stalled:     tickets with status=stalled (circuit breaker, CTL-1066).
 *  - blocked:     tickets with held/workerStatus=blocked, not in flight.
 *  - queued:      tickets with workerStatus=queued (or legacy held=waiting), not in flight.
 *  - needsInput:  tickets with workerStatus=needs-input, not in flight.
 *  - needsHuman:  tickets with workerStatus=needs-human (separate from needs-you; disposition axis).
 *
 * Single-valued precedence: needs-human > needs-input > blocked > queued.
 * The CTL-729 needs-you (operator-prompt / permission-pause) bucket stays a separate axis.
 */
export function groupHoldingBuckets(
  tickets: readonly BoardTicket[],
  workers: readonly BoardWorker[],
  maxParallel: number
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

  const stalled: HoldingBucketItem[] = [];
  const blocked: HoldingBucketItem[] = [];
  const queued: HoldingBucketItem[] = [];
  const needsInput: HoldingBucketItem[] = [];
  const needsHuman: HoldingBucketItem[] = [];
  for (const t of tickets) {
    if (inFlightTicketIds.has(t.id)) continue;
    // CTL-1180: not-in-flight needs-human attention → needs-you (operator-prompt axis).
    if (t.attention === "needs-human") {
      needsYou.push({ kind: "ticket", ticket: t });
      continue;
    }
    if (t.status === "stalled") {
      stalled.push({ kind: "ticket", ticket: t });
      continue;
    }
    // CTL-764 Phase 8: single-valued precedence on workerStatus; fall back to held for back-compat.
    const ws = t.workerStatus ?? null;
    const h = t.held ?? null;
    if (ws === "needs-human") {
      needsHuman.push({ kind: "ticket", ticket: t });
      continue;
    }
    if (ws === "needs-input") {
      needsInput.push({ kind: "ticket", ticket: t });
      continue;
    }
    if (ws === "blocked" || h === "blocked") {
      blocked.push({ kind: "ticket", ticket: t });
      continue;
    }
    if (ws === "queued" || h === "queued" || h === "waiting") {
      queued.push({ kind: "ticket", ticket: t });
    }
  }

  const allEmpty =
    needsYou.length === 0 &&
    stalled.length === 0 &&
    blocked.length === 0 &&
    queued.length === 0 &&
    needsInput.length === 0 &&
    needsHuman.length === 0;
  return {
    needsYou: { kind: "needs-you", items: needsYou },
    stalled: { kind: "stalled", items: stalled },
    blocked: { kind: "blocked", items: blocked },
    queued: { kind: "queued", items: queued },
    needsInput: { kind: "needs-input", items: needsInput },
    needsHuman: { kind: "needs-human", items: needsHuman },
    allEmpty,
  };
}

/** Flatten all bucket items to their ticket ids — for the bucket ∉ queue test. */
export function holdingTicketIds(b: HoldingBuckets): string[] {
  return [
    ...b.needsYou.items,
    ...b.stalled.items,
    ...b.blocked.items,
    ...b.queued.items,
    ...b.needsInput.items,
    ...b.needsHuman.items,
  ].map(itemTicketId);
}

// ── dead / stale ───────────────────────────────────────────────────────────────

/** Dead workers (activeState === "dead"), oldest first — the forensics strip. */
export function deadWorkers(workers: readonly BoardWorker[]): BoardWorker[] {
  return [...workers]
    .filter((w) => w.activeState === "dead")
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.name.localeCompare(b.name));
}
