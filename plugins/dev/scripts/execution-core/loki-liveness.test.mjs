// loki-liveness.test.mjs — CTL-1420 (#17). Cross-host peer liveness read via Loki.
// Pure parser + fail-open reader are exercised with an injected fetcher (no network).
//
// Run: cd plugins/dev/scripts/execution-core && bun test loki-liveness.test.mjs

import { describe, test, expect } from "bun:test";
import {
  parseLokiLivenessResponse,
  readClusterLivenessFromLoki,
  nsToMs,
} from "./loki-liveness.mjs";

// A Loki query_range "streams" response with one stream per host. `metaTickets`
// (3rd values element) simulates the structured-metadata shape; `labelTickets`
// simulates the promoted-stream-label shape. tsNs is a nanosecond string.
function stream(host, entries, { labelTickets } = {}) {
  const s = { host_name: host, event_name: "node.heartbeat" };
  if (labelTickets !== undefined) s.catalyst_node_in_flight_tickets = labelTickets;
  return {
    stream: s,
    values: entries.map((e) =>
      e.metaTickets !== undefined
        ? [e.tsNs, "node.heartbeat", { catalyst_node_in_flight_tickets: e.metaTickets }]
        : [e.tsNs, "node.heartbeat"],
    ),
  };
}
const ok = (result) => ({ ok: true, json: async () => ({ status: "success", data: { resultType: "streams", result } }) });

describe("nsToMs (CTL-1420 #17) — no precision loss on nanosecond timestamps", () => {
  test("converts a ns string to ms without Number overflow", () => {
    // 1783451090000000000 ns → 1783451090000 ms (Number-safe). Direct Number(ns) would lose precision.
    expect(nsToMs("1783451090000000000")).toBe(1783451090000);
    expect(new Date(nsToMs("1783451090000000000")).toISOString()).toBe("2026-07-07T19:04:50.000Z");
  });
  test("non-numeric / empty → NaN", () => {
    expect(Number.isNaN(nsToMs("zzz"))).toBe(true);
    expect(Number.isNaN(nsToMs(""))).toBe(true);
    expect(Number.isNaN(nsToMs(null))).toBe(true);
  });
});

describe("parseLokiLivenessResponse (CTL-1420 #17)", () => {
  test("newest ts per host + in_flight from structured metadata (3rd element)", () => {
    const body = {
      data: {
        result: [
          stream("mini", [
            { tsNs: "1783451060000000000", metaTickets: "CTL-1" },
            { tsNs: "1783451090000000000", metaTickets: "CTL-1,CTL-2" }, // newest
          ]),
          stream("mini-2", [{ tsNs: "1783451092000000000", metaTickets: "" }]),
        ],
      },
    };
    const out = parseLokiLivenessResponse(body);
    expect(out.mini.last_seen).toBe("2026-07-07T19:04:50.000Z");
    expect(out.mini.in_flight_tickets).toEqual(["CTL-1", "CTL-2"]);
    expect(out["mini-2"].in_flight_tickets).toEqual([]);
  });

  test("reads in_flight from the stream-label shape when metadata is absent", () => {
    const body = { data: { result: [stream("mini", [{ tsNs: "1783451090000000000" }], { labelTickets: "CTL-9,CTL-8" })] } };
    expect(parseLokiLivenessResponse(body).mini.in_flight_tickets).toEqual(["CTL-9", "CTL-8"]);
  });

  test("picks the max ts even when values are unordered", () => {
    const body = {
      data: {
        result: [
          stream("mini", [
            { tsNs: "1783451090000000000", metaTickets: "NEW" },
            { tsNs: "1783451000000000000", metaTickets: "OLD" },
          ]),
        ],
      },
    };
    const out = parseLokiLivenessResponse(body);
    expect(out.mini.in_flight_tickets).toEqual(["NEW"]);
  });

  test("newest ts tracked ACROSS streams — real Loki = one single-value stream per beat (regression)", () => {
    // Real Loki splits EVERY heartbeat into its own stream (the changing in_flight_count
    // label), and lists them in arbitrary order. A per-stream `newest` that overwrote
    // out[host] each stream would let the LAST-listed (stale) stream win — the live bug
    // that read a peer ~20 min stale and risked a false reclaim. The newest must win
    // regardless of stream ORDER in the result array.
    const body = {
      data: {
        result: [
          stream("mini", [{ tsNs: "1783451090000000000" }]), // NEWEST, listed FIRST
          stream("mini", [{ tsNs: "1783451000000000000" }]), // older, listed AFTER
          stream("mini", [{ tsNs: "1783451030000000000" }]), // middle, listed LAST
        ],
      },
    };
    const out = parseLokiLivenessResponse(body);
    expect(out.mini.last_seen).toBe("2026-07-07T19:04:50.000Z"); // 1783451090000 ms = newest
  });

  test("skips streams with no host_name / no parseable ts; returns {} on garbage", () => {
    expect(parseLokiLivenessResponse({ data: { result: [{ stream: {}, values: [["1", "x"]] }] } })).toEqual({});
    expect(parseLokiLivenessResponse({ data: { result: [stream("mini", [{ tsNs: "zzz" }])] } })).toEqual({});
    expect(parseLokiLivenessResponse(null)).toEqual({});
    expect(parseLokiLivenessResponse({ data: {} })).toEqual({});
  });
});

describe("readClusterLivenessFromLoki (CTL-1420 #17) — fail-open", () => {
  test("parses a successful response via the injected fetcher", async () => {
    const fetcher = async () => ok([stream("mini", [{ tsNs: "1783451090000000000", metaTickets: "CTL-5" }])]);
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher, nowMs: 1783451100000 });
    expect(out.mini.in_flight_tickets).toEqual(["CTL-5"]);
    expect(typeof out.mini.last_seen).toBe("string");
  });

  test("builds a bounded query window around nowMs (start < end, ns)", async () => {
    let captured;
    const fetcher = async (url) => { captured = url; return ok([]); };
    await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher, nowMs: 1783451100000, windowMs: 600000 });
    const u = new URL(captured);
    expect(Number(u.searchParams.get("start"))).toBe((1783451100000 - 600000) * 1_000_000);
    expect(Number(u.searchParams.get("end"))).toBe(1783451100000 * 1_000_000);
    expect(u.searchParams.get("query")).toContain("node.heartbeat");
  });

  test("no lokiUrl → {} (no fetch attempted)", async () => {
    let called = false;
    const fetcher = async () => { called = true; return ok([]); };
    expect(await readClusterLivenessFromLoki({ fetcher })).toEqual({});
    expect(called).toBe(false);
  });

  test("fetcher throws (e.g. abort/timeout/unreachable) → {}", async () => {
    const fetcher = async () => { throw new Error("ECONNREFUSED"); };
    expect(await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher })).toEqual({});
  });

  test("non-200 → {}", async () => {
    const fetcher = async () => ({ ok: false, status: 503, json: async () => ({}) });
    expect(await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher })).toEqual({});
  });

  test("status != success → {}", async () => {
    const fetcher = async () => ({ ok: true, json: async () => ({ status: "error", data: null }) });
    expect(await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher })).toEqual({});
  });

  test("two-query: liveness from A (all hosts) + tickets enriched from B (per host)", async () => {
    // Query A (no tickets filter) → host+ts for BOTH; Query B (tickets filter) → only the
    // host WITH a non-empty set. The reader merges B's tickets onto A without dropping the
    // empty-set host from liveness.
    const fetcher = async (url) =>
      url.includes("in_flight_tickets")
        ? ok([stream("mini", [{ tsNs: "1783451090000000000", metaTickets: "CTL-1,CTL-2" }])])
        : ok([
            stream("mini", [{ tsNs: "1783451090000000000" }]),
            stream("mini-2", [{ tsNs: "1783451092000000000" }]),
          ]);
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher, nowMs: 1783451100000 });
    expect(Object.keys(out).sort()).toEqual(["mini", "mini-2"]);
    expect(out.mini.in_flight_tickets).toEqual(["CTL-1", "CTL-2"]);
    expect(out["mini-2"].in_flight_tickets).toEqual([]);
  });

  test("tickets-enrichment (query B) failure does NOT break liveness (query A stands)", async () => {
    const fetcher = async (url) => {
      if (url.includes("in_flight_tickets")) throw new Error("loki blip on B");
      return ok([stream("mini", [{ tsNs: "1783451090000000000" }])]);
    };
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher });
    expect(out.mini).toBeDefined();
    expect(out.mini.in_flight_tickets).toEqual([]);
  });
});

// ── CTL-1551: capacity fields (max_parallel / in_flight_count) ──
// Loki only surfaces a structured-metadata field when the query references it, so
// capacity rides a third best-effort query (C) merged onto A — mirroring tickets (B).
describe("capacity enrichment (CTL-1551)", () => {
  const capStream = (host, tsNs, { mp, ifc, asLabels } = {}) => {
    const meta = {};
    if (mp !== undefined) meta.catalyst_node_max_parallel = mp;
    if (ifc !== undefined) meta.catalyst_node_in_flight_count = ifc;
    const s = { host_name: host, event_name: "node.heartbeat" };
    if (asLabels) Object.assign(s, meta);
    return { stream: s, values: [asLabels ? [tsNs, "node.heartbeat"] : [tsNs, "node.heartbeat", meta]] };
  };

  test("parse: capacity from structured metadata (numbers arrive as Loki strings)", () => {
    const out = parseLokiLivenessResponse({
      data: { result: [capStream("mini", "1783451090000000000", { mp: "3", ifc: "2" })] },
    });
    expect(out.mini.max_parallel).toBe(3);
    expect(out.mini.in_flight_count).toBe(2);
  });

  // ── CAT-57: last_advance_at rides the same transport (productivity signal) ──
  test("parse: last_advance_at from structured metadata AND from stream labels", () => {
    const ts = "2026-08-09T04:00:00Z";
    const mkAdv = (host, asLabels) => {
      const meta = { catalyst_node_last_advance_at: ts };
      const st = { host_name: host, event_name: "node.heartbeat" };
      if (asLabels) Object.assign(st, meta);
      return { stream: st, values: [asLabels ? ["1783451090000000000", "node.heartbeat"] : ["1783451090000000000", "node.heartbeat", meta]] };
    };
    expect(parseLokiLivenessResponse({ data: { result: [mkAdv("mini", false)] } }).mini.last_advance_at).toBe(ts);
    expect(parseLokiLivenessResponse({ data: { result: [mkAdv("mini", true)] } }).mini.last_advance_at).toBe(ts);
  });

  test("parse: absent/unparseable last_advance_at is null, never a synthesized timestamp", () => {
    // An OLD-daemon heartbeat carries no such attribute. It must read as unknown so
    // nodeProductivity SKIPS the peer — a fabricated 'now' would mask a stuck host.
    const plain = parseLokiLivenessResponse({
      data: { result: [capStream("mini", "1783451090000000000", { mp: "3" })] },
    });
    expect(plain.mini.last_advance_at).toBeNull();
    for (const bad of ["", "not-a-date", "  "]) {
      const st = { stream: { host_name: "b", event_name: "node.heartbeat" }, values: [["1783451090000000000", "node.heartbeat", { catalyst_node_last_advance_at: bad }]] };
      expect(parseLokiLivenessResponse({ data: { result: [st] } }).b.last_advance_at).toBeNull();
    }
  });

  test("parse: host from per-entry structured metadata when absent from stream labels (CTL-1551)", () => {
    const out = parseLokiLivenessResponse({
      data: {
        result: [
          {
            stream: { event_name: "node.heartbeat" }, // no host_name label
            values: [["1783451090000000000", "node.heartbeat", { host_name: "mini-2" }]],
          },
        ],
      },
    });
    expect(out["mini-2"]).toBeDefined();
    expect(out["mini-2"].last_seen).toBe("2026-07-07T19:04:50.000Z");
  });

  test("parse: capacity from the promoted-stream-label shape", () => {
    const out = parseLokiLivenessResponse({
      data: { result: [capStream("mini-2", "1783451090000000000", { mp: "4", ifc: "0", asLabels: true })] },
    });
    expect(out["mini-2"].max_parallel).toBe(4);
    expect(out["mini-2"].in_flight_count).toBe(0);
  });

  test("parse: absent/invalid capacity → null, never 0 or NaN", () => {
    const out = parseLokiLivenessResponse({
      data: {
        result: [
          capStream("a", "1783451090000000000", {}),
          capStream("b", "1783451090000000000", { mp: "garbage", ifc: "-1" }),
          capStream("c", "1783451090000000000", { mp: "0" }),
        ],
      },
    });
    expect(out.a.max_parallel).toBeNull();
    expect(out.a.in_flight_count).toBeNull();
    expect(out.b.max_parallel).toBeNull();
    expect(out.b.in_flight_count).toBeNull();
    expect(out.c.max_parallel).toBeNull();
  });

  test("three-query: capacity from C merged onto A's liveness map", async () => {
    const fetcher = async (url) => {
      if (url.includes("max_parallel"))
        return ok([capStream("mini", "1783451090000000000", { mp: "3", ifc: "1" })]);
      if (url.includes("in_flight_tickets")) return ok([]);
      return ok([
        stream("mini", [{ tsNs: "1783451090000000000" }]),
        stream("mini-2", [{ tsNs: "1783451092000000000" }]),
      ]);
    };
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher, nowMs: 1783451100000 });
    expect(out.mini.max_parallel).toBe(3);
    expect(out.mini.in_flight_count).toBe(1);
    expect(out["mini-2"].max_parallel).toBeNull(); // no capacity published → no-data, not 0
  });

  // ── CAT-57 (query E): the productivity read must actually be QUERIED ──
  // Regression guard for the exact miss Codex caught: the parser alone is inert,
  // because Loki only surfaces a structured-metadata field when a query REFERENCES
  // it. These tests fail if query E is ever dropped, even with parsing intact.
  test("query E is ISSUED and merges last_advance_at onto A's liveness map", async () => {
    const adv = "2026-08-09T04:00:00Z";
    let sawAdvanceQuery = false;
    const advStream = (host, tsNs) => ({
      stream: { host_name: host, event_name: "node.heartbeat" },
      values: [[tsNs, "node.heartbeat", { catalyst_node_last_advance_at: adv }]],
    });
    const fetcher = async (url) => {
      if (url.includes("last_advance_at")) {
        sawAdvanceQuery = true;
        return ok([advStream("mini", "1783451090000000000")]);
      }
      if (url.includes("max_parallel") || url.includes("in_flight_tickets") || url.includes("active_count")) return ok([]);
      return ok([
        stream("mini", [{ tsNs: "1783451090000000000" }]),
        stream("mini-2", [{ tsNs: "1783451092000000000" }]),
      ]);
    };
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher, nowMs: 1783451100000 });
    expect(sawAdvanceQuery).toBe(true); // the miss this guards
    expect(out.mini.last_advance_at).toBe(adv);
    expect(out["mini-2"].last_advance_at).toBeNull(); // never published → unknown, not fabricated
  });

  test("query E honors the rollback guard — a STALE advance never lands on fresher liveness", async () => {
    // A's newest liveness line is NEWER than E's newest attribute-bearing line
    // (the dual-publish / rollback window). Merging would make a stuck host look
    // productive, so the merge must be skipped and the field stay unknown.
    const fetcher = async (url) => {
      if (url.includes("last_advance_at"))
        return ok([{
          stream: { host_name: "mini", event_name: "node.heartbeat" },
          values: [["1783451000000000000", "node.heartbeat", { catalyst_node_last_advance_at: "2026-08-09T03:00:00Z" }]],
        }]);
      if (url.includes("max_parallel") || url.includes("in_flight_tickets") || url.includes("active_count")) return ok([]);
      return ok([stream("mini", [{ tsNs: "1783451090000000000" }])]);
    };
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher, nowMs: 1783451100000 });
    expect(out.mini.last_advance_at).toBeNull();
  });

  test("query E failure does NOT break liveness, tickets, or capacity", async () => {
    const fetcher = async (url) => {
      if (url.includes("last_advance_at")) throw new Error("loki blip on E");
      if (url.includes("in_flight_tickets"))
        return ok([stream("mini", [{ tsNs: "1783451090000000000", metaTickets: "CTL-7" }])]);
      if (url.includes("max_parallel")) return ok([]);
      return ok([stream("mini", [{ tsNs: "1783451090000000000" }])]);
    };
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher });
    expect(out.mini.last_seen).toBeDefined();
    expect(out.mini.in_flight_tickets).toEqual(["CTL-7"]);
    expect(out.mini.last_advance_at).toBeNull();
  });

  test("capacity-enrichment (query C) failure does NOT break liveness or tickets", async () => {
    const fetcher = async (url) => {
      if (url.includes("max_parallel")) throw new Error("loki blip on C");
      if (url.includes("in_flight_tickets"))
        return ok([stream("mini", [{ tsNs: "1783451090000000000", metaTickets: "CTL-7" }])]);
      return ok([stream("mini", [{ tsNs: "1783451090000000000" }])]);
    };
    const out = await readClusterLivenessFromLoki({ lokiUrl: "http://loki:3100", fetcher });
    expect(out.mini.last_seen).toBeDefined();
    expect(out.mini.in_flight_tickets).toEqual(["CTL-7"]);
    expect(out.mini.max_parallel).toBeNull();
  });
});
