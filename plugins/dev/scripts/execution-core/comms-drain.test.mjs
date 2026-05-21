// Unit tests for the execution-core Step F comms-drain decision (CTL-533).
// Run: cd plugins/dev/scripts/execution-core && bun test comms-drain.test.mjs

import { describe, test, expect } from "bun:test";
import { drainComms } from "./comms-drain.mjs";

describe("drainComms", () => {
  test("promotes type:'attention' messages to attention items", () => {
    const out = drainComms({
      cursor: 0,
      messages: [
        { type: "attention", from: "CTL-7", body: "blocked on review" },
      ],
    });
    expect(out.attentions).toHaveLength(1);
    expect(out.attentions[0].kind).toBe("comms-attention");
    expect(out.attentions[0].ticket).toBe("CTL-7");
    expect(out.attentions[0].body).toContain("blocked on review");
    expect(out.attentions[0].body).toContain("CTL-7");
  });

  test("ignores non-attention message types", () => {
    const out = drainComms({
      cursor: 0,
      messages: [
        { type: "status", from: "CTL-7", body: "still working" },
        { type: "info", from: "CTL-8", body: "fyi" },
      ],
    });
    expect(out.attentions).toEqual([]);
  });

  test("advances the cursor by the number of messages consumed", () => {
    const out = drainComms({
      cursor: 5,
      messages: [
        { type: "attention", from: "CTL-1", body: "a" },
        { type: "status", from: "CTL-2", body: "b" },
        { type: "attention", from: "CTL-3", body: "c" },
      ],
    });
    expect(out.newCursor).toBe(8);
  });

  test("empty message list → no attentions, cursor unchanged", () => {
    const out = drainComms({ cursor: 12, messages: [] });
    expect(out.attentions).toEqual([]);
    expect(out.newCursor).toBe(12);
  });

  test("extracts the ticket id from the author name prefix", () => {
    const out = drainComms({
      cursor: 0,
      messages: [
        { type: "attention", from: "CTL-99-worker", body: "help" },
      ],
    });
    expect(out.attentions[0].ticket).toBe("CTL-99");
  });

  test("falls back to the raw author when no ticket id prefix is present", () => {
    const out = drainComms({
      cursor: 0,
      messages: [{ type: "attention", from: "operator", body: "manual ping" }],
    });
    expect(out.attentions[0].ticket).toBe("operator");
  });
});
