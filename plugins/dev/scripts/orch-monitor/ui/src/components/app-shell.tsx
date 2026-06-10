import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  InboxIcon,
  LayoutGridIcon,
  ListOrderedIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";

import {
  SurfaceContext,
  SETTINGS_BREADCRUMB,
  SURFACE_CHORD,
  SURFACE_LABEL,
  SURFACES,
  isTypingTarget,
  type Surface,
} from "@/lib/surface";
import { breadcrumbFor, buildNavGroups, paletteEntries } from "@/lib/nav-model";
// CTL-911 / SURF3 — the persisted landing-surface preference (which OPERATE
// surface opens first on a fresh load); the Settings surface writes it.
import { readLandingSurface } from "@/lib/prefs";
import { SettingsSurface } from "@/components/settings-surface";
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
import { useAtom } from "jotai";
import { repoScopeAtom } from "@/board/nav-store";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
// CTL-971: reseat the board SURFACE + repo SCOPE on return from a detail page so
// the board actually mounts (else the landing-pref Inbox shows and the scroll/focus
// snapshot the board would consume is silently ignored).
import { useSurfaceRestore } from "@/hooks/use-surface-restore";
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
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AppFooter } from "@/components/app-footer";

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

const SURFACE_ICON: Record<Surface, typeof InboxIcon> = {
  home: InboxIcon,
  board: LayoutGridIcon,
  workers: UsersIcon,
  queue: ListOrderedIcon,
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<boolean>(readSidebarOpen);
  // CTL-911 / SURF3 — the initial surface SEEDS from the persisted landing
  // preference (defaults Home), then becomes ephemeral navigation state: jumping
  // around does NOT rewrite the persisted default — only Settings changes it.
  const [surface, setSurface] = useState<Surface>(readLandingSurface);
  // CTL-911 / SURF3 — Settings is a FOOTER destination, not one of the four
  // OPERATE landing surfaces; it takes over the inset via this open-flag.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // CTL-898 / SHELL8 — the active node scope. Defaults to ALL_NODES (the cluster-
  // wide view); the sidebar's node filter sets it when N>1, and the sidebar also
  // resolves a stale focused scope back to ALL_NODES when its host leaves the
  // roster (a node going dark never strands the operator on an empty view).
  const [nodeScope, setNodeScope] = useState<NodeScope>(ALL_NODES);
  // CTL-944 — the active repo scope for breadcrumbs + palette navigation.
  const [repoScope, setRepoScope] = useAtom(repoScopeAtom);
  // CTL-971 — on return from a detail page, reseat the surface the card was opened
  // from (else the landing-pref Inbox shows) + re-apply the saved repo scope. PEEKS
  // the restore snapshot (the board's own useBoardRestore consumes it for scroll).
  // Reseating the surface ALSO leaves Settings, mirroring the `g`-chord behavior.
  const restoreSurface = useCallback((s: Surface) => {
    setSurface(s);
    setSettingsOpen(false);
  }, []);
  useSurfaceRestore(restoreSurface, setRepoScope);
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

  // `[` toggles the rail; `g <key>` chords jump surfaces. Both ignore typing.
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

      // `g` arms a chord; the next key picks the surface (g h / g b / g w / g q).
      if (e.key === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        chordArmed = true;
        clearTimeout(chordTimer);
        chordTimer = setTimeout(() => {
          chordArmed = false;
        }, 800);
        return;
      }
      if (chordArmed) {
        const target = SURFACE_CHORD[e.key];
        if (target) {
          e.preventDefault();
          setSurface(target);
          setSettingsOpen(false); // jumping to a surface leaves Settings
        }
        chordArmed = false;
        clearTimeout(chordTimer);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(chordTimer);
    };
  }, []);

  // ⌘K / Ctrl+K and a bare `/` (outside a field) open the command palette — the
  // SINGLE search affordance for the shell (SHELL5 de-dups the prototype's two
  // search bars). The open contract lives in lib/command-palette.ts. ⌘K toggles; `/`
  // opens (a quick-open shouldn't re-close on a second slash).
  // CTL-930: the click addEventListener for data-cmdk-trigger is REMOVED — the
  // top-strip search button handles its own onClick via data-cmdk-trigger + the
  // keydown listener. The WorkspaceSwitcher click path is gone with the switcher.
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

  // CTL-944: jumpTo now accepts a NavTarget (surface + scope) for project palette entries.
  const jumpTo = useCallback((s: Surface, scope?: string) => {
    setSurface(s);
    if (scope !== undefined) setRepoScope(scope);
    setSettingsOpen(false);
    setPaletteOpen(false);
  }, [setRepoScope]);

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    setPaletteOpen(false);
  }, []);

  // The context's setSurface ALSO leaves Settings, so clicking an OPERATE nav
  // item from the Settings surface returns to that surface (not a dead frame).
  const selectSurface = useCallback((s: Surface) => {
    setSurface(s);
    setSettingsOpen(false);
  }, []);

  const surfaceCtx = useMemo(
    () => ({ surface, setSurface: selectSurface, settingsOpen, openSettings }),
    [surface, selectSurface, settingsOpen, openSettings],
  );
  const nodeScopeCtx = useMemo(
    () => ({ scope: nodeScope, setScope: setNodeScope }),
    [nodeScope],
  );

  // CTL-930/CTL-944: breadcrumbs are now scope-aware via breadcrumbFor.
  const crumbs = settingsOpen ? SETTINGS_BREADCRUMB : breadcrumbFor(surface, repoScope);

  return (
    <NavSignalContext.Provider value={navSignal}>
    <ClusterSignalContext.Provider value={clusterSignal}>
    <SurfaceContext.Provider value={surfaceCtx}>
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
          {/* ── Thin top strip: hamburger + breadcrumb + ⌘K search ─────────── */}
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
            <SidebarTrigger className="text-muted-foreground" />
            <Separator orientation="vertical" className="mr-1 h-4!" />
            <Breadcrumb>
              <BreadcrumbList>
                {crumbs.map((crumb, i) => {
                  const isLast = i === crumbs.length - 1;
                  return (
                    // Separators are SIBLINGS of items (both <li>) — never nest a
                    // separator inside an item, or it's <li> within <li>.
                    <Fragment key={crumb}>
                      <BreadcrumbItem>
                        {isLast ? (
                          <BreadcrumbPage>{crumb}</BreadcrumbPage>
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

            {/* CTL-930: WorkspaceSwitcher removed from top strip. Scope is communicated
                via the project-grouped left nav. The ⌘K search button is the only right-side
                affordance. It handles its own click to open the palette. */}
            <div className="ml-auto flex items-center">
              {/* ⌘K search trigger. */}
              <button
                type="button"
                data-cmdk-trigger
                onClick={() => setPaletteOpen(true)}
                className="flex h-7 items-center gap-2 rounded-md border border-border bg-secondary/30 px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                aria-label="Search or jump to…"
              >
                <SearchIcon className="size-3.5" />
                <span className="hidden sm:inline">Search…</span>
                <kbd className="rounded border border-border bg-background/60 px-1 py-0.5 text-[10px]">
                  ⌘K
                </kbd>
              </button>
            </div>
          </header>

          {/* The active surface renders edge-to-edge below the strip. The
              Settings surface (CTL-911 / SURF3) takes over the inset when the
              footer Settings item is open; otherwise the surface content
              (children) renders. */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {settingsOpen ? <SettingsSurface /> : children}
          </div>

          {/* CTL-930: AppFooter carries the status cluster (LIVE badge + activity +
              health dots), moved from the in-board header and the sidebar footer. */}
          <AppFooter />
        </SidebarInset>
      </SidebarProvider>

      {/* ── ⌘K command palette — project-grouped nav (CTL-944) ──────────────── */}
      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <CommandInput placeholder="Jump to a surface or search a ticket…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {/* CTL-944: palette entries are project-grouped via paletteEntries(groups). */}
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
          {/* Settings is reachable from ⌘K too. */}
          <CommandGroup heading="Settings">
            <CommandItem value="Settings" onSelect={openSettings}>
              <SettingsIcon className="size-4" />
              Settings
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      </NodeScopeContext.Provider>
    </SurfaceContext.Provider>
    </ClusterSignalContext.Provider>
    </NavSignalContext.Provider>
  );
}
