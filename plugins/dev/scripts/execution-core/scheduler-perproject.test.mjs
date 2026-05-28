// Unit tests for the per-project dispatch helpers added in CTL-706.
// Run: cd plugins/dev/scripts/execution-core && bun test scheduler-perproject.test.mjs

import { describe, test, expect } from "bun:test";
import {
  selectDispatchablePerProject,
  buildPerProjectGauge,
} from "./scheduler.mjs";

const tk = (id) => ({
  identifier: id,
  priority: 1,
  createdAt: "x",
  state: "Todo",
  relations: { nodes: [] },
  inverseRelations: { nodes: [] },
});
const ids = (sel) => sel.map((t) => t.identifier);

describe("selectDispatchablePerProject — equivalence (CTL-706)", () => {
  test("empty perProject behaves exactly like selectDispatchable", () => {
    const ranked = [tk("CTL-1"), tk("CTL-2"), tk("CTL-3")];
    expect(ids(selectDispatchablePerProject(ranked, new Set(["CTL-2"]), 2, {}))).toEqual([
      "CTL-1",
      "CTL-3",
    ]);
  });
  test("freeSlots 0 → []", () => {
    expect(
      selectDispatchablePerProject([tk("CTL-1")], new Set(), 0, {
        perProject: { CTL: { maxParallel: 2 } },
      }),
    ).toEqual([]);
  });
});

describe("selectDispatchablePerProject — cap saturation (CTL-706)", () => {
  test("project at cap is skipped; next non-saturated project picked", () => {
    const ranked = [tk("ADV-1"), tk("ADV-2"), tk("CTL-1")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 2, {
      perProject: { ADV: { maxParallel: 1, reserve: 0 }, CTL: { maxParallel: 3, reserve: 0 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["ADV-1", "CTL-1"]);
  });
  test("in-flight count counts toward the cap", () => {
    const ranked = [tk("ADV-2"), tk("CTL-1")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 2, {
      perProject: { ADV: { maxParallel: 1 }, CTL: { maxParallel: 3 } },
      inFlight: new Set(["ADV-9"]),
    });
    expect(ids(sel)).toEqual(["CTL-1"]);
  });
});

describe("selectDispatchablePerProject — reserve enforcement (CTL-706)", () => {
  test("last shared slot withheld so another project can reach its reserve", () => {
    const ranked = [tk("ADV-1"), tk("CTL-1")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 1, {
      perProject: { ADV: { reserve: 0 }, CTL: { reserve: 1 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["CTL-1"]);
  });
  test("reserve does NOT bite when the reserved project has no waiting work", () => {
    const ranked = [tk("ADV-1"), tk("ADV-2")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 1, {
      perProject: { ADV: { reserve: 0 }, CTL: { reserve: 1 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["ADV-1"]);
  });
  test("a project filling its OWN reserve is never blocked by the reserve guard", () => {
    const ranked = [tk("CTL-1"), tk("CTL-2")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 2, {
      perProject: { CTL: { reserve: 2 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["CTL-1", "CTL-2"]);
  });
});

describe("buildPerProjectGauge (CTL-706)", () => {
  test("counts in-flight per project and surfaces cap/reserve", () => {
    const g = buildPerProjectGauge(
      new Set(["ADV-1", "ADV-2", "CTL-1"]),
      { ADV: { maxParallel: 4, reserve: 2 }, CTL: { maxParallel: 3, reserve: 1 } },
      1,
    );
    expect(g.freeSlots).toBe(1);
    expect(g.perProject.ADV).toEqual({ inFlight: 2, maxParallel: 4, reserve: 2 });
    expect(g.perProject.CTL).toEqual({ inFlight: 1, maxParallel: 3, reserve: 1 });
  });
  test("includes an in-flight project with no config entry", () => {
    const g = buildPerProjectGauge(new Set(["ZZZ-1"]), { CTL: { reserve: 1 } }, 0);
    expect(g.perProject.ZZZ).toEqual({ inFlight: 1 });
    expect(g.perProject.CTL).toEqual({ inFlight: 0, reserve: 1 });
  });
});
