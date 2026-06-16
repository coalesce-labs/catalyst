// cli-cluster.test.mjs — CTL-1188. Unit tests for cli/cluster.mjs.
// Run: cd plugins/dev/scripts/execution-core && bun test cli-cluster.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStatus,
  addHost,
  removeHost,
  renameHost,
  setAnchor,
  tune,
} from "./cli/cluster.mjs";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "cl-test-"));
}

function withRoster(initial, fn) {
  const dir = makeTmp();
  const p = join(dir, "hosts.json");
  writeFileSync(p, JSON.stringify(initial) + "\n");
  try {
    return fn(p, () => JSON.parse(readFileSync(p, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildStatus ────────────────────────────────────────────────────────────

describe("buildStatus (CTL-1188)", () => {
  test("single-host roster, no anchor → one self row, not live", () => {
    const out = buildStatus({
      roster: ["mini"],
      self: "mini",
      peers: {},
      draining: false,
    });
    expect(out.hosts).toHaveLength(1);
    expect(out.hosts[0]).toMatchObject({ name: "mini", self: true, live: false });
    expect(out.draining).toBe(false);
  });

  test("multi-host merges live heartbeats and flags stale roster members", () => {
    const out = buildStatus({
      roster: ["mini", "mac-studio"],
      self: "mini",
      peers: {
        mini: { host: "mini", last_seen: "2026-06-16T12:10:00Z", in_flight_tickets: ["CTL-1"] },
      },
      draining: false,
    });
    const mac = out.hosts.find((h) => h.name === "mac-studio");
    expect(mac.live).toBe(false);
    expect(out.hosts.find((h) => h.name === "mini").inFlight).toEqual(["CTL-1"]);
  });

  test("--json shape is stable (roster, draining, hosts[])", () => {
    const out = buildStatus({ roster: ["mini"], self: "mini", peers: {}, draining: true });
    expect(out).toHaveProperty("hosts");
    expect(out).toHaveProperty("draining", true);
    expect(out).toHaveProperty("roster");
    expect(out).toHaveProperty("self", "mini");
  });

  test("live peer present → live=true", () => {
    const out = buildStatus({
      roster: ["mini"],
      self: "mini",
      peers: { mini: { last_seen: "2026-06-16T12:00:00Z", in_flight_tickets: [] } },
      draining: false,
    });
    expect(out.hosts[0].live).toBe(true);
  });

  test("peer in_flight_tickets is empty array when absent from peers", () => {
    const out = buildStatus({ roster: ["mini"], self: "mini", peers: {}, draining: false });
    expect(out.hosts[0].inFlight).toEqual([]);
  });
});

// ── addHost ────────────────────────────────────────────────────────────────

describe("addHost", () => {
  test("appends a new name and commits", () => {
    withRoster(["mini"], (hostsPath, read) => {
      const committed = [];
      const r = addHost("mac-studio", {
        hostsPath,
        self: "mini",
        readPeers: () => ({}),
        git: (args) => committed.push(args),
        commit: true,
      });
      expect(r.code).toBe(0);
      expect(read()).toEqual(["mini", "mac-studio"]);
      expect(committed.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("idempotent: name already in roster → code 2, no write", () => {
    withRoster(["mini"], (hostsPath, read) => {
      const r = addHost("mini", { hostsPath, self: "mini", readPeers: () => ({}) });
      expect(r.code).toBe(2);
      expect(read()).toEqual(["mini"]);
    });
  });

  test("refuses a name already publishing a live heartbeat", () => {
    withRoster(["mini"], (hostsPath, read) => {
      const r = addHost("ghost", {
        hostsPath,
        self: "mini",
        readPeers: () => ({ ghost: { host: "ghost", last_seen: "2026-06-16T12:00:00Z" } }),
      });
      expect(r.code).toBe(2);
      expect(read()).toEqual(["mini"]);
    });
  });

  test("--no-commit writes but does not invoke git", () => {
    withRoster(["mini"], (hostsPath, read) => {
      const git = () => { throw new Error("should not commit"); };
      const r = addHost("mac-studio", {
        hostsPath,
        self: "mini",
        readPeers: () => ({}),
        git,
        commit: false,
      });
      expect(r.code).toBe(0);
      expect(read()).toEqual(["mini", "mac-studio"]);
    });
  });

  test("missing name → code 2", () => {
    withRoster(["mini"], (hostsPath) => {
      const r = addHost("", { hostsPath, self: "mini", readPeers: () => ({}) });
      expect(r.code).toBe(2);
    });
  });
});

// ── removeHost ─────────────────────────────────────────────────────────────

describe("removeHost", () => {
  test("removes a non-self name and commits", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read) => {
      const r = removeHost("mac-studio", {
        hostsPath,
        self: "mini",
        inFlightCount: () => 0,
        git: () => {},
        commit: true,
      });
      expect(r.code).toBe(0);
      expect(read()).toEqual(["mini"]);
    });
  });

  test("refuses removing self while in-flight > 0", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read) => {
      const r = removeHost("mini", {
        hostsPath,
        self: "mini",
        inFlightCount: () => 2,
      });
      expect(r.code).toBe(2);
      expect(read()).toEqual(["mini", "mac-studio"]);
    });
  });

  test("allows removing self when in-flight === 0", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read) => {
      const r = removeHost("mini", {
        hostsPath,
        self: "mini",
        inFlightCount: () => 0,
        git: () => {},
        commit: false,
      });
      expect(r.code).toBe(0);
      expect(read()).toEqual(["mac-studio"]);
    });
  });

  test("name not in roster → code 2", () => {
    withRoster(["mini"], (hostsPath) => {
      const r = removeHost("nope", { hostsPath, self: "mini", inFlightCount: () => 0 });
      expect(r.code).toBe(2);
    });
  });

  test("missing name → code 2", () => {
    withRoster(["mini"], (hostsPath) => {
      const r = removeHost("", { hostsPath, self: "mini", inFlightCount: () => 0 });
      expect(r.code).toBe(2);
    });
  });
});

// ── renameHost ─────────────────────────────────────────────────────────────

describe("renameHost", () => {
  test("writes Layer-2 host.name, swaps roster entry, signals restart-required", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read) => {
      const writes = [];
      const r = renameHost("mini-2", {
        hostsPath,
        self: "mini",
        writeLayer2: (obj) => writes.push(obj),
        git: () => {},
        commit: true,
      });
      expect(r.code).toBe(0);
      expect(r.restartRequired).toBe(true);
      expect(read()).toEqual(["mini-2", "mac-studio"]);
      expect(writes[0]).toMatchObject({ catalyst: { host: { name: "mini-2" } } });
    });
  });

  test("refuses if newname already in roster", () => {
    withRoster(["mini", "mac-studio"], (hostsPath) => {
      const r = renameHost("mac-studio", {
        hostsPath,
        self: "mini",
        writeLayer2: () => {},
      });
      expect(r.code).toBe(2);
    });
  });

  test("missing newname → code 2", () => {
    withRoster(["mini"], (hostsPath) => {
      const r = renameHost("", { hostsPath, self: "mini", writeLayer2: () => {} });
      expect(r.code).toBe(2);
    });
  });

  test("still writes Layer-2 even when self not in roster", () => {
    withRoster(["other"], (hostsPath, read) => {
      const writes = [];
      const r = renameHost("ghost-2", {
        hostsPath,
        self: "ghost",
        writeLayer2: (obj) => writes.push(obj),
        git: () => {},
        commit: false,
      });
      expect(r.code).toBe(0);
      expect(writes[0]).toMatchObject({ catalyst: { host: { name: "ghost-2" } } });
      expect(read()).toEqual(["other"]);
    });
  });
});

// ── setAnchor ──────────────────────────────────────────────────────────────

describe("setAnchor", () => {
  test("writes Layer-2 livenessAnchorIssue, signals restart-required", () => {
    const writes = [];
    const r = setAnchor("CTL-1090", { writeLayer2: (obj) => writes.push(obj) });
    expect(r.code).toBe(0);
    expect(r.restartRequired).toBe(true);
    expect(writes[0]).toMatchObject({
      catalyst: { cluster: { livenessAnchorIssue: "CTL-1090" } },
    });
  });

  test("rejects empty ticket arg", () => {
    const r = setAnchor("", { writeLayer2: () => {} });
    expect(r.code).toBe(2);
  });
});

// ── tune ───────────────────────────────────────────────────────────────────

describe("tune", () => {
  test("writes a numeric executionCore param to Layer-2 (live)", () => {
    const writes = [];
    const r = tune("maxParallel", "4", { writeLayer2: (o) => writes.push(o) });
    expect(r.code).toBe(0);
    expect(r.restartRequired).toBeFalsy();
    expect(writes[0]).toMatchObject({
      catalyst: { orchestration: { executionCore: { maxParallel: 4 } } },
    });
  });

  test("rejects unknown param", () => {
    const r = tune("bogus", "4", { writeLayer2: () => {} });
    expect(r.code).toBe(2);
  });

  test("rejects non-numeric value", () => {
    const r = tune("maxParallel", "lots", { writeLayer2: () => {} });
    expect(r.code).toBe(2);
  });

  test("rejects non-positive integer", () => {
    const r = tune("maxParallel", "0", { writeLayer2: () => {} });
    expect(r.code).toBe(2);
  });

  test("accepts minParallel and maxParallelCeiling", () => {
    const writes = [];
    expect(tune("minParallel", "2", { writeLayer2: (o) => writes.push(o) }).code).toBe(0);
    expect(tune("maxParallelCeiling", "8", { writeLayer2: (o) => writes.push(o) }).code).toBe(0);
    expect(writes[0]).toMatchObject({ catalyst: { orchestration: { executionCore: { minParallel: 2 } } } });
    expect(writes[1]).toMatchObject({ catalyst: { orchestration: { executionCore: { maxParallelCeiling: 8 } } } });
  });
});
