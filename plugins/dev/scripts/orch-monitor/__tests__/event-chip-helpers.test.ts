import { describe, it, expect } from "bun:test";
import {
  repoBasename,
  stripRefPrefix,
} from "../lib/event-chip-helpers";

describe("repoBasename", () => {
  it("extracts basename from org/repo format", () => {
    expect(repoBasename("coalesce-labs/catalyst")).toBe("catalyst");
  });

  it("returns the name as-is when no slash", () => {
    expect(repoBasename("catalyst")).toBe("catalyst");
  });

  it("handles nested paths by returning last segment", () => {
    expect(repoBasename("a/b/c")).toBe("c");
  });

  it("handles empty string", () => {
    expect(repoBasename("")).toBe("");
  });
});

describe("stripRefPrefix", () => {
  it("strips refs/heads/ prefix", () => {
    expect(stripRefPrefix("refs/heads/main")).toBe("main");
  });

  it("strips refs/heads/ from branch names with slashes", () => {
    expect(stripRefPrefix("refs/heads/CTL-270")).toBe("CTL-270");
  });

  it("strips refs/tags/ prefix", () => {
    expect(stripRefPrefix("refs/tags/v1.0.0")).toBe("v1.0.0");
  });

  it("returns bare branch name unchanged", () => {
    expect(stripRefPrefix("main")).toBe("main");
  });

  it("returns the ref unchanged when no known prefix", () => {
    expect(stripRefPrefix("refs/remotes/origin/main")).toBe(
      "refs/remotes/origin/main",
    );
  });
});
