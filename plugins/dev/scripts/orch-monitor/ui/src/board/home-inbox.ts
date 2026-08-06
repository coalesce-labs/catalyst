// home-inbox.ts — THE pure core of the calm master-detail Inbox home (CTL-899 /
// HOME1). This is the unit-testable spine the React HomeInbox surface renders
// through: it derives the grouped inbox sections, the flat j/k walk order, the
// default selection, and the calm one-sentence header — all from ONE resident
// `BoardPayload` (the cache-backed read-model snapshot, pushed over SSE), never a
// synchronous Linear call. Same pattern as list-order.ts / route-search.ts: a
// React-/jotai-/router-free module so the orch-monitor `bun test` suite can unit
// it directly from outside the `ui/` module graph.
//
// WHERE THE "NEEDS YOU" SIGNAL COMES FROM
// ---------------------------------------
// Direction A (thoughts/shared/research/2026-06-08-home-page-directions.md) +
// the handoff (item #3) reshape the home groups into three calm sections:
//   • "What's blocked"  — held === "blocked" (blocked on a dependency / on you).
//   • "What's waiting"   — held === "queued" (deps satisfied, awaiting capacity;
//     CTL-764 renamed this value from "waiting", legacy tolerated during rollout).
//   • "Running on its own" — the reassurance set (in-flight, nothing needed).
// "Blocked" + "Waiting" ARE the needs-you cases. The durable source for that
// classification is the broker's filter-state.db `ticket_state.labels`, which the
// board-data layer has ALREADY folded into `BoardTicket.held` (board-data.mjs:
// heldFor() → board payload). So this module reads `held` off the resident
// payload and NEVER reaches for Linear — exactly the CTL-899 "Inbox data comes
// from the read-model, never a live Linear call" Gherkin.

import type { BoardPayload, BoardServiceOutage, BoardTicket } from "./types";

/** The kind of inbox section a row belongs to. CTL-729: 'attention' is the single
 *  needs-attention bucket (waiting-on-you ∪ needs-human), at the HEAD of the order.
 *  CTL-1050: 'awareness' is the running-degraded service-outage bucket — between
 *  'running' and 'done', NOT a needs-you section (no action required). */
export type InboxSectionKind =
  | "attention"
  | "blocked"
  | "waiting"
  | "running"
  | "awareness"
  | "done";

/**
 * Whether a section's rows carry a status accent (the only colored rows on the
 * calm page — the needs-you set) or render fully neutral (the reassurance +
 * done sets). Mirrors Direction A's "color reserved for meaning" non-negotiable.
 * CTL-729: 'attention' is a needs-you section so counts.needsYou, the all-clear
 * gate, and the calm header sentence absorb it automatically.
 */
export const NEEDS_YOU_SECTIONS: readonly InboxSectionKind[] = [
  "attention",
  "blocked",
  "waiting",
] as const;

/** True when this section is one the operator must act on (blocked | waiting). */
export function isNeedsYouSection(kind: InboxSectionKind): boolean {
  return (NEEDS_YOU_SECTIONS as readonly string[]).includes(kind);
}

/**
 * One inbox row — a flattened ticket (no nested card). Carries exactly what the
 * bare row + the (HOME4) reading pane need: the key, the one-line ask (title),
 * the section it sits in, the muted human sub-label, and the single primary verb.
 * `ticket` is kept so the reading pane can read the full detail without a second
 * lookup; the row UI itself only needs the flattened fields.
 */
export interface InboxRow {
  /** The ticket key (e.g. "CTL-642") — monospace, muted, the row's stable id. */
  id: string;
  /** The one-line ask — the bright line of the row (the ticket title). */
  title: string;
  /** Which section this row belongs to (drives the accent + grouping). */
  section: InboxSectionKind;
  /** The muted human sub-label ("blocked on you" / "running on its own" / …). */
  subLabel: string;
  /** The single primary verb for the row ("Unblock" / "Answer" / null). */
  verb: string | null;
  /** The blocker ids a `blocked` row is waiting on (empty otherwise). */
  blockers: string[];
  /** The underlying ticket, for the reading pane (HOME4). For an `awareness`
   *  (service-outage) row this is a SYNTHETIC stub so existing ticket-reading
   *  consumers never NPE — the real outage payload is on `outage`. */
  ticket: BoardTicket;
  /** CTL-1050: the service outage backing an `awareness` row (absent on every
   *  ticket-backed row). Row click navigates to /?surface=fleetops. */
  outage?: BoardServiceOutage;
}

/** A grouped, titled section of the inbox (rendered as a bare list with a
 *  hairline-divider header — never a card). */
export interface InboxSection {
  kind: InboxSectionKind;
  /** The section heading shown above its rows ("What's blocked", …). */
  label: string;
  rows: InboxRow[];
}

/** The fully-derived inbox view the Home surface renders. */
export interface InboxModel {
  /** Sections in fixed render order: blocked → waiting → running → done.
   *  Empty sections are dropped, so the page only shows what exists. */
  sections: InboxSection[];
  /** The flat, cross-section walk order j/k moves through and the pane reads —
   *  blocked rows first, then waiting, then running, then done. */
  order: InboxRow[];
  /** The id selected by default on load: the top of `order` (the most-urgent
   *  needs-you row when any exists, else the first running row). null on empty. */
  defaultSelectedId: string | null;
  /** Section counts, for the calm header sentence + the collapsed-count chips. */
  counts: InboxCounts;
}

/** Per-section counts the calm header + section chips read. */
export interface InboxCounts {
  /** CTL-729: the single needs-attention bucket (waiting-on-you ∪ needs-human). */
  attention: number;
  blocked: number;
  waiting: number;
  running: number;
  /** CTL-1220: tickets auto-fixed by the recovery sweep (enforce mode). */
  autoFixed: number;
  /** CTL-1220: tickets identified as fixable by the recovery sweep (shadow mode). */
  triaged: number;
  /** CTL-1050: current service outages (the awareness section) — NOT a needs-you
   *  count and NOT folded into needsYou / the all-clear gate. */
  awareness: number;
  done: number;
  /** attention + blocked + waiting — the single "N need you" figure in the header. */
  needsYou: number;
}

/** Fixed render order of the sections — needs-you first (bright), reassurance
 *  + done last (neutral, collapsed by default in the UI). CTL-729: 'attention'
 *  (the single needs-attention bucket) leads. */
const SECTION_ORDER: readonly InboxSectionKind[] = [
  "attention",
  "blocked",
  "waiting",
  "running",
  // CTL-1050: awareness (service outages) sits AFTER running, BEFORE done.
  "awareness",
  "done",
] as const;

const SECTION_LABEL: Record<InboxSectionKind, string> = {
  attention: "Needs you",
  blocked: "What's blocked",
  waiting: "What's waiting",
  running: "Running on its own",
  awareness: "Awareness",
  done: "Done while you were away",
};

// The held label values the board payload carries (board-data.mjs heldFor()).
// Kept in lock-step with HELD_LABEL_BLOCKED / HELD_LABEL_WAITING there.
// CTL-764 Phase 4: the awaiting-capacity value was renamed "waiting" → "queued"
// (board-data.mjs HELD_LABEL_WAITING = "queued"); heldFor() emits "queued" and
// back-compat-maps a legacy "waiting" label to it. So the payload's `held` is
// "queued" at runtime — match that here (and tolerate a legacy "waiting" during
// rollout, mirroring Board.tsx HeldBadge) or held-awaiting-capacity tickets fall
// through to "running" and vanish from the "What's waiting" inbox section.
const HELD_BLOCKED = "blocked";
const HELD_WAITING = "queued";
const HELD_WAITING_LEGACY = "waiting";

/** Phase/Linear-state values that mean a ticket is finished — its row belongs in
 *  "Done while you were away" rather than the running reassurance set. */
function isDone(t: BoardTicket): boolean {
  return t.status === "done" || t.linearState === "Done";
}

/**
 * Classify ONE ticket into its inbox section. Order matters (CTL-729):
 *   done → attention → blocked → waiting → running.
 * A done ticket is done even if it still carries a stale attention/held flag;
 * otherwise the single needs-attention bucket (waiting-on-you ∪ needs-human) is
 * the MOST urgent operator-action case — it outranks the admission-gate held
 * (blocked/waiting) pair, which in turn outranks the running reassurance set.
 */
export function classifyTicket(t: BoardTicket): InboxSectionKind {
  if (isDone(t)) return "done";
  if (t.attention === "waiting-on-you" || t.attention === "needs-human") return "attention";
  if (t.held === HELD_BLOCKED) return "blocked";
  if (t.held === HELD_WAITING || t.held === HELD_WAITING_LEGACY) return "waiting";
  return "running";
}

/** CTL-729/CTL-1130: the muted human sub-label for an attention row, in plain
 *  language — naming WHY it needs you. For needs-human rows, uses the structured
 *  explanation's call_to_action when present; falls back to the generic phrase. */
function attentionSubLabel(t: BoardTicket): string {
  if (t.attention === "needs-human") {
    return t.humanQuestion && t.humanQuestion.trim() !== ""
      ? t.humanQuestion
      : "escalated — needs human";
  }
  return "waiting on your answer";
}

/** The muted human sub-label per section — plain language, never jargon
 *  (Direction A: "waiting on your answer", not "phase-blocked needs-human").
 *  CTL-729: the 'attention' sub-label is reason-specific (see attentionSubLabel),
 *  so it is resolved in toRow from the ticket, not from the kind alone. */
function subLabelFor(kind: InboxSectionKind): string {
  switch (kind) {
    case "attention":
      // Overridden per-ticket in toRow; this is the neutral fallback.
      return "needs you";
    case "blocked":
      return "blocked on you";
    case "waiting":
      return "waiting on you";
    case "running":
      return "running on its own";
    case "awareness":
      return "running degraded — no action needed";
    case "done":
      return "shipped";
  }
}

/** The single primary verb per section — null for the neutral sets (no action). */
function verbFor(kind: InboxSectionKind): string | null {
  switch (kind) {
    case "attention":
      return "Respond";
    case "blocked":
      return "Unblock";
    case "waiting":
      return "Answer";
    case "running":
    case "awareness":
    case "done":
      return null;
  }
}

/** CTL-1050: the one-line copy for an awareness (service-outage) row — the body
 *  the outage event carries, e.g. "Loki is unreachable since 14:32 — telemetry
 *  views degraded". Falls back to the detail / a bare label when absent. */
function outageTitle(o: BoardServiceOutage): string {
  if (o.detail && o.detail.length > 0) return o.detail;
  return `${o.label} is unreachable`;
}

/** A minimal synthetic BoardTicket for an awareness row, so the existing
 *  ticket-reading consumers (reading pane, inbox-row) never NPE. Keyed by the
 *  service id; carries only the safe display fields. */
function syntheticOutageTicket(o: BoardServiceOutage): BoardTicket {
  return {
    id: o.id,
    title: outageTitle(o),
    type: "service",
    repo: "",
    team: "",
    phase: "monitor-deploy",
    status: "running",
    model: null,
    linearState: "",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 0,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: new Date(o.downSince ?? Date.now()).toISOString(),
  };
}

/** Build an awareness row from a current service outage. One row per service,
 *  keyed by serviceId — updated in place across snapshots, dropped on recovery. */
function outageRow(o: BoardServiceOutage): InboxRow {
  return {
    id: o.id,
    title: outageTitle(o),
    section: "awareness",
    subLabel: subLabelFor("awareness"),
    verb: null,
    blockers: [],
    ticket: syntheticOutageTicket(o),
    outage: o,
  };
}

/** Build the row view-model for one ticket in a given section. */
function toRow(t: BoardTicket, kind: InboxSectionKind): InboxRow {
  return {
    id: t.id,
    title: t.title,
    section: kind,
    // CTL-729: an attention row's sub-label names the specific reason.
    subLabel: kind === "attention" ? attentionSubLabel(t) : subLabelFor(kind),
    verb: verbFor(kind),
    blockers: kind === "blocked" ? (t.blockers ?? []).filter(Boolean) : [],
    ticket: t,
  };
}

/**
 * Derive the full inbox view from a resident `BoardPayload`. PURE: never mutates
 * the payload, never throws on missing fields, and reaches for NO network/Linear
 * — it reads only the snapshot the SSE read-model already pushed.
 *
 * Sections are built in `SECTION_ORDER` and empty ones are dropped (the calm page
 * shows only what exists). `order` is the flat concatenation of those sections'
 * rows — the single j/k walk + reading-pane source — and `defaultSelectedId` is
 * its head (the most-urgent needs-you row, else the first running row, else the
 * first done row; null when there is nothing at all).
 */
export function deriveInbox(payload: BoardPayload): InboxModel {
  const buckets: Record<InboxSectionKind, InboxRow[]> = {
    attention: [],
    blocked: [],
    waiting: [],
    running: [],
    awareness: [],
    done: [],
  };

  // Preserve the payload's array order WITHIN each section (no re-sort) — the
  // board's own order is the operator's mental order, mirroring list-order.ts.
  for (const t of payload.tickets) {
    const kind = classifyTicket(t);
    buckets[kind].push(toRow(t, kind));
  }

  // CTL-1050 §3.2: the awareness section is STATE-DERIVED from the server-decorated
  // current outages — one row per `down` service, structurally flap-proof (a
  // recovered service simply drops out of the next snapshot). NEVER read from the
  // event log here; the inbox renders live state, the event log records history.
  for (const o of payload.serviceHealth?.outages ?? []) {
    buckets.awareness.push(outageRow(o));
  }

  const sections: InboxSection[] = SECTION_ORDER.filter(
    (kind) => buckets[kind].length > 0,
  ).map((kind) => ({ kind, label: SECTION_LABEL[kind], rows: buckets[kind] }));

  const order: InboxRow[] = sections.flatMap((s) => s.rows);

  const counts: InboxCounts = {
    attention: buckets.attention.length,
    blocked: buckets.blocked.length,
    waiting: buckets.waiting.length,
    running: buckets.running.length,
    // CTL-1220: recovery-sweep counts, folded over every ticket (the safe
    // denominator for the "Done while you were away" reassurance copy — these
    // are independent of section bucketing). Fields populated by board-data.mjs
    // from the unified event log (loadRecoveryOutcomes).
    autoFixed: payload.tickets.filter((t) => t.autoFixed).length, // was 0
    triaged: payload.tickets.filter((t) => t.triaged).length, // was 0
    awareness: buckets.awareness.length,
    done: buckets.done.length,
    // CTL-729: the single "N need you" figure absorbs the attention bucket.
    // CTL-1050: awareness is DELIBERATELY excluded — a service outage is "no
    // action needed", so it never inflates the needs-you figure or the all-clear gate.
    needsYou: buckets.attention.length + buckets.blocked.length + buckets.waiting.length,
  };

  return {
    sections,
    order,
    defaultSelectedId: order.length > 0 ? order[0].id : null,
    counts,
  };
}

/**
 * THE all-clear gate (CTL-904 / HOME6). The empty state is the relief payoff —
 * designed as a feature, not a fallback — so it is keyed on the SAME read-model
 * emptiness the rest of the inbox derives from: zero blocked + zero waiting (i.e.
 * `needsYou === 0`). When this holds, NOTHING needs the operator, so Home swaps in
 * the calm all-clear hero even while agents keep running on their own. PURE: reads
 * only the already-derived counts, reaches for no network/Linear.
 */
export function isAllClear(counts: InboxCounts): boolean {
  return counts.needsYou === 0;
}

/**
 * The reassurance line shown in the all-clear hero (CTL-904 / HOME6). Names how
 * many agents are still running on their own — the structural reassurance that
 * makes the check-in operator exhale — and always closes with the "check back
 * whenever" invitation. When nothing at all is in flight it still reassures (the
 * agents are simply idle, not stalled), so the operator is never left with a bare
 * blank pane.
 */
export function allClearReassurance(counts: InboxCounts): string {
  if (counts.running > 0) {
    const verb = counts.running === 1 ? "agent is" : "agents are";
    const its = counts.running === 1 ? "its" : "their";
    return `${counts.running} ${verb} running on ${its} own — check back whenever.`;
  }
  return "Agents are running on their own — check back whenever.";
}

/**
 * The "N shipped while you were away" summary for the all-clear list (CTL-904 /
 * HOME6). Reads the `done` count (the "Done while you were away" reassurance set
 * the broker already folded into the snapshot). Returns null when nothing shipped,
 * so the list shows the bare "All clear" headline without a misleading "0 shipped".
 */
export function shippedWhileAwaySummary(counts: InboxCounts): string | null {
  if (counts.done <= 0) return null;
  return `${counts.done} shipped while you were away`;
}

/**
 * The all-clear list HEADLINE (CTL-904 / HOME6). When nothing needs the operator,
 * the list header reads as everything-handled — "All clear" — rather than leading
 * with an alarm count. This is intentionally SEPARATE from calmHeaderSentence (the
 * normal one-sentence state-of-things header): the all-clear surface owns its own
 * celebratory copy so the alarm-count sentence never leaks into the relief payoff.
 */
export const ALL_CLEAR_HEADLINE = "All clear — nothing needs you right now.";

/**
 * The calm "state of things" header — ONE sentence, never a KPI grid (Direction A
 * non-negotiable #5). Reads e.g.:
 *   "4 running on their own · 2 need you · nothing on fire"
 * The "need you" clause is dropped when nothing needs you (so the sentence reads
 * the reassuring "running on their own · nothing on fire"), and the whole thing
 * collapses to a celebratory line when the inbox is empty.
 */
export function calmHeaderSentence(counts: InboxCounts): string {
  const parts: string[] = [];

  if (counts.running > 0) {
    parts.push(`${counts.running} running on ${counts.running === 1 ? "its" : "their"} own`);
  }
  if (counts.needsYou > 0) {
    parts.push(`${counts.needsYou} need${counts.needsYou === 1 ? "s" : ""} you`);
  }

  // The reassurance tail: "nothing on fire" when nothing is blocked, else name
  // the heat so the calm sentence never lies about a real blocker.
  parts.push(counts.blocked > 0 ? `${counts.blocked} blocked` : "nothing on fire");

  // Wholly-empty inbox → the relief payoff, designed as a feature not a fallback.
  if (counts.running === 0 && counts.needsYou === 0 && counts.done === 0) {
    return "All clear — nothing needs you right now.";
  }

  return parts.join(" · ");
}

/**
 * Move the j/k selection by `delta` (+1 = j/down, -1 = k/up) over the flat walk
 * order, clamped to the list ends (never wraps, never throws). Returns the new
 * selected id; if `currentId` is not in the order (a stale selection after a
 * snapshot reshuffle) it resets to the head, so the pane is never left pointing
 * at a vanished row.
 */
export function moveSelection(
  order: readonly InboxRow[],
  currentId: string | null,
  delta: number,
): string | null {
  if (order.length === 0) return null;
  const idx = currentId == null ? -1 : order.findIndex((r) => r.id === currentId);
  if (idx === -1) return order[0].id;
  const next = Math.min(order.length - 1, Math.max(0, idx + delta));
  return order[next].id;
}

/** Find a row by id in a derived inbox (the reading pane reads the selected
 *  row's full ticket through this). Returns null for an unknown/cleared id. */
export function rowById(model: InboxModel, id: string | null): InboxRow | null {
  if (id == null) return null;
  return model.order.find((r) => r.id === id) ?? null;
}

// ── CTL-901 (HOME3): per-row "how long" durations ───────────────────────────
// The page answers "what needs me and for how long". Each row carries a relative
// duration anchored to a DURABLE read-model timestamp — never a fabricated one:
//   • blocked / waiting → `heldSince` (the applied-at of the held labels, BFF11)
//     = how long it has been waiting on you / blocked.
//   • running           → `currentPhaseSince` (the current phase's startedAt)
//     = how long it has been running / in its current state.
//   • done              → no live duration (it is finished) → null.
// When the chosen anchor is absent or unparseable, the duration is null and the
// UI omits / marks-unavailable the cell rather than inventing a value (the
// "honest, never fabricated" Gherkin). PURE + side-effect-free so it is unit-
// testable from outside the React tree; `now` is injected for the same reason.

/** The ISO timestamp a row's duration is measured FROM, per section. Returns the
 *  durable anchor (heldSince for held rows, currentPhaseSince for running) or
 *  null when this section has no live duration OR the anchor was never stamped. */
export function rowDurationAnchor(row: InboxRow): string | null {
  switch (row.section) {
    case "attention":
      // CTL-729: how long it has needed you — the attention start (the worker's
      // current-phase start for waiting-on-you), falling back to the held applied-at.
      return row.ticket.attentionSince ?? row.ticket.heldSince ?? null;
    case "blocked":
    case "waiting":
      return row.ticket.heldSince ?? null;
    case "running":
      return row.ticket.currentPhaseSince ?? null;
    case "awareness":
      // An awareness row's "duration" is how long the outage has been down.
      return row.outage?.downSince != null
        ? new Date(row.outage.downSince).toISOString()
        : null;
    case "done":
      return null;
  }
}

/**
 * The elapsed milliseconds a row has been in its current waiting/blocked/running
 * state, or null when there is no honest backing timestamp (anchor absent or
 * unparseable) — in which case the UI MUST omit / mark the cell unavailable
 * rather than fabricate a value. A clock-skewed anchor in the future clamps to 0
 * (we never render a negative "−3m"); the anchor itself is never mutated.
 */
export function rowDurationMs(row: InboxRow, now: number): number | null {
  const anchor = rowDurationAnchor(row);
  if (anchor == null) return null;
  const t = Date.parse(anchor);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}
