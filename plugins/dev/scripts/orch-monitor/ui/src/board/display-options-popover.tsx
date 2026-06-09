// display-options-popover.tsx — the BOARD2 (CTL-906) Display-options popover:
// ONE toolbar button that owns every board display choice, folding today's
// scattered subhead Seg toggles (lens / colorBy / repo-lanes) into one tray and
// adding the NEW density / ordering / show-empty knobs. All choices persist via
// the `boardPrefsAtom` (board/prefs-store.ts). Catalyst-specific composition of
// the shadcn primitives in display-options-sections.tsx + ui/popover.tsx.
//
// INVARIANTS honored here:
//   - density is per-surface (the board-prefs atom), NOT a global app mode.
//   - the reserved live-signal cyan appears NOWHERE in this file (a source-grep
//     test guards the hex literal). The "customized" dot uses the blue accent,
//     never the live signal.
//   - CTL-930 forward-compat: this file renders NO in-board tab strip and NO
//     "Catalyst" wordmark; it reserves a Lens slot for CTL-930 to fill.
import { useAtom } from "jotai";
import { SlidersHorizontal } from "lucide-react";
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
} from "./prefs-store";
import { SegRow, SwitchRow } from "./display-options-sections";

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
  // is customized. Uses --accent, deliberately NOT the cyan live signal.
  const customized = JSON.stringify(prefs) !== JSON.stringify(DEFAULT_BOARD_PREFS);

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
            border: "1px solid #262d36",
            background: "#16191f",
            color: "#8b93a1",
            padding: "5px 10px",
            fontSize: 12,
            cursor: "pointer",
            lineHeight: 1,
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
                background: "#4ea1ff",
              }}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        style={{ background: "#16191f", border: "1px solid #262d36", color: "#e6e9ef", padding: 8 }}
      >
        <SegRow
          label="Group by"
          value={prefs.groupBy}
          onChange={(v) => patch({ groupBy: v })}
          options={GROUP_BY_OPTIONS}
        />
        <SegRow
          label="Density"
          value={prefs.density}
          onChange={(v) => patch({ density: v })}
          options={DENSITY_OPTIONS}
        />
        <SegRow
          label="Order"
          value={prefs.order}
          onChange={(v) => patch({ order: v })}
          options={ORDER_OPTIONS}
        />
        <SegRow
          label="Color"
          value={prefs.colorBy}
          onChange={(v) => patch({ colorBy: v })}
          options={COLOR_BY_OPTIONS}
        />
        <SwitchRow
          label="Show empty columns"
          checked={prefs.showEmptyColumns}
          onChange={(v) => patch({ showEmptyColumns: v })}
        />
        {/* Repo lanes — only meaningful in a multi-repo workspace. BOARD3 folds
            this into the general Swimlanes radio (repo becomes one value of
            none|repo|team|project|host); designed adjacent so that's a clean
            swap, not a re-layout. */}
        {repos.length > 1 && (
          <>
            <Separator style={{ margin: "8px 0", background: "#262d36" }} />
            <SegRow
              label="Repo lanes"
              value={prefs.swimlane === "repo" ? "lanes" : "flat"}
              onChange={(v) =>
                patch({ swimlane: (v === "lanes" ? "repo" : "none") as Swimlane })
              }
              options={[
                { k: "flat", label: "Combined" },
                { k: "lanes", label: "Repo lanes" },
              ]}
            />
          </>
        )}
        {/* ── reserved: BOARD3 «Swimlanes radio» / BOARD4 «Layout» / CTL-930
            «Lens» drop in here without re-architecting the tray. ── */}
      </PopoverContent>
    </Popover>
  );
}
