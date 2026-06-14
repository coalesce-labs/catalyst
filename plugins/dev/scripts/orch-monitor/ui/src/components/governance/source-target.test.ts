// source-target.test.ts — CTL-1100 Phase 6

import { describe, it, expect } from "bun:test";
import {
  resolveRuleSource,
  resolveEdgeSource,
  type RuleManifest,
  type FsmDescriptorLike,
} from "./source-target";

const manifest: RuleManifest = {
  rules: [
    { rule_id: "R1", name: "session_registered", datalog: "R1 datalog text", sql: "SELECT 1", guardText: null },
    { rule_id: "R2", name: "session_active", datalog: "R2 datalog", sql: null, guardText: "some guard" },
  ],
};

const descriptor: FsmDescriptorLike = {
  transitions: [
    { from: "implement", to: "verify", kind: "advance", guardText: null, datalog: null, sourceRef: null },
    { from: "verify", to: "remediate", kind: "detour", guardText: "fail verdict", datalog: "detour logic", sourceRef: null },
  ],
};

describe("resolveRuleSource", () => {
  it("returns datalog + sql for known rule_id", () => {
    const info = resolveRuleSource(manifest, { kind: "rule", rule_id: "R1" });
    expect(info).not.toBeNull();
    expect(info?.datalog).toBe("R1 datalog text");
    expect(info?.sql).toBe("SELECT 1");
    expect(info?.guardText).toBeNull();
  });

  it("returns guardText when present", () => {
    const info = resolveRuleSource(manifest, { kind: "rule", rule_id: "R2" });
    expect(info?.guardText).toBe("some guard");
  });

  it("returns null for unknown rule_id (no throw)", () => {
    expect(resolveRuleSource(manifest, { kind: "rule", rule_id: "R999" })).toBeNull();
  });
});

describe("resolveEdgeSource", () => {
  it("resolves a known from→to edge", () => {
    const info = resolveEdgeSource(descriptor, { kind: "edge", from: "verify", to: "remediate" });
    expect(info.guardText).toBe("fail verdict");
    expect(info.datalog).toBe("detour logic");
  });

  it("returns empty SourceInfo when edge not found (no throw)", () => {
    const info = resolveEdgeSource(descriptor, { kind: "edge", from: "plan", to: "teardown" });
    expect(info.guardText).toBeNull();
    expect(info.datalog).toBeNull();
    expect(info.sql).toBeNull();
  });
});
