// peer-liveness.test.ts — CTL-1551: source-aware peer-transport selection for the
// monitor's background peer poll (Loki preferred, Linear anchor legacy fallback).
import { describe, it, expect } from "bun:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs module without type declarations
import { readPeerRecords } from "../lib/peer-liveness.mjs";

const LOKI_PEERS = {
  "mini-2": {
    last_seen: "2026-07-30T15:00:00Z",
    in_flight_tickets: ["CTL-1"],
    max_parallel: 3,
    in_flight_count: 1,
  },
};
const ANCHOR_PEERS = {
  mini: { last_seen: "2026-07-09T00:00:00Z", in_flight_tickets: [], max_parallel: 3, in_flight_count: 6 },
};

describe("readPeerRecords (CTL-1551)", () => {
  it("AUTO (unset source): prefers Loki when the URL resolves and peers exist", () => {
    const r = readPeerRecords({
      rawSource: undefined,
      lokiUrl: "http://loki:3100",
      anchorIssue: "CTL-1217",
      readLoki: () => LOKI_PEERS,
      readAnchor: () => ANCHOR_PEERS,
    });
    expect(r.source).toBe("loki");
    expect(r.peers).toEqual(LOKI_PEERS);
  });

  it("AUTO: empty Loki result falls back to the anchor", () => {
    const r = readPeerRecords({
      rawSource: "",
      lokiUrl: "http://loki:3100",
      anchorIssue: "CTL-1217",
      readLoki: () => ({}),
      readAnchor: () => ANCHOR_PEERS,
    });
    expect(r.source).toBe("anchor");
    expect(r.peers).toEqual(ANCHOR_PEERS);
  });

  it("AUTO: a THROWING Loki read falls back to the anchor (Loki down ≠ blank display)", () => {
    const r = readPeerRecords({
      rawSource: undefined,
      lokiUrl: "http://loki:3100",
      anchorIssue: "CTL-1217",
      readLoki: () => {
        throw new Error("loki unreachable");
      },
      readAnchor: () => ANCHOR_PEERS,
    });
    expect(r.source).toBe("anchor");
    expect(r.peers).toEqual(ANCHOR_PEERS);
  });

  it("AUTO: no Loki URL → anchor", () => {
    const r = readPeerRecords({
      rawSource: undefined,
      lokiUrl: null,
      anchorIssue: "CTL-1217",
      readLoki: () => LOKI_PEERS,
      readAnchor: () => ANCHOR_PEERS,
    });
    expect(r.source).toBe("anchor");
  });

  it("explicit loki: trusts an empty result — never reads the retired anchor", () => {
    let anchorCalls = 0;
    const r = readPeerRecords({
      rawSource: "loki",
      lokiUrl: "http://loki:3100",
      anchorIssue: "CTL-1217",
      readLoki: () => ({}),
      readAnchor: () => {
        anchorCalls++;
        return ANCHOR_PEERS;
      },
    });
    expect(r.source).toBe("loki");
    expect(r.peers).toEqual({});
    expect(anchorCalls).toBe(0);
  });

  it("explicit loki with no URL: fail-open to no peers, still never the anchor", () => {
    const r = readPeerRecords({
      rawSource: "LOKI",
      lokiUrl: null,
      anchorIssue: "CTL-1217",
      readLoki: () => LOKI_PEERS,
      readAnchor: () => ANCHOR_PEERS,
    });
    expect(r.source).toBe("loki");
    expect(r.peers).toEqual({});
  });

  it("explicit linear: anchor only, Loki never consulted", () => {
    let lokiCalls = 0;
    const r = readPeerRecords({
      rawSource: "linear",
      lokiUrl: "http://loki:3100",
      anchorIssue: "CTL-1217",
      readLoki: () => {
        lokiCalls++;
        return LOKI_PEERS;
      },
      readAnchor: () => ANCHOR_PEERS,
    });
    expect(r.source).toBe("anchor");
    expect(r.peers).toEqual(ANCHOR_PEERS);
    expect(lokiCalls).toBe(0);
  });

  it("no transport configured (no URL, no anchor) → peers null so the caller clears caches", () => {
    const r = readPeerRecords({
      rawSource: undefined,
      lokiUrl: null,
      anchorIssue: null,
      readLoki: () => LOKI_PEERS,
      readAnchor: () => ANCHOR_PEERS,
    });
    expect(r.source).toBe("none");
    expect(r.peers).toBeNull();
  });

  it("retainMissingEntries: a host missing from a partial snapshot keeps its previous entry", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — .mjs module
    const { retainMissingEntries } = await import("../lib/peer-liveness.mjs");
    const prev = { mini: "2026-07-30T15:00:00Z", "mini-2": "2026-07-30T15:00:10Z" };
    const next = { mini: "2026-07-30T15:01:00Z" }; // mini-2 absent this snapshot
    expect(retainMissingEntries(prev, next)).toEqual({
      mini: "2026-07-30T15:01:00Z", // fresh value wins
      "mini-2": "2026-07-30T15:00:10Z", // retained — ages out via liveness grace
    });
  });

  it("retainMissingEntries: an EMPTY snapshot (Loki outage fail-open) keeps the whole cache", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — .mjs module
    const { retainMissingEntries } = await import("../lib/peer-liveness.mjs");
    const prev = { mini: { maxParallel: 3, inFlightCount: 1 } };
    expect(retainMissingEntries(prev, {})).toEqual(prev);
    expect(retainMissingEntries(prev, null)).toEqual(prev);
  });

  it("foldPeerSnapshot: a STALE anchor record (same host key, older ts) cannot regress a fresher cache", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — .mjs module
    const { foldPeerSnapshot } = await import("../lib/peer-liveness.mjs");
    const out = foldPeerSnapshot({
      prevHeartbeats: { "mini-2": "2026-07-30T15:00:00Z" }, // fresh (from Loki)
      prevCapacity: { "mini-2": { maxParallel: 3, inFlightCount: 1 } },
      peers: {
        // AUTO anchor fallback after a Loki blip: same host, weeks-old data
        "mini-2": { last_seen: "2026-07-09T00:00:00Z", max_parallel: 3, in_flight_count: 6 },
      },
    });
    expect(out.heartbeats["mini-2"]).toBe("2026-07-30T15:00:00Z"); // newest wins
    expect(out.capacity["mini-2"]).toEqual({ maxParallel: 3, inFlightCount: 1 }); // stale capacity blocked
  });

  it("foldPeerSnapshot: capacity-less records (failed enrichment → nulls) retain previous capacity", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — .mjs module
    const { foldPeerSnapshot } = await import("../lib/peer-liveness.mjs");
    const out = foldPeerSnapshot({
      prevHeartbeats: { mini: "2026-07-30T15:00:00Z" },
      prevCapacity: { mini: { maxParallel: 3, inFlightCount: 2 } },
      peers: {
        mini: { last_seen: "2026-07-30T15:01:00Z", max_parallel: null, in_flight_count: null },
      },
    });
    expect(out.heartbeats.mini).toBe("2026-07-30T15:01:00Z"); // liveness still advances
    expect(out.capacity.mini).toEqual({ maxParallel: 3, inFlightCount: 2 }); // capacity retained, not zeroed
  });

  it("foldPeerSnapshot: a fresher capacity-bearing record updates both caches", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — .mjs module
    const { foldPeerSnapshot } = await import("../lib/peer-liveness.mjs");
    const out = foldPeerSnapshot({
      prevHeartbeats: { mini: "2026-07-30T15:00:00Z" },
      prevCapacity: { mini: { maxParallel: 3, inFlightCount: 2 } },
      peers: { mini: { last_seen: "2026-07-30T15:01:00Z", max_parallel: 4, in_flight_count: 0 } },
    });
    expect(out.heartbeats.mini).toBe("2026-07-30T15:01:00Z");
    expect(out.capacity.mini).toEqual({ maxParallel: 4, inFlightCount: 0 });
  });

  it("a THROWING anchor read propagates (caller's outer catch keeps the last cache)", () => {
    expect(() =>
      readPeerRecords({
        rawSource: "linear",
        lokiUrl: null,
        anchorIssue: "CTL-1217",
        readLoki: () => ({}),
        readAnchor: () => {
          throw new Error("anchor read failed");
        },
      })
    ).toThrow("anchor read failed");
  });
});
