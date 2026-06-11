// palette-actions.ts — THE pure command-list builder behind the ⌘K palette
// (CTL-916 / DETAIL5, detail design §3.2 wireframe + §3.4 actions + §7 blocks).
//
// React-/cmdk-/jotai-free on purpose so the orch-monitor `bun test` suite can
// assert every Gherkin row — the GO TO TICKET / GO TO WORKER / RECENT groups, the
// copy / Loki / Open-PR / next-prev-stuck actions, the cyan live glyph, and the
// disabled-`soon` rows — as pure data, with no DOM and no cmdk runtime. The React
// skin (`CommandPalette.tsx`) renders this list through the re-skinned cmdk
// primitives; it owns the C-token styling + the keyboard wiring, NOT the action
// set, so the actions the operator sees can never drift from what these units lock.
//
// The action discriminant carries everything the skin needs to FIRE an item
// (navigate, copy a string, open a URL) without re-deriving anything from the
// payload — so a test can prove "Copy session id" copies the real `sessionId` and
// "Open PR" opens the real PR number, and the skin is a dumb dispatcher.

import type { BoardPayload, BoardTicket, BoardWorker } from "./types";
import { resolveLiveDot, type LiveSignal } from "./detail-chrome";

// ── focus context ────────────────────────────────────────────────────────────
/** What the palette is opened "over" — drives the worker-only copy/Loki rows and
 *  the Open-PR target. `kind:"none"` (palette opened from the board root) shows
 *  only the navigation + recents groups. */
export type PaletteFocus =
  | { kind: "ticket"; id: string }
  | { kind: "worker"; id: string }
  | { kind: "none" };

// ── action discriminant (what firing an item DOES) ───────────────────────────
/** Navigate to a detail route (the skin calls `navigate({to,params})`). */
export interface NavigateAction {
  type: "navigate";
  to: "/ticket/$id" | "/worker/$id";
  id: string;
}
/** Copy a literal string to the clipboard (the skin calls `navigator.clipboard`). */
export interface CopyAction {
  type: "copy";
  value: string;
}
/** Open an external URL in a new tab (the skin calls `window.open`). */
export interface OpenUrlAction {
  type: "open-url";
  url: string;
}

export type PaletteActionKind = NavigateAction | CopyAction | OpenUrlAction;

// ── a single palette row ─────────────────────────────────────────────────────
/**
 * One command-palette item. `disabled` + `soon` encode the honesty pattern: a row
 * whose live endpoint does not exist yet renders disabled with a `soon` tag and
 * cannot be activated (the Gherkin "render honestly disabled"). `live` is true
 * ONLY when the row surfaces a genuinely-live entity (`working && active`) — the
 * skin paints the reserved cyan glyph on those rows and nowhere else (the §3.4
 * cyan license: cyan never on focus / selection / decoration).
 */
export interface PaletteItem {
  /** Stable id for cmdk's keyed list + the skin's React key. */
  id: string;
  /** The primary label the operator reads + cmdk fuzzy-filters on. */
  label: string;
  /** Optional right-aligned meta (phase / state / id) shown muted + mono. */
  meta?: string;
  /** What firing this row does — absent on a disabled `soon` row. */
  action?: PaletteActionKind;
  /** Disabled `soon` row (no endpoint yet): rendered dim, not activatable. */
  disabled?: boolean;
  /** Honest "endpoint not built yet" tag, rendered next to a disabled row. */
  soon?: boolean;
  /** True iff this row surfaces a genuinely-live entity — the ONLY rows that earn
   *  the reserved cyan live glyph (never on focus / selection / decoration). */
  live?: boolean;
}

/** A titled group of rows (cmdk `CommandGroup`), in render order. Empty groups
 *  are dropped by `buildPaletteGroups` so the palette never shows a bare heading. */
export interface PaletteGroup {
  heading: string;
  items: PaletteItem[];
}

// ── Loki tail ────────────────────────────────────────────────────────────────
/**
 * Build the Grafana-Explore "Tail in Loki" URL for a worker's CC session.
 *
 * The LogQL is the design's verified history query (§5.2): the `claude-code`
 * stream filtered by `session_id` as a **pipe on structured metadata**, NOT a
 * stream-label matcher (`{session_id=…}` returns 0, verified). The base is the
 * Grafana Explore deep-link shape; `grafanaBase` defaults to a relative
 * `/explore` so a self-hosted Grafana behind the same origin works without
 * config, and a deployment can pass its own absolute base.
 *
 * Pure + total: returns the URL string; never throws on an odd session id.
 */
export function lokiTailUrl(sessionId: string, grafanaBase = "/explore"): string {
  // The verified LogQL: claude-code stream, session_id as a metadata pipe.
  const logql = `{service_name="claude-code"} | session_id=\`${sessionId}\``;
  // Grafana Explore reads a JSON `left` (or `panes`) param; the minimal portable
  // form is the legacy `left` array [range, datasource, {expr}]. We URL-encode the
  // whole JSON so a paste-safe deep-link survives.
  const left = JSON.stringify(["now-1h", "now", "Loki", { expr: logql }]);
  const params = new URLSearchParams({ left });
  return `${grafanaBase}?${params.toString()}`;
}

// ── go-to entity rows ────────────────────────────────────────────────────────
/** The live signal a row reads to decide the cyan glyph (the §3.4 conjunction). */
function liveOf(sig: LiveSignal): boolean {
  return resolveLiveDot(sig).kind === "live";
}

/** GO TO TICKET rows from the resident payload (every board ticket). */
function ticketNavItems(tickets: readonly BoardTicket[]): PaletteItem[] {
  return tickets.map((t) => ({
    id: `goto-ticket:${t.id}`,
    label: `${t.id}  ${t.title}`,
    meta: t.linearState,
    action: { type: "navigate", to: "/ticket/$id", id: t.id },
    live: liveOf({ working: t.working, activeState: t.activeState }),
  }));
}

/** GO TO WORKER rows from the resident payload (live runs only — `BoardPayload`
 *  workers are live-only, §3.2). */
function workerNavItems(workers: readonly BoardWorker[]): PaletteItem[] {
  return workers.map((w) => ({
    id: `goto-worker:${w.name}`,
    label: `${w.name}  ${w.phase}`,
    meta: w.status,
    action: { type: "navigate", to: "/worker/$id", id: w.name },
    live: liveOf({ working: w.working, activeState: w.activeState }),
  }));
}

/** RECENT rows — resolve each persisted id back to its resident entity (a ticket
 *  or a worker) so the row carries the same label/live signal as its nav group.
 *  An id no longer in the payload (a Done ticket off the board) still navigates,
 *  rendered without a live glyph (never fabricate liveness for a vanished entity). */
function recentItems(
  recents: readonly string[],
  tickets: readonly BoardTicket[],
  workers: readonly BoardWorker[],
): PaletteItem[] {
  return recents.map((id) => {
    const worker = workers.find((w) => w.name === id);
    if (worker) {
      return {
        id: `recent:${id}`,
        label: `${worker.name}  ${worker.phase}`,
        meta: worker.status,
        action: { type: "navigate", to: "/worker/$id", id },
        live: liveOf({ working: worker.working, activeState: worker.activeState }),
      };
    }
    const ticket = tickets.find((t) => t.id === id);
    return {
      id: `recent:${id}`,
      label: ticket ? `${ticket.id}  ${ticket.title}` : id,
      meta: ticket?.linearState,
      // A recent id may be a ticket OR a colon-bearing worker id; default the route
      // by shape (a `:` in the id means a worker run) so an off-board id still goes
      // somewhere sane.
      action: id.includes(":")
        ? { type: "navigate", to: "/worker/$id", id }
        : { type: "navigate", to: "/ticket/$id", id },
      live: ticket
        ? liveOf({ working: ticket.working, activeState: ticket.activeState })
        : false,
    };
  });
}

// ── focused-entity action rows (copy / Loki / Open PR / stuck-walk) ──────────
/**
 * The action rows that depend on the focused entity (detail design §3.4 / §5.2):
 *   - Copy session id        — AVAILABLE-NOW from `BoardWorker.sessionId`.
 *   - Copy bg_job_id         — `soon` (bg_job_id lives in the phase signal, not on
 *                              BoardWorker — needs the ec-worker endpoint P3).
 *   - Tail in Loki           — AVAILABLE-NOW when the worker has a CC session id.
 *   - Open PR                — AVAILABLE-NOW from `BoardTicket.pr` (worker resolves
 *                              its parent ticket's pr from the payload).
 *   - Next / prev stuck      — navigate to the next/prev stuck worker in the queue.
 *
 * A row whose source is genuinely absent (a worker with no `sessionId` yet, a
 * ticket with no PR) is dropped rather than fabricated — EXCEPT the `soon` rows,
 * which always render (disabled) so the operator sees the capability is coming.
 */
function focusedActionItems(focus: PaletteFocus, payload: BoardPayload): PaletteItem[] {
  if (focus.kind === "none") return [];

  const items: PaletteItem[] = [];

  // Resolve the focused worker + its parent ticket (for Open PR + the stuck walk).
  const worker =
    focus.kind === "worker" ? payload.workers.find((w) => w.name === focus.id) : undefined;
  const ticketId = focus.kind === "ticket" ? focus.id : worker?.ticket;
  const ticket = ticketId ? payload.tickets.find((t) => t.id === ticketId) : undefined;

  // ── Open PR (ticket-or-worker → the parent ticket's PR) ──
  if (ticket?.pr != null) {
    items.push({
      id: "open-pr",
      label: "Open PR",
      meta: `#${ticket.pr}`,
      action: { type: "open-url", url: `https://github.com/pull/${ticket.pr}` },
    });
  }

  if (focus.kind === "worker") {
    // ── Copy session id (CC-UUID) — AVAILABLE-NOW ──
    if (worker?.sessionId) {
      items.push({
        id: "copy-session-id",
        label: "Copy session id",
        meta: worker.sessionId,
        action: { type: "copy", value: worker.sessionId },
      });
      // ── Tail in Loki — AVAILABLE-NOW (rides the CC-UUID, §5.2) ──
      items.push({
        id: "tail-loki",
        label: "Tail in Loki",
        action: { type: "open-url", url: lokiTailUrl(worker.sessionId) },
      });
    }
    // ── Copy bg_job_id — `soon` (lives in the phase signal, not BoardWorker) ──
    items.push({
      id: "copy-bg-job-id",
      label: "Copy bg_job_id",
      disabled: true,
      soon: true,
    });

    // ── Next / prev stuck worker ──
    const stuckWalk = stuckWalkItems(focus.id, payload.workers);
    items.push(...stuckWalk);
  }

  return items;
}

/** The next/prev stuck-worker walk rows. The stuck set is the in-flight queue
 *  filtered to `activeState === "stuck"`; from the focused worker the "next"/"prev"
 *  rows navigate to the neighbouring stuck run (wrapping is avoided — at an end the
 *  row is dropped, never a dead chevron). When the focused worker isn't itself
 *  stuck, both neighbours resolve from the stuck list's natural order. */
function stuckWalkItems(focusedId: string, workers: readonly BoardWorker[]): PaletteItem[] {
  const stuck = workers.filter((w) => w.activeState === "stuck");
  if (stuck.length === 0) return [];

  const idx = stuck.findIndex((w) => w.name === focusedId);
  // If the focused worker isn't stuck, treat the cursor as "before the list" so
  // "next" is the first stuck worker and "prev" is the last.
  const prev = idx > 0 ? stuck[idx - 1] : idx === -1 ? stuck[stuck.length - 1] : undefined;
  const next = idx >= 0 && idx < stuck.length - 1 ? stuck[idx + 1] : idx === -1 ? stuck[0] : undefined;

  const out: PaletteItem[] = [];
  if (next) {
    out.push({
      id: "next-stuck",
      label: "Next stuck worker",
      meta: next.name,
      action: { type: "navigate", to: "/worker/$id", id: next.name },
    });
  }
  if (prev) {
    out.push({
      id: "prev-stuck",
      label: "Prev stuck worker",
      meta: prev.name,
      action: { type: "navigate", to: "/worker/$id", id: prev.name },
    });
  }
  return out;
}

// ── the disabled `soon` rows that always render ──────────────────────────────
/**
 * The write-actions + Linear-search rows that have no endpoint yet (detail design
 * §3.4): they ALWAYS render, disabled with a `soon` tag, and cannot be activated —
 * the honesty pattern, never a dead live action.
 *   - Search all tickets in Linear → needs `/api/search` (P12).
 *   - ⛔ Stop worker               → needs `POST …/stop` + typed confirm (P10);
 *                                    only shown when a worker is focused.
 */
function soonItems(focus: PaletteFocus): PaletteItem[] {
  const items: PaletteItem[] = [
    {
      id: "linear-search",
      label: "Search all tickets in Linear",
      disabled: true,
      soon: true,
    },
  ];
  if (focus.kind === "worker") {
    items.push({
      id: "stop-worker",
      label: "⛔ Stop worker",
      disabled: true,
      soon: true,
    });
  }
  return items;
}

// ── the public builder ───────────────────────────────────────────────────────
/**
 * Build the full ⌘K palette group list from the resident payload, the focused
 * entity, and the persisted recents (detail design §3.2 wireframe order):
 *
 *   ACTIONS        focused-entity rows (Open PR · Copy session/bg_job · Loki · stuck-walk)
 *   GO TO TICKET   every board ticket
 *   GO TO WORKER   every live worker
 *   RECENT         the persisted recently-viewed ids, resolved to entities
 *   ──────────────────────────────────────────────────────────────
 *   <disabled>     Search all tickets in Linear · ⛔ Stop worker  (always, `soon`)
 *
 * Empty groups are dropped (no bare heading). cmdk owns the fuzzy filtering over
 * `label`, so this returns the FULL set every time — the palette narrows as the
 * operator types, not here. Pure: never mutates the payload, never throws.
 */
export function buildPaletteGroups(
  payload: BoardPayload,
  focus: PaletteFocus,
  recents: readonly string[],
): PaletteGroup[] {
  const groups: PaletteGroup[] = [
    { heading: "Actions", items: focusedActionItems(focus, payload) },
    { heading: "Go to ticket", items: ticketNavItems(payload.tickets) },
    { heading: "Go to worker", items: workerNavItems(payload.workers) },
    {
      heading: "Recent",
      items: recentItems(recents, payload.tickets, payload.workers),
    },
    // The disabled `soon` rows are their own trailing group so the separator +
    // honesty tag read clearly under the live actions.
    { heading: "Needs plumbing", items: soonItems(focus) },
  ];
  // Drop empty groups (the `soon` group is never empty, so the honesty rows always
  // show); a heading with no rows would be a bare label.
  return groups.filter((g) => g.items.length > 0);
}
