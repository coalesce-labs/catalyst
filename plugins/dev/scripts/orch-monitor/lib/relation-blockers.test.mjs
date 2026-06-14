// relation-blockers.test.mjs — unit tests for projecting Linear relations into
// the dep-graph's per-ticket blockers[] (CTL-1020).

import { describe, it, expect } from "bun:test";
import {
  normRelation,
  relationEntries,
  buildBlockerMapFromRelations,
  mergeBlockers,
} from "./relation-blockers.mjs";

describe("normRelation", () => {
  it("reads { type, id } (ticket_state shape)", () => {
    expect(normRelation({ type: "blocks", id: "CTL-780" })).toEqual({ type: "blocks", id: "CTL-780" });
  });
  it("reads identifier when id is absent", () => {
    expect(normRelation({ type: "blocked_by", identifier: "CTL-1" })).toEqual({ type: "blocked_by", id: "CTL-1" });
  });
  it("reads relatedIssue.identifier (eligible node shape)", () => {
    expect(normRelation({ type: "blocked_by", relatedIssue: { identifier: "CTL-9" } })).toEqual({
      type: "blocked_by",
      id: "CTL-9",
    });
  });
  it("defaults missing type to related", () => {
    expect(normRelation({ id: "CTL-2" })).toEqual({ type: "related", id: "CTL-2" });
  });
  it("returns null for an entry with no resolvable id", () => {
    expect(normRelation({ type: "blocks" })).toBeNull();
    expect(normRelation(null)).toBeNull();
    expect(normRelation("nope")).toBeNull();
  });
});

describe("relationEntries", () => {
  it("returns an array as-is", () => {
    const arr = [{ type: "blocks", id: "A" }];
    expect(relationEntries(arr)).toBe(arr);
  });
  it("unwraps the {nodes:[...]} eligible shape", () => {
    expect(relationEntries({ nodes: [{ type: "blocks", id: "A" }] })).toEqual([{ type: "blocks", id: "A" }]);
  });
  it("returns [] for null / garbage", () => {
    expect(relationEntries(null)).toEqual([]);
    expect(relationEntries(undefined)).toEqual([]);
    expect(relationEntries(42)).toEqual([]);
  });
});

describe("buildBlockerMapFromRelations", () => {
  it("projects a blocked_by relation into the blocked ticket's blockers", () => {
    // CTL-2 is blocked_by CTL-1 ⇒ CTL-1 is a blocker of CTL-2
    const linfo = { "CTL-2": { relations: [{ type: "blocked_by", id: "CTL-1" }] } };
    const m = buildBlockerMapFromRelations(linfo);
    expect([...(m.get("CTL-2") ?? [])]).toEqual(["CTL-1"]);
  });

  it("projects a blocks relation onto the OTHER ticket (inverse direction)", () => {
    // CTL-1 blocks CTL-2 ⇒ CTL-1 is a blocker of CTL-2, recorded under CTL-2
    const linfo = { "CTL-1": { relations: [{ type: "blocks", id: "CTL-2" }] } };
    const m = buildBlockerMapFromRelations(linfo);
    expect([...(m.get("CTL-2") ?? [])]).toEqual(["CTL-1"]);
    expect(m.has("CTL-1")).toBe(false); // CTL-1 itself gains no blocker
  });

  it("captures the edge regardless of which side declared the relation (dedup)", () => {
    // both sides declare the same blocking edge — must collapse to ONE blocker
    const linfo = {
      "CTL-1": { relations: [{ type: "blocks", id: "CTL-2" }] },
      "CTL-2": { relations: [{ type: "blocked_by", id: "CTL-1" }] },
    };
    const m = buildBlockerMapFromRelations(linfo);
    expect([...(m.get("CTL-2") ?? [])]).toEqual(["CTL-1"]);
  });

  it("ignores related / duplicate (non-dependency) relations", () => {
    const linfo = {
      "CTL-3": { relations: [{ type: "related", id: "CTL-4" }, { type: "duplicate", id: "CTL-5" }] },
    };
    const m = buildBlockerMapFromRelations(linfo);
    expect(m.size).toBe(0);
  });

  it("handles the eligible {nodes:[{type, relatedIssue}]} shape", () => {
    const linfo = {
      "CTL-7": { relations: { nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-6" } }] } },
    };
    const m = buildBlockerMapFromRelations(linfo);
    expect([...(m.get("CTL-7") ?? [])]).toEqual(["CTL-6"]);
  });

  it("skips self-edges and tolerates null relations / empty linfo", () => {
    expect(buildBlockerMapFromRelations({}).size).toBe(0);
    expect(buildBlockerMapFromRelations(null).size).toBe(0);
    const linfo = {
      "CTL-1": { relations: [{ type: "blocks", id: "CTL-1" }] }, // self-edge
      "CTL-2": { relations: null },
      "CTL-3": {},
    };
    expect(buildBlockerMapFromRelations(linfo).size).toBe(0);
  });
});

describe("mergeBlockers", () => {
  it("unions triage + relation blockers, triage first, deduped", () => {
    expect(mergeBlockers(["A", "B"], new Set(["B", "C"]))).toEqual(["A", "B", "C"]);
  });
  it("accepts a relation array as well as a Set", () => {
    expect(mergeBlockers(["A"], ["B"])).toEqual(["A", "B"]);
  });
  it("returns triage blockers untouched when no relation blockers", () => {
    expect(mergeBlockers(["A"], undefined)).toEqual(["A"]);
  });
  it("returns relation blockers when no triage blockers", () => {
    expect(mergeBlockers([], new Set(["X"]))).toEqual(["X"]);
  });
  it("returns [] when both are empty / nullish", () => {
    expect(mergeBlockers(undefined, undefined)).toEqual([]);
    expect(mergeBlockers([], new Set())).toEqual([]);
  });
  it("drops empty/nullish ids and stringifies", () => {
    expect(mergeBlockers(["", "A", null], new Set([""]))).toEqual(["A"]);
  });
});
