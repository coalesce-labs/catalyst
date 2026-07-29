// capacity-history.test.mjs — Phase 5 (CTL-1092). Backend reader for
// node.capacity.changed events from the unified event log.
//
// Run: cd plugins/dev/scripts/orch-monitor && bun test lib/capacity-history.test.mjs
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCapacityHistory } from "./capacity-history.mjs";

// Build a JSONL line matching capacity-event.mjs's OTel envelope.
function eventLine({ name, host, old: oldV, new: newV, reason, ts }) {
  return JSON.stringify({
    ts: ts ?? "2026-06-13T10:00:00Z",
    attributes: { "event.name": name },
    resource: { "host.name": host },
    body: {
      payload: {
        "host.name": host,
        old_maxParallel: oldV,
        new_maxParallel: newV,
        reason,
      },
    },
  });
}

describe("readCapacityHistory — basic extraction", () => {
  it("returns per-host capacity steps from node.capacity.changed events", () => {
    const lines = [
      eventLine({ name: "node.capacity.changed", host: "mini", old: 4, new: 6, reason: "saturated-scale-up", ts: "2026-06-13T10:00:00Z" }),
      eventLine({ name: "node.heartbeat", host: "mini" }), // ignored — wrong event name
      eventLine({ name: "node.capacity.changed", host: "laptop", old: 8, new: 6, reason: "recovery-to-layer1", ts: "2026-06-13T11:00:00Z" }),
    ].join("\n");
    const hist = readCapacityHistory({ read: () => lines });
    expect(hist.mini).toEqual([{ ts: "2026-06-13T10:00:00Z", old: 4, new: 6, reason: "saturated-scale-up" }]);
    expect(hist.laptop[0].new).toBe(6);
    expect(hist.laptop[0].reason).toBe("recovery-to-layer1");
  });

  it("returns empty object when the event log is missing", () => {
    const hist = readCapacityHistory({ read: () => { throw new Error("ENOENT"); } });
    expect(hist).toEqual({});
  });

  it("skips malformed / partial lines without throwing", () => {
    const lines = [
      "not-json{{{",
      eventLine({ name: "node.capacity.changed", host: "mini", old: 2, new: 4, reason: "x", ts: "2026-06-13T10:00:00Z" }),
      "",
    ].join("\n");
    const hist = readCapacityHistory({ read: () => lines });
    expect(hist.mini).toHaveLength(1);
  });

  it("preserves ascending ts order for multiple steps on the same host", () => {
    const lines = [
      eventLine({ name: "node.capacity.changed", host: "mini", old: 4, new: 6, reason: "up", ts: "2026-06-13T10:00:00Z" }),
      eventLine({ name: "node.capacity.changed", host: "mini", old: 6, new: 8, reason: "up2", ts: "2026-06-13T12:00:00Z" }),
      eventLine({ name: "node.capacity.changed", host: "mini", old: 8, new: 6, reason: "dn", ts: "2026-06-13T11:00:00Z" }), // out of order in log
    ].join("\n");
    const hist = readCapacityHistory({ read: () => lines });
    expect(hist.mini).toHaveLength(3);
    expect(hist.mini[0].ts <= hist.mini[1].ts).toBe(true);
    expect(hist.mini[1].ts <= hist.mini[2].ts).toBe(true);
  });
});

describe("readCapacityHistory — host alias resolution", () => {
  it("applies host aliases so pre-pin steps fold into the pinned host", () => {
    const lines = eventLine({ name: "node.capacity.changed", host: "Ryans-Mac-mini-250233", old: 4, new: 6, reason: "x", ts: "2026-06-13T10:00:00Z" });
    const hist = readCapacityHistory({ read: () => lines, aliases: { "Ryans-Mac-mini-250233": "mini" } });
    expect(Object.keys(hist)).toEqual(["mini"]);
    expect(hist.mini[0].new).toBe(6);
  });

  it("passes through names not in the alias map unchanged", () => {
    const lines = eventLine({ name: "node.capacity.changed", host: "laptop", old: 8, new: 4, reason: "dn", ts: "2026-06-13T10:00:00Z" });
    const hist = readCapacityHistory({ read: () => lines, aliases: { "mini-old": "mini" } });
    expect(Object.keys(hist)).toEqual(["laptop"]);
  });
});

// CTL-1529: the PRODUCTION path (no `read` seam) is now a chunked scan rather
// than readFileSync of the whole monthly log. These cover that branch, which the
// injected-string cases above never reach.
describe("readCapacityHistory — bounded production path (CTL-1529)", () => {
  it("reads from a real file and matches the injected-string path exactly", () => {
    const lines = [
      eventLine({ name: "node.capacity.changed", host: "mini", old: 4, new: 6, reason: "up", ts: "2026-06-13T10:00:00Z" }),
      eventLine({ name: "node.heartbeat", host: "mini", old: 0, new: 0, reason: "-", ts: "2026-06-13T10:00:05Z" }),
      eventLine({ name: "node.capacity.changed", host: "mini", old: 6, new: 8, reason: "up2", ts: "2026-06-13T11:00:00Z" }),
    ].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "cap-hist-"));
    const logPath = join(dir, "2026-06.jsonl");
    writeFileSync(logPath, lines + "\n");
    try {
      expect(readCapacityHistory({ logPath })).toEqual(readCapacityHistory({ read: () => lines }));
      expect(readCapacityHistory({ logPath }).mini).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a line straddling the internal chunk boundary is parsed intact (not torn)", () => {
    // A payload far larger than one chunk proves the chunk-stitching path.
    const big = eventLine({ name: "node.capacity.changed", host: "mini", old: 1, new: 2, reason: "z".repeat(2 * 1024 * 1024), ts: "2026-06-13T10:00:00Z" });
    const dir = mkdtempSync(join(tmpdir(), "cap-hist-big-"));
    const logPath = join(dir, "2026-06.jsonl");
    writeFileSync(logPath, big + "\n");
    try {
      const hist = readCapacityHistory({ logPath });
      expect(hist.mini).toHaveLength(1);
      expect(hist.mini[0].reason.length).toBe(2 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing file → {} (never throws)", () => {
    expect(readCapacityHistory({ logPath: join(tmpdir(), "nope-ctl1529.jsonl") })).toEqual({});
  });
});
