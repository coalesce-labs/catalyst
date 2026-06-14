import type { ActionEntry } from "./action-registry";
// Import from surface-constants (React-/router-free) so tests don't pull in @tanstack/react-router.
import { SURFACE_CHORD, SURFACE_LABEL, type Surface } from "./surface-constants";

export interface SurfaceActionHandlers {
  jumpToSurface: (s: Surface) => void;
  /** Deferred — Open Question #1: no create flow exists yet. */
  create: () => void;
}

/** The two-key sequences the detail Shell owns; the surface listener yields these on detail routes. */
const DETAIL_CHORD_KEYS = new Set(["t", "w", "a"]);
const DETAIL_ROUTE = /^\/(ticket|worker)\//;

/** True when a pending `g <key>` on this path must defer to the detail Shell classifier. */
export function surfaceChordYieldsToDetail(pathname: string, key: string): boolean {
  return DETAIL_ROUTE.test(pathname) && DETAIL_CHORD_KEYS.has(key);
}

export function buildSurfaceActions(h: SurfaceActionHandlers): ActionEntry[] {
  const surfaceJumps: ActionEntry[] = Object.entries(SURFACE_CHORD).map(([key, surface]) => ({
    id: `nav.surface.${surface}`,
    title: `Go to ${SURFACE_LABEL[surface as Surface]}`,
    keywords: ["go", "navigate", surface],
    scope: "global" as const,
    keybinding: `g ${key}`,
    handler: () => h.jumpToSurface(surface as Surface),
  }));

  const create: ActionEntry = {
    id: "action.create",
    title: "Create…",
    keywords: ["new", "create"],
    scope: "global",
    keybinding: "c",
    handler: h.create,
  };

  return [...surfaceJumps, create];
}

/** The display binding for a surface's nav hint, derived from SURFACE_CHORD (single source). */
export function surfaceKeybinding(surface: Surface): string | undefined {
  const key = Object.entries(SURFACE_CHORD).find(([, s]) => s === surface)?.[0];
  return key ? `g ${key}` : undefined;
}
