// capacity-history.test.mjs — Phase 5 (CTL-1092). Backend reader for
// node.capacity.changed events from the unified event log.
//
// Run: cd plugins/dev/scripts/orch-monitor && bun test lib/capacity-history.test.mjs
import { describe, it, expect } from "bun:test";
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
