// detail-chrome.ts — the PURE derivations behind the shared detail-page shell
// (CTL-912 / DETAIL1, detail design §3). React-/jotai-/router-free on purpose
// (it imports only the hoisted board *types* + the typed search contract) so the
// orch-monitor `bun test` suite can unit-test the breadcrumb, the pager, and the
// live-dot directly — the same dependency-free-so-it's-testable discipline as
// list-order.ts / route-search.ts. `Shell.tsx` is the thin React skin over these
// functions; because the chrome reads the URL (search params) + the resolved
// list + the entity through these helpers, the breadcrumb / `N / total` / dot can
// never disagree with what the Gherkin specifies.
//
// THE THREE DERIVATIONS:
//   - resolveBreadcrumb(ctx) → the left crumb trail, a PURE fn of the search
//     params (the SAME CTL-845 renders "Board · Implement" or "Stuck" purely from
//     `?from`/`?col`); degraded entry (no ?from) collapses to "Board › <id>".
//   - resolvePager({ids, id, cursor}) → the `N / total` pager state, incl. the
//     cold-link ghost ("4 / —", inert chevrons) and the "— / —" not-in-list case.
//   - resolveLiveDot(entity) → cyan iff working && activeState==="active"; static
//     red iff stuck; otherwise none. Cyan is reserved to liveness ONLY.

import type { DetailFrom, DetailLens } from "./route-search";
import type { BoardActiveState } from "./types";

// ── colour tokens (mirror Board.tsx; cyan is the reserved live signal) ───────
/** The reserved "in-loop" live colour — `Board.tsx:33` `LIVE = "#5be0ff"`. The
 *  detail chrome reuses the SAME token; it is the only cyan in the whole shell
 *  (peek frame + focus ring use blue, below). */
export const LIVE_CYAN = "#5be0ff";
/** Stuck/error red — `Board.tsx` `C.red`. A stuck worker's static dot. */
export const STUCK_RED = "#ef5d5d";
/** The chrome's accent blue — peek frame + focus ring (NEVER cyan), `C.blue`. */
export const CHROME_BLUE = "#4ea1ff";

// ── breadcrumb ───────────────────────────────────────────────────────────────
/**
 * The context the breadcrumb + pager reconstruct from the URL. `id` is the route
 * `$id` (the entity); the rest mirror the typed search params (`route-search.ts`).
 * `total` is the resolved-list length (it drives the middle crumb's count and
 * whether the pager shows at all) — the shell passes `listContextAtom.ids.length`.
 */
export interface BreadcrumbContext {
  id: string;
  from?: DetailFrom;
  lens?: DetailLens;
  col?: string;
  /** Resolved-list length; a `(N)` count rides the middle crumb when > 0. */
  total?: number;
}

/** One crumb in the trail. `to` is the click target (a route path) or null for
 *  the non-navigable entity crumb at the end. `live` flags the entity crumb so
 *  the shell can hang the live-dot off it. */
export interface Crumb {
  label: string;
  /** Route path to navigate to on click, or null when the crumb is inert. */
  to: string | null;
}

/** Human label for each `?from` value (the middle crumb's root word). */
const FROM_LABEL: Record<DetailFrom, string> = {
  board: "Board",
  stuck: "Stuck",
  recent: "Recent",
};

/**
 * Reconstruct the breadcrumb trail purely from the URL context (detail design
 * §3.3 "Breadcrumb"):
 *
 *   - With a `?from` context: `◂ <From>`  ·  `<Col>`  ·  `<id>`
 *       /ticket/CTL-845?from=board&lens=phase&col=Implement
 *         → "◂ Board"(→/) · "Implement"(→/) · "CTL-845"(inert)
 *       /ticket/CTL-845?from=stuck
 *         → "◂ Stuck"(→/) · "CTL-845"(inert)   (no col → no middle crumb)
 *   - Degraded entry (no `?from`, a pasted bare URL): "Board"(→/) · "<id>"(inert)
 *     — the pager is hidden by the shell in this case (resolvePager handles it).
 *
 * The first crumb always routes to `/` (board root, always clickable). The middle
 * crumb (the list context) also routes to `/` — the shell restores the column +
 * scroll from the URL on land, so a bare `/` is the correct back-target. The
 * entity crumb (`$id`) is inert (`to: null`).
 *
 * Pure: no side effects, no router, no throw on a missing/unknown field.
 */
export function resolveBreadcrumb(ctx: BreadcrumbContext): Crumb[] {
  const crumbs: Crumb[] = [];

  if (ctx.from) {
    const root = FROM_LABEL[ctx.from];
    crumbs.push({ label: `◂ ${root}`, to: "/" }); // ◂ <From>
    if (ctx.col) {
      crumbs.push({ label: ctx.col, to: "/" });
    }
  } else {
    // Degraded deep-link: only the board root + the entity.
    crumbs.push({ label: "Board", to: "/" });
  }

  crumbs.push({ label: ctx.id, to: null });
  return crumbs;
}

/**
 * The breadcrumb rendered as a single string with the design's separators
 * (`◂ Board · Implement  CTL-845`), used by the static-source Gherkin assertion
 * and the footer's repeated context crumb. The leading `◂` already lives on the
 * first crumb; list crumbs join with ` · ` and the entity crumb is separated by a
 * double space (the wireframe's spacing). A degraded trail reads `Board › <id>`.
 */
export function breadcrumbText(ctx: BreadcrumbContext): string {
  const crumbs = resolveBreadcrumb(ctx);
  const entity = crumbs[crumbs.length - 1];
  const lead = crumbs.slice(0, -1);
  if (lead.length === 0) return entity.label;
  // Degraded (no ?from) → "Board › CTL-845" (the design's degraded separator).
  if (!ctx.from) return `${lead[0].label} › ${entity.label}`; // ›
  return `${lead.map((c) => c.label).join(" · ")}  ${entity.label}`; // ·  + double space
}

// ── pager ──────────────────────────────────────────────────────────────────
/**
 * The pager's resolved display state (detail design §3.3 "Pager"):
 *   - `n`        the 1-based position, or null when unknown (cold-link / off-list)
 *   - `total`    the resolved-list length, or null when not yet rehydrated
 *   - `prevId`   the id to walk to on ▴ / `k`, or null at the start / when inert
 *   - `nextId`   the id to walk to on ▾ / `j`, or null at the end / when inert
 *   - `text`     the rendered counter: "4 / 27", the cold-link ghost "4 / —", or "— / —"
 *   - `ghosted`  true when the counter is a cold-link placeholder (dimmed, inert)
 *   - `atStart` / `atEnd`  the chevrons are disabled at the list ends
 *   - `inList`   whether `$id` is actually in the resolved list
 */
export interface PagerState {
  n: number | null;
  total: number | null;
  prevId: string | null;
  nextId: string | null;
  text: string;
  ghosted: boolean;
  atStart: boolean;
  atEnd: boolean;
  inList: boolean;
}

/** The em-dash placeholder used in a ghosted / unresolved pager. */
const DASH = "—"; // —

/**
 * Resolve the pager state from the resident id list, the current `$id`, and the
 * `?cursor` from the URL. Encodes all three pager Gherkin scenarios:
 *
 *   1. RESOLVED board walk: `ids=[…CTL-845…]`, id="CTL-845" → "N / total", with
 *      prev/next neighbours, chevrons inert at the ends.
 *   2. COLD-LINK (pasted URL, no resident list yet): `ids=[]` but a `?cursor=4`
 *      → ghosted "5 / —" (cursor is 0-based, the counter is 1-based), inert
 *      chevrons (prev/next null). When the board stream rehydrates `ids`, calling
 *      this again with the populated list lights the pager up — no separate path.
 *   3. OFF-LIST: `ids` populated but `$id` not in it (a Done ticket off the board)
 *      → "— / —", everything inert; the breadcrumb still navigates (shell concern).
 *
 * Pure: never mutates `ids`, never throws. A negative/garbage cursor is treated
 * as absent (route-search already coerces it, but be defensive).
 */
export function resolvePager(input: {
  ids: readonly string[];
  id: string;
  cursor?: number;
}): PagerState {
  const { ids, id, cursor } = input;
  const idx = ids.indexOf(id);

  // ── resolved walk: $id is in the resident list ──
  if (idx >= 0) {
    const total = ids.length;
    const atStart = idx === 0;
    const atEnd = idx === total - 1;
    return {
      n: idx + 1,
      total,
      prevId: atStart ? null : ids[idx - 1],
      nextId: atEnd ? null : ids[idx + 1],
      text: `${idx + 1} / ${total}`,
      ghosted: false,
      atStart,
      atEnd,
      inList: true,
    };
  }

  // ── cold-link ghost: no resident position, but a ?cursor hint exists ──
  if (typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0) {
    const n = cursor + 1; // cursor is 0-based; the counter is 1-based
    return {
      n,
      total: null,
      prevId: null,
      nextId: null,
      text: `${n} / ${DASH}`, // "4 / —"
      ghosted: true,
      atStart: true,
      atEnd: true,
      inList: false,
    };
  }

  // ── off-list / no context at all: "— / —", fully inert ──
  return {
    n: null,
    total: null,
    prevId: null,
    nextId: null,
    text: `${DASH} / ${DASH}`, // "— / —"
    ghosted: true,
    atStart: true,
    atEnd: true,
    inList: false,
  };
}

// ── live-dot ─────────────────────────────────────────────────────────────────
/** The live-dot variants the title anchor renders (detail design §3.3 "Title"). */
export type LiveDot =
  | { kind: "live"; color: string; breathing: true } // cyan breathing ring
  | { kind: "stuck"; color: string; breathing: false } // static red
  | { kind: "none" }; // settled entity → no dot

/** The minimal liveness signal the dot reads off a `BoardTicket` / `BoardWorker`. */
export interface LiveSignal {
  working: boolean;
  activeState: BoardActiveState;
}

/**
 * Derive the title's live-dot (detail design §3.3 "Title block", cyan license
 * §3.4). Cyan is reserved to GENUINE liveness only:
 *
 *   - `working && activeState === "active"` → cyan `#5be0ff` breathing ring.
 *   - `activeState === "stuck"`             → static red `#ef5d5d` dot.
 *   - otherwise (settled / done)            → no dot at all.
 *
 * Mirrors the board's `board-data.mjs:499`-style derivation surfaced on
 * `BoardTicket`/`BoardWorker` (`working` + `activeState`). A worker that is
 * `active` but momentarily `working === false` (between tool calls) does NOT earn
 * cyan — the cyan license is the conjunction, per the Gherkin.
 */
export function resolveLiveDot(sig: LiveSignal): LiveDot {
  if (sig.working && sig.activeState === "active") {
    return { kind: "live", color: LIVE_CYAN, breathing: true };
  }
  if (sig.activeState === "stuck") {
    return { kind: "stuck", color: STUCK_RED, breathing: false };
  }
  return { kind: "none" };
}
