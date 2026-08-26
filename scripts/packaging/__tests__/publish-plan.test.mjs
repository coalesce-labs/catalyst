// publish-plan.test.mjs — CTL-2215 Phase 3.
//
// Run: bun test scripts/packaging/__tests__/publish-plan.test.mjs

import { describe, test, expect } from "bun:test";

import { planSkillsPublish, renderPublishSummary } from "../publish/plan-publish.mjs";

function tree(entries) {
  return new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v, "utf8")]));
}

describe("planSkillsPublish — identical trees", () => {
  test("byte-identical current and published trees → no-change", () => {
    const currentFiles = tree({ "a/SKILL.md": "one", "b/SKILL.md": "two" });
    const publishedFiles = tree({ "a/SKILL.md": "one", "b/SKILL.md": "two" });
    expect(planSkillsPublish({ currentFiles, publishedFiles })).toEqual({ action: "no-change" });
  });
});

describe("planSkillsPublish — added, removed, changed, each populated and asserted by name", () => {
  test("an added file (present only in current) is reported in added", () => {
    const currentFiles = tree({ "a/SKILL.md": "one", "new/SKILL.md": "brand new" });
    const publishedFiles = tree({ "a/SKILL.md": "one" });
    const plan = planSkillsPublish({ currentFiles, publishedFiles });
    expect(plan).toEqual({ action: "publish", added: ["new/SKILL.md"], removed: [], changed: [] });
  });

  test("a removed file (present only in published) is reported in removed — the publish is a REPLACE, not a merge", () => {
    const currentFiles = tree({ "a/SKILL.md": "one" });
    const publishedFiles = tree({ "a/SKILL.md": "one", "gone/SKILL.md": "a de-classified skill" });
    const plan = planSkillsPublish({ currentFiles, publishedFiles });
    expect(plan).toEqual({ action: "publish", added: [], removed: ["gone/SKILL.md"], changed: [] });
  });

  test("a changed file (same path, different bytes) is reported in changed", () => {
    const currentFiles = tree({ "a/SKILL.md": "new body" });
    const publishedFiles = tree({ "a/SKILL.md": "old body" });
    const plan = planSkillsPublish({ currentFiles, publishedFiles });
    expect(plan).toEqual({ action: "publish", added: [], removed: [], changed: ["a/SKILL.md"] });
  });

  test("a mix of all three in one plan, each list independently correct", () => {
    const currentFiles = tree({ "keep/SKILL.md": "same", "changed/SKILL.md": "v2", "new/SKILL.md": "brand new" });
    const publishedFiles = tree({ "keep/SKILL.md": "same", "changed/SKILL.md": "v1", "gone/SKILL.md": "stale" });
    const plan = planSkillsPublish({ currentFiles, publishedFiles });
    expect(plan).toEqual({ action: "publish", added: ["new/SKILL.md"], removed: ["gone/SKILL.md"], changed: ["changed/SKILL.md"] });
  });
});

describe("planSkillsPublish — an unreadable published tree", () => {
  test("published tree is null → inconclusive, never no-change", () => {
    const currentFiles = tree({ "a/SKILL.md": "one" });
    const plan = planSkillsPublish({ currentFiles, publishedFiles: null });
    expect(plan.action).toBe("inconclusive");
    expect(plan.reason).toMatch(/published tree/);
  });

  test("current tree is null → inconclusive, never no-change", () => {
    const publishedFiles = tree({ "a/SKILL.md": "one" });
    const plan = planSkillsPublish({ currentFiles: null, publishedFiles });
    expect(plan.action).toBe("inconclusive");
    expect(plan.reason).toMatch(/regenerated tree/);
  });

  test("a non-Map, non-null value for either side → inconclusive", () => {
    const plan = planSkillsPublish({ currentFiles: "not a map", publishedFiles: new Map() });
    expect(plan.action).toBe("inconclusive");
  });
});

describe("positive control — a fixture pair differing by exactly one byte in one file", () => {
  test("produces action: publish with that one file named, proving the comparator detects a real change", () => {
    const currentFiles = tree({ "x/SKILL.md": "hello worldX", "y/SKILL.md": "unchanged" });
    const publishedFiles = tree({ "x/SKILL.md": "hello world0", "y/SKILL.md": "unchanged" });
    const plan = planSkillsPublish({ currentFiles, publishedFiles });
    expect(plan.action).toBe("publish");
    expect(plan.changed).toEqual(["x/SKILL.md"]);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
  });
});

describe("renderPublishSummary", () => {
  test("no-change renders a legible one-liner", () => {
    expect(renderPublishSummary({ action: "no-change" })).toMatch(/^no-change/);
  });

  test("inconclusive renders the reason", () => {
    expect(renderPublishSummary({ action: "inconclusive", reason: "clone failed" })).toBe("inconclusive — clone failed");
  });

  test("publish renders counts for each non-empty bucket", () => {
    const summary = renderPublishSummary({ action: "publish", added: ["a"], removed: [], changed: ["b", "c"] });
    expect(summary).toContain("1 added");
    expect(summary).toContain("2 changed");
    expect(summary).not.toContain("removed");
  });
});
