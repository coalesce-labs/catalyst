// unstuck-sweep-config.test.mjs — CTL-1064 config gate.
// readUnstuckSweepConfig mirrors readStallJanitorConfig (CTL-1004): env >
// Layer-2 catalyst.unstuckSweep.* > code default. Default mode is "off"
// (safer than stall-janitor's "shadow" — operators must opt in explicitly).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUnstuckSweepConfig, isThrottled, UNSTUCK_SWEEP_DEFAULT_INTERVAL_MS } from "./config.mjs";

const US_ENVS = [
  "CATALYST_UNSTUCK_SWEEP",
  "EXECUTION_CORE_UNSTUCK_SWEEP_MODE",
  "CATALYST_UNSTUCK_SWEEP_INTERVAL_MS",
  "CATALYST_LAYER2_CONFIG_FILE",
];

describe("readUnstuckSweepConfig (CTL-1064)", () => {
  let saved = {};
  let tmp;
  beforeEach(() => {
    for (const k of US_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), "ctl1064-us-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of US_ENVS) {
      saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    }
    saved = {};
    rmSync(tmp, { recursive: true, force: true });
  });

  test("default: mode=off (safe default — operators opt in)", () => {
    const c = readUnstuckSweepConfig();
    expect(c.mode).toBe("off");
    expect(c.intervalMs).toBe(UNSTUCK_SWEEP_DEFAULT_INTERVAL_MS);
    expect(c.intervalMs).toBe(900_000);
  });

  test("CATALYST_UNSTUCK_SWEEP=0 maps to mode:off (kill-switch)", () => {
    process.env.CATALYST_UNSTUCK_SWEEP = "0";
    expect(readUnstuckSweepConfig().mode).toBe("off");
  });

  test("CATALYST_UNSTUCK_SWEEP=shadow → shadow", () => {
    process.env.CATALYST_UNSTUCK_SWEEP = "shadow";
    expect(readUnstuckSweepConfig().mode).toBe("shadow");
  });

  test("CATALYST_UNSTUCK_SWEEP=enforce → enforce", () => {
    process.env.CATALYST_UNSTUCK_SWEEP = "enforce";
    expect(readUnstuckSweepConfig().mode).toBe("enforce");
  });

  test("reads catalyst.unstuckSweep.* from Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        catalyst: { unstuckSweep: { mode: "enforce", intervalSeconds: 300 } },
      }),
    );
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    const out = readUnstuckSweepConfig();
    expect(out.mode).toBe("enforce");
    expect(out.intervalMs).toBe(300_000);
  });

  test("env wins over Layer-2 and default", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { unstuckSweep: { mode: "off" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_UNSTUCK_SWEEP = "enforce";
    expect(readUnstuckSweepConfig().mode).toBe("enforce");
  });

  test("malformed Layer-2 file → code defaults (never throws)", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readUnstuckSweepConfig().mode).toBe("off");
    expect(readUnstuckSweepConfig().intervalMs).toBe(900_000);
  });

  test("invalid mode string → falls back to off", () => {
    process.env.CATALYST_UNSTUCK_SWEEP = "banana";
    expect(readUnstuckSweepConfig().mode).toBe("off");
  });

  test("CATALYST_UNSTUCK_SWEEP_INTERVAL_MS overrides default", () => {
    process.env.CATALYST_UNSTUCK_SWEEP_INTERVAL_MS = "60000";
    expect(readUnstuckSweepConfig().intervalMs).toBe(60_000);
  });
});

describe("isThrottled (CTL-1064)", () => {
  test("returns true when elapsed < intervalMs", () => {
    expect(isThrottled(1000, 5000, 4000)).toBe(true);  // 3000ms elapsed < 5000ms
  });
  test("returns false when elapsed >= intervalMs", () => {
    expect(isThrottled(1000, 5000, 6000)).toBe(false); // 5000ms elapsed >= 5000ms
  });
  test("returns false when lastRunMs=0 and nowMs > interval", () => {
    expect(isThrottled(0, 900_000, 900_001)).toBe(false);
  });
  test("returns true when lastRunMs=0 and nowMs < interval", () => {
    expect(isThrottled(0, 900_000, 500_000)).toBe(true);
  });
});
