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

// withRoster — stage a legacy .catalyst/hosts.json plus a guaranteed-ABSENT
// clusterDir so the verb takes the legacy hosts-fallback path deterministically,
// regardless of any real ~/catalyst/catalyst-cluster clone on the test host. The
// callback receives (hostsPath, readHosts, noCluster) — pass `clusterDir:
// noCluster` to the verb under test.
function withRoster(initial, fn) {
  const dir = makeTmp();
  const p = join(dir, "hosts.json");
  const noCluster = join(dir, "no-such-cluster");
  writeFileSync(p, JSON.stringify(initial) + "\n");
  try {
    return fn(p, () => JSON.parse(readFileSync(p, "utf8")), noCluster);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// withClusterRepo — stage a catalyst-cluster clone whose cluster.json holds the
// given roster (and any extra keys to assert preservation). The callback receives
// (clusterDir, readCluster) where readCluster() parses the current cluster.json.
// CTL-1274: this is the active roster source the writer must edit.
function withClusterRepo(roster, fn, extra = {}) {
  const clusterDir = makeTmp();
  const p = join(clusterDir, "cluster.json");
  writeFileSync(p, JSON.stringify({ schemaVersion: 1, roster, ...extra }, null, 2) + "\n");
  try {
    return fn(clusterDir, () => JSON.parse(readFileSync(p, "utf8")));
  } finally {
    rmSync(clusterDir, { recursive: true, force: true });
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

describe("addHost (legacy hosts-fallback path — no cluster repo)", () => {
  test("appends a new name and commits", () => {
    withRoster(["mini"], (hostsPath, read, noCluster) => {
      const committed = [];
      const r = addHost("mac-studio", {
        hostsPath,
        clusterDir: noCluster,
        self: "mini",
        readPeers: () => ({}),
        git: (args) => committed.push(args),
        commit: true,
      });
      expect(r.code).toBe(0);
      expect(r.source).toBe("hosts-fallback");
      expect(read()).toEqual(["mini", "mac-studio"]);
      expect(committed.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("idempotent: name already in roster → code 2, no write", () => {
    withRoster(["mini"], (hostsPath, read, noCluster) => {
      const r = addHost("mini", { hostsPath, clusterDir: noCluster, self: "mini", readPeers: () => ({}) });
      expect(r.code).toBe(2);
      expect(read()).toEqual(["mini"]);
    });
  });

  test("refuses a name already publishing a live heartbeat", () => {
    withRoster(["mini"], (hostsPath, read, noCluster) => {
      const r = addHost("ghost", {
        hostsPath,
        clusterDir: noCluster,
        self: "mini",
        readPeers: () => ({ ghost: { host: "ghost", last_seen: "2026-06-16T12:00:00Z" } }),
      });
      expect(r.code).toBe(2);
      expect(read()).toEqual(["mini"]);
    });
  });

  test("--no-commit writes but does not invoke git", () => {
    withRoster(["mini"], (hostsPath, read, noCluster) => {
      const git = () => { throw new Error("should not commit"); };
      const r = addHost("mac-studio", {
        hostsPath,
        clusterDir: noCluster,
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
    withRoster(["mini"], (hostsPath, _read, noCluster) => {
      const r = addHost("", { hostsPath, clusterDir: noCluster, self: "mini", readPeers: () => ({}) });
      expect(r.code).toBe(2);
    });
  });
});

// CTL-1274: the cluster-repo writer path — add/remove/rename edit
// cluster.json.roster IN the catalyst-cluster clone (the SAME source the resolver
// reads, source=cluster-repo) and commit + push. git is injected so nothing shells out.
describe("addHost (cluster-repo writer path, CTL-1274)", () => {
  test("appends to cluster.json.roster, commits, and pushes — does NOT touch hosts.json", () => {
    withRoster(["legacy-untouched"], (hostsPath, readHosts, _noCluster) => {
      withClusterRepo(["mini"], (clusterDir, readCluster) => {
        const calls = [];
        const r = addHost("mini-2", {
          hostsPath,
          clusterDir,
          self: "mini",
          readPeers: () => ({}),
          git: (args) => calls.push(args),
          commit: true,
          push: true,
        });
        expect(r.code).toBe(0);
        expect(r.source).toBe("cluster-repo");
        expect(r.sync).toEqual({ committed: true, pushed: true });
        expect(readCluster().roster).toEqual(["mini", "mini-2"]);
        // a git add + commit + push all targeted the cluster clone
        expect(calls.some((a) => a.includes("-C") && a.includes(clusterDir) && a.includes("commit"))).toBe(true);
        expect(calls.some((a) => a.includes("-C") && a.includes(clusterDir) && a.includes("push"))).toBe(true);
        // legacy hosts.json untouched — the cluster repo is the single source
        expect(readHosts()).toEqual(["legacy-untouched"]);
      });
    });
  });

  test("preserves other cluster.json keys (anchorIssue, projects, schemaVersion)", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(
        ["mini"],
        (clusterDir, readCluster) => {
          const r = addHost("mini-2", {
            hostsPath,
            clusterDir,
            self: "mini",
            readPeers: () => ({}),
            git: () => {},
            commit: true,
          });
          expect(r.code).toBe(0);
          const cfg = readCluster();
          expect(cfg.roster).toEqual(["mini", "mini-2"]);
          expect(cfg.anchorIssue).toBe("CTL-1090");
          expect(cfg.projects).toEqual([{ teamKey: "CTL" }]);
          expect(cfg.schemaVersion).toBe(1);
        },
        { anchorIssue: "CTL-1090", projects: [{ teamKey: "CTL" }] },
      );
    });
  });

  test("idempotent: name already in the cluster roster → code 2, no write/commit", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini", "mini-2"], (clusterDir, readCluster) => {
        const r = addHost("mini-2", {
          hostsPath,
          clusterDir,
          self: "mini",
          readPeers: () => ({}),
          git: () => { throw new Error("should not commit on a no-op"); },
        });
        expect(r.code).toBe(2);
        expect(readCluster().roster).toEqual(["mini", "mini-2"]);
      });
    });
  });

  test("--no-commit writes cluster.json but does not invoke git", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini"], (clusterDir, readCluster) => {
        const r = addHost("mini-2", {
          hostsPath,
          clusterDir,
          self: "mini",
          readPeers: () => ({}),
          git: () => { throw new Error("should not commit"); },
          commit: false,
        });
        expect(r.code).toBe(0);
        expect(readCluster().roster).toEqual(["mini", "mini-2"]);
        expect(r.sync).toEqual({ committed: false, pushed: false });
      });
    });
  });

  test("FAIL-OPEN: push failure → committed:true, pushed:false (still code 0, write landed)", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini"], (clusterDir, readCluster) => {
        const git = (args) => {
          if (args.includes("push")) throw new Error("network down");
        };
        const r = addHost("mini-2", {
          hostsPath,
          clusterDir,
          self: "mini",
          readPeers: () => ({}),
          git,
          commit: true,
          push: true,
        });
        expect(r.code).toBe(0);
        expect(r.sync.committed).toBe(true);
        expect(r.sync.pushed).toBe(false);
        expect(r.sync.error).toContain("network down");
        expect(readCluster().roster).toEqual(["mini", "mini-2"]);
      });
    });
  });

  test("still refuses a name already publishing a live heartbeat on the cluster-repo path", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini"], (clusterDir) => {
        const r = addHost("ghost", {
          hostsPath,
          clusterDir,
          self: "mini",
          readPeers: () => ({ ghost: { host: "ghost", last_seen: "2026-06-16T12:00:00Z" } }),
          git: () => { throw new Error("must not commit a live-heartbeat name"); },
        });
        expect(r.code).toBe(2);
      });
    });
  });
});

// ── removeHost ─────────────────────────────────────────────────────────────

describe("removeHost (legacy hosts-fallback path — no cluster repo)", () => {
  test("removes a non-self name and commits", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read, noCluster) => {
      const r = removeHost("mac-studio", {
        hostsPath,
        clusterDir: noCluster,
        self: "mini",
        inFlightCount: () => 0,
        git: () => {},
        commit: true,
      });
      expect(r.code).toBe(0);
      expect(r.source).toBe("hosts-fallback");
      expect(read()).toEqual(["mini"]);
    });
  });

  test("refuses removing self while in-flight > 0", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read, noCluster) => {
      const r = removeHost("mini", {
        hostsPath,
        clusterDir: noCluster,
        self: "mini",
        inFlightCount: () => 2,
      });
      expect(r.code).toBe(2);
      expect(read()).toEqual(["mini", "mac-studio"]);
    });
  });

  test("allows removing self when in-flight === 0", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read, noCluster) => {
      const r = removeHost("mini", {
        hostsPath,
        clusterDir: noCluster,
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
    withRoster(["mini"], (hostsPath, _read, noCluster) => {
      const r = removeHost("nope", { hostsPath, clusterDir: noCluster, self: "mini", inFlightCount: () => 0 });
      expect(r.code).toBe(2);
    });
  });

  test("missing name → code 2", () => {
    withRoster(["mini"], (hostsPath, _read, noCluster) => {
      const r = removeHost("", { hostsPath, clusterDir: noCluster, self: "mini", inFlightCount: () => 0 });
      expect(r.code).toBe(2);
    });
  });
});

describe("removeHost (cluster-repo writer path, CTL-1274)", () => {
  test("removes from cluster.json.roster, commits, pushes — does NOT touch hosts.json", () => {
    withRoster(["legacy-untouched"], (hostsPath, readHosts, _noCluster) => {
      withClusterRepo(["mini", "mini-2"], (clusterDir, readCluster) => {
        const calls = [];
        const r = removeHost("mini-2", {
          hostsPath,
          clusterDir,
          self: "mini",
          inFlightCount: () => 0,
          git: (args) => calls.push(args),
          commit: true,
          push: true,
        });
        expect(r.code).toBe(0);
        expect(r.source).toBe("cluster-repo");
        expect(r.sync).toEqual({ committed: true, pushed: true });
        expect(readCluster().roster).toEqual(["mini"]);
        expect(calls.some((a) => a.includes(clusterDir) && a.includes("push"))).toBe(true);
        expect(readHosts()).toEqual(["legacy-untouched"]); // hosts.json untouched
      });
    });
  });

  test("absent name in the cluster roster → code 2 (not in roster)", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini"], (clusterDir, readCluster) => {
        const r = removeHost("ghost", {
          hostsPath,
          clusterDir,
          self: "mini",
          inFlightCount: () => 0,
          git: () => { throw new Error("must not commit a no-op remove"); },
        });
        expect(r.code).toBe(2);
        expect(readCluster().roster).toEqual(["mini"]);
      });
    });
  });

  test("FAIL-OPEN: push failure → committed:true, pushed:false (still code 0)", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini", "mini-2"], (clusterDir, readCluster) => {
        const git = (args) => {
          if (args.includes("push")) throw new Error("remote rejected");
        };
        const r = removeHost("mini-2", {
          hostsPath,
          clusterDir,
          self: "mini",
          inFlightCount: () => 0,
          git,
          commit: true,
          push: true,
        });
        expect(r.code).toBe(0);
        expect(r.sync.committed).toBe(true);
        expect(r.sync.pushed).toBe(false);
        expect(readCluster().roster).toEqual(["mini"]);
      });
    });
  });

  test("still refuses removing self while in-flight > 0 on the cluster-repo path", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini"], (clusterDir, readCluster) => {
        const r = removeHost("mini", {
          hostsPath,
          clusterDir,
          self: "mini",
          inFlightCount: () => 3,
          git: () => { throw new Error("must not commit while in-flight work exists"); },
        });
        expect(r.code).toBe(2);
        expect(readCluster().roster).toEqual(["mini"]);
      });
    });
  });
});

// ── renameHost ─────────────────────────────────────────────────────────────

describe("renameHost (legacy hosts-fallback path — no cluster repo)", () => {
  test("writes Layer-2 host.name, swaps roster entry, signals restart-required", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, read, noCluster) => {
      const writes = [];
      const r = renameHost("mini-2", {
        hostsPath,
        clusterDir: noCluster,
        self: "mini",
        writeLayer2: (obj) => writes.push(obj),
        git: () => {},
        commit: true,
      });
      expect(r.code).toBe(0);
      expect(r.restartRequired).toBe(true);
      expect(r.source).toBe("hosts-fallback");
      expect(read()).toEqual(["mini-2", "mac-studio"]);
      expect(writes[0]).toMatchObject({ catalyst: { host: { name: "mini-2" } } });
    });
  });

  test("refuses if newname already in roster", () => {
    withRoster(["mini", "mac-studio"], (hostsPath, _read, noCluster) => {
      const r = renameHost("mac-studio", {
        hostsPath,
        clusterDir: noCluster,
        self: "mini",
        writeLayer2: () => {},
      });
      expect(r.code).toBe(2);
    });
  });

  test("missing newname → code 2", () => {
    withRoster(["mini"], (hostsPath, _read, noCluster) => {
      const r = renameHost("", { hostsPath, clusterDir: noCluster, self: "mini", writeLayer2: () => {} });
      expect(r.code).toBe(2);
    });
  });

  test("still writes Layer-2 even when self not in roster", () => {
    withRoster(["other"], (hostsPath, read, noCluster) => {
      const writes = [];
      const r = renameHost("ghost-2", {
        hostsPath,
        clusterDir: noCluster,
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

describe("renameHost (cluster-repo writer path, CTL-1274)", () => {
  test("swaps self→newName in cluster.json.roster, commits, pushes, restart-required", () => {
    withRoster(["legacy-untouched"], (hostsPath, readHosts, _noCluster) => {
      withClusterRepo(["mini", "mac-studio"], (clusterDir, readCluster) => {
        const writes = [];
        const calls = [];
        const r = renameHost("mini-2", {
          hostsPath,
          clusterDir,
          self: "mini",
          writeLayer2: (obj) => writes.push(obj),
          git: (args) => calls.push(args),
          commit: true,
          push: true,
        });
        expect(r.code).toBe(0);
        expect(r.restartRequired).toBe(true);
        expect(r.source).toBe("cluster-repo");
        expect(r.sync).toEqual({ committed: true, pushed: true });
        expect(readCluster().roster).toEqual(["mini-2", "mac-studio"]);
        expect(writes[0]).toMatchObject({ catalyst: { host: { name: "mini-2" } } });
        expect(calls.some((a) => a.includes(clusterDir) && a.includes("push"))).toBe(true);
        expect(readHosts()).toEqual(["legacy-untouched"]); // hosts.json untouched
      });
    });
  });

  test("refuses if newname already in the cluster roster", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["mini", "mac-studio"], (clusterDir, readCluster) => {
        const r = renameHost("mac-studio", {
          hostsPath,
          clusterDir,
          self: "mini",
          writeLayer2: () => { throw new Error("must not write Layer-2 on a refused rename"); },
        });
        expect(r.code).toBe(2);
        expect(readCluster().roster).toEqual(["mini", "mac-studio"]);
      });
    });
  });

  test("writes Layer-2 but leaves the cluster roster alone when self not in roster", () => {
    withRoster(["x"], (hostsPath, _readHosts, _noCluster) => {
      withClusterRepo(["other"], (clusterDir, readCluster) => {
        const writes = [];
        const r = renameHost("ghost-2", {
          hostsPath,
          clusterDir,
          self: "ghost",
          writeLayer2: (obj) => writes.push(obj),
          git: () => { throw new Error("must not commit when self not in roster"); },
          commit: true,
        });
        expect(r.code).toBe(0);
        expect(r.source).toBe("cluster-repo");
        expect(writes[0]).toMatchObject({ catalyst: { host: { name: "ghost-2" } } });
        expect(readCluster().roster).toEqual(["other"]);
      });
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
