import { describe, it, expect } from "bun:test";
import { resolveEntityIcon, liveBadgeKind, groupIconSrc } from "./entity-icon";
import type { RepoIconMap } from "@/hooks/use-repo-icons";

const ICONS: RepoIconMap = {
  catalyst: { autoDataUrl: "data:image/png;base64,AAA", override: null, candidates: [], selectedPath: null },
  adva: { autoDataUrl: null, override: null, candidates: [], selectedPath: null },
};

describe("resolveEntityIcon", () => {
  it("returns the autoDataUrl when the repo has one", () => {
    expect(resolveEntityIcon("catalyst", ICONS)).toBe("data:image/png;base64,AAA");
  });
  it("returns null when the repo's autoDataUrl is null", () => {
    expect(resolveEntityIcon("adva", ICONS)).toBeNull();
  });
  it("returns null for an unknown repo", () => {
    expect(resolveEntityIcon("ghost", ICONS)).toBeNull();
  });
  it("returns null for null/undefined/empty repo (fail-open)", () => {
    expect(resolveEntityIcon(null, ICONS)).toBeNull();
    expect(resolveEntityIcon(undefined, ICONS)).toBeNull();
    expect(resolveEntityIcon("", ICONS)).toBeNull();
  });
  it("returns null for an empty icon map", () => {
    expect(resolveEntityIcon("catalyst", {})).toBeNull();
  });
});

describe("liveBadgeKind", () => {
  it("maps active → live", () => expect(liveBadgeKind("active")).toBe("live"));
  it("maps stuck → stuck", () => expect(liveBadgeKind("stuck")).toBe("stuck"));
  it("maps dead → null (no badge)", () => expect(liveBadgeKind("dead")).toBeNull());
  it("maps null → null (no badge)", () => expect(liveBadgeKind(null)).toBeNull());
});

describe("groupIconSrc", () => {
  it("resolves an icon ONLY on the repo axis", () => {
    expect(groupIconSrc("repo", "catalyst", ICONS)).toBe("data:image/png;base64,AAA");
  });
  it("returns null on team/project/host/none axes", () => {
    for (const axis of ["team", "project", "host", "none"] as const) {
      expect(groupIconSrc(axis, "catalyst", ICONS)).toBeNull();
    }
  });
  it("returns null on repo axis when the repo has no favicon", () => {
    expect(groupIconSrc("repo", "adva", ICONS)).toBeNull();
  });
});

describe("EntityMarker decision (pure inputs)", () => {
  const MARKER_ICONS: RepoIconMap = { catalyst: { autoDataUrl: "data:x", override: null, candidates: [], selectedPath: null } };
  it("icon present → render icon, badge follows liveBadgeKind", () => {
    expect(resolveEntityIcon("catalyst", MARKER_ICONS)).toBe("data:x");
    expect(liveBadgeKind("active")).toBe("live");
    expect(liveBadgeKind("stuck")).toBe("stuck");
    expect(liveBadgeKind(null)).toBeNull();
  });
  it("no icon → resolveEntityIcon null ⇒ component falls back to ActivityDot", () => {
    expect(resolveEntityIcon("catalyst", {})).toBeNull();
  });
});

describe("groupIconSrc axis gating (regression guard)", () => {
  const GATE_ICONS: RepoIconMap = { catalyst: { autoDataUrl: "data:x", override: null, candidates: [], selectedPath: null } };
  it("repo axis with favicon → src", () => expect(groupIconSrc("repo", "catalyst", GATE_ICONS)).toBe("data:x"));
  it("every non-repo axis → null", () => {
    (["none", "team", "project", "host"] as const).forEach((a) =>
      expect(groupIconSrc(a, "catalyst", GATE_ICONS)).toBeNull());
  });
  it("repo axis, null key → null", () => expect(groupIconSrc("repo", null, GATE_ICONS)).toBeNull());
});
