import { describe, expect, it } from "bun:test";
import {
  STATE_MAP_KEYS,
  buildProjectRailRows,
  resolveSelectedProject,
  diffStateMap,
} from "./project-settings-model";

describe("STATE_MAP_KEYS", () => {
  it("pins the canonical 12-key contract", () => {
    expect(STATE_MAP_KEYS).toEqual([
      "backlog", "todo", "triage", "research", "planning", "inProgress",
      "verifying", "reviewing", "remediating", "inReview", "done", "canceled",
    ]);
  });
  it("has exactly 12 keys", () => {
    expect(STATE_MAP_KEYS).toHaveLength(12);
  });
});

describe("buildProjectRailRows", () => {
  const projects = [
    { key: "CTL", name: "Catalyst", defaultColor: "blue", hasWork: true },
    { key: "ADV", name: "Adva", defaultColor: null, hasWork: false },
  ];

  it("maps label from project.name", () => {
    const rows = buildProjectRailRows(projects);
    expect(rows[0].label).toBe("Catalyst");
    expect(rows[1].label).toBe("Adva");
  });

  it("maps dotColorName from project.defaultColor", () => {
    const rows = buildProjectRailRows(projects);
    expect(rows[0].dotColorName).toBe("blue");
    expect(rows[1].dotColorName).toBeNull();
  });

  it("passes hasWork through unchanged", () => {
    const rows = buildProjectRailRows(projects);
    expect(rows[0].hasWork).toBe(true);
    expect(rows[1].hasWork).toBe(false);
  });

  it("sets key from project.key", () => {
    const rows = buildProjectRailRows(projects);
    expect(rows[0].key).toBe("CTL");
  });

  it("returns empty array for empty projects", () => {
    expect(buildProjectRailRows([])).toEqual([]);
  });
});

describe("resolveSelectedProject", () => {
  const projects = [
    { key: "CTL" },
    { key: "ADV" },
  ];

  it("returns matching descriptor by key", () => {
    expect(resolveSelectedProject(projects, "CTL")).toEqual({ key: "CTL" });
    expect(resolveSelectedProject(projects, "ADV")).toEqual({ key: "ADV" });
  });

  it("returns null for an unknown key", () => {
    expect(resolveSelectedProject(projects, "BOGUS")).toBeNull();
  });

  it("returns null for undefined key", () => {
    expect(resolveSelectedProject(projects, undefined)).toBeNull();
  });

  it("returns null for null key", () => {
    expect(resolveSelectedProject(projects, null)).toBeNull();
  });

  it("returns null for empty string key", () => {
    expect(resolveSelectedProject(projects, "")).toBeNull();
  });
});

describe("diffStateMap", () => {
  it("returns only changed, non-empty keys", () => {
    const diff = diffStateMap({ inReview: "In Review" }, { inReview: "Code Review", done: "Closed" });
    expect(diff).toEqual({ inReview: "Code Review", done: "Closed" });
  });

  it("omits keys whose value is unchanged", () => {
    const diff = diffStateMap({ inReview: "In Review" }, { inReview: "In Review" });
    expect(diff).toEqual({});
  });

  it("omits empty-string keys (inherit global)", () => {
    const diff = diffStateMap({ inReview: "In Review" }, { inReview: "" });
    expect(diff).toEqual({});
  });

  it("handles a null current stateMap (all are new)", () => {
    const diff = diffStateMap(null, { inReview: "Custom" });
    expect(diff).toEqual({ inReview: "Custom" });
  });

  it("ignores keys not in STATE_MAP_KEYS", () => {
    const diff = diffStateMap(null, { inReview: "X", unknownKey: "Y" } as Record<string, string>);
    expect("unknownKey" in diff).toBe(false);
    expect(diff.inReview).toBe("X");
  });
});
