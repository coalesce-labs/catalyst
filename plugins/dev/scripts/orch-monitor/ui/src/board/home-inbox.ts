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
//   • "What's waiting"   — held === "waiting" (deps satisfied, awaiting capacity).
//   • "Running on its own" — the reassurance set (in-flight, nothing needed).
// "Blocked" + "Waiting" ARE the needs-you cases. The durable source for that
// classification is the broker's filter-state.db `ticket_state.labels`, which the
// board-data layer has ALREADY folded into `BoardTicket.held` (board-data.mjs:
// heldFor() → board payload). So this module reads `held` off the resident
// payload and NEVER reaches for Linear — exactly the CTL-899 "Inbox data comes
// from the read-model, never a live Linear call" Gherkin.

import type { BoardPayload, BoardTicket } from "./types";

/** The kind of inbox section a row belongs to. */
export type InboxSectionKind = "blocked" | "waiting" | "running" | "done";

/**
 * Whether a section's rows carry a status accent (the only colored rows on the
 * calm page — the needs-you set) or render fully neutral (the reassurance +
 * done sets). Mirrors Direction A's "color reserved for meaning" non-negotiable.
 */
export const NEEDS_YOU_SECTIONS: readonly InboxSectionKind[] = [
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
  /** The underlying ticket, for the reading pane (HOME4). */
  ticket: BoardTicket;
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
  blocked: number;
  waiting: number;
  running: number;
  done: number;
  /** blocked + waiting — the single "N need you" figure in the header. */
  needsYou: number;
}

/** Fixed render order of the sections — needs-you first (bright), reassurance
 *  + done last (neutral, collapsed by default in the UI). */
const SECTION_ORDER: readonly InboxSectionKind[] = ["blocked", "waiting", "running", "done"] as const;

const SECTION_LABEL: Record<InboxSectionKind, string> = {
  blocked: "What's blocked",
  waiting: "What's waiting",
  running: "Running on its own",
  done: "Done while you were away",
};

// The held label values the board payload carries (board-data.mjs heldFor()).
// Kept in lock-step with HELD_LABEL_BLOCKED / HELD_LABEL_WAITING there.
const HELD_BLOCKED = "blocked";
const HELD_WAITING = "waiting";

/** Phase/Linear-state values that mean a ticket is finished — its row belongs in
 *  "Done while you were away" rather than the running reassurance set. */
function isDone(t: BoardTicket): boolean {
  return t.status === "done" || t.linearState === "Done";
}

/**
 * Classify ONE ticket into its inbox section. Order matters: a done ticket is
 * done even if it still carries a stale held label; otherwise blocked/waiting
 * (the needs-you cases) take precedence over the running reassurance set.
 */
export function classifyTicket(t: BoardTicket): InboxSectionKind {
  if (isDone(t)) return "done";
  if (t.held === HELD_BLOCKED) return "blocked";
  if (t.held === HELD_WAITING) return "waiting";
  return "running";
}

/** The muted human sub-label per section — plain language, never jargon
 *  (Direction A: "waiting on your answer", not "phase-blocked needs-human"). */
function subLabelFor(kind: InboxSectionKind): string {
  switch (kind) {
    case "blocked":
      return "blocked on you";
    case "waiting":
      return "waiting on you";
    case "running":
      return "running on its own";
    case "done":
      return "shipped";
  }
}

/** The single primary verb per section — null for the neutral sets (no action). */
function verbFor(kind: InboxSectionKind): string | null {
  switch (kind) {
    case "blocked":
      return "Unblock";
    case "waiting":
      return "Answer";
    case "running":
    case "done":
      return null;
  }
}

/** Build the row view-model for one ticket in a given section. */
function toRow(t: BoardTicket, kind: InboxSectionKind): InboxRow {
  return {
    id: t.id,
    title: t.title,
    section: kind,
    subLabel: subLabelFor(kind),
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
    blocked: [],
    waiting: [],
    running: [],
    done: [],
  };

  // Preserve the payload's array order WITHIN each section (no re-sort) — the
  // board's own order is the operator's mental order, mirroring list-order.ts.
  for (const t of payload.tickets) {
    const kind = classifyTicket(t);
    buckets[kind].push(toRow(t, kind));
  }

  const sections: InboxSection[] = SECTION_ORDER.filter(
    (kind) => buckets[kind].length > 0,
  ).map((kind) => ({ kind, label: SECTION_LABEL[kind], rows: buckets[kind] }));

  const order: InboxRow[] = sections.flatMap((s) => s.rows);

  const counts: InboxCounts = {
    blocked: buckets.blocked.length,
    waiting: buckets.waiting.length,
    running: buckets.running.length,
    done: buckets.done.length,
    needsYou: buckets.blocked.length + buckets.waiting.length,
  };

  return {
    sections,
    order,
    defaultSelectedId: order.length > 0 ? order[0].id : null,
    counts,
  };
}

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
