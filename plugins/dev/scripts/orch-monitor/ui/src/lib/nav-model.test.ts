// nav-model.test.ts — units for the project-grouped nav model (CTL-930 / CTL-944).
// Pure logic, no DOM — run from the ui package:
//   cd ui && bun test src/lib/nav-model.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildNavGroups,
  breadcrumbFor,
  paletteEntries,
  projectWorkerCount,
  projectQueueDepth,
  type NavGroup,
} from "./nav-model";
import type { BoardPayload } from "../board/types";

const payload = (over: Partial<BoardPayload>): BoardPayload => ({
  generatedAt: "",
  config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
  repos: [],
  workers: [],
  tickets: [],
  queue: [],
  ...over,
});

const repoColors: Record<string, { text: string }> = {
  catalyst: { text: "#4ea1ff" },
  adva: { text: "#a98ee3" },
};

describe("nav-model — buildNavGroups", () => {
  it("returns an Overall group first, then per-repo groups, then Observe last", () => {
    const groups = buildNavGroups(["catalyst", "adva"], repoColors);
    expect(groups[0]?.scope).toBe("all");
    expect(groups[0]?.label).toBe("Overall");
    expect(groups.at(-1)?.scope).toBe("observe");
    // per-repo groups in the middle
    const repoGroups = groups.filter((g) => g.scope !== "all" && g.scope !== "observe");
    expect(repoGroups.map((g) => g.scope)).toEqual(["catalyst", "adva"]);
  });

  it("Overall group has exactly 4 items: Inbox, Tickets, Workers, Queue", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const overall = groups.find((g) => g.scope === "all")!;
    expect(overall.items.map((i) => i.target.surface)).toEqual([
      "home", "board", "workers", "queue",
    ]);
    expect(overall.items.map((i) => i.label)).toEqual([
      "Inbox", "Tickets", "Workers", "Queue",
    ]);
  });

  it("per-repo group has the same 4 items scoped to that repo", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const catGroup = groups.find((g) => g.scope === "catalyst")!;
    expect(catGroup).toBeDefined();
    expect(catGroup.label).toBe("catalyst");
    expect(catGroup.dotColor).toBe("#4ea1ff");
    expect(catGroup.items.every((i) => i.target.scope === "catalyst")).toBe(true);
    expect(catGroup.items.map((i) => i.target.surface)).toEqual([
      "home", "board", "workers", "queue",
    ]);
  });

  it("Observe group has Telemetry, Utilization, FinOps, Fleet Ops, DevOps", () => {
    const groups = buildNavGroups([], {});
    const observe = groups.find((g) => g.scope === "observe")!;
    expect(observe).toBeDefined();
    const labels = observe.items.map((i) => i.label);
    expect(labels).toContain("Telemetry");
    expect(labels).toContain("Utilization");
    expect(labels).toContain("FinOps");
    expect(labels).toContain("Fleet Ops");
    expect(labels).toContain("DevOps");
  });

  it("with no repos, only Overall and Observe groups", () => {
    const groups = buildNavGroups([], {});
    expect(groups.map((g) => g.scope)).toEqual(["all", "observe"]);
  });

  it("per-repo group with no color config has no dotColor", () => {
    const groups = buildNavGroups(["unknown-repo"], {});
    const grp = groups.find((g) => g.scope === "unknown-repo")!;
    expect(grp.dotColor).toBeUndefined();
  });
});

describe("nav-model — breadcrumbFor", () => {
  it("overall home → ['Overall', 'Inbox']", () => {
    expect(breadcrumbFor("home", "all")).toEqual(["Overall", "Inbox"]);
  });

  it("overall board → ['Overall', 'Tickets']", () => {
    expect(breadcrumbFor("board", "all")).toEqual(["Overall", "Tickets"]);
  });

  it("overall workers → ['Overall', 'Workers']", () => {
    expect(breadcrumbFor("workers", "all")).toEqual(["Overall", "Workers"]);
  });

  it("overall queue → ['Overall', 'Queue']", () => {
    expect(breadcrumbFor("queue", "all")).toEqual(["Overall", "Queue"]);
  });

  it("project board → ['catalyst', 'Tickets']", () => {
    expect(breadcrumbFor("board", "catalyst")).toEqual(["catalyst", "Tickets"]);
  });

  it("project queue → ['adva', 'Queue']", () => {
    expect(breadcrumbFor("queue", "adva")).toEqual(["adva", "Queue"]);
  });
});

describe("nav-model — paletteEntries", () => {
  it("returns entries for every group (not observe)", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const entries = paletteEntries(groups);
    // Should have Overall + catalyst entries (Observe skipped or included)
    expect(entries.length).toBeGreaterThan(0);
    // Overall group is first
    expect(entries[0]?.group).toBe("Overall");
    expect(entries[0]?.items.length).toBe(4);
  });

  it("each entry item has a target with surface and scope", () => {
    const groups = buildNavGroups(["catalyst"], repoColors);
    const entries = paletteEntries(groups);
    const overall = entries.find((e) => e.group === "Overall")!;
    for (const item of overall.items) {
      expect(item.target.surface).toBeDefined();
      expect(item.target.scope).toBe("all");
    }
  });
});

describe("nav-model — projectWorkerCount", () => {
  it("counts only active workers for the given repo", () => {
    const p = payload({
      workers: [
        { name: "w1", ticket: "CTL-1", tickets: ["CTL-1"], phase: "implement", status: "active", activeState: "active", working: true, lastActiveMs: null, repo: "catalyst", team: "CTL", runtimeMs: null, costUSD: null },
        { name: "w2", ticket: "CTL-2", tickets: ["CTL-2"], phase: "implement", status: "active", activeState: null, working: false, lastActiveMs: null, repo: "catalyst", team: "CTL", runtimeMs: null, costUSD: null },
        { name: "w3", ticket: "ADV-1", tickets: ["ADV-1"], phase: "implement", status: "active", activeState: "active", working: true, lastActiveMs: null, repo: "adva", team: "ADV", runtimeMs: null, costUSD: null },
      ],
    });
    expect(projectWorkerCount(p, "catalyst")).toBe(1);
    expect(projectWorkerCount(p, "adva")).toBe(1);
    expect(projectWorkerCount(p, "unknown")).toBe(0);
  });
});

describe("nav-model — projectQueueDepth", () => {
  it("counts queue items for the given repo", () => {
    const p = payload({
      queue: [
        { id: "CTL-1", ticket: "CTL-1", title: "t", repo: "catalyst", team: "CTL", priority: 2, estimate: null, scope: null, linearState: "Todo", type: "feature", rank: "a" } as unknown as BoardPayload["queue"][0],
        { id: "CTL-2", ticket: "CTL-2", title: "t", repo: "catalyst", team: "CTL", priority: 2, estimate: null, scope: null, linearState: "Todo", type: "feature", rank: "b" } as unknown as BoardPayload["queue"][0],
        { id: "ADV-1", ticket: "ADV-1", title: "t", repo: "adva", team: "ADV", priority: 2, estimate: null, scope: null, linearState: "Todo", type: "feature", rank: "c" } as unknown as BoardPayload["queue"][0],
      ],
    });
    expect(projectQueueDepth(p, "catalyst")).toBe(2);
    expect(projectQueueDepth(p, "adva")).toBe(1);
    expect(projectQueueDepth(p, "unknown")).toBe(0);
  });
});
