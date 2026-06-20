// join-bundle.test.mjs — Phase 1 unit tests for CTL-1183 bundle assembler.
// Run: cd plugins/dev/scripts/execution-core && bun test join-bundle.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleJoinBundle,
  redactBundleForLog,
  JOIN_BUNDLE_SCHEMA_VERSION,
} from "./join-bundle.mjs";

const BUNDLE_ENVS = [
  "CATALYST_CONFIG_FILE",
  "CATALYST_LAYER2_CONFIG_FILE",
  "CATALYST_HOST_NAME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "CATALYST_LIVENESS_ANCHOR_ISSUE",
  // CTL-1214 PATH-B #3: the registry-path override (controls where listProjects()
  // resolves repoRoot) MUST be saved/restored — the detached-listener test below
  // sets it, and assembleJoinBundle() MUTATES CATALYST_CONFIG_FILE as a side
  // effect, so a leak would corrupt later tests.
  "CATALYST_DIR",
  // CTL-1274: the roster comes from the catalyst-cluster repo (cluster.json),
  // resolved via CATALYST_CLUSTER_DIR — saved/restored so the fixture clone here
  // never leaks into other suites that share the default ~/catalyst path.
  "CATALYST_CLUSTER_DIR",
  // CTL-1231: claude settings.json path override (extractClaudeSettings).
  "CATALYST_CLAUDE_SETTINGS_FILE",
];

let saved = {};
let repoDir;
let clusterDir;
let layer2File;

function writeLayer1(cfg) {
  writeFileSync(join(repoDir, ".catalyst", "config.json"), JSON.stringify(cfg));
}
// CTL-1274: the join-bundle roster is sourced from the catalyst-cluster repo's
// cluster.json (NOT a per-repo .catalyst/hosts.json, which is RETIRED).
function writeClusterRoster(arr) {
  writeFileSync(
    join(clusterDir, "cluster.json"),
    JSON.stringify({ schemaVersion: 1, roster: arr }),
  );
}
function writeLayer2(cfg) {
  writeFileSync(layer2File, JSON.stringify(cfg));
}

const LAYER1_FIXTURE = {
  catalyst: {
    projectKey: "catalyst-workspace",
    linear: {
      teamKey: "CTL",
      teamId: "team-uuid-1234",
      stateMap: { Todo: "state-1", "In Progress": "state-2" },
    },
  },
};

const LAYER2_FIXTURE = {
  catalyst: {
    linear: {
      bot: {
        orchestrator: { accessToken: "lin_oauth_orch" },
        worker: { accessToken: "lin_oauth_worker", clientSecret: "secret-worker" },
      },
    },
    cluster: {
      livenessAnchorIssue: "CTL-1090",
    },
    repository: { org: "coalesce-labs", name: "catalyst" },
    orchestration: { pluginDirs: ["/nonexistent-for-test"] },
  },
};

beforeEach(() => {
  for (const k of BUNDLE_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }

  repoDir = mkdtempSync(join(tmpdir(), "jb-test-"));
  clusterDir = mkdtempSync(join(tmpdir(), "jb-cluster-"));
  mkdirSync(join(repoDir, ".catalyst"), { recursive: true });
  layer2File = join(repoDir, "layer2.json");

  process.env.CATALYST_CONFIG_FILE = join(repoDir, ".catalyst", "config.json");
  process.env.CATALYST_LAYER2_CONFIG_FILE = layer2File;
  process.env.CATALYST_CLUSTER_DIR = clusterDir;
  process.env.CATALYST_HOST_NAME = "mini";

  writeLayer1(LAYER1_FIXTURE);
  writeClusterRoster(["mini", "studio"]);
  writeLayer2(LAYER2_FIXTURE);
});

afterEach(() => {
  for (const k of BUNDLE_ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  saved = {};
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(clusterDir, { recursive: true, force: true });
});

describe("assembleJoinBundle", () => {
  test("assembles all SHARED fields from layer-1 + layer-2 fixtures", () => {
    const b = assembleJoinBundle();
    expect(b.schemaVersion).toBe(JOIN_BUNDLE_SCHEMA_VERSION);
    expect(b.hostsRoster).toEqual(["mini", "studio"]);
    expect(b.livenessAnchorIssue).toBe("CTL-1090");
    expect(b.layer1Identity).toEqual({
      projectKey: "catalyst-workspace",
      teamKey: "CTL",
      teamId: "team-uuid-1234",
      stateMap: expect.any(Object),
    });
    expect(b.repoUrl).toBe("coalesce-labs/catalyst");
    expect(b.pluginSourceUrl).toBeTruthy(); // falls back to repoUrl
    expect(b.otlpEndpointHint).toBeNull(); // not set in fixture
  });

  test("botCreds carry accessToken for both bots, read from GLOBAL config", () => {
    const b = assembleJoinBundle();
    expect(b.botCreds.orchestrator.accessToken).toBe("lin_oauth_orch");
    expect(b.botCreds.worker.accessToken).toBe("lin_oauth_worker");
  });

  test("bundle contains NO per-node items", () => {
    const b = assembleJoinBundle();
    expect(b).not.toHaveProperty("host");
    expect(b).not.toHaveProperty("repoRoots");
    expect(b).not.toHaveProperty("eventLog");
    expect(JSON.stringify(b)).not.toContain('"host.name"');
  });

  test("livenessAnchorIssue is null when unset (single-host)", () => {
    writeLayer2({
      ...LAYER2_FIXTURE,
      catalyst: { ...LAYER2_FIXTURE.catalyst, cluster: {} },
    });
    expect(assembleJoinBundle().livenessAnchorIssue).toBeNull();
  });

  test("OTEL_EXPORTER_OTLP_ENDPOINT env overrides layer2 hint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel.test:4318";
    const b = assembleJoinBundle();
    expect(b.otlpEndpointHint).toBe("http://otel.test:4318");
  });

  test("layer2 cluster.otlpEndpointHint used when env is absent", () => {
    writeLayer2({
      ...LAYER2_FIXTURE,
      catalyst: {
        ...LAYER2_FIXTURE.catalyst,
        cluster: { ...LAYER2_FIXTURE.catalyst.cluster, otlpEndpointHint: "http://from-l2:4318" },
      },
    });
    const b = assembleJoinBundle();
    expect(b.otlpEndpointHint).toBe("http://from-l2:4318");
  });

  // CTL-1284: non-secret webhook wiring (smee channels + per-team webhookId map).
  test("monitorWebhooks is null when the seed has no monitor block", () => {
    expect(assembleJoinBundle().monitorWebhooks).toBeNull();
  });

  test("monitorWebhooks carries non-secret smee channels + per-team webhookId map", () => {
    writeLayer2({
      ...LAYER2_FIXTURE,
      catalyst: {
        ...LAYER2_FIXTURE.catalyst,
        monitor: {
          github: { smeeChannel: "https://smee.io/GH", webhookSecretEnv: "X" },
          linear: {
            smeeChannel: "https://smee.io/LIN",
            ctl: { webhookId: "wh-ctl", smeeChannel: "https://smee.io/LIN", registeredAt: "2026-01-01", resourceTypes: ["Issue"] },
            adv: { webhookId: "wh-adv" },
          },
        },
      },
    });
    const wh = assembleJoinBundle().monitorWebhooks;
    expect(wh.github).toEqual({ smeeChannel: "https://smee.io/GH" });
    expect(wh.linear.smeeChannel).toBe("https://smee.io/LIN");
    expect(wh.linear.ctl).toEqual({
      webhookId: "wh-ctl",
      smeeChannel: "https://smee.io/LIN",
      resourceTypes: ["Issue"],
    });
    expect(wh.linear.adv).toEqual({ webhookId: "wh-adv" });
    // registeredAt is dropped; no secrets ever appear.
    expect(JSON.stringify(wh)).not.toContain("registeredAt");
    expect(JSON.stringify(wh)).not.toContain("Secret");
    expect(JSON.stringify(wh)).not.toContain("secret");
  });

  // CTL-1231: allow-listed, secret-free ~/.claude/settings.json slice. The
  // extractor reads $HOME/.claude/settings.json, so point HOME at a fixture dir.
  test("claudeSettings carries allow-listed keys and EXCLUDES secrets/per-host/paths", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "jb-home-"));
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const settingsFile = join(fakeHome, ".claude", "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        model: "claude-opus-4-8",
        cleanupPeriodDays: 30,
        alwaysThinkingEnabled: true,
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_METRICS_EXPORTER: "otlp",
          OTEL_SERVICE_NAME: "catalyst",
          // these MUST be excluded:
          AIRTABLE_API_KEY: "secret-airtable",
          SHADCN_TOKEN: "secret-shadcn",
          OTEL_RESOURCE_ATTRIBUTES: "host.name=laptop",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://laptop:4317",
          GITHUB_SOURCE_ROOT: "/Users/laptop/code",
        },
      }),
    );
    const savedSettings = process.env.CATALYST_CLAUDE_SETTINGS_FILE;
    process.env.CATALYST_CLAUDE_SETTINGS_FILE = settingsFile;
    try {
      const cs = assembleJoinBundle().claudeSettings;
      expect(cs.model).toBe("claude-opus-4-8");
      expect(cs.cleanupPeriodDays).toBe(30);
      expect(cs.alwaysThinkingEnabled).toBe(true);
      expect(cs.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
      expect(cs.env.OTEL_SERVICE_NAME).toBe("catalyst");
      // exclusions — none of these may appear anywhere in the slice
      const blob = JSON.stringify(cs);
      expect(blob).not.toContain("secret-airtable");
      expect(blob).not.toContain("secret-shadcn");
      expect(blob).not.toContain("AIRTABLE_API_KEY");
      expect(blob).not.toContain("OTEL_RESOURCE_ATTRIBUTES");
      expect(blob).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      expect(blob).not.toContain("GITHUB_SOURCE_ROOT");
    } finally {
      if (savedSettings === undefined) delete process.env.CATALYST_CLAUDE_SETTINGS_FILE;
      else process.env.CATALYST_CLAUDE_SETTINGS_FILE = savedSettings;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("missing layer2 produces null/empty fields without throwing", () => {
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(repoDir, "absent.json");
    const b = assembleJoinBundle();
    expect(b.schemaVersion).toBe(JOIN_BUNDLE_SCHEMA_VERSION);
    expect(b.botCreds.orchestrator).toBeNull();
    expect(b.botCreds.worker).toBeNull();
  });

  test("missing layer1 produces null layer1Identity fields without throwing", () => {
    process.env.CATALYST_CONFIG_FILE = join(repoDir, ".catalyst", "absent.json");
    const b = assembleJoinBundle();
    expect(b.layer1Identity.projectKey).toBeNull();
    expect(b.layer1Identity.teamKey).toBeNull();
  });

  // CTL-1214 PATH-B #3 (bug #3) + CTL-1274: the detached `nohup` join-listener runs
  // with cwd=HOME and NO CATALYST_CONFIG_FILE in its env. Before the fix, layer1Path()
  // resolved <cwd>/.catalyst/config.json → null projectKey/teamKey/stateMap. The fix
  // resolves the Layer-1 identity from the execution-core registry's first project
  // repoRoot (listProjects()[0]). Post-CTL-1274 the ROSTER no longer comes from a
  // per-repo hosts.json — it comes from the catalyst-cluster repo (cluster.json,
  // CATALYST_CLUSTER_DIR set in beforeEach), independent of cwd and of which repoRoot
  // the registry yields.
  //
  // The existing beforeEach masks the identity bug because it always sets
  // CATALYST_CONFIG_FILE. This test reproduces the real detached environment: delete
  // the override, chdir to a non-repo tmp dir, and point the registry (via
  // CATALYST_DIR) at a fixture repo that owns the committed Layer-1 config.
  test("detached listener (no CATALYST_CONFIG_FILE, cwd=non-repo) resolves layer1 identity from registry repoRoot; roster from cluster repo", () => {
    // A scratch repoRoot OTHER than repoDir, carrying the committed .catalyst tree.
    const fixtureRepo = mkdtempSync(join(tmpdir(), "jb-registry-repo-"));
    const cwdSandbox = mkdtempSync(join(tmpdir(), "jb-nonrepo-cwd-"));
    const catalystDir = mkdtempSync(join(tmpdir(), "jb-catalyst-dir-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(fixtureRepo, ".catalyst"), { recursive: true });
      writeFileSync(
        join(fixtureRepo, ".catalyst", "config.json"),
        JSON.stringify(LAYER1_FIXTURE),
      );

      // The roster comes from the catalyst-cluster repo (CATALYST_CLUSTER_DIR is
      // still set by beforeEach). Make it a multi-host list so the assertion below
      // proves the bundle ships the real cluster roster, not a single-host default.
      const MULTI_HOST_ROSTER = ["mini", "studio", "mini-2"];
      writeClusterRoster(MULTI_HOST_ROSTER);

      // Layer-2 is still resolved via CATALYST_LAYER2_CONFIG_FILE (set in
      // beforeEach), so the bot creds / liveness anchor remain available; only
      // the cwd-relative Layer-1 read is under test here.

      // Point the execution-core registry at the fixture repoRoot. getRegistryPath()
      // = <CATALYST_DIR>/execution-core/registry.json.
      process.env.CATALYST_DIR = catalystDir;
      mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
      writeFileSync(
        join(catalystDir, "execution-core", "registry.json"),
        JSON.stringify({
          projects: [{ team: "CTL", repoRoot: fixtureRepo, eligibleQuery: null }],
        }),
      );

      // Reproduce the detached listener environment.
      delete process.env.CATALYST_CONFIG_FILE;
      process.chdir(cwdSandbox);

      const b = assembleJoinBundle();

      // Layer-1 identity must be POPULATED from the registry repoRoot, not null.
      expect(b.layer1Identity.projectKey).toBe("catalyst-workspace");
      expect(b.layer1Identity.teamKey).toBe("CTL");
      expect(b.layer1Identity.teamId).toBe("team-uuid-1234");
      expect(b.layer1Identity.stateMap).toEqual({ Todo: "state-1", "In Progress": "state-2" });

      // Roster must be the cluster-repo MULTI-host list, NOT the single-host default.
      expect(b.hostsRoster).toEqual(MULTI_HOST_ROSTER);
      expect(b.hostsRoster.length).toBeGreaterThan(1);
    } finally {
      process.chdir(originalCwd);
      // assembleJoinBundle() MUTATES CATALYST_CONFIG_FILE when it was unset — wipe
      // it here too (afterEach restores from `saved`, which holds the pre-test
      // value; this prevents the mutation leaking inside this test's own teardown).
      delete process.env.CATALYST_CONFIG_FILE;
      rmSync(fixtureRepo, { recursive: true, force: true });
      rmSync(cwdSandbox, { recursive: true, force: true });
      rmSync(catalystDir, { recursive: true, force: true });
    }
  });

  // CTL-1274: a multi-team seed (registry has >1 project) no longer disambiguates
  // the identity repo by hosts.json ownership (RETIRED). registryRepoRoot() returns
  // the FIRST project's repoRoot (the primary/coordination team). The roster still
  // comes from the cluster repo, independent of the chosen repoRoot.
  test("multi-team registry: identity resolves from the first project repoRoot (no hosts.json disambiguation)", () => {
    const primaryRepo = mkdtempSync(join(tmpdir(), "jb-primary-repo-"));
    const otherRepo = mkdtempSync(join(tmpdir(), "jb-other-repo-"));
    const cwdSandbox = mkdtempSync(join(tmpdir(), "jb-multi-cwd-"));
    const catalystDir = mkdtempSync(join(tmpdir(), "jb-multi-catalyst-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(primaryRepo, ".catalyst"), { recursive: true });
      writeFileSync(
        join(primaryRepo, ".catalyst", "config.json"),
        JSON.stringify(LAYER1_FIXTURE),
      );
      mkdirSync(join(otherRepo, ".catalyst"), { recursive: true });
      writeFileSync(
        join(otherRepo, ".catalyst", "config.json"),
        JSON.stringify({ catalyst: { projectKey: "other", linear: { teamKey: "OTL" } } }),
      );

      writeClusterRoster(["mini", "studio"]);

      process.env.CATALYST_DIR = catalystDir;
      mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
      writeFileSync(
        join(catalystDir, "execution-core", "registry.json"),
        JSON.stringify({
          projects: [
            { team: "CTL", repoRoot: primaryRepo, eligibleQuery: null },
            { team: "OTL", repoRoot: otherRepo, eligibleQuery: null },
          ],
        }),
      );

      delete process.env.CATALYST_CONFIG_FILE;
      process.chdir(cwdSandbox);

      const b = assembleJoinBundle();

      // Identity is the FIRST project's (CTL), not the second.
      expect(b.layer1Identity.projectKey).toBe("catalyst-workspace");
      expect(b.layer1Identity.teamKey).toBe("CTL");
      expect(b.hostsRoster).toEqual(["mini", "studio"]);
    } finally {
      process.chdir(originalCwd);
      delete process.env.CATALYST_CONFIG_FILE;
      rmSync(primaryRepo, { recursive: true, force: true });
      rmSync(otherRepo, { recursive: true, force: true });
      rmSync(cwdSandbox, { recursive: true, force: true });
      rmSync(catalystDir, { recursive: true, force: true });
    }
  });
});

describe("redactBundleForLog", () => {
  test("replaces botCreds entirely with sentinel string", () => {
    const r = redactBundleForLog(assembleJoinBundle());
    expect(r.botCreds).toBe("[REDACTED]");
  });

  test("serialized log contains no token values", () => {
    const r = redactBundleForLog(assembleJoinBundle());
    expect(JSON.stringify(r)).not.toContain("lin_oauth_");
    expect(JSON.stringify(r)).not.toContain("secret-worker");
  });

  test("non-secret fields survive redaction", () => {
    const r = redactBundleForLog(assembleJoinBundle());
    expect(r.schemaVersion).toBe(JOIN_BUNDLE_SCHEMA_VERSION);
    expect(r.hostsRoster).toEqual(["mini", "studio"]);
    expect(r.repoUrl).toBe("coalesce-labs/catalyst");
  });
});
