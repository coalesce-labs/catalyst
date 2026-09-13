// vendor.test.mjs — CTL-2306 Phase 2: one source, generated copies.
//
// Run: bun test scripts/packaging/__tests__/vendor.test.mjs
//
// A skill that must run on any harness carries every script and subagent prompt
// it uses inside its own directory. A file two skills share keeps ONE source under
// plugins/dev/ and each skill lists it in `agents/vendor.yaml`; the packaging CLI
// writes byte-identical copies and the drift gate fails when a copy disagrees.
// These tests pin the pure half (core/vendor.mjs): the destination rule, the
// manifest shape, and the write/drift plan.

import { describe, test, expect } from "bun:test";

import { vendorDestination, validateVendorManifest, planVendoredCopies } from "../core/vendor.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

describe("vendorDestination", () => {
  test("a script keeps its path under the skill's scripts/", () => {
    expect(vendorDestination("scripts/lib/draft-pr.sh")).toBe("scripts/lib/draft-pr.sh");
    expect(vendorDestination("scripts/add-finding.sh")).toBe("scripts/add-finding.sh");
  });

  test("a subagent prompt lands under assets/agents/", () => {
    expect(vendorDestination("agents/codebase-locator.md")).toBe("assets/agents/codebase-locator.md");
  });

  test("anything outside scripts/ and agents/*.md is refused, naming the path", () => {
    expect(() => vendorDestination("templates/CLAUDE_SNIPPET.md")).toThrow(/templates\/CLAUDE_SNIPPET\.md/);
    expect(() => vendorDestination("agents/nested/x.md")).toThrow(/agents\/nested\/x\.md/);
    expect(() => vendorDestination("scripts/../hooks.toml")).toThrow(/\.\./);
    expect(() => vendorDestination("/etc/passwd")).toThrow();
    expect(() => vendorDestination("scripts/")).toThrow();
  });
});

describe("validateVendorManifest", () => {
  test("accepts { files: [...] } of unique, valid sources", () => {
    expect(validateVendorManifest({ files: ["scripts/a.sh", "agents/b.md"] }, "x/vendor.yaml")).toEqual({
      files: ["scripts/a.sh", "agents/b.md"],
    });
  });

  test("refuses a missing, empty, duplicated or unknown-keyed manifest, naming the file", () => {
    expect(() => validateVendorManifest(null, "x/vendor.yaml")).toThrow(/x\/vendor\.yaml/);
    expect(() => validateVendorManifest({ files: [] }, "x/vendor.yaml")).toThrow(/empty/);
    expect(() => validateVendorManifest({ files: ["scripts/a.sh", "scripts/a.sh"] }, "x/vendor.yaml")).toThrow(/duplicate/);
    expect(() => validateVendorManifest({ files: ["scripts/a.sh"], extra: 1 }, "x/vendor.yaml")).toThrow(/extra/);
    expect(() => validateVendorManifest({ files: [7] }, "x/vendor.yaml")).toThrow(/string/);
  });
});

describe("planVendoredCopies", () => {
  const entry = (overrides) => ({
    skillId: "implement-plan",
    files: ["scripts/lib/draft-pr.sh"],
    sources: { "scripts/lib/draft-pr.sh": { base64: b64("echo source\n"), mode: 0o755 } },
    current: {},
    ...overrides,
  });

  test("a missing copy is a write AND a drift entry", () => {
    const plan = planVendoredCopies([entry()]);
    expect(plan.errors).toEqual([]);
    expect(plan.writes).toEqual([
      { skillId: "implement-plan", from: "scripts/lib/draft-pr.sh", to: "scripts/lib/draft-pr.sh", base64: b64("echo source\n"), mode: 0o755 },
    ]);
    expect(plan.drift).toEqual([{ skillId: "implement-plan", from: "scripts/lib/draft-pr.sh", to: "scripts/lib/draft-pr.sh", reason: "missing" }]);
  });

  test("a byte-identical copy is neither a write nor drift", () => {
    const plan = planVendoredCopies([entry({ current: { "scripts/lib/draft-pr.sh": { base64: b64("echo source\n") } } })]);
    expect(plan.writes).toEqual([]);
    expect(plan.drift).toEqual([]);
  });

  test("an edited copy is drift with reason 'differs' — the copy never wins over the source", () => {
    const plan = planVendoredCopies([entry({ current: { "scripts/lib/draft-pr.sh": { base64: b64("echo edited\n") } } })]);
    expect(plan.drift.map((d) => d.reason)).toEqual(["differs"]);
    expect(plan.writes[0].base64).toBe(b64("echo source\n"));
  });

  test("a listed source that does not exist is an error, never a silent skip", () => {
    const plan = planVendoredCopies([entry({ sources: { "scripts/lib/draft-pr.sh": null } })]);
    expect(plan.errors).toEqual([{ skillId: "implement-plan", from: "scripts/lib/draft-pr.sh", reason: "source-missing" }]);
    expect(plan.writes).toEqual([]);
  });

  test("an empty input set plans nothing and says so (no vacuous pass for callers that assert coverage)", () => {
    const plan = planVendoredCopies([]);
    expect(plan).toEqual({ writes: [], drift: [], errors: [], skillCount: 0 });
  });
});
