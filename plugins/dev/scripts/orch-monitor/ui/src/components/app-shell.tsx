import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  InboxIcon,
  LayoutGridIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";

import {
  SETTINGS_BREADCRUMB,
  isTypingTarget,
  type Surface,
} from "@/lib/surface";
import { buildSurfaceActions, surfaceChordYieldsToDetail } from "@/lib/surface-actions";
import { matchAction } from "@/lib/action-keymatch";
// CTL-989 — the active surface is now DERIVED from the route (URL = source of
// truth for location); the nav navigates via router.navigate instead of writing
// React surface state.
import {
  pathnameToSurface,
  surfaceToPath,
  SETTINGS_PATH,
} from "@/lib/route-surface";
import {
  breadcrumbFor,
  buildNavGroups,
  detailCrumbFor,
  paletteEntries,
} from "@/lib/nav-model";
// CTL-898 / SHELL8 — the shell owns the NODE-SCOPE store (All-nodes by default).
// Single-host is an identity no-op: the filter affordance is absent (the sidebar
// gates it on the live cluster signal) so the scope stays All-nodes and nothing
// changes on today's single-node deployment.
import { ALL_NODES, NodeScopeContext, type NodeScope } from "@/lib/node-scope";
// CTL-945: lift both signal hooks into AppShell so AppSidebar + AppFooter share
// one EventSource each instead of opening independent duplicate connections.
import { useNavSignal, NavSignalContext } from "@/hooks/use-nav-signal";
import { useClusterSignal, ClusterSignalContext } from "@/hooks/use-cluster-signal";
import {
  readSidebarOpen,
  writeSidebarOpen,
  shouldToggleSidebar,
} from "@/lib/sidebar-collapse";
import { shouldOpenPalette } from "@/lib/command-palette";
import { installOverlayScroll } from "@/lib/overlay-scroll";
import { useAtom, useSetAtom } from "jotai";
import { repoScopeAtom } from "@/board/nav-store";
import { boardPrefsAtom, patchBoardPrefs } from "@/board/prefs-store";
import { buildSettingsActions } from "@/lib/settings-actions";
import { visibleActions } from "@/lib/action-registry";
import { useTicketSearch } from "@/hooks/use-ticket-search";
import { ticketSearchItems } from "@/lib/ticket-search-items";
import { ticketDetailHref } from "@/board/detail-nav";
import { useTheme } from "@/lib/theme";
import { useBrand } from "@/lib/brand";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AppFooter } from "@/components/app-footer";
import { HeaderActionsSlot } from "@/components/header-actions";
import { RepoIconProvider } from "@/board/repo-icon-context";

// CTL-891 / SHELL1 — the full-viewport (h-screen, NO outer max-w / mx-auto)
// frame, ported from the prototype `mockups/home-proto/src/components/AppShell`.
// Owns:
//  - a CONTROLLED SidebarProvider (own open + onOpenChange) so BOTH `[` and the
//    built-in Cmd/Ctrl+B drive collapse; persists open-state to localStorage.
//  - the `g h` / `g b` / `g w` / `g q` chord handlers + `[` toggle, all of which
//    ignore text-entry targets.
//  - the active SURFACE state, exposed via SurfaceContext to the sidebar.
//  - the ⌘K command palette (jump to any surface).
//  - the top strip inside SidebarInset (trigger + breadcrumb + ⌘K).
// Surface→route wiring is the FND stream's concern; this shell only exposes the
// SurfaceContext contract the nav binds to.

// OBS-5: Partial<> — only the OPERATE surfaces have an icon here. The palette
// reads each item's icon from the nav-model groups (see paletteEntries below),
// not this map, so the OBSERVE surfaces don't need an entry; Partial keeps the
// expanded Surface union total without enumerating them.
const SURFACE_ICON: Partial<Record<Surface, typeof InboxIcon>> = {
  home: InboxIcon,
  board: LayoutGridIcon,
  workers: UsersIcon,
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<boolean>(readSidebarOpen);
  // CTL-989 — the active surface + Settings-open are DERIVED from the route (the
  // URL is the source of truth for location). pathnameToSurface maps the current
  // pathname to a surface (or "settings"); the nav navigates via router.navigate.
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search });
  const derived = pathnameToSurface(
    pathname,
    typeof (search as { from?: unknown }).from === "string"
      ? { from: (search as { from?: string }).from }
      : undefined,
  );
  const settingsOpen = derived === "settings";
  // The nav-highlight surface: detail pages + settings still resolve to an
  // OPERATE surface for the left nav (settings highlights nothing of the four,
  // so fall back to the board surface for the SurfaceContext `surface` value the
  // sidebar reads — settingsOpen separately drives the Settings item's active
  // state).
  const surface: Surface = derived === "settings" ? "board" : derived;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  // CTL-898 / SHELL8 — the active node scope. Defaults to ALL_NODES (the cluster-
  // wide view); the sidebar's node filter sets it when N>1, and the sidebar also
  // resolves a stale focused scope back to ALL_NODES when its host leaves the
  // roster (a node going dark never strands the operator on an empty view).
  const [nodeScope, setNodeScope] = useState<NodeScope>(ALL_NODES);
  // CTL-944 — the active repo scope for breadcrumbs + palette navigation.
  // CTL-989 — repoScopeAtom is DEMOTED to a URL-mirror: a single effect below
  // syncs it from the `?scope` typed search param on every search change, so the
  // existing dozen `useAtom(repoScopeAtom)` readers (app-sidebar, surfaces) need
  // no edit. Nav WRITES go through navigate({search:{scope}}), not setRepoScope.
  const [repoScope, setRepoScope] = useAtom(repoScopeAtom);
  const scopeSearch =
    typeof (search as { scope?: unknown }).scope === "string"
      ? (search as { scope?: string }).scope
      : undefined;
  useEffect(() => {
    const next = scopeSearch ?? "all";
    if (next !== repoScope) setRepoScope(next);
  }, [scopeSearch, repoScope, setRepoScope]);
  // Repos from the board snapshot for palette navigation group construction.
  const { payload } = useBoardSnapshot();
  const repos = payload?.repos ?? [];
  // CTL-945: single subscription point for nav + cluster signals. AppSidebar and
  // AppFooter consume NavSignalContext / ClusterSignalContext instead of calling
  // these hooks independently, reducing persistent EventSources from 6 → 4.
  const navSignal = useNavSignal();
  const clusterSignal = useClusterSignal();

  // Persist collapse state across reloads (the controlled provider replaces the
  // primitive's cookie path; localStorage is the source of truth here). Logic +
  // key live in lib/sidebar-collapse.ts so the persistence round-trip is unit-
  // tested without a DOM (CTL-894 / SHELL4).
  useEffect(() => {
    writeSidebarOpen(open);
  }, [open]);

  // CTL-1036: install the SINGLE global overlay-scrollbar listener once for the
  // whole app. It tags any `.cat-overlay-scroll` scroller with `cat-scrolling`
  // while it scrolls and removes it ~1s after the gesture ends — the CSS reveals
  // the slim overlay thumb only while that marker is present, so bars stay hidden
  // at rest and never shift layout.
  useEffect(() => installOverlayScroll(), []);

  // CTL-1025: surface jump + create actions, built once per navigate change.
  // Declared BEFORE the keydown effect below — that effect reads `surfaceActions`
  // in its dependency array, so the const must already be initialized. A later
  // declaration is a temporal-dead-zone ReferenceError that crashes AppShell on
  // first render (target is ES2022, so the bundler keeps the TDZ check).
  const surfaceActions = useMemo(
    () =>
      buildSurfaceActions({
        jumpToSurface: (s) => void navigate({ to: surfaceToPath(s), search: (prev) => prev }),
        create: () => setPaletteOpen(true),
      }),
    [navigate],
  );

  // CTL-1025: `[` toggles the rail; `g <key>` chords + bare `c` go through the
  // action registry (matchAction). Both ignore typing targets.
  useEffect(() => {
    let chordArmed = false;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;

    const onKey = (e: KeyboardEvent) => {
      // `[` — primary collapse toggle (Cmd/Ctrl+B is handled by the controlled
      // provider). shouldToggleSidebar owns the full contract: `[` with no
      // meta/ctrl/alt AND not while typing — see lib/sidebar-collapse.ts. The
      // DOM `e.target` is the standard HTMLElement cast (same idiom as the
      // isTypingTarget callers); the predicate only reads tagName/isContentEditable.
      if (
        shouldToggleSidebar({
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          target: e.target as HTMLElement | null,
        })
      ) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }

      // The `g`-chord path must not steal typing either (separate concern from
      // the `[` binding above).
      if (isTypingTarget(e.target as HTMLElement | null)) return;

      // `g` arms a chord; the next key resolves through the surface action registry.
      if (e.key === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        chordArmed = true;
        clearTimeout(chordTimer);
        chordTimer = setTimeout(() => {
          chordArmed = false;
        }, 800);
        return;
      }
      if (chordArmed) {
        const pathname = window.location.pathname;
        // CTL-1025: on a detail route, yield g t/w/a to the detail Shell classifier.
        if (!surfaceChordYieldsToDetail(pathname, e.key)) {
          const hit = matchAction(surfaceActions, { surface }, { key: e.key }, true);
          if (hit) { e.preventDefault(); hit.handler(); }
        }
        chordArmed = false;
        clearTimeout(chordTimer);
        return;
      }
      // Bare single-key (when no chord is pending) — e.g. `c` → open create.
      const hit = matchAction(surfaceActions, { surface }, { key: e.key }, false);
      if (hit) { e.preventDefault(); hit.handler(); }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(chordTimer);
    };
  }, [navigate, surfaceActions, surface]);

  // ⌘K / Ctrl+K and a bare `/` (outside a field) open the command palette — the
  // SINGLE search affordance for the shell (SHELL5 de-dups the prototype's two
  // search bars). The open contract lives in lib/command-palette.ts. ⌘K toggles; `/`
  // opens (a quick-open shouldn't re-close on a second slash).
  // CTL-1003 §A1: the visible top-strip search BUTTON is removed (the keyboard
  // paths below are the sole palette affordance now); the old click-trigger
  // listener was already retired in CTL-930.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        shouldOpenPalette({
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          target: e.target as HTMLElement | null,
        })
      ) {
        e.preventDefault();
        // ⌘K toggles (open ⇄ close); `/` only opens.
        if (e.key === "k" || e.key === "K") {
          setPaletteOpen((o) => !o);
        } else {
          setPaletteOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // CTL-944 / CTL-989: jumpTo navigates to the surface's route + writes the repo
  // scope onto the URL `?scope` (the source of truth). The repoScopeAtom mirror
  // effect keeps the atom in sync, so the dozen atom readers need no edit.
  const jumpTo = useCallback(
    (s: Surface, scope?: string) => {
      void navigate({
        to: surfaceToPath(s),
        search: (prev) =>
          scope !== undefined
            ? { ...prev, scope: scope === "all" ? undefined : scope }
            : prev,
      });
      setPaletteOpen(false);
    },
    [navigate],
  );

  const openSettings = useCallback(() => {
    void navigate({ to: SETTINGS_PATH, search: (prev) => prev });
    setPaletteOpen(false);
  }, [navigate]);

  // CTL-1024: theme toggle, sidebar toggle, and board-display commands in the palette.
  // CTL-1099: brand cycle (Warm ⇄ Slate) too.
  const { toggle: toggleTheme } = useTheme();
  const { cycle: cycleBrand } = useBrand();
  const setBoardPrefs = useSetAtom(boardPrefsAtom);
  const settingsActions = useMemo(
    () =>
      visibleActions(
        buildSettingsActions({
          toggleTheme,
          cycleBrand,
          toggleSidebar: () => setOpen((o) => !o),
          setGroupBy: (groupBy) => setBoardPrefs((p) => patchBoardPrefs(p, { groupBy })),
          setOrder: (order) => setBoardPrefs((p) => patchBoardPrefs(p, { order })),
          setLayout: (layout) => setBoardPrefs((p) => patchBoardPrefs(p, { layout })),
        }),
        { surface },
      ),
    [toggleTheme, cycleBrand, setBoardPrefs, surface],
  );

  // CTL-1024: live ticket search via /api/search, debounced in the hook.
  const { results: ticketResults } = useTicketSearch(query);
  const ticketRows = ticketSearchItems(ticketResults);

  // CTL-1024: fire an action entry and close + reset the palette.
  const runAction = useCallback((handler: () => void) => {
    handler();
    setPaletteOpen(false);
    setQuery("");
  }, []);

  // CTL-989: nav items navigate via router.navigate (AppSidebar uses the router
  // directly through useSurface()/useNavigate) — there is no SurfaceContext to
  // provide anymore. The active surface is derived from the route everywhere.
  const nodeScopeCtx = useMemo(
    () => ({ scope: nodeScope, setScope: setNodeScope }),
    [nodeScope],
  );

  // CTL-930/CTL-944: breadcrumbs are now scope-aware via breadcrumbFor.
  // CTL-1003 §A1: on a detail route, append the decoded ticket/worker id as the
  // final crumb (e.g. "Overall › Tickets › CTL-729"). The surface crumb then
  // becomes a clickable back-to-list button (handled in the render below).
  const detailId = settingsOpen ? null : detailCrumbFor(pathname);
  const baseCrumbs = settingsOpen
    ? SETTINGS_BREADCRUMB
    : breadcrumbFor(surface, repoScope);
  const crumbs = detailId != null ? [...baseCrumbs, detailId] : baseCrumbs;

  return (
    <NavSignalContext.Provider value={navSignal}>
    <ClusterSignalContext.Provider value={clusterSignal}>
      <NodeScopeContext.Provider value={nodeScopeCtx}>
      {/* Controlled provider → Cmd/Ctrl+B still fires through onOpenChange, so
          `[` and Cmd/Ctrl+B both work with no vendoring. h-screen, edge-to-edge:
          no outer max-w / mx-auto container around the chrome. */}
      <SidebarProvider
        open={open}
        onOpenChange={setOpen}
        className="h-screen min-h-screen"
      >
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          {/* ── Thin top strip: the SINGLE header — breadcrumb + page actions ──
              CTL-1003 §A1: the sidebar collapse icon and the search button are
              gone (`[` / Cmd-B still toggle, ⌘K / `/` still open the palette —
              only the visible buttons are removed). The breadcrumb is the sole
              left affordance; a detail page portals its prev/next chevrons into
              the right-aligned HeaderActionsSlot. */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
            <Breadcrumb>
              <BreadcrumbList>
                {crumbs.map((crumb, i) => {
                  const isLast = i === crumbs.length - 1;
                  // When a detail crumb is present, the SURFACE crumb (the one
                  // just before it) is a clickable back-to-list button; all other
                  // intermediate crumbs stay muted spans.
                  const isSurfaceCrumb =
                    detailId != null && i === crumbs.length - 2;
                  return (
                    // Separators are SIBLINGS of items (both <li>) — never nest a
                    // separator inside an item, or it's <li> within <li>.
                    <Fragment key={crumb}>
                      <BreadcrumbItem>
                        {isLast ? (
                          <BreadcrumbPage>{crumb}</BreadcrumbPage>
                        ) : isSurfaceCrumb ? (
                          <button
                            type="button"
                            className="text-muted-foreground transition-colors hover:text-foreground"
                            onClick={() =>
                              void navigate({
                                to: surfaceToPath(surface),
                                search: (prev) => ({
                                  scope: (prev as { scope?: string }).scope,
                                }),
                              })
                            }
                          >
                            {crumb}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">{crumb}</span>
                        )}
                      </BreadcrumbItem>
                      {!isLast && <BreadcrumbSeparator />}
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>

            {/* CTL-1003: the right-aligned page-action slot — a detail page
                portals its prev/next chevrons here via <HeaderActions>. */}
            <HeaderActionsSlot />
          </header>

          {/* CTL-989: the matched ROUTE renders into the layout's content slot
              (children === the router <Outlet/>). Settings is now the /settings
              route, not an inset takeover. The slot is `flex flex-col min-h-0` so
              the routed surface (a Board root with flex:1/height:100%) can fill
              the full height of the inset content area (the board-height fix
              chain — completed in Pass B). */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <RepoIconProvider repos={repos}>
              {children}
            </RepoIconProvider>
          </div>

          {/* CTL-930: AppFooter carries the status cluster (LIVE badge + activity +
              health dots), moved from the in-board header and the sidebar footer. */}
          <AppFooter />
        </SidebarInset>
      </SidebarProvider>

      {/* ── ⌘K command palette — project-grouped nav + settings + ticket search (CTL-1024) ── */}
      <CommandDialog
        open={paletteOpen}
        onOpenChange={(o) => { setPaletteOpen(o); if (!o) setQuery(""); }}
      >
        {/* CTL-1024: controlled input drives both cmdk fuzzy filter and ticket search. */}
        <CommandInput
          placeholder="Jump to a surface or search a ticket…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {/* CTL-944: project-grouped surface nav. */}
          {paletteEntries(buildNavGroups(repos, {})).map((entry) => (
            <CommandGroup key={entry.group} heading={entry.group}>
              {entry.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={`${entry.group}:${item.target.surface}`}
                    value={`${entry.group} ${item.label}`}
                    onSelect={() => jumpTo(item.target.surface, item.target.scope)}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
          {/* CTL-1024: live ticket search results from /api/search (debounced 150ms).
              keywords={[query]} prevents cmdk's built-in filter from hiding server-
              ranked results whose ticket ID doesn't substring-match the input. */}
          {ticketRows.length > 0 && (
            <CommandGroup heading="Tickets">
              {ticketRows.map((row) => (
                <CommandItem
                  key={row.id}
                  value={row.id}
                  keywords={[query]}
                  onSelect={() => {
                    void navigate({ to: ticketDetailHref(row.id) });
                    setPaletteOpen(false);
                    setQuery("");
                  }}
                >
                  {row.label}
                  {row.meta && (
                    <span className="ml-auto text-xs text-muted-foreground">{row.meta}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {/* CTL-1025: surface navigation commands with keybinding hints. */}
          <CommandGroup heading="Go to">
            {surfaceActions.map((entry) => (
              <CommandItem
                key={entry.id}
                value={`${entry.title} ${(entry.keywords ?? []).join(" ")}`}
                onSelect={() => runAction(entry.handler)}
              >
                {entry.title}
                {entry.keybinding && (
                  <kbd className="ml-auto rounded border border-border px-1 text-[11px] text-muted-foreground font-mono">
                    {entry.keybinding}
                  </kbd>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
          {/* CTL-1024: settings + board-display commands (board-scoped entries hidden off-board). */}
          <CommandGroup heading="Settings">
            <CommandItem value="Settings" onSelect={openSettings}>
              <SettingsIcon className="size-4" />
              Settings
            </CommandItem>
            {settingsActions.map((entry) => (
              <CommandItem
                key={entry.id}
                value={`${entry.title} ${(entry.keywords ?? []).join(" ")}`}
                onSelect={() => runAction(entry.handler)}
              >
                {entry.title}
                {entry.keybinding && (
                  <kbd className="ml-auto rounded border border-border px-1 text-[11px] text-muted-foreground font-mono">
                    {entry.keybinding}
                  </kbd>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      </NodeScopeContext.Provider>
    </ClusterSignalContext.Provider>
    </NavSignalContext.Provider>
  );
}
