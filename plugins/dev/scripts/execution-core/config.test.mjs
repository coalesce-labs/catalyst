// config.test.mjs — CTL-650 Phase 4 + CTL-685 + CTL-684. Config knobs:
//   readWaitWatcherConfig() → { enabled, intervalMs }
//   readMemorySamplerConfig() → { enabled, intervalMs, warnThresholdMb,
//                                  killThresholdMb, killEnabled, killSustainedSamples }
//   CTL-684: auto-tuner config constants and kill-switch.
//
// Run: cd plugins/dev/scripts/execution-core && bun test config.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  readWaitWatcherConfig,
  EVENT_DEBOUNCE_MS,
  readMemorySamplerConfig,
  readRatelimitPollerConfig,
  AUTOTUNE_SAMPLE_INTERVAL_MS,
  AUTOTUNE_WINDOW_SAMPLES,
  AUTOTUNE_TREND_MIN_SAMPLES,
  AUTOTUNE_LOAD_SAFE_FACTOR,
  AUTOTUNE_MEM_CRITICAL_PCT,
  AUTOTUNE_MEM_WARN_PCT,
  AUTOTUNE_ENABLED,
  getHostName,
  getClusterHosts,
  HEARTBEAT_INTERVAL_MS,
  hostMembershipWarning,
  getDrainFlagPath,
  isDraining,
  getDrainedMarkerPath,
  applyBootDrainPolicy,
  getLivenessAnchorIssue,
  LIVENESS_PUBLISH_INTERVAL_MS,
  getStaticRoster,
  resolveClusterHosts,
  CLUSTER_SYNC_INTERVAL_MS,
  readDeadDocWorkerConfig,
  readBoardHealthConfig,
  readProjectionReadConfig, // CTL-1489
  readCoordinationConfig,
  getCoordinationMirrorPath,
  readSanctionedNeedsHuman,
  DEAD_DOC_WORKER_TRANSCRIPT_SILENCE_MS,
  readLinearReplica,
  getReplicaDbPath,
  EXECUTORS,
  DISPATCH_MODES,
  readExecutorLayer1,
  resolveExecutor,
  getExecutor,
  dispatchModeForExecutor,
  resolveExecutorForPhase,
  hasInProcessExecutorRoute,
  codexConfig,
} from "./config.mjs";

const PREV = process.env.CATALYST_WAIT_WATCHER;

afterEach(() => {
  if (PREV === undefined) delete process.env.CATALYST_WAIT_WATCHER;
  else process.env.CATALYST_WAIT_WATCHER = PREV;
});

describe("readWaitWatcherConfig", () => {
  test("defaults to enabled with the EVENT_DEBOUNCE_MS interval", () => {
    delete process.env.CATALYST_WAIT_WATCHER;
    const cfg = readWaitWatcherConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalMs).toBe(EVENT_DEBOUNCE_MS);
  });

  test("CATALYST_WAIT_WATCHER=0 disables it", () => {
    process.env.CATALYST_WAIT_WATCHER = "0";
    expect(readWaitWatcherConfig().enabled).toBe(false);
  });

  test("any other value keeps it enabled", () => {
    process.env.CATALYST_WAIT_WATCHER = "1";
    expect(readWaitWatcherConfig().enabled).toBe(true);
  });
});

// CTL-685: memory-sampler config knob tests.
const MEM_ENVS = [
  "CATALYST_MEMORY_SAMPLER",
  "EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS",
  "EXECUTION_CORE_WORKER_RSS_WARN_MB",
  "EXECUTION_CORE_WORKER_RSS_KILL_MB",
  "EXECUTION_CORE_WORKER_OOM_KILLER",
  "EXECUTION_CORE_KILL_SUSTAINED_SAMPLES",
];
let savedMemEnvs = {};

beforeEach(() => {
  for (const k of MEM_ENVS) {
    savedMemEnvs[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MEM_ENVS) {
    if (savedMemEnvs[k] === undefined) delete process.env[k];
    else process.env[k] = savedMemEnvs[k];
  }
  savedMemEnvs = {};
});

describe("readMemorySamplerConfig (CTL-685)", () => {
  test("returns defaults when env is unset", () => {
    const cfg = readMemorySamplerConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalMs).toBe(30_000);
    expect(cfg.warnThresholdMb).toBe(1500);
    expect(cfg.killThresholdMb).toBe(4000);
    expect(cfg.killEnabled).toBe(true);
    expect(cfg.killSustainedSamples).toBe(3);
  });

  test("CATALYST_MEMORY_SAMPLER=0 disables the sampler", () => {
    process.env.CATALYST_MEMORY_SAMPLER = "0";
    expect(readMemorySamplerConfig().enabled).toBe(false);
  });

  test("any non-zero CATALYST_MEMORY_SAMPLER keeps it enabled", () => {
    process.env.CATALYST_MEMORY_SAMPLER = "1";
    expect(readMemorySamplerConfig().enabled).toBe(true);
  });

  test("EXECUTION_CORE_WORKER_OOM_KILLER=0 disables kill", () => {
    process.env.EXECUTION_CORE_WORKER_OOM_KILLER = "0";
    expect(readMemorySamplerConfig().killEnabled).toBe(false);
  });

  test("numeric env overrides parse correctly", () => {
    process.env.EXECUTION_CORE_WORKER_RSS_WARN_MB = "2048";
    process.env.EXECUTION_CORE_WORKER_RSS_KILL_MB = "6000";
    process.env.EXECUTION_CORE_KILL_SUSTAINED_SAMPLES = "5";
    process.env.EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS = "60000";
    const cfg = readMemorySamplerConfig();
    expect(cfg.warnThresholdMb).toBe(2048);
    expect(cfg.killThresholdMb).toBe(6000);
    expect(cfg.killSustainedSamples).toBe(5);
    expect(cfg.intervalMs).toBe(60000);
  });

  test("non-numeric interval falls back to 30000", () => {
    process.env.EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS = "not-a-number";
    expect(readMemorySamplerConfig().intervalMs).toBe(30_000);
  });

  test("zero interval falls back to 30000", () => {
    process.env.EXECUTION_CORE_MEMORY_SAMPLE_INTERVAL_MS = "0";
    expect(readMemorySamplerConfig().intervalMs).toBe(30_000);
  });
});

// CTL-787: rate-limit poller config knob tests.
const RL_ENVS = [
  "CATALYST_RATELIMIT_POLLER",
  "EXECUTION_CORE_RATELIMIT_POLL_INTERVAL_MS",
  "EXECUTION_CORE_RATELIMIT_USAGE_ENDPOINT",
];
let savedRlEnvs = {};

describe("readRatelimitPollerConfig (CTL-787)", () => {
  beforeEach(() => {
    for (const k of RL_ENVS) {
      savedRlEnvs[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of RL_ENVS) {
      if (savedRlEnvs[k] === undefined) delete process.env[k];
      else process.env[k] = savedRlEnvs[k];
    }
    savedRlEnvs = {};
  });

  test("returns defaults when env is unset", () => {
    const cfg = readRatelimitPollerConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.intervalMs).toBe(300000);
    expect(cfg.usageEndpoint).toBe("https://api.anthropic.com/api/oauth/usage");
  });

  test("CATALYST_RATELIMIT_POLLER=0 disables the poller", () => {
    process.env.CATALYST_RATELIMIT_POLLER = "0";
    expect(readRatelimitPollerConfig().enabled).toBe(false);
  });

  test("any non-zero CATALYST_RATELIMIT_POLLER keeps it enabled", () => {
    process.env.CATALYST_RATELIMIT_POLLER = "1";
    expect(readRatelimitPollerConfig().enabled).toBe(true);
  });

  test("numeric interval override parses correctly", () => {
    process.env.EXECUTION_CORE_RATELIMIT_POLL_INTERVAL_MS = "600000";
    expect(readRatelimitPollerConfig().intervalMs).toBe(600000);
  });

  test("non-numeric interval falls back to 300000", () => {
    process.env.EXECUTION_CORE_RATELIMIT_POLL_INTERVAL_MS = "nope";
    expect(readRatelimitPollerConfig().intervalMs).toBe(300000);
  });

  test("custom usage endpoint override is honored", () => {
    process.env.EXECUTION_CORE_RATELIMIT_USAGE_ENDPOINT = "https://example/usage";
    expect(readRatelimitPollerConfig().usageEndpoint).toBe("https://example/usage");
  });
});

// CTL-684: auto-tuner config constants.
// Note: env vars are read at module import time, so we test the already-imported
// default values here (the module is loaded once per test run). Env-override
// tests require a fresh require/import which is not straightforward in ESM — the
// defaults are tested by asserting the expected literals below.
describe("auto-tuner defaults (CTL-684)", () => {
  test("AUTOTUNE_SAMPLE_INTERVAL_MS defaults to 30000", () => {
    expect(AUTOTUNE_SAMPLE_INTERVAL_MS).toBe(30_000);
  });

  test("AUTOTUNE_WINDOW_SAMPLES defaults to 10", () => {
    expect(AUTOTUNE_WINDOW_SAMPLES).toBe(10);
  });

  test("AUTOTUNE_TREND_MIN_SAMPLES defaults to 3", () => {
    expect(AUTOTUNE_TREND_MIN_SAMPLES).toBe(3);
  });

  test("AUTOTUNE_LOAD_SAFE_FACTOR defaults to 4", () => {
    expect(AUTOTUNE_LOAD_SAFE_FACTOR).toBe(4);
  });

  test("AUTOTUNE_MEM_CRITICAL_PCT defaults to 5", () => {
    expect(AUTOTUNE_MEM_CRITICAL_PCT).toBe(5);
  });

  test("AUTOTUNE_MEM_WARN_PCT defaults to 20", () => {
    expect(AUTOTUNE_MEM_WARN_PCT).toBe(20);
  });

  test("AUTOTUNE_ENABLED defaults to true (kill-switch off)", () => {
    expect(AUTOTUNE_ENABLED).toBe(true);
  });
});

// CTL-859: host identity + cluster roster.
describe("getHostName (CTL-859)", () => {
  const HOST_ENVS = ["CATALYST_HOST_NAME", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {};
  let tmp;

  beforeEach(() => {
    for (const k of HOST_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), "ctl859-host-"));
  });

  afterEach(() => {
    for (const k of HOST_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    saved = {};
    rmSync(tmp, { recursive: true, force: true });
  });

  test("defaults to os.hostname() with trailing .local stripped", () => {
    // Point Layer-2 at a non-existent file so the hostname default is exercised.
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
    const expected = hostname().replace(/\.local$/, "");
    expect(getHostName()).toBe(expected);
  });

  test("reads catalyst.host.name from the Layer-2 config file", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { host: { name: "mac-studio" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(getHostName()).toBe("mac-studio");
  });

  test("CATALYST_HOST_NAME env wins over the Layer-2 config file", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { host: { name: "from-file" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_HOST_NAME = "from-env";
    expect(getHostName()).toBe("from-env");
  });

  test("malformed Layer-2 file falls back to the hostname default", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, "{ this is not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    const expected = hostname().replace(/\.local$/, "");
    expect(getHostName()).toBe(expected);
  });
});

describe("getClusterHosts cluster-repo source (CTL-859 / CTL-1211 / CTL-1274)", () => {
  // CTL-1274: the per-repo .catalyst/hosts.json roster is RETIRED. The roster's
  // single durable home is the catalyst-cluster repo's cluster.json. A project
  // hosts.json (still present on disk in legacy checkouts) MUST be ignored — when
  // neither cluster-repo nor static resolves, the single-host default is the only
  // outcome and NO project file is read. CATALYST_CONFIG_FILE is still set so any
  // accidental regrowth of a project-hosts.json reader would be caught here.
  const ENVS = ["CATALYST_CONFIG_FILE", "CATALYST_HOST_NAME", "CATALYST_LAYER2_CONFIG_FILE", "CATALYST_CLUSTER_DIR"];
  let saved = {};
  let repo, cluster;

  beforeEach(() => {
    for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    repo = mkdtempSync(join(tmpdir(), "ctl1274-repo-"));
    cluster = mkdtempSync(join(tmpdir(), "ctl1274-cluster-"));
    mkdirSync(join(repo, ".catalyst"), { recursive: true });
    process.env.CATALYST_CONFIG_FILE = join(repo, ".catalyst", "config.json");
    process.env.CATALYST_CLUSTER_DIR = cluster;
    process.env.CATALYST_HOST_NAME = "solo-host";
  });

  afterEach(() => {
    for (const k of ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    saved = {};
    rmSync(repo, { recursive: true, force: true });
    rmSync(cluster, { recursive: true, force: true });
  });

  const writeCluster = (obj) => writeFileSync(join(cluster, "cluster.json"), JSON.stringify(obj));
  const writeProject = (arr) => writeFileSync(join(repo, ".catalyst", "hosts.json"), JSON.stringify(arr));

  test("reads roster from cluster.json when present", () => {
    writeCluster({ schemaVersion: 1, roster: ["mini", "mini-2"] });
    expect(getClusterHosts()).toEqual(["mini", "mini-2"]);
  });

  test("cluster.json roster wins; a present project hosts.json is ignored", () => {
    writeCluster({ schemaVersion: 1, roster: ["mini", "mini-2"] });
    writeProject(["legacy-should-never-win"]);
    expect(getClusterHosts()).toEqual(["mini", "mini-2"]);
  });

  test("single-host default when cluster.json absent — project hosts.json is NOT read", () => {
    // A legacy hosts.json on disk must be inert (the retired fallback).
    writeProject(["legacy-a", "legacy-b"]);
    expect(getClusterHosts()).toEqual(["solo-host"]);
  });

  test("ignores a too-new cluster schemaVersion and degrades to single-host (no project read)", () => {
    writeCluster({ schemaVersion: 999, roster: ["should", "be", "ignored"] });
    writeProject(["legacy-ignored"]);
    expect(getClusterHosts()).toEqual(["solo-host"]);
  });

  test("empty cluster roster degrades to single-host (no project read)", () => {
    writeCluster({ schemaVersion: 1, roster: [] });
    writeProject(["legacy-ignored"]);
    expect(getClusterHosts()).toEqual(["solo-host"]);
  });

  test("filters non-string entries from the cluster roster", () => {
    writeCluster({ schemaVersion: 1, roster: ["mini", 42, "", "mini-2"] });
    expect(getClusterHosts()).toEqual(["mini", "mini-2"]);
  });

  test("unversioned cluster.json is treated as v1 and read", () => {
    writeCluster({ roster: ["mini", "mini-2"] });
    expect(getClusterHosts()).toEqual(["mini", "mini-2"]);
  });
});

// CTL-1273 seam, CTL-1274 source swap + per-repo hosts.json retirement: the roster
// resolver — cluster-repo → static → single-host. Every source is a file read
// redirected via env (CATALYST_CLUSTER_DIR / CATALYST_LAYER2_CONFIG_FILE), so these
// tests are fully hermetic with no spawn/Linear.
describe("getStaticRoster (CTL-1273)", () => {
  const ENVS = ["CATALYST_LAYER2_CONFIG_FILE", "CATALYST_STATIC_ROSTER"];
  let saved = {};
  let tmp, cfg;

  beforeEach(() => {
    for (const k of ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), "ctl1273-static-"));
    cfg = join(tmp, "config.json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    saved = {};
    rmSync(tmp, { recursive: true, force: true });
  });

  test("reads catalyst.cluster.staticRoster from Layer-2", () => {
    writeFileSync(cfg, JSON.stringify({ catalyst: { cluster: { staticRoster: ["mini", "mini-2"] } } }));
    expect(getStaticRoster()).toEqual(["mini", "mini-2"]);
  });

  test("filters non-string / empty entries", () => {
    writeFileSync(cfg, JSON.stringify({ catalyst: { cluster: { staticRoster: ["mini", 42, "", "x"] } } }));
    expect(getStaticRoster()).toEqual(["mini", "x"]);
  });

  test("unset / empty array / malformed → null", () => {
    writeFileSync(cfg, JSON.stringify({ catalyst: { cluster: {} } }));
    expect(getStaticRoster()).toBe(null);
    writeFileSync(cfg, JSON.stringify({ catalyst: { cluster: { staticRoster: [] } } }));
    expect(getStaticRoster()).toBe(null);
    writeFileSync(cfg, "{ not json");
    expect(getStaticRoster()).toBe(null);
  });

  test("CATALYST_STATIC_ROSTER env override (comma-separated)", () => {
    process.env.CATALYST_STATIC_ROSTER = "mini, mini-2 ,";
    expect(getStaticRoster()).toEqual(["mini", "mini-2"]);
  });
});

describe("executor flag + resolver (CTL-1365a)", () => {
  // CATALYST_NODE_CLASS + a temp Layer-2 file keep the node-class default
  // deterministic (worker → "bg" in Phase 1) so the precedence assertions don't
  // depend on the host's real Layer-2 config.
  const ENVS = ["CATALYST_EXECUTOR", "CATALYST_NODE_CLASS", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {};
  let tmp, l1, l2;

  beforeEach(() => {
    for (const k of ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), "ctl1365-exec-"));
    l1 = join(tmp, "config.json"); // Layer-1 .catalyst/config.json
    l2 = join(tmp, "layer2.json"); // Layer-2 machine-local (empty → node-class default worker)
    process.env.CATALYST_LAYER2_CONFIG_FILE = l2;
  });

  afterEach(() => {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    saved = {};
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeL1 = (executor) =>
    writeFileSync(l1, JSON.stringify({ catalyst: { orchestration: { executor } } }));

  test("EXECUTORS + DISPATCH_MODES are frozen closed enums", () => {
    expect(EXECUTORS).toEqual(["bg", "sdk", "oneshot-legacy", "codex-exec"]);
    expect(Object.isFrozen(EXECUTORS)).toBe(true);
    expect(DISPATCH_MODES).toEqual(["phase-agents", "oneshot-legacy", "sdk", "codex-exec"]);
    expect(Object.isFrozen(DISPATCH_MODES)).toBe(true);
    expect(() => {
      EXECUTORS.push("rogue");
    }).toThrow();
  });

  test("dispatchModeForExecutor maps bg→phase-agents, sdk→sdk, oneshot-legacy→oneshot-legacy, codex-exec→codex-exec, unknown→phase-agents", () => {
    expect(dispatchModeForExecutor("bg")).toBe("phase-agents");
    expect(dispatchModeForExecutor("sdk")).toBe("sdk");
    expect(dispatchModeForExecutor("oneshot-legacy")).toBe("oneshot-legacy");
    expect(dispatchModeForExecutor("codex-exec")).toBe("codex-exec");
    expect(dispatchModeForExecutor("nonsense")).toBe("phase-agents");
    expect(dispatchModeForExecutor(undefined)).toBe("phase-agents");
  });

  test("node-class default is bg in Phase 1 (no env, no Layer-1)", () => {
    const r = resolveExecutor(l1); // l1 does not exist yet
    expect(r.executor).toBe("bg");
    expect(r.source).toBe("default");
    expect(r.inferred).toBe(true);
    expect(r.recognized).toBe(true);
    expect(getExecutor(l1)).toBe("bg");
  });

  test("Layer-1 catalyst.orchestration.executor overrides the node-class default", () => {
    writeL1("sdk");
    const r = resolveExecutor(l1);
    expect(r.executor).toBe("sdk");
    expect(r.source).toBe("layer1");
    expect(r.inferred).toBe(false);
    expect(getExecutor(l1)).toBe("sdk");
  });

  test("CATALYST_EXECUTOR env outranks Layer-1 (env > Layer-1 > node-class default)", () => {
    writeL1("oneshot-legacy");
    process.env.CATALYST_EXECUTOR = "sdk";
    const r = resolveExecutor(l1);
    expect(r.executor).toBe("sdk");
    expect(r.source).toBe("env");
    expect(getExecutor(l1)).toBe("sdk");
  });

  test("env/Layer-1 values are trimmed + lowercased to canonical executors", () => {
    process.env.CATALYST_EXECUTOR = "  SDK ";
    expect(resolveExecutor(l1).executor).toBe("sdk");
    delete process.env.CATALYST_EXECUTOR;
    writeL1("ONESHOT-LEGACY");
    expect(resolveExecutor(l1).executor).toBe("oneshot-legacy");
  });

  test("unrecognized explicit value → bg (most restrictive) + recognized:false", () => {
    process.env.CATALYST_EXECUTOR = "bgg";
    const r = resolveExecutor(l1);
    expect(r.executor).toBe("bg");
    expect(r.recognized).toBe(false);
    expect(r.raw).toBe("bgg");
  });

  test("getExecutor warns exactly ONCE per unique unrecognized value", () => {
    const warnings = [];
    const orig = console.warn;
    // The console-shim path logs WARN to stderr; capture via process.stderr.write.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      warnings.push(String(chunk));
      return true;
    };
    try {
      process.env.CATALYST_EXECUTOR = "ctl1365-unique-typo-A";
      getExecutor(l1);
      getExecutor(l1);
      getExecutor(l1);
    } finally {
      process.stderr.write = origWrite;
      console.warn = orig;
    }
    const hits = warnings.filter((w) => w.includes("ctl1365-unique-typo-A"));
    expect(hits.length).toBe(1); // warn-once dedupe
  });

  test("present-but-non-string Layer-1 value → bg + recognized:false (never silent sdk)", () => {
    writeFileSync(l1, JSON.stringify({ catalyst: { orchestration: { executor: false } } }));
    const r = resolveExecutor(l1);
    expect(r.executor).toBe("bg");
    expect(r.recognized).toBe(false);
  });

  test("ENOENT / malformed Layer-1 → bg, never throws", () => {
    // Missing file (readExecutorLayer1 returns undefined → node-class default).
    expect(() => resolveExecutor(join(tmp, "does-not-exist.json"))).not.toThrow();
    expect(resolveExecutor(join(tmp, "does-not-exist.json")).executor).toBe("bg");
    expect(readExecutorLayer1(join(tmp, "does-not-exist.json"))).toBeUndefined();
    // Malformed JSON.
    writeFileSync(l1, "{ not json");
    expect(() => resolveExecutor(l1)).not.toThrow();
    expect(resolveExecutor(l1).executor).toBe("bg");
    // No configPath at all.
    expect(readExecutorLayer1(undefined)).toBeUndefined();
    expect(resolveExecutor(undefined).executor).toBe("bg");
  });

  test("empty-string env is 'cleared' → node-class default", () => {
    process.env.CATALYST_EXECUTOR = "   ";
    writeL1("sdk"); // empty env falls through to Layer-1
    expect(resolveExecutor(l1).executor).toBe("sdk");
  });

  // --- CTL-1457: codex-exec value, compound aliases, per-phase routing, codexConfig ---

  test("resolveExecutor accepts codex-exec + canonicalizes compound aliases; rejects unknown (existing behavior preserved)", () => {
    process.env.CATALYST_EXECUTOR = "codex-exec";
    const r = resolveExecutor(l1);
    expect(r.executor).toBe("codex-exec");
    expect(r.recognized).toBe(true);

    // compound aliases canonicalize to the bare value
    process.env.CATALYST_EXECUTOR = "claude-bg";
    expect(resolveExecutor(l1).executor).toBe("bg");
    process.env.CATALYST_EXECUTOR = "claude-sdk";
    expect(resolveExecutor(l1).executor).toBe("sdk");
    process.env.CATALYST_EXECUTOR = "claude-oneshot";
    expect(resolveExecutor(l1).executor).toBe("oneshot-legacy");
    // aliases are case-normalized (normalized is already toLowerCase)
    process.env.CATALYST_EXECUTOR = "  CLAUDE-SDK ";
    expect(resolveExecutor(l1).executor).toBe("sdk");

    // an unknown value is STILL rejected → bg (most restrictive) + recognized:false
    process.env.CATALYST_EXECUTOR = "totally-bogus";
    const u = resolveExecutor(l1);
    expect(u.executor).toBe("bg");
    expect(u.recognized).toBe(false);
  });

  const writeExecutorByPhase = (map) =>
    writeFileSync(l1, JSON.stringify({ catalyst: { orchestration: { executorByPhase: map } } }));

  test("resolveExecutorForPhase returns the executorByPhase entry when the phase is routed", () => {
    writeExecutorByPhase({ triage: "codex-exec" });
    const r = resolveExecutorForPhase("triage", { configPath: l1 });
    expect(r.executor).toBe("codex-exec");
    expect(r.source).toBe("executorByPhase");
  });

  test("resolveExecutorForPhase canonicalizes a compound alias in the map", () => {
    writeExecutorByPhase({ triage: "claude-sdk" });
    expect(resolveExecutorForPhase("triage", { configPath: l1 }).executor).toBe("sdk");
  });

  test("resolveExecutorForPhase falls back to the node executor when the phase key is absent (unrouted = today)", () => {
    writeExecutorByPhase({ triage: "codex-exec" });
    const r = resolveExecutorForPhase("implement", { configPath: l1 });
    expect(r.executor).toBe("bg"); // node-class default; unrouted behaves exactly as before
    expect(r.source).toBe("default");
  });

  test("resolveExecutorForPhase with NO executorByPhase key returns the node executor", () => {
    writeL1("sdk"); // top-level executor only, no per-phase map
    expect(resolveExecutorForPhase("triage", { configPath: l1 }).executor).toBe("sdk");
  });

  test("resolveExecutorForPhase THROWS on an unknown executor value in the map (no silent fallback)", () => {
    writeExecutorByPhase({ triage: "gpt-9000" });
    expect(() => resolveExecutorForPhase("triage", { configPath: l1 })).toThrow(/gpt-9000/);
    expect(() => resolveExecutorForPhase("triage", { configPath: l1 })).toThrow(/triage/);
  });

  // CTL-1457 (N1): hasInProcessExecutorRoute — does the map route ANY phase in-process?
  test("hasInProcessExecutorRoute: true when a phase routes to codex-exec", () => {
    expect(hasInProcessExecutorRoute({ triage: "codex-exec" })).toBe(true);
  });
  test("hasInProcessExecutorRoute: true when a phase routes to sdk", () => {
    expect(hasInProcessExecutorRoute({ implement: "sdk" })).toBe(true);
  });
  test("hasInProcessExecutorRoute: true via a compound alias (claude-sdk→sdk)", () => {
    expect(hasInProcessExecutorRoute({ plan: "claude-sdk" })).toBe(true);
  });
  test("hasInProcessExecutorRoute: false for an all-bg map (no in-process route)", () => {
    expect(hasInProcessExecutorRoute({ triage: "bg", plan: "claude-bg" })).toBe(false);
  });
  test("hasInProcessExecutorRoute: false for an empty / absent / non-object map", () => {
    expect(hasInProcessExecutorRoute({})).toBe(false);
    expect(hasInProcessExecutorRoute(undefined)).toBe(false);
    expect(hasInProcessExecutorRoute(null)).toBe(false);
    expect(hasInProcessExecutorRoute("codex-exec")).toBe(false); // non-object → false
  });
  test("hasInProcessExecutorRoute: case-insensitive, whitespace-tolerant", () => {
    expect(hasInProcessExecutorRoute({ triage: " Codex-Exec " })).toBe(true);
  });

  test("codexConfig resolves defaults (home ~/catalyst/codex-home, bin codex, model null, writableRoots [catalystDir])", () => {
    // l1 has no codex key; env bag empty → pure defaults. catalystDir() reads the
    // hermetic CATALYST_DIR pinned by test-setup.mjs.
    const cfg = codexConfig({ configPath: l1, env: {} });
    expect(cfg.codexHome).toBe(`${process.env.CATALYST_DIR}/codex-home`);
    expect(cfg.bin).toBe("codex");
    expect(cfg.model).toBeNull();
    expect(cfg.writableRoots).toEqual([process.env.CATALYST_DIR]);
    expect(cfg.pluginRoot).toBeNull();
  });

  test("codexConfig honors env overrides (CATALYST_CODEX_HOME/BIN/MODEL/PLUGIN_ROOT)", () => {
    const cfg = codexConfig({
      configPath: l1,
      env: {
        CATALYST_CODEX_HOME: "/custom/codex-home",
        CATALYST_CODEX_BIN: "/opt/bin/codex",
        CATALYST_CODEX_MODEL: "o4-mini",
        CATALYST_CODEX_PLUGIN_ROOT: "/plugins/root",
      },
    });
    expect(cfg.codexHome).toBe("/custom/codex-home");
    expect(cfg.bin).toBe("/opt/bin/codex");
    expect(cfg.model).toBe("o4-mini");
    expect(cfg.pluginRoot).toBe("/plugins/root");
  });

  test("codexConfig reads Layer-1 catalyst.orchestration.codex.* (env wins over Layer-1)", () => {
    writeFileSync(
      l1,
      JSON.stringify({
        catalyst: {
          orchestration: {
            codex: {
              codexHome: "/l1/codex-home",
              bin: "codex-l1",
              model: "gpt-l1",
              writableRoots: ["/root/a", "/root/b"],
              pluginRoot: "/l1/plugins",
            },
          },
        },
      }),
    );
    const cfg = codexConfig({ configPath: l1, env: {} });
    expect(cfg.codexHome).toBe("/l1/codex-home");
    expect(cfg.bin).toBe("codex-l1");
    expect(cfg.model).toBe("gpt-l1");
    expect(cfg.writableRoots).toEqual(["/root/a", "/root/b"]);
    expect(cfg.pluginRoot).toBe("/l1/plugins");

    // env override wins over the Layer-1 value
    const overridden = codexConfig({ configPath: l1, env: { CATALYST_CODEX_BIN: "/env/codex" } });
    expect(overridden.bin).toBe("/env/codex");
    expect(overridden.model).toBe("gpt-l1"); // untouched keys still come from Layer-1
  });
});

describe("resolveClusterHosts (CTL-1274 — cluster-repo source)", () => {
  const ENVS = [
    "CATALYST_CONFIG_FILE",
    "CATALYST_HOST_NAME",
    "CATALYST_LAYER2_CONFIG_FILE",
    "CATALYST_CLUSTER_DIR",
    "CATALYST_LIVENESS_ANCHOR_ISSUE",
    "CATALYST_STATIC_ROSTER",
  ];
  let saved = {};
  let repo, cluster, cfg;

  beforeEach(() => {
    for (const k of ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    repo = mkdtempSync(join(tmpdir(), "ctl1274-resolve-repo-"));
    cluster = mkdtempSync(join(tmpdir(), "ctl1274-resolve-cluster-"));
    mkdirSync(join(repo, ".catalyst"), { recursive: true });
    cfg = join(repo, "layer2.json");
    process.env.CATALYST_CONFIG_FILE = join(repo, ".catalyst", "config.json");
    // A real (empty) cluster dir → cluster.json absent → cluster-repo source is a
    // deterministic miss unless a test writes cluster.json.
    process.env.CATALYST_CLUSTER_DIR = cluster;
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
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

  const writeHosts = (arr) => writeFileSync(join(repo, ".catalyst", "hosts.json"), JSON.stringify(arr));
  const writeLayer2 = (obj) => writeFileSync(cfg, JSON.stringify(obj));
  const writeCluster = (obj) => writeFileSync(join(cluster, "cluster.json"), JSON.stringify(obj));

  test("cluster-repo source wins when cluster.json.roster is present", () => {
    writeCluster({ schemaVersion: 1, roster: ["mini", "mini-2"] });
    writeLayer2({ catalyst: { cluster: { staticRoster: ["static-should-lose"] } } });
    writeHosts(["legacy-should-lose"]); // both lower priority (legacy file is inert)
    expect(resolveClusterHosts()).toEqual({
      hosts: ["mini", "mini-2"],
      source: "cluster-repo",
      multiHost: true,
    });
  });

  test("FAIL-OPEN: a too-new cluster schema falls through to static (never empties)", () => {
    writeCluster({ schemaVersion: 999, roster: ["should", "be", "ignored"] });
    writeLayer2({ catalyst: { cluster: { staticRoster: ["static-a", "static-b"] } } });
    const r = resolveClusterHosts();
    expect(r.hosts).toEqual(["static-a", "static-b"]);
    expect(r.source).toBe("static");
  });

  test("FAIL-OPEN: an empty cluster roster falls through to static (not an empty fleet)", () => {
    writeCluster({ schemaVersion: 1, roster: [] });
    writeLayer2({ catalyst: { cluster: { staticRoster: ["static-a", "static-b"] } } });
    const r = resolveClusterHosts();
    expect(r.source).toBe("static");
    expect(r.hosts).toEqual(["static-a", "static-b"]);
  });

  test("no cluster.json + no static → single-host default makes no cluster read crash", () => {
    // empty cluster dir, no static, no hosts.json → single-host
    const r = resolveClusterHosts();
    expect(r).toEqual({ hosts: ["solo-host"], source: "single-host", multiHost: false });
  });

  test("static source when no cluster-repo; a legacy hosts.json is NOT consulted", () => {
    writeLayer2({ catalyst: { cluster: { staticRoster: ["a", "b"] } } });
    writeHosts(["legacy-ignored"]);
    const r = resolveClusterHosts();
    expect(r).toEqual({ hosts: ["a", "b"], source: "static", multiHost: true });
  });

  test("hosts-fallback is RETIRED: a legacy .catalyst/hosts.json is never read (single-host, not hosts-fallback)", () => {
    writeHosts(["mini", "mac-studio"]);
    const r = resolveClusterHosts();
    expect(r.source).not.toBe("hosts-fallback");
    expect(r).toEqual({ hosts: ["solo-host"], source: "single-host", multiHost: false });
  });

  test("single-host default when no cluster-repo, no static, no hosts file", () => {
    const r = resolveClusterHosts();
    expect(r).toEqual({ hosts: ["solo-host"], source: "single-host", multiHost: false });
  });

  test("a single-host cluster-repo roster reports multiHost:false", () => {
    writeCluster({ schemaVersion: 1, roster: ["mini"] });
    expect(resolveClusterHosts()).toEqual({
      hosts: ["mini"],
      source: "cluster-repo",
      multiHost: false,
    });
  });

  test("unversioned cluster.json is treated as v1 and read", () => {
    writeCluster({ roster: ["mini", "mini-2"] });
    expect(resolveClusterHosts().source).toBe("cluster-repo");
    expect(resolveClusterHosts().hosts).toEqual(["mini", "mini-2"]);
  });

  test("filters non-string entries from the cluster roster", () => {
    writeCluster({ schemaVersion: 1, roster: ["mini", 42, "", "mini-2"] });
    expect(resolveClusterHosts().hosts).toEqual(["mini", "mini-2"]);
  });
});

describe("HEARTBEAT_INTERVAL_MS (CTL-859)", () => {
  test("defaults to 30000ms", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});

describe("CLUSTER_SYNC_INTERVAL_MS (CTL-1274)", () => {
  test("defaults to 5 minutes when the env override is unset", () => {
    // EXECUTION_CORE_CLUSTER_SYNC_INTERVAL_MS is not set in the test env.
    expect(CLUSTER_SYNC_INTERVAL_MS).toBe(5 * 60_000);
  });
});

import { readWatchdogConfig, phaseBudgetMs, WATCHDOG_MINUTES_PER_TURN } from "./config.mjs";

const WD_ENVS = ["CATALYST_WATCHDOG", "EXECUTION_CORE_WATCHDOG_MODE",
  "EXECUTION_CORE_WATCHDOG_SILENCE_MS", "EXECUTION_CORE_WATCHDOG_BUDGET_MULTIPLIER",
  "EXECUTION_CORE_WATCHDOG_REVIVE_BUDGET", "CATALYST_LAYER2_CONFIG_FILE"];

describe("readWatchdogConfig (CTL-729)", () => {
  let saved = {}, tmp;
  beforeEach(() => {
    for (const k of WD_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = mkdtempSync(join(tmpdir(), "ctl729-wd-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of WD_ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
    saved = {}; rmSync(tmp, { recursive: true, force: true });
  });

  test("defaults: mode=shadow, 30-min silence, mult 1.5, revive 0", () => {
    const c = readWatchdogConfig();
    expect(c.mode).toBe("shadow");
    expect(c.silenceThresholdMs).toBe(30 * 60_000);
    expect(c.phaseBudgetMultiplier).toBe(1.5);
    expect(c.reviveBudget).toBe(0);
  });
  test("CATALYST_WATCHDOG=0 maps to mode:off", () => {
    process.env.CATALYST_WATCHDOG = "0";
    expect(readWatchdogConfig().mode).toBe("off");
  });
  test("reads catalyst.watchdog.* from Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { watchdog: {
      mode: "enforce", silenceThresholdMinutes: 45, phaseBudgetMultiplier: 2, reviveBudget: 1 } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    const out = readWatchdogConfig();
    expect(out.mode).toBe("enforce");
    expect(out.silenceThresholdMs).toBe(45 * 60_000);
    expect(out.phaseBudgetMultiplier).toBe(2);
    expect(out.reviveBudget).toBe(1);
  });
  test("env wins over Layer-2 and default", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { watchdog: { mode: "off", silenceThresholdMinutes: 45 } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.EXECUTION_CORE_WATCHDOG_MODE = "enforce";
    process.env.EXECUTION_CORE_WATCHDOG_SILENCE_MS = "600000";
    const out = readWatchdogConfig();
    expect(out.mode).toBe("enforce");
    expect(out.silenceThresholdMs).toBe(600_000);
  });
  test("malformed Layer-2 file → code defaults (never throws)", () => {
    const cfg = join(tmp, "config.json"); writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readWatchdogConfig().silenceThresholdMs).toBe(30 * 60_000);
  });
  test("invalid mode string → falls back to shadow", () => {
    process.env.EXECUTION_CORE_WATCHDOG_MODE = "banana";
    expect(readWatchdogConfig().mode).toBe("shadow");
  });
  test("reviveBudget=0 from env is honored", () => {
    process.env.EXECUTION_CORE_WATCHDOG_REVIVE_BUDGET = "0";
    expect(readWatchdogConfig().reviveBudget).toBe(0);
  });
});

describe("phaseBudgetMs (CTL-729)", () => {
  test("turnCap × MINUTES_PER_TURN × multiplier (plan=25)", () => {
    const cfg = { phaseBudgetMultiplier: 1.5 };
    expect(phaseBudgetMs("plan", 25, cfg)).toBe(25 * WATCHDOG_MINUTES_PER_TURN * 1.5 * 60_000);
  });
  test("absolute floor engages for tiny turnCap", () => {
    expect(phaseBudgetMs("x", 3, { phaseBudgetMultiplier: 1.5 })).toBe(20 * 60_000);
  });
  test("missing/NaN turnCap → safe fallback budget", () => {
    expect(phaseBudgetMs("implement", undefined, { phaseBudgetMultiplier: 1.5 })).toBeGreaterThan(0);
  });
  test("CTL-729 coverage: undefined turnCap → exact 90-min fallback (WATCHDOG_FALLBACK_BUDGET_MS)", () => {
    // Pin the exact fallback so a regression swapping it for the 20-min floor or 0
    // is caught (the toBeGreaterThan(0) assertion above would not notice).
    expect(phaseBudgetMs("implement", undefined, { phaseBudgetMultiplier: 1.5 })).toBe(90 * 60_000);
  });
  test("CTL-729 coverage: cap<=0 (zero/negative turnCap) → 90-min fallback, not the floor", () => {
    // The `!Number.isFinite(cap) || cap <= 0` guard returns the fallback, NOT the
    // 20-min floor — exercise both the zero and negative branches.
    expect(phaseBudgetMs("implement", 0, { phaseBudgetMultiplier: 1.5 })).toBe(90 * 60_000);
    expect(phaseBudgetMs("implement", -5, { phaseBudgetMultiplier: 1.5 })).toBe(90 * 60_000);
  });
});

describe("hostMembershipWarning (CTL-1057)", () => {
  test("warns when multiHost and self not in roster", () => {
    const w = hostMembershipWarning(["mini", "studio"], "laptop");
    expect(w).toMatch(/not in the cluster roster/i);
    expect(w).toContain("laptop");
    expect(w).toContain("mini");
    expect(w).toContain("studio");
  });

  test("no warning on single-host roster even when name mismatches", () => {
    expect(hostMembershipWarning(["mini"], "RyansMini250233.rozich")).toBeNull();
  });

  test("no warning when self is the only roster entry (matches)", () => {
    expect(hostMembershipWarning(["solo"], "solo")).toBeNull();
  });

  test("no warning when self is in a multi-host roster", () => {
    expect(hostMembershipWarning(["mini", "studio"], "studio")).toBeNull();
  });

  test("no warning for empty roster", () => {
    expect(hostMembershipWarning([], "laptop")).toBeNull();
  });

  test("no warning for non-array roster", () => {
    expect(hostMembershipWarning(null, "laptop")).toBeNull();
    expect(hostMembershipWarning(undefined, "laptop")).toBeNull();
  });
});

describe("getDrainFlagPath + isDraining (CTL-1095)", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "drain-cfg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("getDrainFlagPath joins orchDir/drain", () => {
    expect(getDrainFlagPath("/tmp/ec")).toBe(join("/tmp/ec", "drain"));
  });

  test("isDraining is false when no flag file", () => {
    expect(isDraining(tmp)).toBe(false);
  });

  test("isDraining is true when flag file is present", () => {
    writeFileSync(join(tmp, "drain"), "");
    expect(isDraining(tmp)).toBe(true);
  });

  test("isDraining returns false again after flag is removed", () => {
    const flag = join(tmp, "drain");
    writeFileSync(flag, "");
    expect(isDraining(tmp)).toBe(true);
    rmSync(flag);
    expect(isDraining(tmp)).toBe(false);
  });
});

// CTL-1321: applyBootDrainPolicy — boot accepting work by default. A prior drain
// leaves a persistent `drain` flag (+ `drain.drained` sentinel) that survives
// restart; boot must clear them unless CATALYST_BOOT_DRAINED=1 opts the node out
// of rotation (re-set the flag AFTER the clear).
describe("applyBootDrainPolicy (CTL-1321)", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "boot-drain-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("getDrainedMarkerPath joins orchDir/drain.drained (shared with scheduler)", () => {
    expect(getDrainedMarkerPath("/tmp/ec")).toBe(join("/tmp/ec", "drain.drained"));
  });

  test("default boot clears a pre-existing drain flag → node accepts work", () => {
    writeFileSync(getDrainFlagPath(tmp), "");
    const r = applyBootDrainPolicy(tmp, { env: {} });
    expect(r.drained).toBe(false);
    expect(existsSync(getDrainFlagPath(tmp))).toBe(false);
    expect(isDraining(tmp)).toBe(false);
  });

  test("default boot also removes the drain.drained sentinel", () => {
    writeFileSync(getDrainFlagPath(tmp), "");
    writeFileSync(join(tmp, "drain.drained"), "");
    applyBootDrainPolicy(tmp, { env: {} });
    expect(existsSync(getDrainFlagPath(tmp))).toBe(false);
    expect(existsSync(join(tmp, "drain.drained"))).toBe(false);
  });

  test("CATALYST_BOOT_DRAINED=1 re-sets the drain flag after the default clear", () => {
    // Stale sentinel only (no drain flag): the opt-in must (re)create the flag
    // AND clear the sentinel so the once-per-episode dedup latch re-arms.
    writeFileSync(join(tmp, "drain.drained"), "");
    const r = applyBootDrainPolicy(tmp, { env: { CATALYST_BOOT_DRAINED: "1" } });
    expect(r.drained).toBe(true);
    expect(isDraining(tmp)).toBe(true);
    expect(existsSync(getDrainFlagPath(tmp))).toBe(true);
    expect(existsSync(join(tmp, "drain.drained"))).toBe(false);
  });

  test("CATALYST_BOOT_DRAINED=1 with a pre-existing drain flag keeps it drained (clear-then-set)", () => {
    // The most direct guard against a set-then-clear inversion: a drain flag that
    // was already present must remain present (the clear runs first, the re-set last).
    writeFileSync(getDrainFlagPath(tmp), "");
    const r = applyBootDrainPolicy(tmp, { env: { CATALYST_BOOT_DRAINED: "1" } });
    expect(r.drained).toBe(true);
    expect(existsSync(getDrainFlagPath(tmp))).toBe(true);
    expect(isDraining(tmp)).toBe(true);
  });

  test('only the exact string "1" opts in — "true" falls through to clear', () => {
    writeFileSync(getDrainFlagPath(tmp), "");
    const r = applyBootDrainPolicy(tmp, { env: { CATALYST_BOOT_DRAINED: "true" } });
    expect(r.drained).toBe(false);
    expect(isDraining(tmp)).toBe(false);
  });

  test('"0" falls through to clear (opt-in idiom, not the kill-switch !== "0")', () => {
    writeFileSync(getDrainFlagPath(tmp), "");
    const r = applyBootDrainPolicy(tmp, { env: { CATALYST_BOOT_DRAINED: "0" } });
    expect(r.drained).toBe(false);
    expect(isDraining(tmp)).toBe(false);
  });

  test("idempotent — default applied twice stays live", () => {
    writeFileSync(getDrainFlagPath(tmp), "");
    applyBootDrainPolicy(tmp, { env: {} });
    applyBootDrainPolicy(tmp, { env: {} });
    expect(isDraining(tmp)).toBe(false);
  });

  test("idempotent — opt-in applied twice stays drained with sentinel cleared", () => {
    applyBootDrainPolicy(tmp, { env: { CATALYST_BOOT_DRAINED: "1" } });
    applyBootDrainPolicy(tmp, { env: { CATALYST_BOOT_DRAINED: "1" } });
    expect(isDraining(tmp)).toBe(true);
    expect(existsSync(join(tmp, "drain.drained"))).toBe(false);
  });

  test("missing-file safety — clean orchDir never throws (default + opt-in)", () => {
    expect(() => applyBootDrainPolicy(tmp, { env: {} })).not.toThrow();
    expect(isDraining(tmp)).toBe(false);
    expect(() => applyBootDrainPolicy(tmp, { env: { CATALYST_BOOT_DRAINED: "1" } })).not.toThrow();
    expect(isDraining(tmp)).toBe(true);
  });
});

// CTL-1090: getLivenessAnchorIssue + LIVENESS_PUBLISH_INTERVAL_MS
describe("getLivenessAnchorIssue (CTL-1090)", () => {
  const LIVENESS_ENVS = ["CATALYST_LIVENESS_ANCHOR_ISSUE", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {};
  let tmp2;

  beforeEach(() => {
    for (const k of LIVENESS_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp2 = mkdtempSync(join(tmpdir(), "ctl1090-anchor-"));
  });

  afterEach(() => {
    for (const k of LIVENESS_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    saved = {};
    rmSync(tmp2, { recursive: true, force: true });
  });

  test("CATALYST_LIVENESS_ANCHOR_ISSUE env wins", () => {
    const cfg = join(tmp2, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { cluster: { livenessAnchorIssue: "CTL-1" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_LIVENESS_ANCHOR_ISSUE = "CTL-ENV-999";
    expect(getLivenessAnchorIssue()).toBe("CTL-ENV-999");
  });

  test("falls back to Layer-2 catalyst.cluster.livenessAnchorIssue", () => {
    const cfg = join(tmp2, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { cluster: { livenessAnchorIssue: "CTL-ANCHOR" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(getLivenessAnchorIssue()).toBe("CTL-ANCHOR");
  });

  test("returns null when unset and no Layer-2 file", () => {
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp2, "absent.json");
    expect(getLivenessAnchorIssue()).toBeNull();
  });

  test("returns null when Layer-2 file is malformed (never throws)", () => {
    const cfg = join(tmp2, "config.json");
    writeFileSync(cfg, "{ not valid json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(getLivenessAnchorIssue()).toBeNull();
  });

  test("returns null when livenessAnchorIssue is empty string", () => {
    const cfg = join(tmp2, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { cluster: { livenessAnchorIssue: "" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(getLivenessAnchorIssue()).toBeNull();
  });
});

describe("LIVENESS_PUBLISH_INTERVAL_MS (CTL-1090)", () => {
  test("defaults to 120000ms (2 minutes)", () => {
    expect(LIVENESS_PUBLISH_INTERVAL_MS).toBe(120_000);
  });
});

describe("readDeadDocWorkerConfig (CTL-1245)", () => {
  const DD_ENVS = ["CATALYST_DEAD_DOC_WORKER_RECLAIM", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {}, tmp;
  beforeEach(() => {
    for (const k of DD_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = mkdtempSync(join(tmpdir(), "ctl1245-dd-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of DD_ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
    saved = {}; rmSync(tmp, { recursive: true, force: true });
  });

  test("default: mode=off (ships inert — strict no-op)", () => {
    expect(readDeadDocWorkerConfig().mode).toBe("off");
  });
  test("CATALYST_DEAD_DOC_WORKER_RECLAIM=0 maps to mode:off (kill-switch)", () => {
    process.env.CATALYST_DEAD_DOC_WORKER_RECLAIM = "0";
    expect(readDeadDocWorkerConfig().mode).toBe("off");
  });
  test("env shadow / enforce are honored", () => {
    process.env.CATALYST_DEAD_DOC_WORKER_RECLAIM = "shadow";
    expect(readDeadDocWorkerConfig().mode).toBe("shadow");
    process.env.CATALYST_DEAD_DOC_WORKER_RECLAIM = "enforce";
    expect(readDeadDocWorkerConfig().mode).toBe("enforce");
  });
  test("reads catalyst.recovery.deadDocWorker.mode from Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { recovery: { deadDocWorker: { mode: "enforce" } } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readDeadDocWorkerConfig().mode).toBe("enforce");
  });
  test("env wins over Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { recovery: { deadDocWorker: { mode: "enforce" } } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_DEAD_DOC_WORKER_RECLAIM = "0";
    expect(readDeadDocWorkerConfig().mode).toBe("off");
  });
  test("invalid mode string → falls back to off", () => {
    process.env.CATALYST_DEAD_DOC_WORKER_RECLAIM = "banana";
    expect(readDeadDocWorkerConfig().mode).toBe("off");
  });
  test("malformed Layer-2 file → off (never throws)", () => {
    const cfg = join(tmp, "config.json"); writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readDeadDocWorkerConfig().mode).toBe("off");
  });
  test("transcript-silence floor defaults to 30 minutes", () => {
    expect(DEAD_DOC_WORKER_TRANSCRIPT_SILENCE_MS).toBe(30 * 60_000);
  });
});

describe("readSanctionedNeedsHuman (CTL-1432 B3)", () => {
  const saved = process.env.CATALYST_BH_SANCTIONED_LATCHES;
  afterEach(() => {
    if (saved === undefined) delete process.env.CATALYST_BH_SANCTIONED_LATCHES;
    else process.env.CATALYST_BH_SANCTIONED_LATCHES = saved;
  });
  test("env list → parsed, trimmed, empties dropped", () => {
    process.env.CATALYST_BH_SANCTIONED_LATCHES = "CTL-1, CTL-2 ,, CTL-3";
    expect(readSanctionedNeedsHuman()).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
  });
  test("(Codex P2) an EMPTY env var explicitly clears the allowlist → [] (does not fall through to Layer-2)", () => {
    process.env.CATALYST_BH_SANCTIONED_LATCHES = "";
    expect(readSanctionedNeedsHuman()).toEqual([]);
  });
});

describe("readBoardHealthConfig (CTL-1290)", () => {
  const BH_ENVS = ["CATALYST_BOARD_HEALTH", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {}, tmp;
  beforeEach(() => {
    for (const k of BH_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = mkdtempSync(join(tmpdir(), "ctl1290-bh-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of BH_ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
    saved = {}; rmSync(tmp, { recursive: true, force: true });
  });

  test("default: mode=shadow (the CTL-1290 floor — NOT off; shadow mutates nothing)", () => {
    expect(readBoardHealthConfig().mode).toBe("shadow");
  });
  test("CATALYST_BOARD_HEALTH=0 maps to mode:off (kill-switch)", () => {
    process.env.CATALYST_BOARD_HEALTH = "0";
    expect(readBoardHealthConfig().mode).toBe("off");
  });
  test("env off / shadow / enforce are honored", () => {
    process.env.CATALYST_BOARD_HEALTH = "off";
    expect(readBoardHealthConfig().mode).toBe("off");
    process.env.CATALYST_BOARD_HEALTH = "shadow";
    expect(readBoardHealthConfig().mode).toBe("shadow");
    process.env.CATALYST_BOARD_HEALTH = "enforce";
    expect(readBoardHealthConfig().mode).toBe("enforce");
  });
  test("garbage env → falls back to shadow (NOT off)", () => {
    process.env.CATALYST_BOARD_HEALTH = "banana";
    expect(readBoardHealthConfig().mode).toBe("shadow");
  });
  test("reads catalyst.boardHealth.mode from Layer-2 when env absent", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { boardHealth: { mode: "off" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readBoardHealthConfig().mode).toBe("off");
  });
  test("env wins over Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { boardHealth: { mode: "off" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_BOARD_HEALTH = "enforce";
    expect(readBoardHealthConfig().mode).toBe("enforce");
  });
  test("malformed Layer-2 file → shadow (never throws)", () => {
    const cfg = join(tmp, "config.json"); writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readBoardHealthConfig().mode).toBe("shadow");
  });
  test("accepts an injected env bag (env param overrides process.env)", () => {
    process.env.CATALYST_BOARD_HEALTH = "shadow";
    expect(readBoardHealthConfig({ CATALYST_BOARD_HEALTH: "0" }).mode).toBe("off");
  });
});

describe("readProjectionReadConfig (CTL-1489)", () => {
  const PR_ENVS = ["CATALYST_PROJECTION_READS", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {}, tmp;
  beforeEach(() => {
    for (const k of PR_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = mkdtempSync(join(tmpdir(), "ctl1489-pr-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of PR_ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
    saved = {}; rmSync(tmp, { recursive: true, force: true });
  });

  test("default: mode=shadow (shadow doubles reads but changes no decision)", () => {
    expect(readProjectionReadConfig({}).mode).toBe("shadow");
  });
  test("=0 kill-switch → off", () => {
    expect(readProjectionReadConfig({ CATALYST_PROJECTION_READS: "0" }).mode).toBe("off");
  });
  test("env off / shadow / enforce are honored", () => {
    expect(readProjectionReadConfig({ CATALYST_PROJECTION_READS: "off" }).mode).toBe("off");
    expect(readProjectionReadConfig({ CATALYST_PROJECTION_READS: "shadow" }).mode).toBe("shadow");
    expect(readProjectionReadConfig({ CATALYST_PROJECTION_READS: "enforce" }).mode).toBe("enforce");
  });
  test("garbage env → falls back to shadow", () => {
    expect(readProjectionReadConfig({ CATALYST_PROJECTION_READS: "garbage" }).mode).toBe("shadow");
  });
  test("reads catalyst.projectionReads.mode from Layer-2 when env absent", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { projectionReads: { mode: "enforce" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readProjectionReadConfig({}).mode).toBe("enforce");
  });
  test("env wins over Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { projectionReads: { mode: "enforce" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readProjectionReadConfig({ CATALYST_PROJECTION_READS: "0" }).mode).toBe("off");
  });
  test("malformed Layer-2 file → shadow (never throws)", () => {
    const cfg = join(tmp, "config.json"); writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readProjectionReadConfig({}).mode).toBe("shadow");
  });
});

describe("readCoordinationConfig (CTL-1488)", () => {
  const CO_ENVS = ["CATALYST_COORDINATION_MODE", "CATALYST_COORDINATION_HUB_URL", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {}, tmp;
  beforeEach(() => {
    for (const k of CO_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = mkdtempSync(join(tmpdir(), "ctl1488-co-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of CO_ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
    saved = {}; rmSync(tmp, { recursive: true, force: true });
  });

  test("default (no env, no Layer-2) is 'off' — NOT 'shadow' like board-health", () => {
    expect(readCoordinationConfig({}).mode).toBe("off");
  });
  test("CATALYST_COORDINATION_MODE=0 is the kill-switch regardless of Layer-2", () => {
    expect(readCoordinationConfig({ CATALYST_COORDINATION_MODE: "0" }).mode).toBe("off");
  });
  test("env overrides Layer-2; Layer-2 overrides default", () => {
    expect(readCoordinationConfig({ CATALYST_COORDINATION_MODE: "enforce" }).mode).toBe("enforce");
  });
  test("env off / shadow / enforce are honored", () => {
    expect(readCoordinationConfig({ CATALYST_COORDINATION_MODE: "off" }).mode).toBe("off");
    expect(readCoordinationConfig({ CATALYST_COORDINATION_MODE: "shadow" }).mode).toBe("shadow");
    expect(readCoordinationConfig({ CATALYST_COORDINATION_MODE: "enforce" }).mode).toBe("enforce");
  });
  test("garbage env → falls back to off (fail-safe: the process/egress stays inert)", () => {
    expect(readCoordinationConfig({ CATALYST_COORDINATION_MODE: "banana" }).mode).toBe("off");
  });
  test("reads catalyst.coordination.mode + hubUrl from Layer-2 when env absent", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { coordination: { mode: "shadow", hubUrl: "https://hub.example" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    const c = readCoordinationConfig();
    expect(c.mode).toBe("shadow");
    expect(c.hubUrl).toBe("https://hub.example");
  });
  test("env CATALYST_COORDINATION_HUB_URL overrides Layer-2 hubUrl; unset hubUrl is null", () => {
    expect(readCoordinationConfig({}).hubUrl).toBeNull();
    expect(readCoordinationConfig({ CATALYST_COORDINATION_HUB_URL: "https://env.hub" }).hubUrl).toBe("https://env.hub");
  });
  test("malformed Layer-2 file → off (never throws)", () => {
    const cfg = join(tmp, "config.json"); writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readCoordinationConfig().mode).toBe("off");
  });
  test("getCoordinationMirrorPath resolves coordination.jsonl under CATALYST_DIR", () => {
    const prev = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = tmp;
    try {
      expect(getCoordinationMirrorPath()).toBe(join(tmp, "coordination.jsonl"));
    } finally {
      prev === undefined ? delete process.env.CATALYST_DIR : (process.env.CATALYST_DIR = prev);
    }
  });
});

describe("readLinearReplica (CTL-1340)", () => {
  const LR_ENVS = ["CATALYST_LINEAR_REPLICA", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {}, tmp;
  beforeEach(() => {
    for (const k of LR_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = mkdtempSync(join(tmpdir(), "ctl1340-lr-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of LR_ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
    saved = {}; rmSync(tmp, { recursive: true, force: true });
  });

  test("default (unset): mode=off (ships inert)", () => {
    expect(readLinearReplica().mode).toBe("off");
  });
  test("CATALYST_LINEAR_REPLICA=on → on", () => {
    process.env.CATALYST_LINEAR_REPLICA = "on";
    expect(readLinearReplica().mode).toBe("on");
  });
  test("CATALYST_LINEAR_REPLICA=1 → on", () => {
    process.env.CATALYST_LINEAR_REPLICA = "1";
    expect(readLinearReplica().mode).toBe("on");
  });
  test("CATALYST_LINEAR_REPLICA=off → off (explicit kill-switch)", () => {
    process.env.CATALYST_LINEAR_REPLICA = "off";
    expect(readLinearReplica().mode).toBe("off");
  });
  test("CATALYST_LINEAR_REPLICA=0 → off (explicit kill-switch)", () => {
    process.env.CATALYST_LINEAR_REPLICA = "0";
    expect(readLinearReplica().mode).toBe("off");
  });
  test("garbage env → off (never silently on)", () => {
    process.env.CATALYST_LINEAR_REPLICA = "banana";
    expect(readLinearReplica().mode).toBe("off");
  });
  test("reads catalyst.linearReplica.mode=on from Layer-2 when env absent", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { linearReplica: { mode: "on" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readLinearReplica().mode).toBe("on");
  });
  test("Layer-2 mode other than 'on' → off", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { linearReplica: { mode: "off" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readLinearReplica().mode).toBe("off");
  });
  test("env wins over Layer-2 (env off beats Layer-2 on)", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { linearReplica: { mode: "on" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_LINEAR_REPLICA = "0";
    expect(readLinearReplica().mode).toBe("off");
  });
  test("env wins over Layer-2 (env on beats absent Layer-2)", () => {
    process.env.CATALYST_LINEAR_REPLICA = "on";
    expect(readLinearReplica().mode).toBe("on");
  });
  test("malformed Layer-2 file → off (never throws)", () => {
    const cfg = join(tmp, "config.json"); writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readLinearReplica().mode).toBe("off");
  });
  test("accepts an injected env bag (env param overrides process.env)", () => {
    process.env.CATALYST_LINEAR_REPLICA = "on";
    expect(readLinearReplica({ CATALYST_LINEAR_REPLICA: "0" }).mode).toBe("off");
  });
});

describe("getReplicaDbPath (CTL-1340)", () => {
  const RD_ENVS = ["CATALYST_REPLICA_DB", "CATALYST_DIR"];
  let saved = {};
  beforeEach(() => {
    for (const k of RD_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of RD_ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
    saved = {};
  });

  test("CATALYST_REPLICA_DB overrides the default path", () => {
    process.env.CATALYST_REPLICA_DB = "/custom/path/replica.db";
    expect(getReplicaDbPath()).toBe("/custom/path/replica.db");
  });
  test("default: <catalystDir>/catalyst-replica.db (CATALYST_DIR-rooted)", () => {
    process.env.CATALYST_DIR = "/tmp/ctl1340-dir";
    expect(getReplicaDbPath()).toBe("/tmp/ctl1340-dir/catalyst-replica.db");
  });
  test("re-resolved per call (env change is observed without re-import)", () => {
    process.env.CATALYST_DIR = "/tmp/a";
    expect(getReplicaDbPath()).toBe("/tmp/a/catalyst-replica.db");
    process.env.CATALYST_DIR = "/tmp/b";
    expect(getReplicaDbPath()).toBe("/tmp/b/catalyst-replica.db");
  });
});

// ─── CTL-1091 (Codex P2): resolveRestoreHoldMs validation contract ───────────
import { resolveRestoreHoldMs } from "./config.mjs";

describe("resolveRestoreHoldMs — restore-hold override validation (CTL-1091 P2)", () => {
  const DEF = 600_000;

  test("unset (undefined) → default", () => {
    expect(resolveRestoreHoldMs(undefined, DEF)).toBe(DEF);
  });

  test("empty string → default (NOT 0 — closes the Number(\"\")===0 bug)", () => {
    expect(resolveRestoreHoldMs("", DEF)).toBe(DEF);
    expect(resolveRestoreHoldMs("   ", DEF)).toBe(DEF);
  });

  test("explicit \"0\" → 0 (opt-out preserved, disables the hold)", () => {
    expect(resolveRestoreHoldMs("0", DEF)).toBe(0);
  });

  test("negative → default (invalid)", () => {
    expect(resolveRestoreHoldMs("-5", DEF)).toBe(DEF);
    expect(resolveRestoreHoldMs("-1", DEF)).toBe(DEF);
  });

  test("non-numeric → default", () => {
    expect(resolveRestoreHoldMs("abc", DEF)).toBe(DEF);
    expect(resolveRestoreHoldMs("NaN", DEF)).toBe(DEF);
  });

  test("valid positive → honored", () => {
    expect(resolveRestoreHoldMs("120000", DEF)).toBe(120_000);
  });

  test("non-string (defensive) → default", () => {
    expect(resolveRestoreHoldMs(null, DEF)).toBe(DEF);
    expect(resolveRestoreHoldMs(5000, DEF)).toBe(DEF);
  });
});
