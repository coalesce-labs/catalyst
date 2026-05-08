import { describe, test, expect } from "bun:test";

describe("daemon integration", () => {
  test("processLine skips legacy lines and counts canonical", async () => {
    // Reset module state by reimporting fresh
    const mod = await import("./index.ts");
    // The module initializes stats when imported; test that exported functions work
    // processLine should skip non-canonical lines
    const legacyLine = JSON.stringify({ ts: "2026-05-08T00:00:00Z", event: "old" });
    const canonicalLine = JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "t" }, resource: { "service.name": "s", "service.namespace": "catalyst", "service.version": "1.0.0" }, severityText: "INFO", severityNumber: 9, traceId: null, spanId: null, body: {} });

    const statsBefore = mod.getStats();
    mod.processLine(legacyLine);
    mod.processLine(canonicalLine);
    const statsAfter = mod.getStats();

    expect(statsAfter.skipped).toBe(statsBefore.skipped + 1);
    expect(statsAfter.processed).toBe(statsBefore.processed + 1);
  });
});
