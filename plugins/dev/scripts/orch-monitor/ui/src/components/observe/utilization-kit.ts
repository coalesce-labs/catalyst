// utilization-kit.ts — the PURE decision logic behind the OBSERVE Utilization
// surface (OBS-16). Lifted into its own React-free module (the same pattern
// hero-state.ts / finops-panels.ts follow) so the two load-bearing derivations —
// the STARVED/JAMMED pathology and the slot-occupancy percentage — are unit-tested
// in isolation, without a DOM or a live board.
//
// "Am I getting value from the slots I'm paying for?" The surface answers with ONE
// number (occupancy %) and ONE named diagnostic (the pathology badge). Both read
// the AUTOTUNED live capacity from /api/board `config` — NEVER a static config-file
// read (maxParallel is autotuned at runtime).

import type { OtelLogEntry } from "@/lib/types";

/** The four slot-utilization pathologies. The first two are the HISTORICAL failure
 *  modes the surface exists to make loud:
 *   - "JAMMED"    — free slots AND a waiting queue: the dispatcher is not placing
 *                   work it could (a dispatcher problem). The live Mini state.
 *   - "STARVED"   — free slots AND an empty queue: there is nothing to dispatch
 *                   (a backlog problem — feed the eligible set).
 *   - "SATURATED" — no free slots: fully booked, every slot busy. Not a problem.
 *   - "HEALTHY"   — none of the above (the neutral default). */
export type Pathology = "JAMMED" | "STARVED" | "SATURATED" | "HEALTHY";

/**
 * Decide the slot pathology from the live (autotuned) capacity counters.
 *
 *   freeSlots > 0 ∧ queueLen > 0  → JAMMED     (dispatcher problem)
 *   freeSlots > 0 ∧ queueLen == 0 → STARVED    (backlog problem)
 *   freeSlots == 0                → SATURATED   (fully booked — fine)
 *   otherwise                     → HEALTHY     (quiet)
 *
 * Note: the design doc's ">5min" JAMMED qualifier (gate JAMMED on the queue's
 * oldest item being stale) needs the OBS-15 event-log read-model, which is NOT
 * built — until then ANY `freeSlots>0 ∧ queue>0` is JAMMED (the live Mini case is a
 * multi-day park, unambiguously a dispatcher stall; we do not suppress it waiting
 * for a timestamp we can't read yet). Negative inputs are clamped to 0 so a bad
 * counter never mis-classifies. PURE + exported for the kit test.
 */
export function pathology(freeSlots: number, queueLen: number): Pathology {
  const free = Math.max(0, Math.floor(freeSlots));
  const queue = Math.max(0, Math.floor(queueLen));
  if (free === 0) return "SATURATED";
  // free > 0 from here.
  if (queue > 0) return "JAMMED";
  return "STARVED";
}

/**
 * Slot occupancy as a whole percent: `round(inFlight / maxParallel × 100)`, using
 * the AUTOTUNED live `maxParallel` from /api/board config. Returns 0 when
 * maxParallel <= 0 (no capacity → no division by zero, an honest 0%). Clamped to
 * [0,100] so a transient inFlight > maxParallel (a just-reconciled overshoot) never
 * renders >100%. PURE + exported for the kit test.
 */
export function occupancyPct(inFlight: number, maxParallel: number): number {
  if (!Number.isFinite(maxParallel) || maxParallel <= 0) return 0;
  const pct = Math.round((Math.max(0, inFlight) / maxParallel) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** The hero's utilization BAND (distinct from the pathology — the band is calm and
 *  factual so it doesn't compete with the loud STARVED/JAMMED badge below it):
 *   - "idle"  — 0% busy (◯ neutral grey; honest, not alarming on its own)
 *   - "partial" — 0 < pct < 100 (◐ cyan)
 *   - "full"  — 100% (● green, fully utilized) */
export type OccupancyBand = "idle" | "partial" | "full";

export function occupancyBand(pct: number): OccupancyBand {
  if (pct <= 0) return "idle";
  if (pct >= 100) return "full";
  return "partial";
}

// ── idle-between-phases (P3) ─────────────────────────────────────────────────
// The CTL-928 board lane: a ticket that is in-flight-on-paper but has NO live
// worker and has NOT reached the terminal `done` phase — it finished an
// intermediate phase (triage/research/plan/…) and is awaiting its next dispatch.
// The board's `laneFor` (board-data.mjs) is the server-side source of truth; the
// UI re-derives the SAME rule from the board ticket fields so the idle list reads
// the same population the board does (no new endpoint). Live = empty (workers:[],
// no between-phases tickets) → the honest zero state.

/** The synthetic pipeline-done phase (mirrors board-data.mjs PIPELINE_DONE_PHASE).
 *  A ticket on this phase is genuinely finished (recent-done), NOT idle-between. */
export const PIPELINE_DONE_PHASE = "done";

/** The minimal board-ticket shape the idle-between derivation needs. */
export interface IdleTicketInput {
  id: string;
  phase: string;
  /** A live worker is attached when workerStatus is set AND activeState != "dead". */
  workerStatus: string | null;
  activeState: "active" | "stuck" | "dead" | null;
  /** ISO start of the current phase — the "idle-for" anchor. null when unknown. */
  currentPhaseSince?: string | null;
}

/** One idle-between-phases row for the P3 list. */
export interface IdleRow {
  /** The ticket / worker identity (the list's left column). */
  id: string;
  /** The last (terminal-intermediate) phase it completed — the middle column. */
  phase: string;
  /** ms since the current phase started, or null when no honest timestamp exists
   *  (rendered as "—", never fabricated). */
  idleForMs: number | null;
}

/** Derive the idle-between-phases rows from the board tickets, applying the SAME
 *  laneFor rule the server uses: no live worker AND not the terminal `done` phase.
 *  PURE + exported for the kit test. `now` is injectable for deterministic idle-for.
 *  Live → `[]` (the honest empty state the ChartCard renders as "no data"). */
export function idleBetweenPhases(
  tickets: IdleTicketInput[],
  now: number = Date.now(),
): IdleRow[] {
  const rows: IdleRow[] = [];
  for (const t of tickets) {
    const hasLiveWorker = t.workerStatus !== null && t.activeState !== "dead";
    if (hasLiveWorker) continue; // live → on the board's "live" lane, not idle
    if (t.phase === PIPELINE_DONE_PHASE) continue; // finished → recent-done, not idle
    const since = t.currentPhaseSince ? Date.parse(t.currentPhaseSince) : NaN;
    const idleForMs = Number.isFinite(since) ? Math.max(0, now - since) : null;
    rows.push({ id: t.id, phase: t.phase, idleForMs });
  }
  // Longest-idle first (the most-stuck row leads).
  rows.sort((a, b) => (b.idleForMs ?? -1) - (a.idleForMs ?? -1));
  return rows;
}

// ── 429 / overload rate (P_err) ──────────────────────────────────────────────
// The api_error stream (from /api/otel/errors, already corrected to the OBS-7
// pipe-filter path) carries EVERY api_error, not just rate-limit ones. The
// UTILIZATION P_err panel only wants the rate-limit / overload class — a 429
// ("rate_limit") or 529 ("overloaded") is the signal that the fleet is being
// THROTTLED (paying for slots it can't use). We filter the entries to that class by
// matching the error string / status_code / raw line against the rate-limit tokens.
// Live → [] (no 429s in range — the healthy zero the ChartCard renders honestly).

/** The rate-limit / overload tokens an api_error line is matched against. 429 =
 *  rate_limit, 529 = overloaded; the word forms catch the JSON `type` shapes
 *  Anthropic returns ("rate_limit_error", "overloaded_error"). Matched
 *  case-insensitively against the line + its structured-metadata labels. */
const RATE_LIMIT_TOKENS = ["429", "529", "overloaded", "rate_limit", "rate limit"];

/** True when an api_error entry is a rate-limit / overload error. Scans the raw
 *  line plus every structured-metadata label value (the error string + status_code
 *  live in the labels, not the body — verified live, design §3.2 / OBS-7). PURE +
 *  exported for the kit test. */
export function isRateLimitError(entry: OtelLogEntry): boolean {
  const haystacks: string[] = [entry.line ?? ""];
  if (entry.labels) {
    for (const v of Object.values(entry.labels)) {
      if (typeof v === "string") haystacks.push(v);
    }
  }
  const blob = haystacks.join(" ").toLowerCase();
  return RATE_LIMIT_TOKENS.some((tok) => blob.includes(tok));
}

/** Filter an api_error set to the rate-limit / overload class (429/529/overloaded).
 *  PURE; an empty input or no rate-limit rows → [] (the honest healthy zero). */
export function rateLimitErrors(entries: OtelLogEntry[]): OtelLogEntry[] {
  return entries.filter(isRateLimitError);
}
