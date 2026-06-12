import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const towerSrc = readFileSync(
  join(import.meta.dir, "..", "components", "queue", "control-tower.tsx"),
  "utf8",
);
const boardSrc = readFileSync(join(import.meta.dir, "Board.tsx"), "utf8");

describe("CTL-1083 — ControlTower is height-bounded inside the workers flex column", () => {
  it("does not shrink (keeps natural height, never collapses the board)", () => {
    expect(towerSrc).toContain("flexShrink: 0");
  });
  it("caps its height and scrolls internally instead of starving the swimlane board", () => {
    expect(towerSrc).toMatch(/overflowY:\s*"auto"/);
    expect(towerSrc).toMatch(/maxHeight:/);
  });
});

describe("CTL-1083 — workers grouping Seg stays wired to local state", () => {
  it("binds value={workerGrouping} and onChange={setWorkerGrouping}", () => {
    expect(boardSrc).toContain("value={workerGrouping}");
    expect(boardSrc).toContain("onChange={setWorkerGrouping}");
  });
});
