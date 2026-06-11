// Shell.tsx — the shared detail-PAGE chrome both the ticket page (DETAIL2) and
// the worker page (DETAIL3) render inside (CTL-912 / DETAIL1, detail design §3).
//
// IMPORTANT: this is the detail-PAGE chrome (breadcrumb · pager · live-dot title ·
// Properties rail · <DetailBody> slot · footer) — it is NOT the app-nav Sidebar
// (that is the SHELL stream's `AppShell` frame). The two are distinct components
// that nest: AppShell is the application frame; Shell is the per-entity detail
// chrome inside a route.
//
// All ordering / breadcrumb / pager / live-dot logic is the PURE detail-chrome.ts
// + list-order.ts (unit-tested without a DOM). This file is the thin React skin:
//   - it reads the typed `?from&lens&col&cursor` search params off the URL,
//   - resolves the walk list via `resolveList` (the SAME comparator as Board.tsx,
//     so `N / total` can never drift from the on-screen order),
//   - drives the jotai nav store (listContextAtom / peekAtom / paletteOpenAtom /
//     recentlyViewedAtom) — owned by FND, READ (not re-created) here,
//   - extends the existing keyboard hook in place with j/k / g-chords / ⌘K
//     (use-keyboard-nav.ts), preserving `/`→search, `?`, Esc + the input guard.
//
// The page surface drops its body into <DetailBody> and appends page-specific
// Property rows below the shared rail divider; the shell never renders body panels.

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useDetailEntryState } from "../hooks/use-detail-entry-state";
import {
  breadcrumbText,
  resolveBreadcrumb,
  resolvePager,
  resolveLiveDot,
  CHROME_BLUE,
  type LiveSignal,
  type PagerState,
} from "./detail-chrome";
import { C } from "./board-tokens";
import {
  cheatsheetOpenAtom,
  listContextAtom,
  paletteOpenAtom,
  recordRecentAtom,
} from "./nav-store";
import type { DetailSearch } from "./route-search";
import { useKeyboardNav } from "../hooks/use-keyboard-nav";
import { ChevronUp, ChevronDown } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HeaderActions } from "@/components/header-actions";

// ── tokens (CTL-1033: the ONE canonical palette from board-tokens.ts; the stale
//    local ramp here was the cause of detail pages rendering darker than the
//    sidebar — C.s1 is now the shared content canvas) ──────────────────────────

// ── live-dot CSS (reuses the board's `catalyst-live-dot` breathing-ring keyframe,
//    Board.tsx:118/121 — the SAME cyan signal, no new animation) ──────────────
const SHELL_PULSE_CSS = `
@keyframes catalystShellLivePing { 0%{box-shadow:0 0 0 0 rgba(91,224,255,.6)} 70%{box-shadow:0 0 0 6px rgba(91,224,255,0)} 100%{box-shadow:0 0 0 0 rgba(91,224,255,0)} }
.catalyst-shell-live-dot { animation: catalystShellLivePing 1.9s infinite; }
@media (prefers-reduced-motion: reduce) { .catalyst-shell-live-dot { animation: none; } }
`;

/** The route kind the shell is chrome-ing — selects the list-context `kind` and
 *  the route the breadcrumb/pager navigate to (`/ticket/$id` vs `/worker/$id`). */
export type ShellKind = "ticket" | "worker";

/** The freshness of the board stream the footer reports. `unknown` renders a dim
 *  dot with no "live" claim (the never-fabricate discipline) until the page surface
 *  passes a real `EventSource.readyState`-derived value. */
export type StreamHealth =
  | { state: "live"; lastFrameAgoMs: number | null }
  | { state: "reconnecting" }
  | { state: "unknown" };

/** The shared, cheap Property rows the shell knows how to render (detail design
 *  §3.3 "Properties rail"). Any row whose value is `undefined` renders DIMMED with
 *  an em-dash — NEVER an invented value. `null` is a real, plumbed "absent" (e.g.
 *  no project) and renders as "—" but not dimmed. */
export interface PropertyRow {
  label: string;
  /** A plumbed value (string), a plumbed-but-empty value (null), or an unplumbed
   *  field (undefined → dimmed placeholder, never fabricated). */
  value: string | null | undefined;
  /** CTL-1012: an optional project-icon data URL rendered before the value (the
   *  Repo/Team rows orient by the same brand the lane headers show). null/absent →
   *  no icon. The icon is suppressed when the value is unplumbed/empty. */
  iconSrc?: string | null;
}

export interface ShellProps {
  /** Route kind — ticket or worker. */
  kind: ShellKind;
  /** The route `$id` (e.g. "CTL-845" or "CTL-845:2"). */
  id: string;
  /** Typed search params off the URL (validated by route-search.ts). CTL-996:
   *  the full DetailSearch (incl. tab/pipeline) so the walk pager preserves them. */
  search: DetailSearch;
  /** The resident board id list for this context (resolved by the page via
   *  `resolveList(payload, ctx)`); `[]` for a cold-link until the stream rehydrates. */
  listIds: readonly string[];
  /** The entity's liveness signal (working + activeState) for the title dot. */
  live: LiveSignal;
  /** The entity's display title prose. CTL-996: `null` renders the breadcrumb/
   *  back chrome with ONLY the live/stuck dot + the mono `id` — no bold title
   *  span — so the page body's <h1> owns the single visible title (ticket page);
   *  the worker page still passes its name string. */
  title: string | null;
  /** The shared Properties-rail rows (page may append more below the divider).
   *  Optional in `chrome="bare"` mode where the page supplies its own `rail`. */
  properties?: PropertyRow[];
  /** Footer stream-health (defaults to `unknown` → dim, no fabricated "live"). */
  streamHealth?: StreamHealth;
  /** Page-specific extra Property rows, rendered below the shared rail divider. */
  railExtra?: ReactNode;
  /** The page body — ticket: spine/telemetry/runs; worker: burn-strip/tail/diag. */
  children: ReactNode;
  /** Open the ⌘K palette (saves/restores focus in the caller). Optional so the
   *  shell degrades to a no-op until the palette ticket (DETAIL/T8) wires it. */
  onPalette?: () => void;
  /** CTL-1003 §A1: chrome density. `"full"` (default) keeps the in-page detail
   *  header (breadcrumb + pager) AND the LiveDotTitle (worker page). `"bare"`
   *  drops BOTH — no second header bar, no floating mono-key/dot above the title
   *  — and instead portals the prev/next chevrons into the app header's action
   *  slot (the ticket reading page; the app shell's single header owns the
   *  breadcrumb). `properties` is optional in bare mode (the page passes `rail`). */
  chrome?: "full" | "bare";
  /** CTL-1003 §B1: when set, REPLACES the shared PropertiesRail in the body row —
   *  the ticket page passes its floating rail-card column here. */
  rail?: ReactNode;
}

// ── pager chevron ────────────────────────────────────────────────────────────
function Chevron({
  dir,
  disabled,
  onClick,
}: {
  dir: "up" | "down";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={dir === "up" ? "Previous" : "Next"}
      disabled={disabled}
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        color: disabled ? C.fgDim : C.fgMuted,
        cursor: disabled ? "default" : "pointer",
        font: `12px ${C.mono}`,
        padding: "2px 4px",
        lineHeight: 1,
      }}
    >
      {dir === "up" ? "▴" : "▾"}
    </button>
  );
}

// ── pager ────────────────────────────────────────────────────────────────────
function Pager({
  pager,
  onPrev,
  onNext,
}: {
  pager: PagerState;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      data-shell-pager
      data-ghosted={pager.ghosted}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "1px 4px",
        opacity: pager.ghosted ? 0.5 : 1,
      }}
    >
      <span style={{ font: `11px ${C.mono}`, color: C.fgMuted, padding: "0 4px" }}>{pager.text}</span>
      <Chevron dir="up" disabled={pager.atStart || pager.prevId === null} onClick={onPrev} />
      <Chevron dir="down" disabled={pager.atEnd || pager.nextId === null} onClick={onNext} />
    </div>
  );
}

// ── PagerChevrons (CTL-1003 §A1) ─────────────────────────────────────────────
// The bare-chrome prev/next controls, portaled into the app header's action slot.
// Two ghost lucide icon buttons under shadcn Tooltips whose copy advertises the
// j/k hotkeys (D1: k = previous, j = next — Linear's idiom + the shipped
// use-keyboard-nav binding). Disabled per the same end-of-list logic as Pager.
function PagerChevrons({
  pager,
  onPrev,
  onNext,
}: {
  pager: PagerState;
  onPrev: () => void;
  onNext: () => void;
}) {
  const prevDisabled = pager.atStart || pager.prevId === null;
  const nextDisabled = pager.atEnd || pager.nextId === null;
  const suffix = pager.inList ? ` · ${pager.text}` : "";
  const btn =
    "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";
  return (
    <div data-shell-pager-chevrons className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Previous ticket"
            disabled={prevDisabled}
            onClick={onPrev}
            className={btn}
          >
            <ChevronUp className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Previous ticket — K{suffix}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Next ticket"
            disabled={nextDisabled}
            onClick={onNext}
            className={btn}
          >
            <ChevronDown className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Next ticket — J{suffix}</TooltipContent>
      </Tooltip>
    </div>
  );
}

// ── breadcrumb ─────────────────────────────────────────────────────────────
function Breadcrumb({
  ctx,
  onRoot,
}: {
  ctx: Parameters<typeof resolveBreadcrumb>[0];
  onRoot: () => void;
}) {
  const crumbs = resolveBreadcrumb(ctx);
  return (
    <nav data-shell-breadcrumb aria-label="Breadcrumb" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        const sep = i > 0 ? (ctx.from ? " · " : " › ") : "";
        return (
          <span key={`${c.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
            {sep && <span style={{ color: C.fgDim, margin: "0 2px" }}>{sep}</span>}
            {c.to !== null ? (
              <button
                type="button"
                onClick={onRoot}
                style={{
                  background: "transparent",
                  border: "none",
                  color: C.fgMuted,
                  cursor: "pointer",
                  font: `12px ${C.mono}`,
                  padding: 0,
                }}
              >
                {c.label}
              </button>
            ) : (
              <span style={{ font: `12px ${C.mono}`, color: last ? C.fg : C.fgMuted }}>{c.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ── live-dot title anchor ─────────────────────────────────────────────────
// CTL-996: a `null` title renders ONLY the live/stuck dot + the mono muted `id`
// (the breadcrumb/back chrome) — no bold title span — so the ticket page's body
// <h1> is the SINGLE visible title (kills the old duplicate-title rendering). The
// worker page still passes its name string and renders the bold title as before.
function LiveDotTitle({ id, title, live }: { id: string; title: string | null; live: LiveSignal }) {
  const dot = resolveLiveDot(live);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      {dot.kind === "live" && (
        <span
          data-shell-live-dot="live"
          className="catalyst-shell-live-dot"
          style={{ width: 9, height: 9, borderRadius: "50%", background: dot.color, flex: "0 0 auto" }}
        />
      )}
      {dot.kind === "stuck" && (
        <span
          data-shell-live-dot="stuck"
          style={{ width: 9, height: 9, borderRadius: "50%", background: dot.color, flex: "0 0 auto" }}
        />
      )}
      <span style={{ font: `11px ${C.mono}`, color: C.fgMuted, flex: "0 0 auto" }}>{id}</span>
      {title != null && (
        <span style={{ color: C.fg, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
      )}
    </div>
  );
}

// ── Properties rail ─────────────────────────────────────────────────────────
function PropertiesRail({ rows, extra }: { rows: PropertyRow[]; extra?: ReactNode }) {
  return (
    // CTL-1048: the rail no longer owns its own scroller — it is a plain flex
    // column inside the Shell's single scrolling body row, so a wheel gesture over
    // it scrolls the whole page (it "chains" by construction; a short rail rides
    // along, a tall rail extends the shared scrollHeight). No `overflowY` / no
    // `cat-overlay-scroll` here, or it would re-split the scroll context and
    // re-create the dead zone CTL-1048 fixes.
    <aside
      data-shell-rail
      style={{
        width: 280,
        flex: "0 0 280px",
        background: C.s1,
        borderLeft: `1px solid ${C.border}`,
        padding: "12px 14px",
      }}
    >
      {rows.map((r) => {
        const unplumbed = r.value === undefined;
        // CTL-1012: show the project mark only when both the icon AND a real value
        // are present (never beside a dimmed "—").
        const showIcon = r.iconSrc != null && r.value != null;
        return (
          <div
            key={r.label}
            data-shell-prop={r.label}
            data-unplumbed={unplumbed}
            style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", fontSize: 12 }}
          >
            <span style={{ color: C.fgMuted }}>{r.label}</span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                font: `11px ${C.mono}`,
                color: unplumbed ? C.fgDim : C.fg,
                textAlign: "right",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {showIcon && (
                <img
                  src={r.iconSrc ?? undefined}
                  alt=""
                  aria-hidden
                  style={{ width: 14, height: 14, borderRadius: 3, objectFit: "contain", flex: "0 0 auto" }}
                />
              )}
              {/* unplumbed → dimmed em-dash placeholder, NEVER a fabricated value;
                  a plumbed-but-null value (e.g. no project) reads "—" too but lit. */}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.value == null ? "—" : r.value}
              </span>
            </span>
          </div>
        );
      })}
      {extra != null && (
        <div data-shell-rail-extra style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
          {extra}
        </div>
      )}
    </aside>
  );
}

// ── footer ─────────────────────────────────────────────────────────────────
function ShellFooter({ health, context }: { health: StreamHealth; context: string }) {
  const dotColor =
    health.state === "live" ? C.green : health.state === "reconnecting" ? C.red : C.fgDim;
  const label =
    health.state === "live"
      ? `stream live${health.lastFrameAgoMs != null ? ` · ${Math.round(health.lastFrameAgoMs / 1000)}s ago` : ""}`
      : health.state === "reconnecting"
        ? "stream reconnecting"
        : "stream —"; // unknown → dim, no fabricated "live"
  return (
    <footer
      data-shell-footer
      style={{
        height: 28,
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 14px",
        background: C.s1,
        borderTop: `1px solid ${C.border}`,
        font: `11px ${C.mono}`,
        color: C.fgMuted,
      }}
    >
      <span data-shell-stream-health={health.state} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
        {label}
      </span>
      <span>j/k move · esc back · ⌘K actions · ? keys</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: C.fgDim }}>{context}</span>
    </footer>
  );
}

/**
 * The shared detail-page shell. Both the ticket and worker pages render their
 * body through `children` and append page-specific Property rows via `railExtra`.
 */
export function Shell({
  kind,
  id,
  search,
  listIds,
  live,
  title,
  properties = [],
  streamHealth = { state: "unknown" },
  railExtra,
  children,
  onPalette,
  chrome = "full",
  rail,
}: ShellProps) {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  // ── CTL-1049 back-stack entry state ─────────────────────────────────────────
  // The shared scaffolding owns the SCROLL half of the convention: it saves the
  // single detail scroller's (`data-shell-scroll`) offset into the current history
  // entry's state on scroll-idle, and restores it on mount when the entry already
  // carries a non-default offset (a back/forward traverse). A fresh PUSH lands on
  // a new entry key whose `scrollY` is 0, so the page opens at the top. Both detail
  // pages inherit this because both render through this Shell — no per-page wiring.
  const { key: entryKey, state: entryState, setState: setEntryState } = useDetailEntryState();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Snapshot the restore target ONCE per entry key (a back/forward traverse), so
  // the restore effect doesn't fight the live scroll writes that follow.
  const restoreYRef = useRef<{ key: string; y: number } | null>(null);
  if (restoreYRef.current?.key !== entryKey) {
    restoreYRef.current = { key: entryKey, y: entryState.scrollY };
  }

  // Restore the saved offset when this entry mounts / changes (back/forward).
  // Fresh push → scrollY 0 → a no-op (already at top). We restore AFTER paint so
  // the body has its real scrollHeight; rAF avoids a layout-thrash on first frame.
  useEffect(() => {
    const el = scrollRef.current;
    const target = restoreYRef.current;
    if (!el || !target || target.y <= 0) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = target.y;
    });
    return () => cancelAnimationFrame(raf);
  }, [entryKey]);

  // Save the offset on scroll-idle (debounced) into THIS entry's state so a later
  // back/forward traverse restores it. Debounced so a fling doesn't write on every
  // frame; the trailing write captures the resting offset.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        const y = el.scrollTop;
        setEntryState((prev) => (prev.scrollY === y ? prev : { ...prev, scrollY: y }));
      }, 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (idle) clearTimeout(idle);
    };
  }, [entryKey, setEntryState]);

  const [listContext, setListContext] = useAtom(listContextAtom);
  const recordRecent = useSetAtom(recordRecentAtom);
  // ── overlay open-state (CTL-916 / DETAIL5): the ⌘K palette + the `?` cheatsheet
  //    are siblings under one layered-Escape discipline (detail design §3.4). ────
  const [paletteOpen, setPaletteOpen] = useAtom(paletteOpenAtom);
  const [cheatsheetOpen, setCheatsheetOpen] = useAtom(cheatsheetOpenAtom);

  // Mirror the resolved walk list into the jotai store so peek / palette read the
  // SAME ids. The page resolves `listIds` from the resident payload via
  // resolveList; the shell only reflects it (FND owns the atoms, the shell reads).
  useEffect(() => {
    setListContext({ ids: [...listIds], kind, lens: search.lens, col: search.col });
  }, [listIds, kind, search.lens, search.col, setListContext]);

  // Record this entity into recents on LAND (drives the ⌘K RECENT group, P11).
  useEffect(() => {
    recordRecent(id);
  }, [id, recordRecent]);

  // The pager resolves from the jotai-mirrored ids (so a stream rehydrate that
  // updates the atom re-lights the pager) falling back to the prop on first paint.
  const ids = listContext.ids.length > 0 ? listContext.ids : listIds;
  const pager = useMemo(
    () => resolvePager({ ids, id, cursor: search.cursor }),
    [ids, id, search.cursor],
  );

  const breadcrumbCtx = {
    id,
    from: search.from,
    lens: search.lens,
    col: search.col,
    total: pager.total ?? undefined,
  };

  // ── navigation: walk in place (route-param swap), back to the originating list ─
  // Typed TanStack navigate — `to` is the literal route, `params.id` the swapped
  // run/ticket id, `search` carries the ?cursor tick. No casts (the route tree is
  // type-registered in router.tsx, so these resolve against the real routes).
  const walk = useCallback(
    (targetId: string | null) => {
      if (targetId === null) return; // bounds-nudge no-op at the ends
      const nextCursor = ids.indexOf(targetId);
      const nextSearch = { ...search, ...(nextCursor >= 0 ? { cursor: nextCursor } : {}) };
      if (kind === "ticket") {
        void navigate({ to: "/ticket/$id", params: { id: targetId }, search: nextSearch });
      } else {
        void navigate({ to: "/worker/$id", params: { id: targetId }, search: nextSearch });
      }
    },
    [ids, kind, navigate, search],
  );

  const goPrev = useCallback(() => walk(pager.prevId), [walk, pager.prevId]);
  const goNext = useCallback(() => walk(pager.nextId), [walk, pager.nextId]);
  // CTL-989: Esc / breadcrumb-root return to the originating list with a CLIENT-
  // SIDE router navigation (NO full-document reload — the Board lives in the same
  // router tree now). Prefer `history.back()` so the prior history entry is reused
  // and TanStack scroll restoration replays the board scroller's exact offset; if
  // there is no back entry (a cold deep-link opened directly into the detail page),
  // navigate forward to the originating surface route (Workers vs the Tickets
  // board, derived from `?from`). Display-options ride their own persisted atoms.
  const goRoot = useCallback(() => {
    if (canGoBack) {
      router.history.back();
      return;
    }
    // Cold deep-link (no back entry): forward to the originating surface route.
    // A worker page returns to /workers; a ticket page to the Tickets board.
    void navigate({ to: kind === "worker" ? "/workers" : "/board" });
  }, [canGoBack, router, navigate, kind]);

  // ── ⌘K palette toggle (CTL-916 / DETAIL5). The hook reaches `onPalette` even
  //    while an input is focused (key-nav.ts §1). A caller-supplied `onPalette`
  //    wins (lets a page save/restore focus around the toggle); otherwise the
  //    shell toggles the shared atom the <CommandPalette> reads. ───────────────
  const togglePalette = useCallback(() => {
    if (onPalette) {
      onPalette();
      return;
    }
    setPaletteOpen((v) => !v);
  }, [onPalette, setPaletteOpen]);

  // ── `?` cheatsheet toggle (CTL-916 / DETAIL5). Mutually exclusive with the
  //    palette so two overlays never stack. ──────────────────────────────────
  const toggleCheatsheet = useCallback(() => {
    setCheatsheetOpen((v) => !v);
    setPaletteOpen(false);
  }, [setCheatsheetOpen, setPaletteOpen]);

  // ── layered Escape (detail design §3.4): an open overlay eats the first Esc;
  //    only a clean page Escapes back to the originating list (board root). The
  //    overlays ALSO stop-propagate their own Escape, but this is the belt-and-
  //    braces layer for an Esc that reaches the global handler first. ──────────
  const onEscape = useCallback(() => {
    if (paletteOpen) {
      setPaletteOpen(false);
      return;
    }
    if (cheatsheetOpen) {
      setCheatsheetOpen(false);
      return;
    }
    goRoot();
  }, [paletteOpen, cheatsheetOpen, setPaletteOpen, setCheatsheetOpen, goRoot]);

  // ── keyboard: extend the existing hook IN PLACE (j/k/⌘K/g-chords); the
  //    pre-existing `/`→search + `?` + the input guard are kept by the hook ────
  useKeyboardNav({
    onNext: goNext,
    onPrev: goPrev,
    onEscape,
    onPalette: togglePalette,
    onQuestionMark: toggleCheatsheet,
    onGotoActive: () => {
      document.querySelector("[data-spine-active]")?.scrollIntoView({ block: "center" });
    },
    // g t / g w are page-surface concerns (a worker→ticket jump needs the parent
    // ticket id the page holds) — left unbound here; the page can re-bind via its
    // own useKeyboardNav if it needs them. The shell wires the universal ones.
  });

  const footerContext = breadcrumbText(breadcrumbCtx);

  return (
    // CTL-989: the detail Shell renders inside AppShell's <Outlet/> (a flex-col
    // content slot, `flex min-h-0 flex-1` → its height IS the inset content area).
    // CTL-1048: this outer div fills that slot EXACTLY (`height:100%`, `minHeight:0`
    // so the flex child can shrink) and the SCROLL lives one level down on the body
    // row — NOT here. The old `minHeight:"100vh"` + `overflow:"hidden"` made the
    // shell taller than its clipped slot, so its only inner scroller was the narrow
    // prose column; wheel input anywhere ELSE (rail, gutters, header padding) hit
    // this overflow-hidden box with no scrollable ancestor and went dead. Removing
    // both, and moving overflow to the full-width body row below, makes the entire
    // detail viewport (prose + rail) ONE scroll context with no dead zones.
    <div
      data-detail-shell={kind}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: C.s1,
        color: C.fg,
        overflow: "hidden",
      }}
    >
      <style>{SHELL_PULSE_CSS}</style>

      {/* ShellHeader — breadcrumb (left) + pager (right). CTL-1003 §A1: in
          `chrome="bare"` mode (the ticket reading page) this second header bar is
          NOT rendered — the app shell's single header owns the breadcrumb, and the
          prev/next chevrons are portaled into its action slot below. */}
      {chrome === "full" ? (
        <header
          data-shell-header
          style={{
            height: 44,
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "0 14px",
            background: C.s1,
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <Breadcrumb ctx={breadcrumbCtx} onRoot={goRoot} />
          {/* Pager hidden on a fully-degraded deep-link (no list, no cursor) — the
              "— / —" state still renders so the operator sees why it's inert; only a
              cold bare link with no context at all suppresses it. */}
          {(pager.inList || pager.ghosted) && <Pager pager={pager} onPrev={goPrev} onNext={goNext} />}
        </header>
      ) : (
        // Bare chrome: portal the prev/next chevrons into the app header's slot.
        (pager.inList || pager.ghosted) && (
          <HeaderActions>
            <PagerChevrons pager={pager} onPrev={goPrev} onNext={goNext} />
          </HeaderActions>
        )
      )}

      {/* Body row: <DetailBody> slot + Properties rail.
          CTL-1048: THIS row is the single scroll context for the whole detail page.
          It spans the full width (prose column + rail), so a wheel/trackpad gesture
          anywhere over the page — prose, rail, or the gutter between them — scrolls
          the same element. The prose column and the rail are plain (non-scrolling)
          flex children inside it; neither owns its own `overflow` anymore, so there
          is no dead zone and no overscroll-behavior trap (a short rail simply rides
          along with the body). `min-h-0` lets it shrink below content height so the
          overflow actually engages; `cat-overlay-scroll` keeps the CTL-1036 overlay
          scrollbar styling on the new scroller. */}
      <div
        data-shell-scroll
        className="cat-overlay-scroll"
        style={{ display: "flex", flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}
      >
        <div
          data-shell-body
          style={{ flex: "1 1 auto", minWidth: 0, padding: "14px 16px" }}
        >
          {/* CTL-1003 §A1: in bare mode the floating mono-key + live dot above the
              title is suppressed (the page <h1> + status row own the title). */}
          {chrome === "full" && <LiveDotTitle id={id} title={title} live={live} />}
          <div style={{ marginTop: chrome === "full" ? 12 : 0 }}>{children}</div>
        </div>
        {/* CTL-1003 §B1: a page-supplied floating rail (`rail`) replaces the shared
            flat PropertiesRail; the worker page keeps PropertiesRail + railExtra. */}
        {rail != null ? rail : <PropertiesRail rows={properties} extra={railExtra} />}
      </div>

      <ShellFooter health={streamHealth} context={footerContext} />
    </div>
  );
}

/** A passthrough wrapper for the body slot so page surfaces can compose explicitly.
 *  Reserves the data attribute the body region is keyed on for tests.
 *  @ignore
 */
export function DetailBody({ children }: { children: ReactNode }) {
  return <div data-detail-body>{children}</div>;
}

/** Re-export the accent so page surfaces use the SAME blue (never cyan) for their
 *  own chrome (focus ring / peek frame), per the cyan-restraint discipline. */
export { CHROME_BLUE };
