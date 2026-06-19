// config.test.mjs — CTL-650 Phase 4 + CTL-685 + CTL-684. Config knobs:
//   readWaitWatcherConfig() → { enabled, intervalMs }
//   readMemorySamplerConfig() → { enabled, intervalMs, warnThresholdMb,
//                                  killThresholdMb, killEnabled, killSustainedSamples }
//   CTL-684: auto-tuner config constants and kill-switch.
//
// Run: cd plugins/dev/scripts/execution-core && bun test config.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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
  getLivenessAnchorIssue,
  LIVENESS_PUBLISH_INTERVAL_MS,
  getStaticRoster,
  resolveClusterHosts,
  CLUSTER_SYNC_INTERVAL_MS,
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
