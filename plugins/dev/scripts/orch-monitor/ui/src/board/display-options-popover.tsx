// display-options-popover.tsx — the BOARD2 (CTL-906) Display-options popover,
// restyled in CTL-930 Phase 2. ONE toolbar button that owns every board display
// choice, folding the scattered subhead Seg toggles into a quiet Linear-grammar
// tray. All choices persist via `boardPrefsAtom` (board/prefs-store.ts).
//
// INVARIANTS honored here:
//   - density is per-surface (the board-prefs atom), NOT a global app mode.
//   - The reserved live-signal cyan appears NOWHERE in this file (a source-grep
//     test guards the hex literal and the LIVE token).
//   - CTL-930: the Lens slot reservation is removed — Workers is first-class nav.
//   - display-options-popover.tsx filename is stable (guard test imports from it).
//   - All five option arrays kept at lines 44–69 (guard test source-parses them).
import { useAtom } from "jotai";
import {
  LayoutGrid,
  ListOrdered,
  Palette,
  Rows2,
  SlidersHorizontal,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  boardPrefsAtom,
  DEFAULT_BOARD_PREFS,
  patchBoardPrefs,
  type BoardPrefs,
  type Density,
  type GroupBy,
  type ColorBy,
  type Ordering,
  type Swimlane,
  type Layout,
} from "./prefs-store";
import { LayoutSwitch, SelectRow, ChipToggle, PropertiesSection } from "./display-options-sections";
// BOARD3 / CTL-907: the swimlane axis option set (none|repo|team|project|host),
// owned alongside the swimlane renderer so the control and the engine cannot drift.
import { SWIMLANE_OPTIONS } from "./Swimlane";
import { C } from "./board-tokens";

// The option arrays. Their keys are the STORED pref values, so a drift-guard
// test (board-display-options-drift.test.ts) asserts each array's key set equals
// its BoardPrefs union — adding a union member without a UI row (or vice-versa)
// fails the build's tests.
export const DENSITY_OPTIONS: { k: Density; label: string }[] = [
  { k: "comfortable", label: "Comfortable" },
  { k: "compact", label: "Compact" },
];
export const GROUP_BY_OPTIONS: { k: GroupBy; label: string }[] = [
  { k: "linear", label: "Status" },
  { k: "phase", label: "Pipeline" },
];
export const COLOR_BY_OPTIONS: { k: ColorBy; label: string }[] = [
  { k: "phase", label: "Phase" },
  { k: "status", label: "Status" },
  { k: "repo", label: "Repo" },
  { k: "type", label: "Type" },
];
export const ORDER_OPTIONS: { k: Ordering; label: string }[] = [
  { k: "priority", label: "Priority" },
  { k: "recent", label: "Recent" },
  { k: "live", label: "Live first" },
];
// BOARD4 / CTL-908: the Board ⇄ List layout toggle. Keys are the STORED pref
// values — the drift-guard test asserts this array's key set equals the `Layout`
// union, exactly like the other option arrays.
export const LAYOUT_OPTIONS: { k: Layout; label: string }[] = [
  { k: "board", label: "Board" },
  { k: "list", label: "List" },
];

// ── Phase 2 / CTL-930 exported helpers ───────────────────────────────────────

/**
 * Convert a chip's pressed state to a Density value.
 * The Compact chip: pressed → "compact", unpressed → "comfortable".
 */
export const chipToDensity = (pressed: boolean): Density =>
  pressed ? "compact" : "comfortable";

/** True when the density is "compact" (drives the chip's pressed state). */
export const densityIsCompact = (d: Density): boolean => d === "compact";

/**
 * Which sections are visible for a given layout.
 * In List layout, Color and Empty-columns controls are hidden (BoardList uses neither).
 */
export function visibleSections(layout: Layout): { color: boolean; emptyColumns: boolean } {
  if (layout === "board") return { color: true, emptyColumns: true };
  return { color: false, emptyColumns: false };
}

export function DisplayOptionsPopover({
  repos = [],
}: {
  /** The live repo list — the repo-lanes row only renders for a multi-repo
   *  workspace (single-repo = identity no-op, no row). */
  repos?: string[];
}) {
  const [prefs, setPrefs] = useAtom(boardPrefsAtom);
  const patch = (d: Partial<BoardPrefs>) => setPrefs((p) => patchBoardPrefs(p, d));
  // A small dot when any pref differs from default → the operator sees the board
  // is customized. Uses C.blue accent, deliberately NOT the cyan live signal.
  const customized = JSON.stringify(prefs) !== JSON.stringify(DEFAULT_BOARD_PREFS);

  const sections = visibleSections(prefs.layout);
  const swimlaneOptions = repos.length > 1
    ? SWIMLANE_OPTIONS
    : SWIMLANE_OPTIONS.filter((o) => o.k !== "repo");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Display options"
          style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: C.s2,
            color: C.fgMuted,
            padding: "5px 10px",
            fontSize: 12,
            cursor: "pointer",
            lineHeight: 1,
            fontFamily: "inherit",
          }}
        >
          <SlidersHorizontal style={{ width: 14, height: 14 }} aria-hidden />
          Display
          {customized && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: -3,
                right: -3,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: C.blue,
              }}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        style={{
          background: C.s2,
          border: `1px solid ${C.border}`,
          color: C.fg,
          padding: "10px 8px",
          width: 240,
        }}
        onInteractOutside={(e) => {
          // Radix nested-portal dismissal guard: keep the tray open when the user
          // clicks inside a DropdownMenuContent (a nested portal outside the Popover
          // portal tree). Keyed to data-slot="dropdown-menu-content".
          if ((e.target as Element | null)?.closest?.('[data-slot="dropdown-menu-content"]'))
            e.preventDefault();
        }}
      >
        {/* 1. Layout switch — top of tray */}
        <LayoutSwitch
          value={prefs.layout}
          onChange={(v) => patch({ layout: v })}
          options={LAYOUT_OPTIONS}
        />

        <Separator style={{ margin: "8px 0", background: C.border }} />

        {/* 2. SelectRow controls: Columns / Rows / Ordering / Color */}
        <SelectRow
          label="Columns"
          icon={LayoutGrid}
          tip="Which axis becomes the board's columns"
          value={prefs.groupBy}
          onChange={(v) => patch({ groupBy: v })}
          options={GROUP_BY_OPTIONS}
        />
        <SelectRow
          label="Rows"
          icon={Rows2}
          tip="Horizontal swimlanes across the board"
          value={prefs.swimlane}
          onChange={(v) => patch({ swimlane: v as Swimlane })}
          options={swimlaneOptions}
        />
        <SelectRow
          label="Ordering"
          icon={ListOrdered}
          tip="How cards sort inside each column"
          value={prefs.order}
          onChange={(v) => patch({ order: v })}
          options={ORDER_OPTIONS}
        />
        {sections.color && (
          <SelectRow
            label="Color"
            icon={Palette}
            tip="What the card accent encodes"
            value={prefs.colorBy}
            onChange={(v) => patch({ colorBy: v })}
            options={COLOR_BY_OPTIONS}
          />
        )}

        <Separator style={{ margin: "8px 0", background: C.border }} />

        {/* 3. PropertiesSection chips */}
        <PropertiesSection>
          <ChipToggle
            label="Compact"
            pressed={densityIsCompact(prefs.density)}
            onChange={(v) => patch({ density: chipToDensity(v) })}
          />
          {sections.emptyColumns && (
            <ChipToggle
              label="Empty columns"
              pressed={prefs.showEmptyColumns}
              onChange={(v) => patch({ showEmptyColumns: v })}
            />
          )}
        </PropertiesSection>

        {/* 4. Reset row — only when customized */}
        {customized && (
          <button
            type="button"
            onClick={() => setPrefs(() => DEFAULT_BOARD_PREFS)}
            style={{
              display: "block",
              width: "100%",
              padding: "4px 2px",
              marginTop: 4,
              background: "transparent",
              border: "none",
              color: C.fgDim,
              fontSize: 11,
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Reset to defaults
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
