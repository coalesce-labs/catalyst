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
});
