import { describe, expect, it } from "bun:test";
import {
  STATE_MAP_KEYS,
  buildProjectRailRows,
  mergeIconRepos,
  resolveSelectedProject,
  diffStateMap,
  SETTINGS_PENDING_SECTIONS,
  CLUSTER_SECTION_KEY,
  HOST_NODE_SECTION_KEY,
  resolveSettingsView,
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

describe("mergeIconRepos (CTL-1253)", () => {
  it("includes an idle configured project's repo absent from observed-work repos", () => {
    // The bug: observed-work repos (board snapshot) miss the idle ADV team's repo,
    // so its favicon candidates were never fetched and the Detected group stayed empty.
    const merged = mergeIconRepos(["ctl"], [{ repo: "ctl" }, { repo: "adva" }]);
    expect(merged).toContain("adva");
    expect(merged).toEqual(["ctl", "adva"]);
  });

  it("dedupes a repo present in BOTH sources", () => {
    expect(mergeIconRepos(["ctl"], [{ repo: "ctl" }])).toEqual(["ctl"]);
  });

  it("keeps observed-work repos first, then appends new roster repos", () => {
    const merged = mergeIconRepos(["ctl", "otl"], [{ repo: "adva" }, { repo: "ctl" }]);
    expect(merged).toEqual(["ctl", "otl", "adva"]);
  });

  it("returns the observed repos unchanged when the roster is empty", () => {
    expect(mergeIconRepos(["ctl"], [])).toEqual(["ctl"]);
  });

  it("returns roster repos when there is no observed work yet", () => {
    expect(mergeIconRepos([], [{ repo: "adva" }, { repo: "ctl" }])).toEqual(["adva", "ctl"]);
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

// ── CTL-1212: pending sections + resolveSettingsView ─────────────────────────

const projects = [{ key: "CTL", name: "Catalyst", defaultColor: "blue", hasWork: true }];

describe("SETTINGS_PENDING_SECTIONS", () => {
  it("defines Cluster and Host/Node with sentinel keys distinct from any team key", () => {
    const keys = SETTINGS_PENDING_SECTIONS.map((s) => s.key);
    expect(keys).toEqual([CLUSTER_SECTION_KEY, HOST_NODE_SECTION_KEY]);
    expect(CLUSTER_SECTION_KEY.startsWith("__")).toBe(true);
    expect(SETTINGS_PENDING_SECTIONS.find((s) => s.key === CLUSTER_SECTION_KEY)?.label).toBe("Cluster");
  });

  it("Host/Node section has a label and a note", () => {
    const section = SETTINGS_PENDING_SECTIONS.find((s) => s.key === HOST_NODE_SECTION_KEY);
    expect(section?.label).toBeTruthy();
    expect(section?.note).toBeTruthy();
  });
});

describe("resolveSettingsView", () => {
  it("returns kind:general for a null key", () => {
    expect(resolveSettingsView(projects, null).kind).toBe("general");
  });

  it("returns kind:general for undefined key", () => {
    expect(resolveSettingsView(projects, undefined).kind).toBe("general");
  });

  it("returns kind:project with the descriptor for a known team key", () => {
    const v = resolveSettingsView(projects, "CTL");
    expect(v.kind).toBe("project");
    if (v.kind === "project") expect(v.project.key).toBe("CTL");
  });

  it("returns kind:pending with the section for CLUSTER_SECTION_KEY", () => {
    const v = resolveSettingsView(projects, CLUSTER_SECTION_KEY);
    expect(v.kind).toBe("pending");
    if (v.kind === "pending") expect(v.section.label).toBe("Cluster");
  });

  it("returns kind:pending with the section for HOST_NODE_SECTION_KEY", () => {
    const v = resolveSettingsView(projects, HOST_NODE_SECTION_KEY);
    expect(v.kind).toBe("pending");
    if (v.kind === "pending") expect(v.section.label).toMatch(/Host/);
  });

  it("falls back to kind:general for an unknown key", () => {
    expect(resolveSettingsView(projects, "NOPE").kind).toBe("general");
  });
});
