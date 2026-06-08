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

describe("getClusterHosts (CTL-859)", () => {
  const ROSTER_ENVS = ["CATALYST_CONFIG_FILE", "CATALYST_HOST_NAME", "CATALYST_LAYER2_CONFIG_FILE"];
  let saved = {};
  let repo;

  beforeEach(() => {
    for (const k of ROSTER_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    repo = mkdtempSync(join(tmpdir(), "ctl859-roster-"));
    mkdirSync(join(repo, ".catalyst"), { recursive: true });
    // CATALYST_CONFIG_FILE points at <repoRoot>/.catalyst/config.json; the
    // roster reader resolves hosts.json as its sibling.
    process.env.CATALYST_CONFIG_FILE = join(repo, ".catalyst", "config.json");
  });

  afterEach(() => {
    for (const k of ROSTER_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    saved = {};
    rmSync(repo, { recursive: true, force: true });
  });

  test("reads the roster array from .catalyst/hosts.json when present", () => {
    writeFileSync(
      join(repo, ".catalyst", "hosts.json"),
      JSON.stringify(["mini", "mac-studio"]),
    );
    expect(getClusterHosts()).toEqual(["mini", "mac-studio"]);
  });

  test("absent roster returns the single-host default [getHostName()]", () => {
    process.env.CATALYST_HOST_NAME = "solo-host";
    // no hosts.json written
    expect(getClusterHosts()).toEqual(["solo-host"]);
  });

  test("malformed roster falls back to the single-host default", () => {
    writeFileSync(join(repo, ".catalyst", "hosts.json"), "not-json-at-all");
    process.env.CATALYST_HOST_NAME = "solo-host";
    expect(getClusterHosts()).toEqual(["solo-host"]);
  });

  test("empty array roster falls back to the single-host default", () => {
    writeFileSync(join(repo, ".catalyst", "hosts.json"), "[]");
    process.env.CATALYST_HOST_NAME = "solo-host";
    expect(getClusterHosts()).toEqual(["solo-host"]);
  });

  test("non-string entries are filtered out", () => {
    writeFileSync(
      join(repo, ".catalyst", "hosts.json"),
      JSON.stringify(["mini", 42, "", "mac-studio"]),
    );
    expect(getClusterHosts()).toEqual(["mini", "mac-studio"]);
  });
});

describe("HEARTBEAT_INTERVAL_MS (CTL-859)", () => {
  test("defaults to 30000ms", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});
