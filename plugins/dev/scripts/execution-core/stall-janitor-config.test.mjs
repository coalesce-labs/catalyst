// stall-janitor-config.test.mjs — CTL-1004 config gate.
// readStallJanitorConfig mirrors readWatchdogConfig (CTL-729): env >
// Layer-2 catalyst.stallJanitor.* > code default. Default mode is "shadow".

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStallJanitorConfig } from "./config.mjs";

const SJ_ENVS = [
  "CATALYST_STALL_JANITOR",
  "EXECUTION_CORE_STALL_JANITOR_MODE",
  "EXECUTION_CORE_STALL_JANITOR_TERMINAL_IDLE_MS",
  "CATALYST_LAYER2_CONFIG_FILE",
];

describe("readStallJanitorConfig (CTL-1004)", () => {
  let saved = {};
  let tmp;
  beforeEach(() => {
    for (const k of SJ_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = mkdtempSync(join(tmpdir(), "ctl1004-sj-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
  });
  afterEach(() => {
    for (const k of SJ_ENVS) {
      saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    }
    saved = {};
    rmSync(tmp, { recursive: true, force: true });
  });

  test("default: mode=shadow (shadow-first), terminalIdleMs=600s", () => {
    const c = readStallJanitorConfig();
    expect(c.mode).toBe("shadow");
    expect(c.terminalIdleMs).toBe(600_000);
  });

  test("CATALYST_STALL_JANITOR=0 maps to mode:off (kill-switch)", () => {
    process.env.CATALYST_STALL_JANITOR = "0";
    expect(readStallJanitorConfig().mode).toBe("off");
  });

  test("CATALYST_STALL_JANITOR=enforce → enforce", () => {
    process.env.CATALYST_STALL_JANITOR = "enforce";
    expect(readStallJanitorConfig().mode).toBe("enforce");
  });

  test("CATALYST_STALL_JANITOR=shadow → shadow", () => {
    process.env.CATALYST_STALL_JANITOR = "shadow";
    expect(readStallJanitorConfig().mode).toBe("shadow");
  });

  test("reads catalyst.stallJanitor.* from Layer-2", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        catalyst: { stallJanitor: { mode: "enforce", terminalIdleSeconds: 900 } },
      }),
    );
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    const out = readStallJanitorConfig();
    expect(out.mode).toBe("enforce");
    expect(out.terminalIdleMs).toBe(900_000);
  });

  test("env wins over Layer-2 and default", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { stallJanitor: { mode: "off" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    process.env.CATALYST_STALL_JANITOR = "enforce";
    expect(readStallJanitorConfig().mode).toBe("enforce");
  });

  test("malformed Layer-2 file → code defaults (never throws)", () => {
    const cfg = join(tmp, "config.json");
    writeFileSync(cfg, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    expect(readStallJanitorConfig().mode).toBe("shadow");
    expect(readStallJanitorConfig().terminalIdleMs).toBe(600_000);
  });

  test("invalid mode string → falls back to shadow", () => {
    process.env.CATALYST_STALL_JANITOR = "banana";
    expect(readStallJanitorConfig().mode).toBe("shadow");
  });
});
