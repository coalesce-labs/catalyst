// reading-pane-model.ts — THE pure core of the HOME4 reading pane (CTL-902).
// The reading pane is the progressive-disclosure payload that keeps the list rows
// calm: the one-line ask lives on the row, everything else lives HERE, one
// selection deeper, with no nested cards. This React-/jotai-/router-free module
// derives EXACTLY what the pane shows from the selected `InboxRow` plus the
// resident `BoardWorker[]` (for the View-in-Claude session) — same pattern as
// home-inbox.ts / phase-model.ts, so the orch-monitor `bun test` suite can unit
// it directly from outside the `ui/` module graph.
//
// HONESTY CONTRACT (the ticket's load-bearing rule)
// ─────────────────────────────────────────────────
// The ask / goal / summary / options / blocker content is NOT in the board
// payload today — it is served per-item by the BFF inbox endpoint (a separate
// NEEDS-PLUMBING ticket) onto the OPTIONAL BoardTicket fields. So every getter
// here renders a field the read-model OMITS as ABSENT, never fabricated: a
// missing ask yields null (the pane shows nothing in its place), missing options
// yield an empty list, and a missing session id HIDES View-in-Claude rather than
// emitting a dead link.

import type { BoardEscalationExplanation, BoardWorker } from "./types";
import { isNeedsYouSection, type InboxRow } from "./home-inbox";

/** The kind of hero "What's needed now" block a needs-you item shows:
 *  a `decision` (with options) or a `blocked` item (with a blocker detail). */
export type HeroKind = "decision" | "blocked";

/** The accent a context block uses for emphasis. NEVER cyan — cyan is reserved
 *  for the live signal. The amber/red accents are the ONLY colored emphasis the
 *  pane carries, applied as a background TINT + a left accent BAR (never a
 *  bordered sub-card). `none` = the neutral resting state (no emphasis). */
export type PaneAccent = "amber" | "red" | "none";

/** One decision option as the pane renders it — a label + one-line trade-off. */
export interface PaneOption {
  label: string;
  detail: string;
}

/** The About block — the one-line summary, the goal, and the phase strip read.
 *  Any field the read-model omits is null (rendered absent, never fabricated). */
export interface AboutBlock {
  summary: string | null;
  goal: string | null;
  /** 0-based index of the ticket's current phase in the canonical pipeline,
   *  for the HOME2 phase strip. -1 when the phase is unknown/pre-pipeline. */
  phaseIndex: number;
  /** True when the ticket has finished (the strip + glyph read as done). */
  done: boolean;
}

/** The View-in-Claude deep link — present only when a session id is known. */
export interface ViewInClaude {
  /** https://claude.ai/code/<sessionId> — the agent's Claude Code session. */
  href: string;
  sessionId: string;
}

/**
 * The View-in-Claude deep link for a row, or null when no session id is known.
 *
 * The session id is `BoardWorker.sessionId` — the CC-UUID from
 * `claude agents --json` (board-data.mjs). A ticket's worker is the one whose
 * `worker.ticket` (or its `tickets[]` set) names this row's id. When no worker /
 * no session id is found, this returns null and the pane HIDES the action rather
 * than rendering a dead link (the "no session ⇒ hidden, not a dead link"
 * Gherkin). The target is `https://claude.ai/code/<sessionId>`.
 */
export function viewInClaudeFor(
  row: InboxRow,
  workers: readonly BoardWorker[],
): ViewInClaude | null {
  const worker = workers.find(
    (w) => w.ticket === row.id || (w.tickets ?? []).includes(row.id),
  );
  const sessionId = worker?.sessionId;
  if (sessionId == null || sessionId === "") return null;
  return { href: `https://claude.ai/code/${sessionId}`, sessionId };
}

/**
 * The hero "What's needed now" kind for a needs-you row: `blocked` shows the
 * blocker detail, `waiting` shows the decision options. null for the neutral
 * (running/done) sets, which carry no hero block at all.
 */
export function heroKindFor(row: InboxRow): HeroKind | null {
  if (!isNeedsYouSection(row.section)) return null;
  return row.section === "blocked" ? "blocked" : "decision";
}

/**
 * The full ask in plain language for the hero block, or null when the read-model
 * has not served one (rendered absent, never fabricated). Only meaningful for a
 * needs-you row — the neutral sets have no ask.
 */
export function askFor(row: InboxRow): string | null {
  if (!isNeedsYouSection(row.section)) return null;
  const ask = row.ticket.ask;
  return ask != null && ask !== "" ? ask : null;
}

/**
 * The decision options for a `waiting` (decision) row — each a label + a one-line
 * trade-off. Empty when the row is not a decision, or when the read-model served
 * no options (rendered as no options, never fabricated). Drops any option missing
 * a label so the pane never shows a blank line.
 */
export function optionsFor(row: InboxRow): PaneOption[] {
  if (heroKindFor(row) !== "decision") return [];
  const opts = row.ticket.options ?? [];
  return opts
    .filter((o) => o != null && o.label != null && o.label !== "")
    .map((o) => ({ label: o.label, detail: o.detail ?? "" }));
}

/**
 * The blocker description for a `blocked` row, or null when the read-model served
 * none (rendered absent, never fabricated). Only meaningful for a blocked row.
 */
export function blockerFor(row: InboxRow): string | null {
  if (heroKindFor(row) !== "blocked") return null;
  const blocker = row.ticket.blocker;
  return blocker != null && blocker !== "" ? blocker : null;
}

/**
 * The context accent for the hero block — amber for a decision (waiting), red for
 * a blocker, and `none` for the neutral resting state. NEVER cyan. The UI applies
 * this as a whisper of background tint + a left accent bar (Direction A's
 * "emphasis is tint, never a nested card" rule), so a `none` accent renders the
 * block fully neutral with no tint/bar.
 */
export function accentFor(row: InboxRow): PaneAccent {
  const kind = heroKindFor(row);
  if (kind === "blocked") return "red";
  if (kind === "decision") return "amber";
  return "none";
}

/** CTL-1110: the needs-human escalation card view-model — a highlighted CTA plus
 *  the labelled explanation sections, top to bottom. Each field is null when the
 *  payload omitted it (rendered absent, never fabricated). */
export interface EscalationExplanationView {
  callToAction: string | null;
  outcome: string | null;
  problem: string | null;
  whyYou: string | null;
  whyNotAuto: string | null;
  whatToDo: string | null;
}

const nz = (s: string | null | undefined): string | null =>
  s != null && s !== "" ? s : null;

/**
 * The needs-human escalation explanation for the hero card, or null when the row
 * is not escalated, carries no explanation, or every field is empty (the pane
 * then falls back to the bare hero). Keyed on `attention === "needs-human"` so
 * waiting-on-you decision rows are untouched.
 */
export function escalationExplanationFor(row: InboxRow): EscalationExplanationView | null {
  if (row.ticket.attention !== "needs-human") return null;
  const e = row.ticket.explanation as BoardEscalationExplanation | null | undefined;
  if (e == null) return null;
  const view: EscalationExplanationView = {
    callToAction: nz(e.call_to_action),
    outcome: nz(e.outcome),
    problem: nz(e.problem),
    whyYou: nz(e.why_you),
    whyNotAuto: nz(e.why_not_auto),
    whatToDo: nz(e.what_to_do),
  };
  if (Object.values(view).every((v) => v == null)) return null;
  return view;
}

/**
 * The About block view-model for ANY row — the one-line summary, the goal, and
 * the phase-strip read (the where-it's-at). Summary/goal are null when the
 * read-model omits them (rendered absent). `phaseIndex` / `done` feed the HOME2
 * phase strip + StatusIcon. PURE: takes the phase-index resolver injected so this
 * module stays free of the phase-model import cycle and is trivially unit-tested.
 */
export function aboutBlockFor(
  row: InboxRow,
  phaseIndexOf: (phase: string) => number,
  isDoneStatus: (status: string) => boolean,
): AboutBlock {
  const summary = row.ticket.summary;
  const goal = row.ticket.goal;
  return {
    summary: summary != null && summary !== "" ? summary : null,
    goal: goal != null && goal !== "" ? goal : null,
    phaseIndex: phaseIndexOf(row.ticket.phase),
    done: isDoneStatus(row.ticket.status),
  };
}
