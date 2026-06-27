// cluster-roster.test.ts — CTL-1214 Phase 2. The project roster relocates from
// each repo's Layer-1 monitor.linear.teams[] to the cluster-scope
// cluster.json.projects[]; readClusterProjects() is the single precedence
// definition (cluster → Layer-1) every consumer now routes through.
//
// Determinism: every test points CATALYST_CLUSTER_DIR at a temp dir (the
// config.test.mjs convention) so a real ~/catalyst/catalyst-cluster/cluster.json
// on the host never bleeds into the cluster-absent fallback cases.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readClusterProjects } from "../lib/cluster-roster";
import { loadWebhookConfig } from "../lib/webhook-config";
import { loadMonitorConfig } from "../lib/monitor-config";
import { loadProjects } from "../lib/project-roster";

const ENVS = [
  "CATALYST_CLUSTER_DIR",
  "CATALYST_DIR",
  "CATALYST_CONFIG_FILE",
  "CATALYST_CONFIG_PATH",
  "CATALYST_WEBHOOK_SECRET",
];

describe("readClusterProjects (CTL-1214 Phase 2)", () => {
  let clusterDir: string;
  let repoDir: string;
  let homeDir: string;
  let saved: Record<string, string | undefined>;

  const clusterJson = (path: string) => join(path, "cluster.json");
  const layer1Path = () => join(repoDir, "config.json");

  const writeCluster = (projects: unknown) =>
    writeFileSync(
      clusterJson(clusterDir),
      JSON.stringify({ schemaVersion: 1, roster: ["mini"], projects }),
    );
  const writeLayer1Teams = (teams: unknown) =>
    writeFileSync(
      layer1Path(),
      JSON.stringify({ catalyst: { monitor: { linear: { teams } } } }),
    );

  beforeEach(() => {
    saved = {};
    for (const k of ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    clusterDir = mkdtempSync(join(tmpdir(), "ctl1214-cluster-"));
    repoDir = mkdtempSync(join(tmpdir(), "ctl1214-repo-"));
    homeDir = mkdtempSync(join(tmpdir(), "ctl1214-home-"));
    // An empty cluster dir → cluster.json absent → deterministic miss unless a
    // test writes one. Point the resolver at it so the host's real cluster repo
    // is never consulted.
    process.env.CATALYST_CLUSTER_DIR = clusterDir;
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(clusterDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns roster from cluster.json.projects[]", () => {
    writeCluster([
      { teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst", projectKey: "catalyst-workspace" },
      { teamKey: "ADV", vcsRepo: "groundworkapp/Adva", projectKey: "adva" },
    ]);
    // Layer-1 carries a DIFFERENT (stale) roster — cluster must win.
    writeLayer1Teams([{ key: "OLD", vcsRepo: "stale/repo" }]);

    const roster = readClusterProjects({ layer1ConfigPath: layer1Path() });
    expect(roster).toEqual([
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      { key: "ADV", vcsRepo: "groundworkapp/Adva" },
    ]);
  });

  it("falls back to Layer-1 monitor.linear.teams[] when cluster.json absent", () => {
    // clusterDir is empty (no cluster.json).
    writeLayer1Teams([
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      { key: "ADV", vcsRepo: "groundworkapp/Adva" },
    ]);

    const roster = readClusterProjects({ layer1ConfigPath: layer1Path() });
    expect(roster).toEqual([
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      { key: "ADV", vcsRepo: "groundworkapp/Adva" },
    ]);
  });

  it("falls back to Layer-1 when cluster.json has a malformed projects array (lose no value)", () => {
    // A present-but-useless cluster projects array must NOT shadow a populated
    // Layer-1 roster — the cluster source only wins on ≥1 valid entry.
    writeCluster([{ teamKey: "", vcsRepo: "no/key" }, { nope: true }]);
    writeLayer1Teams([{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }]);

    const roster = readClusterProjects({ layer1ConfigPath: layer1Path() });
    expect(roster).toEqual([{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }]);
  });

  it("returns [] when neither source resolves", () => {
    expect(readClusterProjects({ layer1ConfigPath: join(repoDir, "missing.json") })).toEqual([]);
  });

  it("cluster roster has no coalesce-labs/adva (uses groundworkapp/Adva)", () => {
    writeCluster([
      { teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst", projectKey: "catalyst-workspace" },
      { teamKey: "ADV", vcsRepo: "groundworkapp/Adva", projectKey: "adva" },
    ]);
    const roster = readClusterProjects({ layer1ConfigPath: layer1Path() });
    expect(roster.some((t) => t.vcsRepo === "coalesce-labs/adva")).toBe(false);
    expect(roster.find((t) => t.key === "ADV")?.vcsRepo).toBe("groundworkapp/Adva");
  });

  it("skips malformed cluster entries (empty teamKey / bad vcsRepo) but keeps valid ones", () => {
    writeCluster([
      { teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst", projectKey: "catalyst-workspace" },
      { teamKey: "", vcsRepo: "missing/key", projectKey: "x" },
      { teamKey: "BAD", vcsRepo: "no-slash", projectKey: "x" },
      { teamKey: "BAD2", vcsRepo: "too/many/slashes", projectKey: "x" },
    ]);
    const roster = readClusterProjects({ layer1ConfigPath: layer1Path() });
    expect(roster).toEqual([{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }]);
  });

  // ── Consumer wiring: all three route through readClusterProjects ───────────

  it("readLinearTeams() (webhook-config) sources from the cluster roster when present", () => {
    writeCluster([
      { teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst", projectKey: "catalyst-workspace" },
      { teamKey: "ADV", vcsRepo: "groundworkapp/Adva", projectKey: "adva" },
    ]);
    // Layer-1 has a stale single team; cluster must win for webhook annotation.
    writeFileSync(
      layer1Path(),
      JSON.stringify({ catalyst: { monitor: { linear: { teams: [{ key: "OLD", vcsRepo: "stale/repo" }] } } } }),
    );
    writeFileSync(
      join(homeDir, "config.json"),
      JSON.stringify({ catalyst: { monitor: { github: { smeeChannel: "https://smee.io/h" } } } }),
    );
    process.env.CATALYST_WEBHOOK_SECRET = "x";

    const cfg = loadWebhookConfig(homeDir, layer1Path());
    expect(cfg!.linearTeams).toEqual([
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      { key: "ADV", vcsRepo: "groundworkapp/Adva" },
    ]);
  });

  it("monitor-config repoOwners built from the cluster roster", () => {
    writeCluster([
      { teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst", projectKey: "catalyst-workspace" },
      { teamKey: "ADV", vcsRepo: "groundworkapp/Adva", projectKey: "adva" },
    ]);
    // Layer-1 only carries repoColors here (no teams) — repoOwners must come from cluster.
    const cfgPath = layer1Path();
    writeFileSync(
      cfgPath,
      JSON.stringify({ catalyst: { monitor: { github: { repoColors: { "coalesce-labs/catalyst": "green" } } } } }),
    );
    const noRegistry = join(repoDir, "no-registry.json");
    const cfg = loadMonitorConfig(cfgPath, noRegistry);
    expect(cfg.repoOwners).toEqual({
      catalyst: "coalesce-labs/catalyst",
      adva: "groundworkapp/Adva",
    });
    // repoColors still read from Layer-1.
    expect(cfg.repoColors["coalesce-labs/catalyst"]).toBe("green");
  });

  it("project-roster buildProjects() uses the cluster roster", () => {
    writeCluster([
      { teamKey: "CTL", vcsRepo: "coalesce-labs/catalyst", projectKey: "catalyst-workspace" },
      { teamKey: "ADV", vcsRepo: "groundworkapp/Adva", projectKey: "adva" },
    ]);
    const cfgPath = layer1Path();
    // Layer-1 carries no teams; the descriptors must come from the cluster roster.
    writeFileSync(cfgPath, JSON.stringify({ catalyst: {} }));
    const projects = loadProjects({
      configPath: cfgPath,
      registryPath: join(repoDir, "no-registry.json"),
      observedRepos: [],
    });
    const byKey = Object.fromEntries(projects.map((p) => [p.key, p.vcsRepo]));
    expect(byKey.CTL).toBe("coalesce-labs/catalyst");
    expect(byKey.ADV).toBe("groundworkapp/Adva");
    // The stale coalesce-labs/adva is gone.
    expect(projects.some((p) => p.vcsRepo === "coalesce-labs/adva")).toBe(false);
  });

  it("project-roster falls back to Layer-1 teams when cluster.json absent (back-compat)", () => {
    const cfgPath = layer1Path();
    writeFileSync(
      cfgPath,
      JSON.stringify({ catalyst: { monitor: { linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] } } } }),
    );
    const projects = loadProjects({
      configPath: cfgPath,
      registryPath: join(repoDir, "no-registry.json"),
      observedRepos: [],
    });
    expect(projects.find((p) => p.key === "CTL")?.vcsRepo).toBe("coalesce-labs/catalyst");
  });
});
