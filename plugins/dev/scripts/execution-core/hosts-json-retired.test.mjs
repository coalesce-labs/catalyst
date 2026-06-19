// hosts-json-retired.test.mjs — CTL-1274 CI guard: the per-repo
// .catalyst/hosts.json roster file is RETIRED and must never come back.
//
// The fleet roster's single durable home is the catalyst-cluster GitHub repo
// (cluster.json.roster, read via resolveClusterHosts source=cluster-repo). The
// legacy per-repo hosts.json + its readers were removed in CTL-1274. This test
// is the build-time tripwire that fails CI if either (a) a committed
// .catalyst/hosts.json reappears in the catalyst repo, or (b) the resolver
// regrows a hosts-fallback source that reads a project hosts.json.
//
// Run: cd plugins/dev/scripts/execution-core && bun test hosts-json-retired.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveClusterHosts } from "./config.mjs";

describe("hosts.json retired (CTL-1274)", () => {
  test("the catalyst repo has NO committed .catalyst/hosts.json", () => {
    // Repo root is 4 levels up from the execution-core dir:
    //   hosts-json-retired.test.mjs → execution-core → scripts → dev → plugins → repo root
    const execCoreDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(execCoreDir, "../../../../");
    const hostsJson = resolve(repoRoot, ".catalyst", "hosts.json");
    expect(existsSync(hostsJson)).toBe(false);
  });

  describe("resolveClusterHosts exposes no hosts-fallback source", () => {
    const ENVS = [
      "CATALYST_CONFIG_FILE",
      "CATALYST_HOST_NAME",
      "CATALYST_LAYER2_CONFIG_FILE",
      "CATALYST_CLUSTER_DIR",
      "CATALYST_STATIC_ROSTER",
    ];
    let saved = {};
    let repo, cluster;

    beforeEach(() => {
      for (const k of ENVS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
      repo = mkdtempSync(join(tmpdir(), "ctl1274-guard-repo-"));
      cluster = mkdtempSync(join(tmpdir(), "ctl1274-guard-cluster-"));
      mkdirSync(join(repo, ".catalyst"), { recursive: true });
      // CATALYST_CONFIG_FILE points where a legacy reader WOULD resolve
      // <repoRoot>/.catalyst/hosts.json; the resolver must ignore it.
      process.env.CATALYST_CONFIG_FILE = join(repo, ".catalyst", "config.json");
      // An empty cluster dir → cluster.json absent → cluster-repo source misses.
      process.env.CATALYST_CLUSTER_DIR = cluster;
      process.env.CATALYST_HOST_NAME = "solo-host";
    });

    afterEach(() => {
      for (const k of ENVS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      saved = {};
      rmSync(repo, { recursive: true, force: true });
      rmSync(cluster, { recursive: true, force: true });
    });

    test("a present .catalyst/hosts.json is NEVER read (source=single-host, not hosts-fallback)", () => {
      // Drop a roster file exactly where the legacy reader looked. The resolver
      // must NOT consult it — with no cluster-repo and no static roster the only
      // legitimate outcome is the single-host default.
      writeFileSync(
        join(repo, ".catalyst", "hosts.json"),
        JSON.stringify(["legacy-a", "legacy-b"])
      );
      const r = resolveClusterHosts();
      expect(r.source).not.toBe("hosts-fallback");
      expect(r).toEqual({ hosts: ["solo-host"], source: "single-host", multiHost: false });
    });

    test("precedence is cluster-repo → static → single-host (no hosts-fallback rung)", () => {
      // cluster-repo wins when present.
      writeFileSync(
        join(cluster, "cluster.json"),
        JSON.stringify({ schemaVersion: 1, roster: ["mini", "mini-2"] })
      );
      // Even with a project hosts.json present, cluster-repo is authoritative.
      writeFileSync(
        join(repo, ".catalyst", "hosts.json"),
        JSON.stringify(["legacy-should-never-win"])
      );
      expect(resolveClusterHosts().source).toBe("cluster-repo");

      // Drop the cluster repo → static (Layer-2) takes over, NOT hosts-fallback.
      rmSync(join(cluster, "cluster.json"));
      const l2 = join(repo, "layer2.json");
      writeFileSync(
        l2,
        JSON.stringify({ catalyst: { cluster: { staticRoster: ["s-a", "s-b"] } } })
      );
      process.env.CATALYST_LAYER2_CONFIG_FILE = l2;
      expect(resolveClusterHosts().source).toBe("static");

      // Drop static too → single-host, never hosts-fallback even though the
      // project hosts.json still exists on disk.
      delete process.env.CATALYST_LAYER2_CONFIG_FILE;
      expect(resolveClusterHosts().source).toBe("single-host");
    });
  });
});
