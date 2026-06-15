// use-resolved-repo-colors.test.ts — CTL-1153 (M2): unit tests for resolveRepoColorMap.
// Imports from lib/repo-color-map (pure, no React); the hook re-exports for callers.
import { describe, expect, it } from "bun:test";
import { resolveRepoColorMap } from "@/lib/repo-color-map";
import { NAMED_COLORS } from "@/lib/color-palette";

const projects = (entries: Array<{ repo: string; defaultColor: string | null }>) => entries;

describe("resolveRepoColorMap", () => {
  it("returns an empty map for an empty project list", () => {
    expect(resolveRepoColorMap(projects([]), {})).toEqual({});
  });

  it("maps a project's server defaultColor to a RepoColor entry", () => {
    const result = resolveRepoColorMap(projects([{ repo: "catalyst", defaultColor: "blue" }]), {});
    expect(result["catalyst"]).toEqual(NAMED_COLORS["blue"]);
  });

  it("prefers a valid localStorage pick over the server defaultColor", () => {
    const result = resolveRepoColorMap(
      projects([{ repo: "catalyst", defaultColor: "blue" }]),
      { catalyst: "purple" },
    );
    expect(result["catalyst"]).toEqual(NAMED_COLORS["purple"]);
  });

  it("ignores a stale/unknown localStorage pick and falls back to server default", () => {
    const result = resolveRepoColorMap(
      projects([{ repo: "catalyst", defaultColor: "blue" }]),
      { catalyst: "chartreuse" },
    );
    expect(result["catalyst"]).toEqual(NAMED_COLORS["blue"]);
  });

  it("omits a project entry when neither pick nor defaultColor resolves", () => {
    const result = resolveRepoColorMap(
      projects([{ repo: "catalyst", defaultColor: null }]),
      {},
    );
    expect("catalyst" in result).toBe(false);
  });

  it("handles multiple projects independently", () => {
    const result = resolveRepoColorMap(
      projects([
        { repo: "catalyst", defaultColor: "blue" },
        { repo: "adva", defaultColor: "purple" },
        { repo: "ghost", defaultColor: null },
      ]),
      { adva: "green" },
    );
    expect(result["catalyst"]).toEqual(NAMED_COLORS["blue"]);
    expect(result["adva"]).toEqual(NAMED_COLORS["green"]);
    expect("ghost" in result).toBe(false);
  });

  it("is keyed by short repo name (not owner/repo)", () => {
    const result = resolveRepoColorMap(
      projects([{ repo: "catalyst", defaultColor: "teal" }]),
      {},
    );
    expect("catalyst" in result).toBe(true);
    expect("coalesce-labs/catalyst" in result).toBe(false);
  });
});
