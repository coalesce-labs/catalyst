// detail-nav.ts — CTL-942 + CTL-951: card → detail-page navigation.
//
// The /ticket/$id + /worker/$id routes live in the TanStack router mounted by
// the BOARD entry (board.html → main.tsx → AppRouter); the app shell
// (index.html → App) mounts NO router. The Board component mounts in BOTH
// entries, so any "open the detail page" affordance must be a real browser
// navigation (the server's CTL-942 SPA fallback answers it with board.html) —
// an in-app router push can't cross entries and the embedded shell has no
// router to push into.
//
// CTL-951 turns the PLAIN single-click into that navigation (the drawer is
// removed): one click on a card — kanban OR list — goes straight to the detail
// page. Before navigating, `openDetail` persists the on-screen list + scroll +
// originating card into sessionStorage so `Esc`/back restores the board in the
// EXACT state it was left, even across the full-document navigation the entry
// split forces. The detail Shell reconstructs the breadcrumb + pager purely from
// the `?from&lens&col&cursor` search params encoded by `detailHref` (which read
// through the SAME `resolveList` order — see route-search.ts / detail-chrome.ts).
//
// Pure helpers (no DOM) are unit-testable directly; the few that DO touch
// `sessionStorage` / `window` are written defensively so they no-op rather than
// throw when storage is unavailable (private mode, SSR, the bun test shim).

import type { DetailFrom, DetailLens } from "./route-search";

/** The kind of entity a card opens — selects the route + the list-context kind. */
export type DetailKind = "ticket" | "worker";

/** The list-origin context a card carries into the detail page (mirrors the
 *  typed search params the Shell reconstructs). `cursor` is the 0-based index of
 *  the clicked entity within the on-screen ordered list. */
export interface DetailNavContext {
  from: DetailFrom;
  lens?: DetailLens;
  col?: string;
  cursor?: number;
}

/** Base path for a detail page (no search params). `id` carries colons for
 *  worker run ids ("CTL-845:2") — a colon is legal inside one path segment. */
function detailBase(kind: DetailKind, id: string): string {
  return `/${kind}/${encodeURIComponent(id)}`;
}

/** Full-page URL for a ticket detail page (base, no search). */
export function ticketDetailHref(id: string): string {
  return detailBase("ticket", id);
}

/** Full-page URL for a worker (single-run) detail page; ids carry colons. */
export function workerDetailHref(name: string): string {
  return detailBase("worker", name);
}

/**
 * Build the deep-link href WITH the typed `?from&lens&col&cursor` search params
 * so the detail Shell can reconstruct the breadcrumb + pager (and the `Esc`/back
 * target) from the URL alone. Omits any absent field (a cold context yields the
 * bare base path). `cursor` is encoded only when it is a finite, non-negative
 * integer — anything else is dropped (route-search coerces defensively too).
 */
export function detailHref(kind: DetailKind, id: string, ctx: DetailNavContext): string {
  const params = new URLSearchParams();
  params.set("from", ctx.from);
  if (ctx.lens) params.set("lens", ctx.lens);
  if (ctx.col) params.set("col", ctx.col);
  if (typeof ctx.cursor === "number" && Number.isInteger(ctx.cursor) && ctx.cursor >= 0) {
    params.set("cursor", String(ctx.cursor));
  }
  const qs = params.toString();
  return qs ? `${detailBase(kind, id)}?${qs}` : detailBase(kind, id);
}

// ── persisted board state (survives the full-document navigation) ─────────────

/** The sessionStorage key the board-restore context is stashed under. One key,
 *  overwritten on every card open — the operator only ever returns to the LAST
 *  list they left. */
export const LIST_CONTEXT_STORAGE_KEY = "catalyst-list-context-v1";

/** Restore snapshots older than this are ignored on read (a day-old session
 *  shouldn't yank the operator to a stale scroll position). */
export const LIST_CONTEXT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * The board state captured when a card is opened, so `Esc`/back can restore the
 * board exactly. `ids` + `kind` + `lens` + `col` mirror the resolved walk list
 * (so the restored board's listContextAtom matches the pager); `scroll` is the
 * board scroll-container offset; `focusId` is the originating card to re-focus;
 * `cursor` is its index in `ids`. Display-options (density/grouping/order/repo
 * scope) are NOT stored here — they already persist in their own localStorage
 * atoms (`boardPrefsAtom` / `repoScopeAtom`) and survive the navigation for free.
 */
export interface ListContextSnapshot {
  ids: string[];
  kind: DetailKind;
  lens?: DetailLens;
  col?: string;
  /** The 0-based index of the opened entity in `ids` (the restored cursor). */
  cursor: number;
  /** The opened entity id — the card the board re-focuses on return. */
  focusId: string;
  /** The board scroll-container offset to restore (px). */
  scroll: { top: number; left: number };
  /** When captured (ms epoch) — a stale snapshot is ignored on restore. */
  savedAt: number;
}

/** Safe `sessionStorage` accessor — returns null when storage is unavailable
 *  (SSR / private-mode throw / the bun shim) rather than throwing. */
function safeSessionStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Persist a board-restore snapshot to sessionStorage. The only side effect is
 * the storage write; it swallows quota/serialization errors so a card click can
 * never fail to navigate because the stash failed.
 */
export function writeListContext(snapshot: ListContextSnapshot): void {
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.setItem(LIST_CONTEXT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // quota / serialization — non-fatal; navigation proceeds without restore.
  }
}

/**
 * Read + validate the persisted board-restore snapshot. Returns null when
 * absent, malformed, or older than `LIST_CONTEXT_MAX_AGE_MS`. Total + never
 * throws — a hand-edited or corrupt blob yields null, never a crash.
 */
export function readListContext(now: number = Date.now()): ListContextSnapshot | null {
  const store = safeSessionStorage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(LIST_CONTEXT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  return parseListContext(raw, now);
}

/**
 * Parse + validate a serialized snapshot (split out so it's unit-testable
 * without a storage runtime). Drops anything malformed/stale to null.
 */
export function parseListContext(
  raw: string,
  now: number = Date.now(),
): ListContextSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Partial<ListContextSnapshot> & Record<string, unknown>;
  if (!Array.isArray(o.ids) || !o.ids.every((x) => typeof x === "string")) return null;
  if (o.kind !== "ticket" && o.kind !== "worker") return null;
  if (typeof o.focusId !== "string") return null;
  if (typeof o.savedAt !== "number" || !Number.isFinite(o.savedAt)) return null;
  if (now - o.savedAt > LIST_CONTEXT_MAX_AGE_MS) return null;
  const scroll =
    o.scroll && typeof o.scroll === "object"
      ? {
          top: typeof (o.scroll as { top?: unknown }).top === "number" ? (o.scroll as { top: number }).top : 0,
          left: typeof (o.scroll as { left?: unknown }).left === "number" ? (o.scroll as { left: number }).left : 0,
        }
      : { top: 0, left: 0 };
  return {
    ids: o.ids as string[],
    kind: o.kind,
    lens: o.lens === "linear" || o.lens === "phase" ? o.lens : undefined,
    col: typeof o.col === "string" ? o.col : undefined,
    cursor:
      typeof o.cursor === "number" && Number.isInteger(o.cursor) && o.cursor >= 0 ? o.cursor : 0,
    focusId: o.focusId,
    scroll,
    savedAt: o.savedAt,
  };
}

/** Clear the persisted board-restore snapshot (called once it's consumed on
 *  restore, so it never re-fires on a later unrelated board visit). */
export function clearListContext(): void {
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.removeItem(LIST_CONTEXT_STORAGE_KEY);
  } catch {
    // non-fatal
  }
}

// ── the click → navigate seam (the DOM-touching helpers) ──────────────────────

/**
 * True when a mouse event is the "open in a new tab" gesture: Cmd-click (mac),
 * Ctrl-click, or middle-click. Cards intercept these to open the detail page in
 * a new tab; a PLAIN primary click navigates in place (CTL-951).
 */
export function isNewTabClick(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  button: number;
}): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1;
}

/** Open a detail page in a new tab (the modified-click gesture). */
export function openDetailInNewTab(href: string): void {
  if (typeof window === "undefined") return;
  window.open(href, "_blank", "noopener,noreferrer");
}

/**
 * The full-document navigation a PLAIN card click performs (CTL-951). The detail
 * routes only exist in the board.html entry's router; a full-doc nav reaches them
 * from BOTH entries because the server's SPA fallback serves board.html for
 * `/ticket/*` and `/worker/*`. We `assign` (not `replace`) so the browser Back
 * button returns to the board — and on that return the board reads the
 * sessionStorage snapshot to restore scroll + focus + list-context.
 */
export function hardNavigate(href: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(href);
}

/**
 * Open a card's detail page on a plain single-click: capture the board-restore
 * snapshot, then hard-navigate to the deep link. `scroll` is the board
 * scroll-container offset the caller reads (kanban + list own different scroll
 * roots); it defaults to no offset when omitted. `from` defaults to "board".
 */
export function openDetail(
  kind: DetailKind,
  id: string,
  args: {
    ids: string[];
    lens?: DetailLens;
    col?: string;
    from?: DetailFrom;
    scroll?: { top: number; left: number };
  },
): void {
  const cursor = args.ids.indexOf(id);
  const from: DetailFrom = args.from ?? "board";
  writeListContext({
    ids: args.ids,
    kind,
    lens: args.lens,
    col: args.col,
    cursor: cursor >= 0 ? cursor : 0,
    focusId: id,
    scroll: args.scroll ?? { top: 0, left: 0 },
    savedAt: Date.now(),
  });
  const href = detailHref(kind, id, {
    from,
    lens: args.lens,
    col: args.col,
    cursor: cursor >= 0 ? cursor : undefined,
  });
  hardNavigate(href);
}
