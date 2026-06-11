// nav-store.ts — the jotai navigation store for the detail-page chrome
// (CTL-882 / FND2). The URL owns *location* (route + typed search params, see
// route-search.ts); this store owns the *ephemeral cursor* — list-context,
// peek overlay, ⌘K palette open-state — plus the one persisted bit:
// recently-viewed (detail design §3.1 / §6 P11).
//
//   listContextAtom   {ids, kind, lens, col}   — the resolved walk list
//   peekAtom          {open, leftId, onId, nextId}
//   paletteOpenAtom   boolean
//   recentlyViewedAtom string[] (atomWithStorage → localStorage, P11)
//
// jotai is already in-grain (the kibo-ui gantt is the only other consumer,
// `components/kibo-ui/gantt/index.tsx:28`). This ticket stands up the atoms ONLY
// — the shell chrome, the peek/palette UI, and the pager that READ these atoms
// are owned by the SHELL/DETAIL streams (boundary stated in the ticket).
//
// The recency-merge logic is factored into the PURE `pushRecent` helper so the
// orch-monitor `bun test` suite can unit-test the "CTL-845 then CTL-831 then
// reload → recency order" Gherkin without a jotai/localStorage runtime; the
// atom setter just calls it.

import { atom } from "jotai";
import { atomFamily, atomWithStorage } from "jotai/utils";
import type { ListKind, ListLens } from "./list-order";
import { pushRecent, RECENTLY_VIEWED_KEY } from "./recents";
import { REPO_SCOPE_ALL, type RepoScope } from "../lib/repo-scope";
import { freshEntryState, type DetailEntryState } from "./detail-entry-state";

// Re-export the recents constants/helper so consumers of the store have one
// import surface; the testable logic itself lives in the jotai-free recents.ts.
export { pushRecent, RECENTLY_VIEWED_KEY, RECENTLY_VIEWED_CAP } from "./recents";

// ── workspace scope (CTL-897 / SHELL7) ──────────────────────────────────────
/**
 * The active workspace scope the operator selected in the config-driven
 * workspace switcher: the all-repos sentinel (`REPO_SCOPE_ALL`) or a real repo
 * key (`BoardPayload.repos[n]`). Lifted to the FND store (NOT a per-component
 * `useState`) so the TWO switcher placements — the sidebar header and the top
 * strip — share ONE active scope: selecting a repo in either reflects in the
 * other, and the data surfaces (Home / Board / Workers / Queue) read this SAME
 * atom to scope-filter their resident snapshot. Persisted via `atomWithStorage`
 * so the scope survives a reload, the same way `recentlyViewedAtom` does. The
 * stale-scope reconciliation (a persisted scope no longer in the live config →
 * fall back to "All") lives in the pure `lib/repo-scope.ts#resolveScope`, applied
 * by the switcher against the live `BoardPayload.repos`.
 */
export const REPO_SCOPE_STORAGE_KEY = "catalyst-repo-scope";
export const repoScopeAtom = atomWithStorage<RepoScope>(
  REPO_SCOPE_STORAGE_KEY,
  REPO_SCOPE_ALL,
  undefined,           // use default storage
  { getOnInit: true }, // CTL-944: prevents first-frame write to wrong prefs slice
);

// ── project-grouped nav open-state (CTL-944) ─────────────────────────────────
/**
 * Persisted open/closed state for each per-project nav group in the sidebar.
 * Keys are repo scope strings; true = open, false = collapsed. Groups containing
 * the active item force-render open regardless of this value.
 */
export const navGroupsOpenAtom = atomWithStorage<Record<string, boolean>>(
  "catalyst-nav-groups-v1",
  {},
);

// ── section open-state for the Overall + Observe groups (CTL-1034) ───────────
/**
 * CTL-1034: EVERY top-level sidebar section is collapsible — not just the
 * per-project groups. The Overall group (always-on all-projects scope) and the
 * Observe group each get their own persisted open/closed bit so the operator can
 * fold any section, and the choice survives a reload (the same `atomWithStorage`
 * discipline the per-project `navGroupsOpenAtom` and the board prefs use).
 *
 * Both default to OPEN (true) — the sidebar starts fully expanded; collapsing is
 * an explicit operator gesture. A section containing the active surface force-
 * renders open regardless of the stored bit (see the sidebar's force-open guard),
 * so the selected item is never hidden inside a collapsed section.
 *
 * Previously the Overall group was a plain (non-collapsible) SidebarGroup and the
 * Observe open-state lived in an ephemeral component `useState(false)` (lost on
 * unmount, defaulted collapsed). Persisting both here unifies the collapse model.
 */
export const navOverallOpenAtom = atomWithStorage<boolean>(
  "catalyst-nav-overall-v1",
  true,
);
export const navObserveOpenAtom = atomWithStorage<boolean>(
  "catalyst-nav-observe-v1",
  true,
);

// ── list context (the resolved walk list) ───────────────────────────────────
/**
 * The list the operator is walking, resolved once (via `resolveList`) from the
 * resident payload + the typed search params, and read by the pager (`N /
 * total`), the j/k handler, and peek (prev/next). `ids` is the ordered id list
 * — `BoardTicket.id` for tickets, `BoardWorker.name` for workers.
 *
 * Cold-link (a pasted bare URL with no `?from`): `ids` is `[]` until the board
 * stream rehydrates, at which point the shell resets this atom and the pager
 * silently lights up (detail design §3.3 "Cold-link").
 */
export interface ListContextState {
  ids: string[];
  kind: ListKind;
  lens?: ListLens;
  col?: string;
}

/** The empty / cold-link context: no list resolved yet. */
export const EMPTY_LIST_CONTEXT: ListContextState = { ids: [], kind: "ticket" };

export const listContextAtom = atom<ListContextState>(EMPTY_LIST_CONTEXT);

// ── peek overlay ────────────────────────────────────────────────────────────
/**
 * The blue-framed peek overlay state (detail design §3.3 "Peek"). `onId` is the
 * entity currently centred; `leftId`/`nextId` are its neighbours in
 * `listContextAtom.ids` (null at the list ends). The shell sets `open` while
 * j/k is held or a chevron is hovered.
 */
export interface PeekState {
  open: boolean;
  leftId: string | null;
  onId: string | null;
  nextId: string | null;
}

/** Closed peek with no anchored entity. */
export const PEEK_CLOSED: PeekState = { open: false, leftId: null, onId: null, nextId: null };

export const peekAtom = atom<PeekState>(PEEK_CLOSED);

// ── ⌘K palette ──────────────────────────────────────────────────────────────
/** Whether the ⌘K command palette is open. The shell saves/restores focus
 *  around the toggle (detail design §3.4); this atom is just the boolean. */
export const paletteOpenAtom = atom<boolean>(false);

// ── ? cheatsheet ─────────────────────────────────────────────────────────────
/** Whether the `?` keyboard cheatsheet overlay is open (CTL-916 / DETAIL5,
 *  detail design §3.4 / §7 `command-menu-keyboard`). Toggled by the shell's `?`
 *  binding; read by the cheatsheet overlay. A sibling of `paletteOpenAtom` so the
 *  two overlays share the one layered-Escape discipline. */
export const cheatsheetOpenAtom = atom<boolean>(false);

// ── recently-viewed (persisted) ─────────────────────────────────────────────
// The localStorage key, the cap, and the `pushRecent` recency-merge live in the
// jotai-free `recents.ts` (re-exported above) so the recency Gherkin is unit-
// testable in the main `bun test` suite without a jotai runtime.

/**
 * The recently-viewed ids, most-recent-first, persisted to localStorage via
 * `atomWithStorage` so the ⌘K RECENT group survives a reload (detail design §6
 * P11). Write through `recordRecentAtom` (below) rather than setting this
 * directly, so the de-dupe + cap invariants always hold.
 */
export const recentlyViewedAtom = atomWithStorage<string[]>(RECENTLY_VIEWED_KEY, []);

/**
 * Write-only atom: record a freshly-viewed `id` into `recentlyViewedAtom`,
 * applying the `pushRecent` recency-merge (move-to-front, de-dupe, cap). The
 * shell calls `set(recordRecentAtom, id)` on every detail LAND.
 */
export const recordRecentAtom = atom(null, (get, set, id: string) => {
  set(recentlyViewedAtom, pushRecent(get(recentlyViewedAtom), id));
});

// ── back-stack entry state (CTL-1049) ─────────────────────────────────────────
/**
 * Per-history-entry transient detail-view state, keyed by the TanStack Router
 * per-entry key (`location.state.__TSR_key`). This is the mechanism behind the
 * CTL-1049 convention: a fresh PUSH navigation lands on a NEW key → a NEW atom →
 * the fresh defaults (Spec tab, all rail sections open, top of scroll); a BACK /
 * FORWARD traverse lands on the SAME key → the already-populated atom → the
 * restored state. The push/pop distinction is structural (new key vs same key),
 * not conditional — no `useNavigationType` branch needed.
 *
 * The DEFAULTS, the rail-section resolution, and the LRU eviction arithmetic live
 * in the jotai-free `detail-entry-state.ts` so they unit-test under the root
 * `bun test`; this family is the thin jotai wiring. Memory is bounded by
 * `useDetailEntryState` (use-detail-entry-state.ts), which calls
 * `detailEntryStateFamily.remove(key)` for keys evicted past the LRU cap.
 *
 * `atomFamily` is the documented jotai primitive for a dynamic, param-keyed set
 * of atoms (jotai.org/docs/utilities/family). Each `__TSR_key` gets its own
 * independent atom seeded from a FRESH defaults copy.
 */
export const detailEntryStateFamily = atomFamily((_key: string) =>
  atom<DetailEntryState>(freshEntryState()),
);
