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
  SURFACE_BREADCRUMB,
  SURFACE_CHORD,
  SURFACE_LABEL,
  SURFACES,
  isTypingTarget,
  type Surface,
} from "@/lib/surface";
// CTL-911 / SURF3 — the persisted landing-surface preference (which OPERATE
// surface opens first on a fresh load); the Settings surface writes it.
import { readLandingSurface } from "@/lib/prefs";
import { SettingsSurface } from "@/components/settings-surface";
// CTL-898 / SHELL8 — the shell owns the NODE-SCOPE store (All-nodes by default).
// Single-host is an identity no-op: the filter affordance is absent (the sidebar
// gates it on the live cluster signal) so the scope stays All-nodes and nothing
// changes on today's single-node deployment.
import { ALL_NODES, NodeScopeContext, type NodeScope } from "@/lib/node-scope";
import {
  readSidebarOpen,
  writeSidebarOpen,
  shouldToggleSidebar,
} from "@/lib/sidebar-collapse";
import { shouldOpenPalette } from "@/lib/command-palette";
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
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

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
  // search bars). Clicks on the top-strip search field (data-cmdk-trigger) open
  // it too. The open contract — including the "'/' never hijacks typing" guard —
  // lives in lib/command-palette.ts (`shouldOpenPalette`) so it is unit-tested
  // without a DOM, the same way `[` uses shouldToggleSidebar. ⌘K toggles; `/`
  // opens (a quick-open shouldn't re-close on a second slash).
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
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("[data-cmdk-trigger]")) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, []);

  const jumpTo = useCallback((s: Surface) => {
    setSurface(s);
    setSettingsOpen(false);
    setPaletteOpen(false);
  }, []);

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

  const crumbs = settingsOpen ? SETTINGS_BREADCRUMB : SURFACE_BREADCRUMB[surface];

  return (
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

            {/* CTL-897 / SHELL7 — the workspace switcher, ALSO duplicated into the
                top strip (handoff cosmetic #6: the earlier "too much" call was
                reversed — the operator now wants it in the top as well). It shares
                the SAME active scope as the sidebar-header instance via the FND
                `repoScopeAtom`, so a selection in one reflects in the other. */}
            <div className="ml-auto flex items-center">
              <WorkspaceSwitcher placement="topstrip" />
            </div>

            {/* ⌘K search trigger. */}
            <button
              type="button"
              data-cmdk-trigger
              className="ml-2 flex h-7 items-center gap-2 rounded-md border border-border bg-secondary/30 px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label="Search or jump to…"
            >
              <SearchIcon className="size-3.5" />
              <span className="hidden sm:inline">Search…</span>
              <kbd className="rounded border border-border bg-background/60 px-1 py-0.5 text-[10px]">
                ⌘K
              </kbd>
            </button>
          </header>

          {/* The active surface renders edge-to-edge below the strip. The
              Settings surface (CTL-911 / SURF3) takes over the inset when the
              footer Settings item is open; otherwise the surface content
              (children) renders. */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {settingsOpen ? <SettingsSurface /> : children}
          </div>
        </SidebarInset>
      </SidebarProvider>

      {/* ── ⌘K command palette — jump to any surface ───────────────────────── */}
      <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <CommandInput placeholder="Jump to a surface or search a ticket…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Go to">
            {SURFACES.map((s) => {
              const Icon = SURFACE_ICON[s];
              return (
                <CommandItem
                  key={s}
                  value={SURFACE_LABEL[s]}
                  onSelect={() => jumpTo(s)}
                >
                  <Icon className="size-4" />
                  {SURFACE_LABEL[s]}
                </CommandItem>
              );
            })}
            {/* CTL-911 / SURF3 — Settings is reachable from ⌘K too (it's a
                footer destination, not an OPERATE landing surface). */}
            <CommandItem value="Settings" onSelect={openSettings}>
              <SettingsIcon className="size-4" />
              Settings
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      </NodeScopeContext.Provider>
    </SurfaceContext.Provider>
  );
}
