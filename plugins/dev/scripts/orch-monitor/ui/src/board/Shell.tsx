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

import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import {
  breadcrumbText,
  resolveBreadcrumb,
  resolvePager,
  resolveLiveDot,
  CHROME_BLUE,
  type LiveSignal,
  type PagerState,
} from "./detail-chrome";
import {
  cheatsheetOpenAtom,
  listContextAtom,
  paletteOpenAtom,
  recordRecentAtom,
} from "./nav-store";
import type { DetailFrom, DetailLens } from "./route-search";
import { useKeyboardNav } from "../hooks/use-keyboard-nav";

// ── tokens (mirror Board.tsx's inline-`C` palette; DESIGN.md dark surfaces) ──
const C = {
  s0: "#0b0d10",
  s1: "#111318",
  border: "#262d36",
  fg: "#e6e9ef",
  fgMuted: "#8b93a1",
  fgDim: "#5b626f",
  green: "#39d07a",
  red: "#ef5d5d",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

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
}

export interface ShellProps {
  /** Route kind — ticket or worker. */
  kind: ShellKind;
  /** The route `$id` (e.g. "CTL-845" or "CTL-845:2"). */
  id: string;
  /** Typed search params off the URL (validated by route-search.ts). */
  search: { from?: DetailFrom; lens?: DetailLens; col?: string; cursor?: number };
  /** The resident board id list for this context (resolved by the page via
   *  `resolveList(payload, ctx)`); `[]` for a cold-link until the stream rehydrates. */
  listIds: readonly string[];
  /** The entity's liveness signal (working + activeState) for the title dot. */
  live: LiveSignal;
  /** The entity's display title prose. */
  title: string;
  /** The shared Properties-rail rows (page may append more below the divider). */
  properties: PropertyRow[];
  /** Footer stream-health (defaults to `unknown` → dim, no fabricated "live"). */
  streamHealth?: StreamHealth;
  /** Page-specific extra Property rows, rendered below the shared rail divider. */
  railExtra?: ReactNode;
  /** The page body — ticket: spine/telemetry/runs; worker: burn-strip/tail/diag. */
  children: ReactNode;
  /** Open the ⌘K palette (saves/restores focus in the caller). Optional so the
   *  shell degrades to a no-op until the palette ticket (DETAIL/T8) wires it. */
  onPalette?: () => void;
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
function LiveDotTitle({ id, title, live }: { id: string; title: string; live: LiveSignal }) {
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
      <span style={{ color: C.fg, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {title}
      </span>
    </div>
  );
}

// ── Properties rail ─────────────────────────────────────────────────────────
function PropertiesRail({ rows, extra }: { rows: PropertyRow[]; extra?: ReactNode }) {
  return (
    <aside
      data-shell-rail
      style={{
        width: 280,
        flex: "0 0 280px",
        background: C.s1,
        borderLeft: `1px solid ${C.border}`,
        padding: "12px 14px",
        overflowY: "auto",
      }}
    >
      {rows.map((r) => {
        const unplumbed = r.value === undefined;
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
                font: `11px ${C.mono}`,
                color: unplumbed ? C.fgDim : C.fg,
                textAlign: "right",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {/* unplumbed → dimmed em-dash placeholder, NEVER a fabricated value;
                  a plumbed-but-null value (e.g. no project) reads "—" too but lit. */}
              {r.value == null ? "—" : r.value}
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
  properties,
  streamHealth = { state: "unknown" },
  railExtra,
  children,
  onPalette,
}: ShellProps) {
  const navigate = useNavigate();
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
  const goRoot = useCallback(() => void navigate({ to: "/" }), [navigate]);

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
    <div
      data-detail-shell={kind}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: C.s0,
        color: C.fg,
        overflow: "hidden",
      }}
    >
      <style>{SHELL_PULSE_CSS}</style>

      {/* ShellHeader — breadcrumb (left) + pager (right) */}
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

      {/* Body row: <DetailBody> slot + Properties rail */}
      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        <div data-shell-body style={{ flex: "1 1 auto", minWidth: 0, overflowY: "auto", padding: "14px 16px" }}>
          <LiveDotTitle id={id} title={title} live={live} />
          <div style={{ marginTop: 12 }}>{children}</div>
        </div>
        <PropertiesRail rows={properties} extra={railExtra} />
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
