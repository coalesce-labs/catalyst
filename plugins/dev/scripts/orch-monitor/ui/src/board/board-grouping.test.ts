// board-grouping.test.ts — units for the BOARD3 (CTL-907) row-swimlane grouping
// engine. Pure logic, no DOM — run from the ui package:
//   cd ui && bun test src/board/board-grouping.test.ts
//
// The THIRD member of the *-grouping.ts family (worker-grouping.test.ts /
// queue-grouping.test.ts), encoding the BOARD3 Gherkin scenarios that are testable
// without a renderer:
//   • "Swimlane by project" — one labeled lane per project; no-project → "Unassigned".
//   • "Swimlane by host-node shows what each node is working on" — group by
//     owner_host (host.id), one labeled lane per node, header shows node name +
//     (overlay) heartbeat liveness dot.
//   • "Single-node is an identity no-op" — one distinct host → exactly one lane.
//   • "Swimlanes = None" — one synthetic flat lane, no header.
//   • (implicit) by team, and the existing repo axis BOARD3 subsumes.
import { describe, it, expect } from "bun:test";
import type { BoardHostRef } from "./types";
import {
  buildLanes,
  groupKeyFor,
  showLaneChrome,
  singleLaneHint,
  UNASSIGNED,
  type GroupableEntity,
  type HostLiveness,
  type Lane,
} from "./board-grouping";

// host is the REAL shipped shape: BoardHostRef {name, id}. id is the dedup key.
const h = (name: string): BoardHostRef => ({ name, id: `id-${name}` });
const T = (over: Partial<GroupableEntity>): GroupableEntity => over;

describe("board-grouping — axis resolution", () => {
  it("groupBy=none yields exactly one synthetic lane holding all items, no header", () => {
    const lanes = buildLanes([T({ team: "CTL" }), T({ team: "ADV" })], "none");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.items).toHaveLength(2);
    expect(lanes[0]?.label).toBe(""); // no header
    expect(lanes[0]?.live).toBeNull();
    expect(lanes[0]?.key).toBe(UNASSIGNED);
  });

  it("groupBy=project groups by project; missing -> Unassigned lane sorted LAST", () => {
    const lanes = buildLanes([T({ project: "Zeta" }), T({}), T({ project: "Alpha" })], "project");
    expect(lanes.map((l) => l.label)).toEqual(["Alpha", "Zeta", "Unassigned"]);
    // each lane wraps its own items; the no-project ticket lands in Unassigned.
    expect(lanes.at(-1)?.items).toHaveLength(1);
  });

  it("groupBy=team groups by team prefix, alpha-sorted, case-insensitive; missing -> No team last", () => {
    const lanes = buildLanes([T({ team: "adv" }), T({ team: "CTL" }), T({})], "team");
    expect(lanes.map((l) => l.label)).toEqual(["adv", "CTL", "No team"]); // base-sensitivity sort, fallback last
  });

  it("groupBy=repo subsumes the existing repo-lanes axis (BOARD3 generalizes it)", () => {
    const lanes = buildLanes([T({ repo: "adva" }), T({ repo: "catalyst" }), T({})], "repo");
    expect(lanes.map((l) => l.label)).toEqual(["adva", "catalyst", "Unassigned"]);
  });
});

describe("board-grouping — host axis (attribution shipped; liveness via injected overlay)", () => {
  it("buckets by host.id, labels by host.name; fallback last; no overlay -> no dot", () => {
    const lanes = buildLanes(
      [
        T({ host: h("mac-studio") }),
        T({ host: h("mini") }),
        T({}), // host-less -> Unassigned fallback
      ],
      "host",
    );
    expect(lanes.map((l) => l.label)).toEqual(["mac-studio", "mini", "Unassigned"]); // alpha, fallback last
    expect(lanes.map((l) => l.live)).toEqual([null, null, null]); // no overlay -> no dot
  });

  it("with a liveness overlay, orders live -> degraded -> offline, fallback last", () => {
    const liveness: HostLiveness = {
      "id-mini": "live",
      "id-mac-studio": "offline",
      "id-air": "degraded",
    };
    const lanes = buildLanes(
      [T({ host: h("mac-studio") }), T({ host: h("mini") }), T({ host: h("air") }), T({})],
      "host",
      liveness,
    );
    expect(lanes.map((l) => l.label)).toEqual(["mini", "air", "mac-studio", "Unassigned"]);
    expect(lanes.map((l) => l.live)).toEqual(["live", "degraded", "offline", null]);
  });

  it("liveness overlay is ignored on non-host axes (no dot leaks onto team/project)", () => {
    const liveness: HostLiveness = { "id-mini": "live" };
    const lanes = buildLanes([T({ team: "CTL" }), T({ team: "ADV" })], "team", liveness);
    expect(lanes.every((l) => l.live === null)).toBe(true);
  });

  it("two names sharing one id collapse to ONE lane (queue-grouping dedup rule)", () => {
    const sameId: BoardHostRef = { name: "mini", id: "id-mini" };
    const aliased: BoardHostRef = { name: "mini.local", id: "id-mini" };
    const lanes = buildLanes([T({ host: sameId }), T({ host: aliased })], "host");
    expect(lanes).toHaveLength(1);
  });

  it("single distinct host -> ONE lane (identity no-op precondition)", () => {
    const lanes = buildLanes([T({ host: h("mini") }), T({ host: h("mini") })], "host");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.label).toBe("mini");
  });

  it("all hosts un-stamped (single-host TODAY) -> ONE Unassigned lane (identity no-op)", () => {
    const lanes = buildLanes([T({}), T({})], "host");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.label).toBe("Unassigned");
    expect(lanes[0]?.live).toBeNull();
  });
});

describe("board-grouping — invariants", () => {
  it("never emits an empty lane (only groups entities given)", () => {
    const lanes = buildLanes([T({ team: "A" })], "team");
    expect(lanes.every((l) => l.items.length > 0)).toBe(true);
  });

  it("UNASSIGNED sentinel cannot collide with a real value", () => {
    // a real team literally named "Unassigned"/"unassigned" is its own lane — the
    // bracketed reserved sentinel is distinct from any human-facing label.
    expect(groupKeyFor(T({ team: "Unassigned" }), "team")).not.toBe(UNASSIGNED);
    expect(groupKeyFor(T({ team: "unassigned" }), "team")).not.toBe(UNASSIGNED);
  });

  it("empty input on a real axis yields zero lanes (nothing to group)", () => {
    expect(buildLanes([], "host")).toEqual([]);
    expect(buildLanes([], "team")).toEqual([]);
  });

  it("none-axis on empty input still yields the single synthetic lane (flat board)", () => {
    const lanes = buildLanes([], "none");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.items).toHaveLength(0);
  });

  it("preserves entity intra-lane order (stable bucketing)", () => {
    const a = T({ team: "X", project: "first" });
    const b = T({ team: "X", project: "second" });
    const lanes = buildLanes([a, b], "team");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.items).toEqual([a, b]);
  });
});

// ── Phase 3 — showLaneChrome ─────────────────────────────────────────────────

describe("showLaneChrome — lane-chrome policy", () => {
  it("(none, 5) → false — identity no-op always suppresses chrome", () => {
    expect(showLaneChrome("none", 5)).toBe(false);
  });

  it("(team, 1) → true — THE regression lock: explicit axis always shows chrome even for 1 lane", () => {
    expect(showLaneChrome("team", 1)).toBe(true);
  });

  it("(host, 1) → true — single host lane gets chrome", () => {
    expect(showLaneChrome("host", 1)).toBe(true);
  });

  it("(repo, 1) → true — single repo lane gets chrome", () => {
    expect(showLaneChrome("repo", 1)).toBe(true);
  });

  it("(project, 3) → true — multiple lanes with explicit axis", () => {
    expect(showLaneChrome("project", 3)).toBe(true);
  });

  it("(team, 0) → false — zero lanes means nothing to decorate", () => {
    expect(showLaneChrome("team", 0)).toBe(false);
  });

  it("(none, 1) → false — none axis never shows chrome", () => {
    expect(showLaneChrome("none", 1)).toBe(false);
  });
});

// ── CTL-1012 — lane.repo (the team→repo icon/name bridge) ─────────────────────

describe("board-grouping — lane.repo (CTL-1012 team→repo bridge)", () => {
  it("a TEAM lane carries its first member's repo (the icon/name bridge)", () => {
    // Team "ADV" entities all live in repo "adva" — the lane surfaces that repo so
    // the header can resolve the project icon + brand name from the team axis.
    const lanes = buildLanes(
      [T({ team: "ADV", repo: "adva" }), T({ team: "ADV", repo: "adva" })],
      "team",
    );
    expect(lanes[0]?.label).toBe("ADV");
    expect(lanes[0]?.repo).toBe("adva");
  });

  it("a REPO lane carries its repo (== its key)", () => {
    const lanes = buildLanes([T({ repo: "catalyst" })], "repo");
    expect(lanes[0]?.repo).toBe("catalyst");
  });

  it("a lane whose first member has no repo carries repo=null (fail-open)", () => {
    const lanes = buildLanes([T({ team: "CTL" })], "team");
    expect(lanes[0]?.repo).toBeNull();
  });

  it("the synthetic none lane carries the first item's repo", () => {
    expect(buildLanes([T({ repo: "adva" })], "none")[0]?.repo).toBe("adva");
    expect(buildLanes([], "none")[0]?.repo).toBeNull();
  });
});

// ── Phase 3 — singleLaneHint ─────────────────────────────────────────────────

const makeLane = (label: string, count: number): Lane<unknown> => ({
  key: label === "Unassigned" || label === "No team" ? UNASSIGNED : label,
  label,
  live: null,
  repo: null,
  items: Array.from({ length: count }, () => ({})),
});

describe("singleLaneHint — single-lane hint text", () => {
  it("returns null for axis=none", () => {
    expect(singleLaneHint("none", makeLane("", 3), "ticket")).toBeNull();
  });

  it("team axis, 3 tickets → 'All 3 tickets are in team CTL'", () => {
    expect(singleLaneHint("team", makeLane("CTL", 3), "ticket")).toBe(
      "All 3 tickets are in team CTL",
    );
  });

  it("team axis, count=1 → 'The only ticket here is in team CTL'", () => {
    expect(singleLaneHint("team", makeLane("CTL", 1), "ticket")).toBe(
      "The only ticket here is in team CTL",
    );
  });

  it("team UNASSIGNED → 'All 3 tickets have no team'", () => {
    const lane = makeLane("No team", 3);
    // key must be UNASSIGNED sentinel
    expect(singleLaneHint("team", lane, "ticket")).toBe(
      "All 3 tickets have no team",
    );
  });

  it("host axis, 2 workers → 'All 2 workers are on host mini'", () => {
    expect(singleLaneHint("host", makeLane("mini", 2), "worker")).toBe(
      "All 2 workers are on host mini",
    );
  });

  it("host UNASSIGNED → \"All 3 workers aren't attributed to a host yet\"", () => {
    const lane = makeLane("Unassigned", 3);
    expect(singleLaneHint("host", lane, "worker")).toBe(
      "All 3 workers aren't attributed to a host yet",
    );
  });

  it("project axis, UNASSIGNED → 'All 2 tickets have no project'", () => {
    const lane = makeLane("Unassigned", 2);
    expect(singleLaneHint("project", lane, "ticket")).toBe(
      "All 2 tickets have no project",
    );
  });

  it("repo axis, 4 tickets → 'All 4 tickets are in repo catalyst'", () => {
    expect(singleLaneHint("repo", makeLane("catalyst", 4), "ticket")).toBe(
      "All 4 tickets are in repo catalyst",
    );
  });
});
