// prefs-store.ts — the BOARD2 (CTL-906) board-display-prefs store. A SIBLING of
// nav-store.ts using the IDENTICAL mechanism the FND store already ships
// (`atomWithStorage` to localStorage under a `catalyst-*` key, exactly as
// `repoScopeAtom` / `recentlyViewedAtom`). This is THE single source the
// display-options popover writes and that BOARD3 (swimlanes) / BOARD4 (list
// layout) / SURF3 (settings) read.
//
// One OBJECT atom (not many) so the localStorage surface is a single versioned
// key and the popover reads/writes one related cluster; field-level updates go
// through `patchBoardPrefs`.
//
// repo scope is deliberately NOT here — it is the shared `repoScopeAtom` already
// persisted by nav-store.ts (the workspace switcher). Duplicating it would split
// one piece of state across two keys.

import { atomWithStorage, createJSONStorage } from "jotai/utils";

export type Density = "comfortable" | "compact";
export type GroupBy = "linear" | "phase"; // generalized lens (Status / Pipeline)
export type ColorBy = "phase" | "status" | "repo" | "type";
export type Ordering = "priority" | "recent" | "live"; // shared comparator keys
export type Layout = "board" | "list"; // BOARD4 renders "list"
export type Swimlane = "none" | "repo" | "team" | "project" | "host"; // BOARD3 renders team/project/host

export interface BoardPrefs {
  density: Density;
  groupBy: GroupBy;
  colorBy: ColorBy;
  order: Ordering;
  showEmptyColumns: boolean;
  /** BOARD2 ships "none"|"repo" rendering; BOARD3 extends to team/project/host. */
  swimlane: Swimlane;
  /** BOARD2 ships the CONTROL board-only; BOARD4 renders the "list" branch. */
  layout: Layout;
}

// First-ever-visit defaults — SURF3 Gherkin: "calm-dark + dense board + Status
// grouping + Home landing". "dense board" = comfortable; "Status" = the
// Linear-state lens (the default lens today, Board.tsx:739).
export const DEFAULT_BOARD_PREFS: BoardPrefs = {
  density: "comfortable",
  groupBy: "linear",
  colorBy: "phase",
  order: "priority",
  showEmptyColumns: true,
  swimlane: "none",
  layout: "board",
};

// The single versioned localStorage key (catalyst-* like the nav-store keys) so
// a future schema change can migrate via the version suffix, not crash.
export const BOARD_PREFS_STORAGE_KEY = "catalyst-board-prefs-v1";

// Allowed values per enum field, so a hand-edited or stale blob with an
// out-of-range value falls back to the default for THAT field (rather than
// rendering an unknown enum the UI can't map).
const DENSITY_VALUES: readonly Density[] = ["comfortable", "compact"];
const GROUP_BY_VALUES: readonly GroupBy[] = ["linear", "phase"];
const COLOR_BY_VALUES: readonly ColorBy[] = ["phase", "status", "repo", "type"];
const ORDERING_VALUES: readonly Ordering[] = ["priority", "recent", "live"];
const LAYOUT_VALUES: readonly Layout[] = ["board", "list"];
const SWIMLANE_VALUES: readonly Swimlane[] = ["none", "repo", "team", "project", "host"];

function pickEnum<T extends string>(
  candidate: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof candidate === "string" && (allowed as readonly string[]).includes(candidate)
    ? (candidate as T)
    : fallback;
}

/**
 * Normalize an arbitrary parsed value into a complete, valid `BoardPrefs`:
 * spread the defaults under it (so a v1 blob missing a newer field is filled),
 * then clamp each enum field to its allowed set. Total function — never throws,
 * always returns a fully-populated object. (Same total/non-throwing ethos as
 * route-search.ts's `validateDetailSearch`.)
 */
export function normalizeBoardPrefs(value: unknown): BoardPrefs {
  const o = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof BoardPrefs, unknown>>;
  return {
    density: pickEnum(o.density, DENSITY_VALUES, DEFAULT_BOARD_PREFS.density),
    groupBy: pickEnum(o.groupBy, GROUP_BY_VALUES, DEFAULT_BOARD_PREFS.groupBy),
    colorBy: pickEnum(o.colorBy, COLOR_BY_VALUES, DEFAULT_BOARD_PREFS.colorBy),
    order: pickEnum(o.order, ORDERING_VALUES, DEFAULT_BOARD_PREFS.order),
    showEmptyColumns:
      typeof o.showEmptyColumns === "boolean"
        ? o.showEmptyColumns
        : DEFAULT_BOARD_PREFS.showEmptyColumns,
    swimlane: pickEnum(o.swimlane, SWIMLANE_VALUES, DEFAULT_BOARD_PREFS.swimlane),
    layout: pickEnum(o.layout, LAYOUT_VALUES, DEFAULT_BOARD_PREFS.layout),
  };
}

/**
 * Field-level update helper for the popover rows: spread a partial patch over
 * the prior prefs. Pure — never mutates the input.
 */
export function patchBoardPrefs(prev: BoardPrefs, patch: Partial<BoardPrefs>): BoardPrefs {
  return { ...prev, ...patch };
}

// The stock JSON storage (reads/writes browser localStorage; jotai
// feature-detects `window`, which the test shims under bun). Its `getItem`
// already returns the initialValue on a JSON.parse error, and may attach a
// cross-tab `subscribe` when `window.addEventListener` + `window.Storage` exist.
// localStorage is synchronous, so getItem returns a value (never a promise) — we
// keep the wrapper synchronous to preserve the SyncStorage shape.
const baseStorage = createJSONStorage<BoardPrefs>();

// Wrap so EVERY read is run through `normalizeBoardPrefs` — the merge-on-read
// robustness: a partial blob (missing a newer field), a `null`, or an object
// with out-of-range enums is repaired to a complete, valid BoardPrefs rather
// than crashing the board or surfacing an unknown enum. A per-key reviver can't
// add missing keys, so we normalize the whole parsed object here.
const normalizingStorage = {
  // `normalizeBoardPrefs` accepts `unknown` and always returns a complete,
  // valid BoardPrefs — so the base storage's return (a value under sync
  // localStorage) flows in without a cast and out as a guaranteed BoardPrefs.
  getItem: (key: string, initialValue: BoardPrefs): BoardPrefs =>
    normalizeBoardPrefs(baseStorage.getItem(key, initialValue)),
  setItem: (key: string, value: BoardPrefs) => baseStorage.setItem(key, value),
  removeItem: (key: string) => baseStorage.removeItem(key),
  // Preserve the cross-tab subscriber when the base storage exposes one (it is
  // only attached in a real `window` with localStorage's storage events).
  ...(baseStorage.subscribe ? { subscribe: baseStorage.subscribe } : {}),
};

/**
 * THE board-display-prefs atom. Persisted to localStorage under a single
 * versioned key; every read is normalized (defaults filled, enums clamped) so a
 * stale or hand-edited blob never crashes the board. The display-options popover
 * is the writer; BOARD3 / BOARD4 / SURF3 read it.
 */
export const boardPrefsAtom = atomWithStorage<BoardPrefs>(
  BOARD_PREFS_STORAGE_KEY,
  DEFAULT_BOARD_PREFS,
  normalizingStorage,
  { getOnInit: true },
);
