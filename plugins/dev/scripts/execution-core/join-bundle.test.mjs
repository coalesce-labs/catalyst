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
];

let saved = {};
let repoDir;
let layer2File;

function writeLayer1(cfg) {
  writeFileSync(join(repoDir, ".catalyst", "config.json"), JSON.stringify(cfg));
}
function writeHosts(arr) {
  writeFileSync(join(repoDir, ".catalyst", "hosts.json"), JSON.stringify(arr));
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
  mkdirSync(join(repoDir, ".catalyst"), { recursive: true });
  layer2File = join(repoDir, "layer2.json");

  process.env.CATALYST_CONFIG_FILE = join(repoDir, ".catalyst", "config.json");
  process.env.CATALYST_LAYER2_CONFIG_FILE = layer2File;
  process.env.CATALYST_HOST_NAME = "mini";

  writeLayer1(LAYER1_FIXTURE);
  writeHosts(["mini", "studio"]);
  writeLayer2(LAYER2_FIXTURE);
});

afterEach(() => {
  for (const k of BUNDLE_ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  saved = {};
  rmSync(repoDir, { recursive: true, force: true });
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
