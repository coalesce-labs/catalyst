// surface.ts — the app-shell surface contract (CTL-891 / SHELL1).
//
// Ported from the prototype `mockups/home-proto/src/lib/surface.ts`. This is the
// PURE, framework-agnostic core of the shell: the surface union, the `g`-chord
// jump map, and the per-surface breadcrumb trail. AppShell/AppSidebar consume it;
// keeping it free of React makes the keyboard/IA contract unit-testable without a
// DOM (the same pattern board-logic.ts / route-search.ts follow).
//
// Surface switching itself is consumed from the FND routing/store stream — this
// module only declares the contract the shell binds to; it does NOT own routing.
import { createContext, useContext } from "react";

/** The top-level surfaces the shell can render in SidebarInset. */
export type Surface = "home" | "board" | "workers" | "queue";

/** Every surface in nav order — the single source the sidebar + palette iterate. */
export const SURFACES: readonly Surface[] = [
  "home",
  "board",
  "workers",
  "queue",
] as const;

/** Human label per surface (sidebar item + command palette).
 *  CTL-930: home → "Inbox", board → "Tickets" (internal union keys unchanged). */
export const SURFACE_LABEL: Record<Surface, string> = {
  home: "Inbox",
  board: "Tickets",
  workers: "Workers",
  queue: "Queue",
};

/** The `g <key>` jump keys, kept next to the Surface union so they stay in sync. */
export const SURFACE_CHORD: Record<string, Surface> = {
  h: "home",
  b: "board",
  w: "workers",
  q: "queue",
};

/** Breadcrumb trail per surface — scope-less fallback (used by tests + non-scoped contexts).
 *  CTL-930: scope-aware breadcrumbs use lib/nav-model#breadcrumbFor instead. */
export const SURFACE_BREADCRUMB: Record<Surface, string[]> = {
  home: ["Overall", "Inbox"],
  board: ["Overall", "Tickets"],
  workers: ["Overall", "Workers"],
  queue: ["Overall", "Queue"],
};

/**
 * Breadcrumb for the Settings surface (CTL-911 / SURF3). Settings is a FOOTER
 * destination, NOT one of the four OPERATE landing surfaces — so it stays out
 * of the `Surface` union / `SURFACES` / `SURFACE_CHORD` (which the shell's nav,
 * the command palette, and the landing-surface preference all iterate). The
 * shell renders it via a separate open-flag, with this trail in the top strip.
 */
export const SETTINGS_BREADCRUMB: string[] = ["Settings"];

/**
 * True when focus is in a text-entry context — the shell's `[` / `g` chord
 * handlers must NOT steal those keystrokes. Pure so it can be unit-tested with a
 * minimal `{ tagName, isContentEditable }` shape rather than a real DOM node.
 */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable === true
  );
}

interface SurfaceContextValue {
  surface: Surface;
  setSurface: (s: Surface) => void;
  /** Whether the Settings surface is currently shown (CTL-911 / SURF3). */
  settingsOpen: boolean;
  /** Open the Settings surface (the footer Settings nav item calls this). */
  openSettings: () => void;
}

export const SurfaceContext = createContext<SurfaceContextValue | null>(null);

export function useSurface(): SurfaceContextValue {
  const ctx = useContext(SurfaceContext);
  if (!ctx) throw new Error("useSurface must be used within an AppShell.");
  return ctx;
}
