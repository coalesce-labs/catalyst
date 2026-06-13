// cluster-heartbeat-capacity.test.mjs — CTL-1092. Extend cluster-heartbeat to
// carry max_parallel and in_flight_count in the attachment metadata.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cluster-heartbeat-capacity.test.mjs

import { describe, test, expect } from "bun:test";
import {
  parseHeartbeatMetadata,
  publishHeartbeat,
} from "./cluster-heartbeat.mjs";

describe("parseHeartbeatMetadata capacity fields (CTL-1092)", () => {
  test("normalizes max_parallel (finite int) from metadata", () => {
    const m = parseHeartbeatMetadata({ host: "laptop", last_seen: "...", in_flight_tickets: [], max_parallel: 8 });
    expect(m.max_parallel).toBe(8);
  });

  test("normalizes in_flight_count from metadata (fallback to in_flight_tickets.length)", () => {
    const m = parseHeartbeatMetadata({ host: "laptop", last_seen: "...", in_flight_tickets: ["CTL-1", "CTL-2"] });
    expect(m.in_flight_count).toBe(2);
  });

  test("uses in_flight_count field when explicitly provided", () => {
    const m = parseHeartbeatMetadata({ host: "laptop", last_seen: "...", in_flight_tickets: [], in_flight_count: 3 });
    expect(m.in_flight_count).toBe(3);
  });

  test("max_parallel defaults to null when missing or non-integer", () => {
    expect(parseHeartbeatMetadata({ host: "laptop", last_seen: "...", in_flight_tickets: [] }).max_parallel).toBeNull();
    expect(parseHeartbeatMetadata({ host: "laptop", last_seen: "...", in_flight_tickets: [], max_parallel: "bad" }).max_parallel).toBeNull();
  });

  test("in_flight_count defaults to 0 when missing tickets", () => {
    expect(parseHeartbeatMetadata({ host: "laptop", last_seen: "...", in_flight_tickets: [] }).in_flight_count).toBe(0);
  });
});

describe("publishHeartbeat metadata capacity fields (CTL-1092)", () => {
  test("publishes max_parallel and in_flight_count in metadata", async () => {
    const calls = [];
    const post = async (q, v) => {
      calls.push({ q, v });
      if (q.includes("ResolveIssue")) return { issues: { nodes: [{ id: "uuid-anchor" }] } };
      return { attachmentCreate: { success: true, attachment: { id: "a1" } } };
    };
    const rec = await publishHeartbeat(
      { anchorIssue: "CTL-9999", host: "laptop", inFlightTickets: ["CTL-1", "CTL-2"], maxParallel: 8 },
      { post, now: () => "2026-06-13T01:00:00Z" },
    );
    const write = calls.find((c) => c.q.includes("attachmentCreate"));
    expect(write.v.input.metadata.max_parallel).toBe(8);
    expect(write.v.input.metadata.in_flight_count).toBe(2);
    expect(write.v.input.metadata.in_flight_tickets).toEqual(["CTL-1", "CTL-2"]);
    // Returned record also carries the capacity fields
    expect(rec.max_parallel).toBe(8);
    expect(rec.in_flight_count).toBe(2);
  });

  test("max_parallel defaults to null when omitted from publishHeartbeat", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issues: { nodes: [{ id: "uuid-x" }] } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const rec = await publishHeartbeat(
      { anchorIssue: "CTL-9999", host: "mini", inFlightTickets: [] },
      { post, now: () => "2026-06-13T01:00:00Z" },
    );
    expect(rec.max_parallel).toBeNull();
    expect(rec.in_flight_count).toBe(0);
  });
});
