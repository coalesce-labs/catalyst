import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const towerSrc = readFileSync(
  join(import.meta.dir, "..", "components", "queue", "control-tower.tsx"),
  "utf8",
);
const boardSrc = readFileSync(join(import.meta.dir, "Board.tsx"), "utf8");

describe("CTL-1098 — ControlTower fills its own Dispatch screen (no 45vh cap)", () => {
  it("no longer caps its height at a viewport fraction", () => {
    // ControlTower owns the Dispatch screen; the screen's scroll container owns overflow.
    expect(towerSrc).not.toMatch(/maxHeight:\s*"45vh"/);
  });
  it("does not pin its own internal vertical scroll", () => {
    // overflow is owned by the dispatch-scroll container in Board.tsx, not ControlTower.
    expect(towerSrc).not.toMatch(/overflowY:\s*"auto"/);
  });
});

describe("CTL-1083 — workers grouping Seg stays wired to local state", () => {
  it("binds value={workerGrouping} and onChange={setWorkerGrouping}", () => {
    expect(boardSrc).toContain("value={workerGrouping}");
    expect(boardSrc).toContain("onChange={setWorkerGrouping}");
  });
});
