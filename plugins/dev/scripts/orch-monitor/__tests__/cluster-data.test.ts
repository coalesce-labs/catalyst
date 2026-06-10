import { describe, it, expect } from "bun:test";
import {
  assembleClusterBoard,
  classifyLiveness,
  CLUSTER_LIVE_MS,
  CLUSTER_DEGRADED_MS,
  scanHeartbeats,
} from "../lib/cluster-data";

// Fixed clock for deterministic liveness boundaries.
const NOW = Date.parse("2026-06-09T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("classifyLiveness", () => {
  it("live when last heartbeat within CLUSTER_LIVE_MS", () => {
    expect(classifyLiveness(iso(CLUSTER_LIVE_MS - 1), NOW)).toBe("live");
  });
  it("degraded between live and degraded windows", () => {
    expect(classifyLiveness(iso(CLUSTER_LIVE_MS + 1), NOW)).toBe("degraded");
  });
  it("offline past CLUSTER_DEGRADED_MS", () => {
    expect(classifyLiveness(iso(CLUSTER_DEGRADED_MS + 1), NOW)).toBe("offline");
  });
  it("offline when never seen (null)", () => {
    expect(classifyLiveness(null, NOW)).toBe("offline");
  });
});

describe("scanHeartbeats", () => {
  it("keeps the latest ts per host and ignores non-heartbeat / malformed lines", () => {
    const log = [
      JSON.stringify({ attributes: { "event.name": "node.heartbeat" }, ts: iso(60_000), resource: { "host.name": "mini" } }),
      JSON.stringify({ attributes: { "event.name": "node.heartbeat" }, ts: iso(10_000), body: { payload: { "host.name": "mini" } } }),
      JSON.stringify({ attributes: { "event.name": "phase.plan.complete" }, ts: iso(1), resource: { "host.name": "mini" } }),
      "}{ not json",
      JSON.stringify({ attributes: { "event.name": "node.heartbeat" }, ts: iso(5_000), resource: { "host.name": "studio" } }),
    ].join("\n");
    const seen = scanHeartbeats(log);
    expect(seen.mini).toBe(iso(10_000)); // latest of the two mini events
    expect(seen.studio).toBe(iso(5_000));
  });
  it("returns {} for empty input", () => {
    expect(scanHeartbeats("")).toEqual({});
  });
});

describe("assembleClusterBoard", () => {
  const baseDeps = {
    now: NOW,
    hosts: ["mini"],
    heartbeats: { mini: iso(10_000) },
    readClaim: async () => null,
    listActiveTickets: async () => [
      { id: "CTL-900", title: "A", linearState: "Implement" },
    ],
    localHost: "mini",
    localPhaseFor: (_id: string): string | null => "implement",
    prGet: (_id: string): { number: number; state: string } | null => null,
  };

  it("self-attributes local in-flight tickets when no claim exists (single-host)", async () => {
    const p = await assembleClusterBoard(baseDeps);
    const mini = p.hosts.find((h) => h.hostName === "mini");
    expect(mini?.liveness).toBe("live");
    expect(mini?.tickets.map((t) => t.id)).toContain("CTL-900");
    expect(p.unclaimed).toHaveLength(0);
  });

  it("attributes a ticket to its claim owner_host (multi-host)", async () => {
    const p = await assembleClusterBoard({
      ...baseDeps,
      hosts: ["mini", "studio"],
      heartbeats: { mini: iso(10_000), studio: iso(20_000) },
      readClaim: async (t: string) =>
        t === "CTL-900" ? { owner_host: "studio", generation: 3, phase: "review", claimed_at: iso(20_000) } : null,
      localPhaseFor: () => null,
    });
    const studio = p.hosts.find((h) => h.hostName === "studio");
    expect(studio?.tickets[0]).toMatchObject({ id: "CTL-900", phase: "review" });
    expect(p.hosts.find((h) => h.hostName === "mini")?.tickets).toHaveLength(0);
  });

  it("buckets active tickets with no claim and no local phase as unclaimed", async () => {
    const p = await assembleClusterBoard({ ...baseDeps, localPhaseFor: () => null });
    expect(p.unclaimed.map((t) => t.id)).toContain("CTL-900");
  });

  it("unions roster, heartbeat-only, and claim-owner hosts", async () => {
    const p = await assembleClusterBoard({
      ...baseDeps,
      hosts: ["mini"],
      heartbeats: { mini: iso(10_000), ghost: iso(900_000) }, // ghost only in heartbeats
      readClaim: async () => ({ owner_host: "studio", generation: 1, phase: "pr", claimed_at: iso(1) }),
      localPhaseFor: () => null,
    });
    const names = p.hosts.map((h) => h.hostName).sort();
    expect(names).toEqual(["ghost", "mini", "studio"]);
    expect(p.hosts.find((h) => h.hostName === "ghost")?.liveness).toBe("offline");
  });

  it("populates pr fields best-effort from prGet, null otherwise", async () => {
    const p = await assembleClusterBoard({
      ...baseDeps,
      prGet: (id: string) => (id === "CTL-900" ? { number: 42, state: "OPEN" } : null),
    });
    expect(p.hosts[0].tickets[0]).toMatchObject({ pr: 42, prState: "OPEN" });
  });

  it("is deterministic and stamps generatedAt from injected now", async () => {
    const p = await assembleClusterBoard(baseDeps);
    expect(p.generatedAt).toBe(new Date(NOW).toISOString());
  });
});
