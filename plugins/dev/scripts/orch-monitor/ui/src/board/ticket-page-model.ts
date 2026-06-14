// ticket-page-model.ts — the PURE derivations behind the ticket detail PAGE BODY
// (CTL-913 / DETAIL2, detail design §4). React-/jotai-/router-free on purpose (it
// imports only the hoisted board *types*) so the orch-monitor `bun test` suite can
// unit-test the PIPELINE rail, the HELD banner, and the LIFECYCLE SPINE node
// derivation directly — the SAME dependency-free-so-it's-testable discipline as
// detail-chrome.ts / list-order.ts / route-search.ts. `ticket-detail-page.tsx` is
// the thin React skin over these functions.
//
// The ticket page is the lifecycle aggregate sourced from RESIDENT board data
// ALONE (BoardTicket + phaseSummary): zero new endpoints. Every cell that needs
// backend plumbing it does not yet have is surfaced HONESTLY as a "NEEDS-PLUMBING"
// marker, never a fabricated value (design §4.2):
//   - held-duration: `heldFor` is pure label classification with NO timestamp, so
//     the banner's duration is `NEEDS-PLUMBING` (depends on the BFF ticket-detail
//     endpoint, DETAIL trailing tickets) — never a fabricated "2h14m".
//   - spine run-link / artifact / cost-sparkline: depend on the BFF run-records
//     endpoint (DETAIL6/DETAIL7) — surfaced as `pending` per-node markers so the
//     row renders DIMMED, never empty or invented.
//
// THE THREE DERIVATIONS:
//   - resolvePipelineRail(ticket) → one segment per canonical phase, classified
//     past | current | future (current = the ticket's `phase`); colors/dotted
//     state are the React skin's concern, the class is decided here purely.
//   - resolveHeldBanner(ticket) → null when not held; otherwise the banner tone
//     (blocked → red, waiting → yellow), the blocker ids, and the explicit
//     held-duration NEEDS-PLUMBING marker.
//   - resolveSpineNodes(ticket) → one node per phaseSummary entry with the cells
//     that ARE plumbed (phase/status/duration/timestamps/model) and the per-node
//     NEEDS-PLUMBING flags for the cells that are not (run-link/artifact/cost).

import type { BoardTicket, BoardPhaseTiming } from "./types";
import { buildBars } from "../components/ticket-gantt";

// ── canonical phase order ───────────────────────────────────────────────────
// Mirrors lib/board-data.mjs:35 PHASE_ORDER (the data-layer source of truth) and
// Board.tsx:48 PHASE_COLS — the pipeline rail walks these 10 phases left→right.
// Kept as a local const (the server list is .mjs, not import-able into the typed
// UI) but asserted against the resident `phaseSummary` order at render time, so a
// future phase added server-side surfaces rather than silently mis-classifies.
export const PIPELINE_PHASES = [
  "triage",
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "pr",
  "monitor-merge",
  "monitor-deploy",
  "teardown",
] as const;

type PipelinePhase = (typeof PIPELINE_PHASES)[number];

/** Human label per canonical phase (mirrors Board.tsx:48 PHASE_COLS labels). */
const PHASE_LABEL: Record<string, string> = {
  triage: "Triage",
  research: "Research",
  plan: "Plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  pr: "PR",
  "monitor-merge": "Merge",
  "monitor-deploy": "Deploy",
  teardown: "Teardown",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase;
}

// ── PIPELINE rail ───────────────────────────────────────────────────────────

/** Where a phase sits relative to the ticket's current phase. */
export type SegmentPlacement = "past" | "current" | "future";

export interface PipelineSegment {
  phase: string;
  /** Display label (Board.tsx:48 PHASE_COLS labels). */
  label: string;
  /** past = solid (walked); current = cyan (here now); future = dotted ghost. */
  placement: SegmentPlacement;
  /** The phase's status from phaseSummary[], or null when it has no entry (a
   *  future phase that never ran). Drives the skin's tooltip — never fabricated. */
  status: string | null;
}

/**
 * Resolve the PIPELINE rail (design §4.2 "PIPELINE rail"): one segment per
 * canonical phase, classified `past` / `current` / `future` off the ticket's
 * `phase` (the current phase) + `phaseSummary[].status`.
 *
 *   - The segment whose phase === ticket.phase is `current` (the skin colors it
 *     cyan — the reserved live signal).
 *   - Every canonical phase BEFORE the current one is `past` (solid). Whether it
 *     actually ran is reflected in `status` (from phaseSummary), not invented.
 *   - Every canonical phase AFTER the current one is `future` (a dotted ghost).
 *
 * Pure: no side effects, no throw on an unknown phase. An off-list `ticket.phase`
 * (e.g. a legacy "done") classifies every canonical phase as `past` (the lifecycle
 * is complete) — the rail still renders honestly rather than crashing.
 */
export function resolvePipelineRail(ticket: Pick<BoardTicket, "phase" | "phaseSummary">): PipelineSegment[] {
  const statusByPhase = new Map<string, string>();
  for (const p of ticket.phaseSummary) {
    // last-write-wins is fine; phaseSummary has at most one entry per phase.
    statusByPhase.set(p.phase, p.status);
  }

  // findIndex (not indexOf) so the comparison stays string-vs-string without a
  // widening cast — an off-rail phase (e.g. "done") yields -1, handled below.
  const currentIdx = PIPELINE_PHASES.findIndex((p) => p === ticket.phase);

  return PIPELINE_PHASES.map((phase, i) => {
    let placement: SegmentPlacement;
    if (currentIdx === -1) {
      // current phase isn't on the canonical rail (e.g. "done"/"merged") → the
      // whole lifecycle reads as walked. No cyan (nothing is "here now").
      placement = "past";
    } else if (i < currentIdx) {
      placement = "past";
    } else if (i === currentIdx) {
      placement = "current";
    } else {
      placement = "future";
    }
    return {
      phase,
      label: phaseLabel(phase),
      placement,
      status: statusByPhase.get(phase) ?? null,
    };
  });
}

// ── HELD banner ─────────────────────────────────────────────────────────────

/** The banner's severity tone (drives the border color in the skin). */
export type HeldTone = "blocked" | "waiting";

export interface HeldBanner {
  /** blocked → red border; waiting → yellow border (design §4.2). */
  tone: HeldTone;
  /** The blocker ids a `blocked` hold names (only populated for tone==="blocked";
   *  a `waiting` hold has no blockers — deps satisfied, lost the selection tick). */
  blockers: string[];
  /** held-duration is NEEDS-PLUMBING: `heldFor` carries NO timestamp, so the
   *  banner shows this honest marker, NEVER a fabricated duration (design §4.2).
   *  The literal string the skin renders verbatim. */
  durationMarker: "NEEDS-PLUMBING";
}

export const HELD_DURATION_MARKER = "NEEDS-PLUMBING" as const;

/**
 * Resolve the HELD banner (design §4.2 "HELD banner"):
 *
 *   - `held == null`  → returns null (the banner does NOT render at all).
 *   - `held === "blocked"` → red-bordered banner naming `blockers[]`.
 *   - `held === "waiting"` → yellow-bordered banner; no blockers.
 *   - held-duration is ALWAYS the NEEDS-PLUMBING marker (no timestamp exists).
 *
 * Pure: no side effects. A `blocked` hold with an absent/empty `blockers` array
 * yields `blockers: []` (the skin renders "no blockers named" — honest, not a
 * fabricated id).
 */
export function resolveHeldBanner(
  ticket: Pick<BoardTicket, "held" | "blockers">,
): HeldBanner | null {
  if (ticket.held == null) return null;
  return {
    tone: ticket.held, // "blocked" | "waiting" — the type narrows here
    blockers: ticket.held === "blocked" ? (ticket.blockers ?? []) : [],
    durationMarker: HELD_DURATION_MARKER,
  };
}

// ── LIFECYCLE SPINE ─────────────────────────────────────────────────────────

/** A per-node cell whose backend plumbing has NOT landed yet (design §4.2). The
 *  skin renders these DIMMED, never empty or fabricated. */
export type SpineCellState = "plumbed" | "pending";

export interface SpineNode {
  phase: string;
  label: string;
  status: string;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Per-phase model (◆sonnet/◆opus) — plumbed via BFF6 (BoardPhaseTiming.model);
   *  null when the phase signal carried no model. */
  model: string | null;
  /** True iff this node IS the ticket's current (active) phase — the skin anchors
   *  the spine scroll + the cyan "here now" treatment on it. */
  isActive: boolean;
  /** Per-phase cost in USD from BoardTicket.phaseCosts (CTL-953, AVAILABLE NOW).
   *  null when phaseCosts is absent or has no entry for this phase — never fabricated. */
  costUSD: number | null;
  /** Per-phase token count from BoardTicket.phaseCosts (CTL-953, AVAILABLE NOW).
   *  null when phaseCosts is absent or has no entry for this phase — never fabricated. */
  tokens: number | null;
  /** `plumbed` when costUSD is non-null (real phaseCosts data available);
   *  `pending` when no per-phase cost exists yet (skin dims it honestly). */
  costSparkline: SpineCellState;
  /** Artifact plumbing: `pending` always at model level — the skin issues
   *  the /api/ticket-artifacts/<id> fetch and passes resolved links down. */
  artifact: SpineCellState;
  /** Run-link plumbing: `pending` — /api/ticket-runs not yet wired. */
  runLink: SpineCellState;
}

/**
 * Resolve the LIFECYCLE SPINE (design §4.2 "LIFECYCLE SPINE"): one node per
 * `phaseSummary[]` entry, carrying the cells that ARE resident-plumbed
 * (phase/status/duration/timestamps/model/cost/tokens from phaseCosts) and the
 * NEEDS-PLUMBING flags for cells that still require backend wiring
 * (artifact = fetch-in-skin; run-link = future endpoint).
 *
 * CTL-953: `costUSD` and `tokens` are resolved directly from
 * `BoardTicket.phaseCosts[phase]` — no new endpoint. `costSparkline` is
 * `"plumbed"` when the value exists, `"pending"` otherwise.
 *
 * `isActive` is true for the node whose phase === ticket.phase AND that is not
 * terminal — i.e. the live/current node the spine scroll + cyan ring anchor on.
 *
 * Pure: no side effects. An empty phaseSummary yields `[]` (the skin renders an
 * honest "no phases yet" empty state, never a fabricated row).
 */
export function resolveSpineNodes(
  ticket: Pick<BoardTicket, "phase" | "phaseSummary" | "phaseCosts">,
): SpineNode[] {
  return ticket.phaseSummary.map((row: BoardPhaseTiming): SpineNode => {
    const isActive = row.phase === ticket.phase && !TERMINAL_SPINE_STATUSES.has(row.status);
    const phaseCost = ticket.phaseCosts?.[row.phase] ?? null;
    const costUSD = phaseCost && phaseCost.costUSD > 0 ? phaseCost.costUSD : null;
    const tokens = phaseCost && phaseCost.tokens > 0 ? phaseCost.tokens : null;
    return {
      phase: row.phase,
      label: phaseLabel(row.phase),
      status: row.status,
      durationMs: row.durationMs,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      model: row.model,
      isActive,
      costUSD,
      tokens,
      costSparkline: costUSD != null ? "plumbed" : "pending",
      // artifact links are resolved in the skin via /api/ticket-artifacts fetch.
      artifact: "pending",
      // run-link depends on /api/ticket-runs (not yet wired) — honest pending.
      runLink: "pending",
    };
  });
}

/** Phase statuses that mean a phase is no longer running — mirrors the TERMINAL
 *  set in lib/board-data.mjs / Board.tsx TERMINAL_STATUSES, so the spine's
 *  "active node" never lights cyan on a finished phase. */
const TERMINAL_SPINE_STATUSES = new Set([
  "done",
  "failed",
  "stalled",
  "skipped",
  "signal_corrupt",
  "superseded",
  "canceled",
]);

// ── Linear deep-link ────────────────────────────────────────────────────────

/**
 * Build the Linear deep-link for a ticket header (design §4.2 "Header"):
 * `↗ Linear` uses the workspace issue URL keyed by the ticket id. Mirrors the
 * existing worker-table.tsx:275 fallback shape
 * (`https://linear.app/issue/<ID>`).
 *
 * Pure: an empty/blank id returns null (the skin renders the id as plain text,
 * NEVER a dead `↗` — the honesty discipline from design §4.2).
 */
export function linearDeepLink(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return null;
  return `https://linear.app/issue/${encodeURIComponent(trimmed)}`;
}

// ── COMMS channel ───────────────────────────────────────────────────────────

/**
 * The orch comms channel name for a ticket (design §4.2 "COMMS"): the existing
 * `CommsView` is keyed by `channel = "orch-" + id`. Pure helper so the test
 * pins the exact channel string the Gherkin names ("orch-CTL-845").
 */
export function orchChannelFor(id: string): string {
  return `orch-${id}`;
}

// ── ACTIVITY predicate ──────────────────────────────────────────────────────

/**
 * The jq predicate scoping the ACTIVITY feed to ONE ticket (design §4.2
 * "ACTIVITY" — the existing activity stream scoped to the ticket's orchestrator
 * run). `useActivityStream` takes a jq predicate; we filter the global event log
 * to rows whose ticket scope matches this ticket. Canonical event scope keys
 * (verified against the existing row renderer, activity-event-row.tsx:278-279):
 *   - `catalyst.worker.ticket`    — the phase-agent worker's ticket
 *   - `linear.issue.identifier`   — the Linear-sourced ticket id
 * Either match keeps the feed honest to "this ticket's activity" without an
 * orchestrator-id lookup the resident payload does not carry.
 *
 * Empty/blank id → "" (the unfiltered all-events stream — the hook's documented
 * no-filter sentinel, use-activity.ts:29), rather than a predicate that silently
 * matches nothing.
 */
export function activityPredicateForTicket(ticketId: string): string {
  const trimmed = ticketId.trim();
  if (trimmed.length === 0) return "";
  const esc = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return (
    `(.attributes["catalyst.worker.ticket"] == "${esc}"` +
    ` or .attributes["linear.issue.identifier"] == "${esc}")`
  );
}

// ── SHIPPED status (DETAIL2-v2 §2a — the PM "is it shipped?" answer) ──────────
//
// A PURE, tested derivation of the lead-with-the-answer hero. It reads the
// RESIDENT BoardTicket + the rail it already derives (resolvePipelineRail) — it
// NEVER calls Linear. The skin renders the glyph/tone/headline/detail verbatim;
// every branch is honest (no fabricated "2h ago" — there is no merge/deploy
// timestamp on the resident payload).

export type ShipState = "shipped" | "merged" | "in-flight" | "held" | "settled";

export interface ShippedStatus {
  state: ShipState;
  /** the glyph the skin renders: "✓" shipped/merged · "●" in-flight · "⚠" held · "○" settled */
  glyph: "✓" | "●" | "⚠" | "○";
  /** semantic tone → skin color (success / info / warning / neutral). */
  tone: "success" | "info" | "warning" | "neutral";
  /** the headline, UPPERCASE plain language: "SHIPPED", "MERGED — deploying", "IN REVIEW", "BLOCKED", … */
  headline: string;
  /** the muted tail clause: "merged & deployed", "not yet shipped · phase review", "waiting on CTL-653" */
  detail: string;
  /** convenience flags for the skin / tests */
  isShipped: boolean; // merged AND deployed
  prNumber: number | null;
}

/** Phase statuses that mean a phase walked to a terminal/walked-past outcome —
 *  used so a `current` monitor-deploy that is still `running` is NOT read as
 *  shipped. Mirrors the TERMINAL set the spine + gantt share. */
const TERMINAL_RAIL_STATUSES = new Set(["done", "complete", "merged"]);

/** A rail segment is "walked past" when it is genuinely behind us: placement
 *  "past", OR placement "current" with a terminal status (do NOT trust placement
 *  alone for the current node — a running current monitor-deploy is not shipped). */
function isWalkedPast(seg: PipelineSegment | undefined): boolean {
  if (!seg) return false;
  if (seg.placement === "past") return true;
  if (seg.placement === "current" && seg.status != null) {
    return TERMINAL_RAIL_STATUSES.has(seg.status);
  }
  return false;
}

/**
 * Resolve the SHIPPED hero status (design DETAIL2-v2 §2a). Precedence is
 * top→bottom, FIRST match wins:
 *
 *   1. held  → ⚠ BLOCKED / WAITING (warning)
 *   2. (compute rail) SHIPPED: linearState==="Done" OR monitor-deploy walked-past → ✓ (success)
 *   3. MERGED: monitor-merge walked-past (deploy not yet) → ✓ MERGED — deploying (success)
 *   4. IN-FLIGHT: a current rail phase + working/active → ● IN <PHASE> (info)
 *   5. SETTLED: off-rail/legacy phase, not done, not working → ○ SETTLED (neutral)
 *
 * Pure: no throw on an unknown phase (mirrors resolvePipelineRail's tolerance).
 * An empty phaseSummary still resolves via branches 1/4/5.
 */
export function resolveShippedStatus(
  ticket: Pick<
    BoardTicket,
    | "phase"
    | "phaseSummary"
    | "linearState"
    | "pr"
    | "held"
    | "blockers"
    | "working"
    | "activeState"
    | "estimate"
    | "estimateDisplay"
  >,
): ShippedStatus {
  const prNumber = ticket.pr ?? null;

  // 1. HELD — the strongest "you must act" signal; lead with it.
  if (ticket.held != null) {
    const blocked = ticket.held === "blocked";
    const blockers = blocked ? (ticket.blockers ?? []) : [];
    return {
      state: "held",
      glyph: "⚠",
      tone: "warning",
      headline: blocked ? "BLOCKED" : "WAITING",
      detail: blocked
        ? blockers.length > 0
          ? "waiting on " + blockers.join(", ")
          : "blocked — no blockers named"
        : "deps satisfied · awaiting capacity",
      isShipped: false,
      prNumber,
    };
  }

  const rail = resolvePipelineRail(ticket);
  const deploy = rail.find((s) => s.phase === "monitor-deploy");
  const merge = rail.find((s) => s.phase === "monitor-merge");
  const prTail = prNumber != null ? ` · #${prNumber}` : "";

  // 2. SHIPPED — merged AND deployed. linearState Done is the strongest signal.
  if (ticket.linearState === "Done" || isWalkedPast(deploy)) {
    return {
      state: "shipped",
      glyph: "✓",
      tone: "success",
      headline: "SHIPPED",
      detail: "merged & deployed" + prTail,
      isShipped: true,
      prNumber,
    };
  }

  // 3. MERGED — merged but deploy not yet walked-past.
  if (isWalkedPast(merge)) {
    return {
      state: "merged",
      glyph: "✓",
      tone: "success",
      headline: "MERGED — deploying",
      detail: "merged · deploy in progress" + prTail,
      isShipped: false,
      prNumber,
    };
  }

  // 4. IN-FLIGHT — a current phase exists on the rail and the ticket is working.
  const current = rail.find((s) => s.placement === "current");
  const isWorking = ticket.working || ticket.activeState === "active";
  if (current && isWorking) {
    const est =
      ticket.estimate != null
        ? ` · ${ticket.estimateDisplay ?? `${ticket.estimate}pts`}`
        : "";
    return {
      state: "in-flight",
      glyph: "●",
      tone: "info",
      headline: "IN " + phaseLabel(ticket.phase).toUpperCase(),
      detail:
        `not yet shipped · phase ${ticket.phase}` +
        est +
        (prNumber != null ? ` · #${prNumber}` : " · no PR"),
      isShipped: false,
      prNumber,
    };
  }

  // 5. SETTLED — off-rail/legacy phase, not done, not working.
  return {
    state: "settled",
    glyph: "○",
    tone: "neutral",
    headline: "SETTLED",
    detail: "not active",
    isShipped: false,
    prNumber,
  };
}

// ── CONSOLIDATED LIFECYCLE TIMELINE rows (design DETAIL2-v2 §4a) ─────────────
//
// ONE row model that joins the spine COLUMNS (resolveSpineNodes — already
// plumbed: phase/status/duration/timestamps/model/cost/tokens) onto the bar
// GEOMETRY (buildBars — same BoardPhaseTiming source). Geometry + columns come
// from the SAME derivation so they can never drift. A LEFT join: buildBars drops
// rows with no startedAt, so a phase with no start gets leftPct/widthPct = null
// (its columns render with a blank bar cell — honest, never a fabricated bar).

export interface TimelineRow {
  // identity + columns (from resolveSpineNodes — already plumbed)
  phase: string;
  label: string;
  status: string;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  model: string | null;
  costUSD: number | null;
  tokens: number | null;
  isActive: boolean;
  costSparkline: SpineCellState;
  artifact: SpineCellState;
  runLink: SpineCellState;
  // bar geometry (from buildBars — same BoardPhaseTiming source)
  leftPct: number | null; // null when this phase has no startedAt (no bar, columns only)
  widthPct: number | null;
  isRunning: boolean;
}

/**
 * Resolve the consolidated lifecycle TIMELINE (design DETAIL2-v2 §4a): one row
 * per phaseSummary entry (source order), each carrying the spine columns AND the
 * bar geometry from the SAME BoardPhaseTiming source.
 *
 * `now` is passed in (mirrors buildBars(rows, now)) so the function stays
 * pure/testable. Pure: no side effects. An empty phaseSummary yields [] (the
 * skin renders an honest empty state).
 */
export function resolveTimelineRows(
  ticket: Pick<BoardTicket, "phase" | "phaseSummary" | "phaseCosts">,
  now: number,
): TimelineRow[] {
  const nodes = resolveSpineNodes(ticket);
  const bars = buildBars(ticket.phaseSummary, now) ?? [];
  // index geometry by phase (phaseSummary has at most one entry per phase).
  const geomByPhase = new Map(bars.map((b) => [b.row.phase, b] as const));

  return nodes.map((node): TimelineRow => {
    const geom = geomByPhase.get(node.phase) ?? null;
    return {
      phase: node.phase,
      label: node.label,
      status: node.status,
      durationMs: node.durationMs,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      model: node.model,
      costUSD: node.costUSD,
      tokens: node.tokens,
      isActive: node.isActive,
      costSparkline: node.costSparkline,
      artifact: node.artifact,
      runLink: node.runLink,
      leftPct: geom ? geom.leftPct : null,
      widthPct: geom ? geom.widthPct : null,
      isRunning: geom ? geom.isRunning : false,
    };
  });
}
