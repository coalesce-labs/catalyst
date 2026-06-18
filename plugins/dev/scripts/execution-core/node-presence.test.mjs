// node-presence.test.mjs — CTL-1272. Hermetic tests for the NEW additive
// liveness source (Tailscale device presence + peer-HTTP /healthz over the
// tailnet). Everything is injected: a fake `exec` seam stands in for
// `tailscale status --json` and a fake `fetchImpl` stands in for the /healthz
// GET, so no real binary is spawned and no real network is touched.
//
// The fixture mirrors the REAL fleet shape captured this session (verified live
// 2026-06-18): Self{HostName:"Ryan's MacBook Pro", DNSName:"ryans-macbook-pro…",
// Online:true}; Peer{ RyansMini250233 → DNSName mini.tail…, Online:true; mini-2
// → DNSName mini-2.tail…, Online:true; an Online:false entry } — Tags null
// fleet-wide, so name-mapping (nameMap + DNSName-first-label fallback) is the
// usable path, NOT tags.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  readTailscaleStatus,
  tailscaleNameForRoster,
  tailscaleOnline,
  probePeerHealth,
  isHostLive,
  readLivePeers,
} from "./node-presence.mjs";

// ─── fixtures ────────────────────────────────────────────────────────────────

// Real-shaped `tailscale status --json` payload. RyansMini250233 maps to roster
// "mini" via its DNSName first label; mini-2's HostName already matches roster.
function fakeStatusJson() {
  return JSON.stringify({
    Self: {
      HostName: "Ryan's MacBook Pro",
      DNSName: "ryans-macbook-pro.tail32996b.ts.net.",
      Online: true,
      Tags: null,
    },
    Peer: {
      "nodekey:aaa": {
        HostName: "RyansMini250233",
        DNSName: "mini.tail32996b.ts.net.",
        Online: true,
        LastSeen: "0001-01-01T00:00:00Z",
        Tags: null,
      },
      "nodekey:bbb": {
        HostName: "mini-2",
        DNSName: "mini-2.tail32996b.ts.net.",
        Online: true,
        LastSeen: "0001-01-01T00:00:00Z",
        Tags: null,
      },
      "nodekey:ccc": {
        HostName: "studio",
        DNSName: "studio.tail32996b.ts.net.",
        Online: false,
        LastSeen: "2026-06-02T11:57:13.1Z",
        Tags: null,
      },
    },
  });
}

// An exec seam that returns the fixture stdout (mirrors execFileSync's string
// return). Records the binary + args it was asked to run.
function fakeExec(stdout) {
  const calls = [];
  const exec = (file, args) => {
    calls.push({ file, args });
    return stdout;
  };
  exec.calls = calls;
  return exec;
}

// An exec seam that throws (binary missing / spawn failure).
function throwingExec(message = "spawn ENOENT") {
  return () => {
    throw new Error(message);
  };
}

// A fetchImpl returning a canned /healthz Response. body is an object → JSON.
function fakeFetch(status, body) {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

// A fetchImpl that rejects (network down).
function rejectingFetch(message = "fetch failed") {
  return async () => {
    throw new Error(message);
  };
}

const NAME_MAP = { RyansMini250233: "mini" };

// ─── env save/restore (self-exclusion in readLivePeers uses getHostName) ─────

let savedHostName;
beforeEach(() => {
  savedHostName = process.env.CATALYST_HOST_NAME;
});
afterEach(() => {
  if (savedHostName === undefined) delete process.env.CATALYST_HOST_NAME;
  else process.env.CATALYST_HOST_NAME = savedHostName;
});

// ─── readTailscaleStatus ─────────────────────────────────────────────────────

describe("readTailscaleStatus", () => {
  it("parses `tailscale status --json` stdout into { Self, Peer } via the injected exec", () => {
    const exec = fakeExec(fakeStatusJson());
    const status = readTailscaleStatus({ exec });
    expect(status).not.toBeNull();
    expect(status.Self.HostName).toBe("Ryan's MacBook Pro");
    expect(Object.keys(status.Peer)).toHaveLength(3);
    // It actually invoked the seam (no real binary).
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args).toEqual(expect.arrayContaining(["status", "--json"]));
  });

  it("returns null (never throws) when the exec throws — binary missing / spawn error", () => {
    const status = readTailscaleStatus({ exec: throwingExec() });
    expect(status).toBeNull();
  });

  it("returns null on malformed / non-JSON stdout", () => {
    const status = readTailscaleStatus({ exec: fakeExec("not json at all <<<") });
    expect(status).toBeNull();
  });
});

// ─── tailscaleNameForRoster ──────────────────────────────────────────────────

describe("tailscaleNameForRoster", () => {
  it("nameMap entry takes precedence (RyansMini250233 → mini)", () => {
    const node = { HostName: "RyansMini250233", DNSName: "mini.tail32996b.ts.net." };
    expect(tailscaleNameForRoster(node, { nameMap: NAME_MAP })).toBe("mini");
  });

  it("falls back to the DNSName first DNS label when no map matches", () => {
    const node = { HostName: "RyansMini250233", DNSName: "mini.tail32996b.ts.net." };
    expect(tailscaleNameForRoster(node, { nameMap: {} })).toBe("mini");
  });

  it("uses HostName verbatim when there is no map and no usable DNSName", () => {
    const node = { HostName: "mini-2", DNSName: "" };
    expect(tailscaleNameForRoster(node, {})).toBe("mini-2");
  });
});

// ─── tailscaleOnline ─────────────────────────────────────────────────────────

describe("tailscaleOnline", () => {
  const status = JSON.parse(fakeStatusJson());

  it("mapped peer with Online===true → true (RyansMini250233 → mini via nameMap)", () => {
    expect(tailscaleOnline(status, "mini", { nameMap: NAME_MAP })).toBe(true);
  });

  it("peer present but Online===false → false (definitive offline)", () => {
    expect(tailscaleOnline(status, "studio", { nameMap: NAME_MAP })).toBe(false);
  });

  it("host absent from status (not in Self/Peer) → false", () => {
    expect(tailscaleOnline(status, "ghost", { nameMap: NAME_MAP })).toBe(false);
  });

  it("null status → false", () => {
    expect(tailscaleOnline(null, "mini", { nameMap: NAME_MAP })).toBe(false);
  });
});

// ─── probePeerHealth ─────────────────────────────────────────────────────────

describe("probePeerHealth", () => {
  it("200 with fresh tick → reachable + up + healthy", async () => {
    const fetchImpl = fakeFetch(200, {
      host: "mini",
      daemonAlive: true,
      lastTickAgeMs: 5_000,
    });
    const res = await probePeerHealth("mini", {
      baseUrl: "http://mini:7400",
      fetchImpl,
      staleMs: 120_000,
    });
    expect(res.reachable).toBe(true);
    expect(res.up).toBe(true);
    expect(res.healthy).toBe(true);
    expect(res.lastTickAgeMs).toBe(5_000);
  });

  it("200 but lastTickAgeMs > staleMs (wedged daemon) → up but NOT healthy", async () => {
    const fetchImpl = fakeFetch(200, {
      host: "mini",
      daemonAlive: true,
      lastTickAgeMs: 900_000,
    });
    const res = await probePeerHealth("mini", {
      baseUrl: "http://mini:7400",
      fetchImpl,
      staleMs: 120_000,
    });
    expect(res.reachable).toBe(true);
    expect(res.up).toBe(true);
    expect(res.healthy).toBe(false);
  });

  it("fetch rejects (network down) → { reachable:false }, never throws", async () => {
    const res = await probePeerHealth("mini", {
      baseUrl: "http://mini:7400",
      fetchImpl: rejectingFetch(),
      staleMs: 120_000,
    });
    expect(res.reachable).toBe(false);
    expect(res.healthy).toBe(false);
  });

  it("non-2xx (503) → reachable false / not healthy", async () => {
    const res = await probePeerHealth("mini", {
      baseUrl: "http://mini:7400",
      fetchImpl: fakeFetch(503, { error: "down" }),
      staleMs: 120_000,
    });
    expect(res.reachable).toBe(false);
    expect(res.healthy).toBe(false);
  });

  it("200 but unparseable/garbage body → not healthy (does not throw)", async () => {
    const res = await probePeerHealth("mini", {
      baseUrl: "http://mini:7400",
      fetchImpl: fakeFetch(200, "<<garbage not json>>"),
      staleMs: 120_000,
    });
    expect(res.healthy).toBe(false);
  });
});

// ─── isHostLive ──────────────────────────────────────────────────────────────

describe("isHostLive", () => {
  const status = JSON.parse(fakeStatusJson());

  it("online AND healthy → live=true", async () => {
    const res = await isHostLive("mini", {
      status,
      nameMap: NAME_MAP,
      baseUrl: "http://mini:7400",
      fetchImpl: fakeFetch(200, { host: "mini", daemonAlive: true, lastTickAgeMs: 5_000 }),
      staleMs: 120_000,
    });
    expect(res.live).toBe(true);
    expect(res.online).toBe(true);
    expect(res.healthy).toBe(true);
  });

  it("Online===false (definitive) → live=false (work-rehome implied; online:false)", async () => {
    const res = await isHostLive("studio", {
      status,
      nameMap: NAME_MAP,
      baseUrl: "http://studio:7400",
      fetchImpl: fakeFetch(200, { host: "studio", daemonAlive: true, lastTickAgeMs: 5_000 }),
      staleMs: 120_000,
    });
    expect(res.online).toBe(false);
    expect(res.live).toBe(false);
  });

  it("reachable-but-wedged (Online true, /healthz stale tick) → live=false (not merely reachable)", async () => {
    const res = await isHostLive("mini", {
      status,
      nameMap: NAME_MAP,
      baseUrl: "http://mini:7400",
      fetchImpl: fakeFetch(200, { host: "mini", daemonAlive: true, lastTickAgeMs: 900_000 }),
      staleMs: 120_000,
    });
    expect(res.online).toBe(true);
    expect(res.reachable).toBe(true);
    expect(res.healthy).toBe(false);
    expect(res.live).toBe(false);
  });

  it("FAIL-OPEN: null tailscale status (probe infra error) → live=true (assume live, no mass-eviction)", async () => {
    const res = await isHostLive("mini", {
      status: null,
      nameMap: NAME_MAP,
      baseUrl: "http://mini:7400",
      fetchImpl: fakeFetch(200, { host: "mini", daemonAlive: true, lastTickAgeMs: 5_000 }),
      staleMs: 120_000,
    });
    expect(res.live).toBe(true);
    expect(res.source).toBe("fail-open");
  });

  it("FAIL-OPEN: exec spawn failure (status read throws) → live=true", async () => {
    const res = await isHostLive("mini", {
      exec: throwingExec(),
      nameMap: NAME_MAP,
      baseUrl: "http://mini:7400",
      fetchImpl: fakeFetch(200, { host: "mini", daemonAlive: true, lastTickAgeMs: 5_000 }),
      staleMs: 120_000,
    });
    expect(res.live).toBe(true);
    expect(res.source).toBe("fail-open");
  });

  it("FAIL-OPEN: /healthz fetch throws while Tailscale Online=true → degrade to assume-live", async () => {
    const res = await isHostLive("mini", {
      status,
      nameMap: NAME_MAP,
      baseUrl: "http://mini:7400",
      fetchImpl: rejectingFetch(),
      staleMs: 120_000,
    });
    expect(res.online).toBe(true);
    expect(res.reachable).toBe(false);
    expect(res.live).toBe(true);
    expect(res.source).toBe("fail-open");
  });
});

// ─── readLivePeers ───────────────────────────────────────────────────────────

describe("readLivePeers", () => {
  const status = JSON.parse(fakeStatusJson());

  it("maps over a roster minus self; one online+healthy, one Online=false → correct per-host", async () => {
    process.env.CATALYST_HOST_NAME = "laptop"; // self not in roster → both probed
    // mini → online+healthy; studio → Online=false
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes("mini")) {
        return new Response(
          JSON.stringify({ host: "mini", daemonAlive: true, lastTickAgeMs: 5_000 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ host: "studio", daemonAlive: true, lastTickAgeMs: 5_000 }),
        { status: 200 },
      );
    };
    const out = await readLivePeers(["mini", "studio"], {
      status,
      nameMap: NAME_MAP,
      fetchImpl,
      baseUrlFor: (host) => `http://${host}:7400`,
      staleMs: 120_000,
    });
    expect(out.mini.live).toBe(true);
    expect(out.mini.online).toBe(true);
    expect(out.mini.healthy).toBe(true);
    expect(out.studio.online).toBe(false);
    expect(out.studio.live).toBe(false);
  });

  it("self is always live and never probed against itself", async () => {
    process.env.CATALYST_HOST_NAME = "mini";
    let selfProbed = false;
    const fetchImpl = async (url) => {
      if (String(url).includes("mini")) selfProbed = true; // self URL would contain "mini"
      return new Response(
        JSON.stringify({ host: "studio", daemonAlive: true, lastTickAgeMs: 5_000 }),
        { status: 200 },
      );
    };
    const out = await readLivePeers(["mini", "studio"], {
      status,
      nameMap: NAME_MAP,
      fetchImpl,
      baseUrlFor: (host) => `http://${host}:7400`,
      staleMs: 120_000,
    });
    expect(out.mini.live).toBe(true);
    expect(out.mini.source).toBe("self");
    expect(out.mini.online).toBe(true);
    // self (mini) was excluded from probing — only studio's URL was fetched.
    expect(selfProbed).toBe(false);
  });

  it("name-mapping end-to-end: roster [mini] + nameMap {RyansMini250233:mini} + healthy /healthz → mini live", async () => {
    process.env.CATALYST_HOST_NAME = "laptop";
    const out = await readLivePeers(["mini"], {
      status,
      nameMap: NAME_MAP,
      fetchImpl: fakeFetch(200, { host: "mini", daemonAlive: true, lastTickAgeMs: 5_000 }),
      baseUrlFor: (host) => `http://${host}:7400`,
      staleMs: 120_000,
    });
    expect(out.mini.live).toBe(true);
    expect(out.mini.online).toBe(true);
    expect(out.mini.healthy).toBe(true);
  });
});
