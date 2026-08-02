import { describe, test, expect } from "bun:test";
import { RESOLVE_CONFLICT_SWEEP_EVENT_TYPES } from "./resolve-conflict-sweep-event-types.mjs";

describe("RESOLVE_CONFLICT_SWEEP_EVENT_TYPES", () => {
  test("is a frozen array of exactly these 8 strings", () => {
    expect(Object.isFrozen(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES)).toBe(true);
    expect(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES).toEqual([
      "resolve-conflict.marked.resolvable",
      "resolve-conflict.would.mark",
      "resolve-conflict.dispatched",
      "resolve-conflict.would.dispatch",
      "resolve-conflict.cleared",
      "resolve-conflict.would.clear",
      "resolve-conflict.escalated",
      "resolve-conflict.would.escalate",
    ]);
  });

  test("every entry is unique", () => {
    expect(new Set(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES).size).toBe(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES.length);
  });
});
