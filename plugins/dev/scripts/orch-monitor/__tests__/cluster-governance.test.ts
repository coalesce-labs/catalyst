// CTL-1104: cluster-governance.mjs — per-host governance snapshot reader.
// Uses fixture JSONL written to a tmp file; all thresholds are injected.
// The drift-guard test imports classifyHostLiveness and asserts the reader
// classifies identically so governance freshness can never diverge from
// host liveness.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyHostLiveness,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LIVENESS_GRACE_MS,
} from "../lib/node-liveness.mjs";

const clusterGov = await import("../lib/cluster-governance.mjs");
const { readClusterGovernance } = clusterGov as {
  readClusterGovernance: (opts?: {
    logPath?: string;
    roster?: string[];
    now?: number;
    intervalMs?: number;
    graceMs?: number;
  }) => {
    singleHost: boolean;
    generatedAt: string;
    nodes: Array<{
      host: string;
      governance: Record<string, unknown> | null;
      reportedAt: string | null;
      ageMs: number | null;
      status: "live" | "degraded" | "offline";
    }>;
  };
};

const INTERVAL = DEFAULT_HEARTBEAT_INTERVAL_MS;
const GRACE = DEFAULT_LIVENESS_GRACE_MS;

const SAMPLE_GOV = {
  beliefsShadow: true,
  diagnostician: false,
  intentsEnforce: false,
  advanceShadowSummary: false,
  stallJanitor: { mode: "enforce" },
  watchdog: { mode: "shadow" },
  unstuckSweep: { mode: "off" },
};

function makeHeartbeatLine(host: string, ts: string, gov: Record<string, unknown> | null = SAMPLE_GOV) {
  return JSON.stringify({
    ts,
    id: "aabbccdd",
    attributes: { "event.name": "node.heartbeat" },
    resource: { "host.name": host },
    body: {
      payload: {
        "host.name": host,
        ...(gov ? { governance: gov } : {}),
        epoch: Date.parse(ts),
      },
    },
  });
}

let tmpDir: string;
let logPath: string;

// Create a fresh temp dir + logPath for each describe block sharing setup.
function setup(lines: string[]): string {
  tmpDir = mkdtempSync(join(tmpdir(), "ctl1104-"));
  const p = join(tmpDir, "events.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-06-13T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("readClusterGovernance — basic roster extraction", () => {
  it("returns one node per roster host, newest heartbeat wins", () => {
    const lp = setup([
      makeHeartbeatLine("host-A", at(5_000)),
      makeHeartbeatLine("host-A", at(60_000)),  // older — should NOT win
      makeHeartbeatLine("host-B", at(10_000)),
    ]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A", "host-B"], now: NOW, intervalMs: INTERVAL, graceMs: GRACE });
    expect(result.nodes).toHaveLength(2);
    const a = result.nodes.find((n) => n.host === "host-A")!;
    expect(a.reportedAt).toBe(at(5_000));
    expect(a.governance).toEqual(SAMPLE_GOV);
  });

  it("extracts body.payload.governance verbatim", () => {
    const lp = setup([makeHeartbeatLine("host-A", at(5_000), { beliefsShadow: false, intentsEnforce: true })]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW });
    expect(result.nodes[0].governance).toEqual({ beliefsShadow: false, intentsEnforce: true });
  });

  it("sets reportedAt from ts and ageMs = now − Date.parse(ts)", () => {
    const ts = at(15_000);
    const lp = setup([makeHeartbeatLine("host-A", ts)]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW });
    expect(result.nodes[0].reportedAt).toBe(ts);
    expect(result.nodes[0].ageMs).toBe(15_000);
  });
});

describe("readClusterGovernance — staleness via classifyHostLiveness drift guard", () => {
  const CASES: Array<{ msAgo: number; expected: "live" | "degraded" | "offline" }> = [
    { msAgo: INTERVAL - 1, expected: "live" },
    { msAgo: INTERVAL,     expected: "live" },          // boundary inclusive
    { msAgo: INTERVAL + 1, expected: "degraded" },
    { msAgo: GRACE,        expected: "degraded" },      // grace boundary inclusive
    { msAgo: GRACE + 1,    expected: "offline" },
    { msAgo: 30 * 60_000,  expected: "offline" },
  ];

  for (const { msAgo, expected } of CASES) {
    it(`ageMs ${msAgo}ms → status "${expected}" (matches classifyHostLiveness)`, () => {
      const ts = at(msAgo);
      const lp = setup([makeHeartbeatLine("host-A", ts)]);
      const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW, intervalMs: INTERVAL, graceMs: GRACE });
      const node = result.nodes[0];
      expect(node.status).toBe(expected);
      // Drift guard: must match classifyHostLiveness identically
      expect(node.status).toBe(classifyHostLiveness(ts, NOW, { intervalMs: INTERVAL, graceMs: GRACE }));
    });
  }
});

describe("readClusterGovernance — missing / never-heard host", () => {
  it("a roster host with no heartbeat → governance null, reportedAt null, ageMs null, status offline", () => {
    const lp = setup([makeHeartbeatLine("other-host", at(5_000))]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW });
    const node = result.nodes[0];
    expect(node.governance).toBeNull();
    expect(node.reportedAt).toBeNull();
    expect(node.ageMs).toBeNull();
    expect(node.status).toBe("offline");
  });
});

describe("readClusterGovernance — robustness", () => {
  it("missing log file → all-offline signal, never throws", () => {
    expect(() => {
      const result = readClusterGovernance({
        logPath: "/tmp/does-not-exist-ctl1104.jsonl",
        roster: ["host-A", "host-B"],
        now: NOW,
      });
      expect(result.nodes.every((n) => n.status === "offline")).toBe(true);
    }).not.toThrow();
  });

  it("garbage / partial JSON line is skipped", () => {
    const lp = setup([
      "{invalid-json",
      makeHeartbeatLine("host-A", at(5_000)),
    ]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW });
    expect(result.nodes[0].reportedAt).toBe(at(5_000));
  });

  it("non-node.heartbeat line is ignored", () => {
    const lp = setup([
      JSON.stringify({ ts: at(5_000), attributes: { "event.name": "phase.start" }, body: { payload: { "host.name": "host-A", governance: SAMPLE_GOV } } }),
      makeHeartbeatLine("host-A", at(10_000)),
    ]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW });
    // Only the heartbeat line should be picked up
    expect(result.nodes[0].reportedAt).toBe(at(10_000));
  });

  it("heartbeat with no governance field → host classifies on ts but governance is null", () => {
    const lp = setup([makeHeartbeatLine("host-A", at(5_000), null)]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW });
    const node = result.nodes[0];
    expect(node.governance).toBeNull();
    expect(node.status).toBe("live");
  });

  it("future-dated ts (clock skew) → ageMs 0, status live", () => {
    const futurTs = new Date(NOW + 5_000).toISOString();
    const lp = setup([makeHeartbeatLine("host-A", futurTs)]);
    const result = readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW, intervalMs: INTERVAL, graceMs: GRACE });
    expect(result.nodes[0].ageMs).toBe(0);
    expect(result.nodes[0].status).toBe("live");
  });
});

describe("readClusterGovernance — singleHost + generatedAt", () => {
  it("singleHost true when roster.length <= 1", () => {
    const lp = setup([makeHeartbeatLine("host-A", at(5_000))]);
    expect(readClusterGovernance({ logPath: lp, roster: [], now: NOW }).singleHost).toBe(true);
    expect(readClusterGovernance({ logPath: lp, roster: ["host-A"], now: NOW }).singleHost).toBe(true);
  });

  it("singleHost false when roster.length > 1", () => {
    const lp = setup([makeHeartbeatLine("host-A", at(5_000))]);
    expect(readClusterGovernance({ logPath: lp, roster: ["host-A", "host-B"], now: NOW }).singleHost).toBe(false);
  });

  it("generatedAt is the injected now as ISO", () => {
    const lp = setup([]);
    const result = readClusterGovernance({ logPath: lp, roster: [], now: NOW });
    expect(result.generatedAt).toBe(new Date(NOW).toISOString());
  });
});
