import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanJsonlFile } from "./scan-jsonl.ts";

describe("scanJsonlFile", () => {
  test("counts canonical attributes[event.name] and flat event fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-audit-test-"));
    const file = join(dir, "2026-06.jsonl");
    const lines = [
      // canonical
      JSON.stringify({ ts: "2026-06-01T00:00:00Z", id: "1", attributes: { "event.name": "node.heartbeat" }, resource: {}, severityText: "INFO", severityNumber: 9, traceId: null, spanId: null, body: {} }),
      JSON.stringify({ ts: "2026-06-01T00:00:01Z", id: "2", attributes: { "event.name": "node.heartbeat" }, resource: {}, severityText: "INFO", severityNumber: 9, traceId: null, spanId: null, body: {} }),
      // flat reap-intent
      JSON.stringify({ ts: "2026-06-01T00:00:02Z", event: "phase.terminal.reap-requested", ticket: "CTL-1008" }),
      JSON.stringify({ ts: "2026-06-01T00:00:03Z", event: "phase.terminal.reap-requested", ticket: "CTL-1009" }),
      JSON.stringify({ ts: "2026-06-01T00:00:04Z", event: "worktree.cleanup-deferred" }),
      // malformed — should be tolerated
      "not-json{{{",
      "",
    ].join("\n");
    writeFileSync(file, lines);

    const counts = await scanJsonlFile(file);
    expect(counts.get("node.heartbeat")).toBe(2);
    expect(counts.get("phase.terminal.reap-requested")).toBe(2);
    expect(counts.get("worktree.cleanup-deferred")).toBe(1);
    // malformed and empty lines don't crash or produce entries
    expect(counts.size).toBe(3);

    rmSync(dir, { recursive: true });
  });
});
