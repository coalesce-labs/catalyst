// daemon-watchdog-config.test.mjs — CTL-1502. The stuck-but-alive daemon
// watchdog config reader: off/shadow/enforce mode (mirrors readWatchdogConfig)
// + the numeric three-layer precedence (env > Layer-1
// catalyst.orchestration.daemonWatchdog > frozen default, mirrors
// readFleetHealthConfig). All env-driven; a temp Layer-1 file exercises the
// middle layer.
//
// Run: cd plugins/dev/scripts/execution-core && bun test daemon-watchdog-config.test.mjs

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDaemonWatchdogConfig,
  readDaemonWatchdogConfigLayer1,
} from "./config.mjs";

// The env vars this reader consults — cleared before each test for isolation.
const ENV_KEYS = [
  "CATALYST_DAEMON_WATCHDOG",
  "EXECUTION_CORE_DAEMON_WATCHDOG_MODE",
  "EXECUTION_CORE_DAEMON_WATCHDOG_INTERVAL_MS",
  "EXECUTION_CORE_DAEMON_WATCHDOG_DLQ_MAX_BYTES",
  "EXECUTION_CORE_DAEMON_WATCHDOG_STALENESS_MS",
  "EXECUTION_CORE_DAEMON_WATCHDOG_COOLDOWN_MS",
  "EXECUTION_CORE_DAEMON_WATCHDOG_SUSTAINED_TICKS",
  "EXECUTION_CORE_DAEMON_WATCHDOG_VERIFY_TICKS",
];

let saved;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function writeL1(obj) {
  const dir = mkdtempSync(join(tmpdir(), "dw-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("mode resolution", () => {
  test("default is shadow", () => {
    expect(readDaemonWatchdogConfig().mode).toBe("shadow");
    expect(readDaemonWatchdogConfig().enabled).toBe(true);
  });

  test("CATALYST_DAEMON_WATCHDOG=0 is the kill-switch → off (enabled false)", () => {
    process.env.CATALYST_DAEMON_WATCHDOG = "0";
    const c = readDaemonWatchdogConfig();
    expect(c.mode).toBe("off");
    expect(c.enabled).toBe(false);
  });

  test("env EXECUTION_CORE_DAEMON_WATCHDOG_MODE=enforce → enforce", () => {
    process.env.EXECUTION_CORE_DAEMON_WATCHDOG_MODE = "enforce";
    expect(readDaemonWatchdogConfig().mode).toBe("enforce");
  });

  test("Layer-1 mode used when env absent", () => {
    const { path, cleanup } = writeL1({
      catalyst: { orchestration: { daemonWatchdog: { mode: "enforce" } } },
    });
    try {
      expect(readDaemonWatchdogConfig(path).mode).toBe("enforce");
    } finally {
      cleanup();
    }
  });

  test("invalid mode falls back to shadow", () => {
    process.env.EXECUTION_CORE_DAEMON_WATCHDOG_MODE = "bogus";
    expect(readDaemonWatchdogConfig().mode).toBe("shadow");
  });

  test("kill-switch beats a Layer-1 enforce", () => {
    process.env.CATALYST_DAEMON_WATCHDOG = "0";
    const { path, cleanup } = writeL1({
      catalyst: { orchestration: { daemonWatchdog: { mode: "enforce" } } },
    });
    try {
      expect(readDaemonWatchdogConfig(path).mode).toBe("off");
    } finally {
      cleanup();
    }
  });
});

describe("numeric knobs — env > Layer-1 > default", () => {
  test("defaults", () => {
    const c = readDaemonWatchdogConfig();
    expect(c.intervalMs).toBe(120_000);
    expect(c.dlqMaxBytes).toBe(1_073_741_824);
    expect(c.stalenessMs).toBe(900_000);
    expect(c.cooldownMs).toBe(900_000);
    expect(c.sustainedTicks).toBe(2);
    expect(c.verifyTicks).toBe(2);
  });

  test("Layer-1 overrides defaults", () => {
    const { path, cleanup } = writeL1({
      catalyst: {
        orchestration: {
          daemonWatchdog: { dlqMaxBytes: 42, cooldownMs: 111, sustainedTicks: 5 },
        },
      },
    });
    try {
      const c = readDaemonWatchdogConfig(path);
      expect(c.dlqMaxBytes).toBe(42);
      expect(c.cooldownMs).toBe(111);
      expect(c.sustainedTicks).toBe(5);
      expect(c.verifyTicks).toBe(2); // untouched → default
    } finally {
      cleanup();
    }
  });

  test("env wins over Layer-1", () => {
    process.env.EXECUTION_CORE_DAEMON_WATCHDOG_DLQ_MAX_BYTES = "999";
    const { path, cleanup } = writeL1({
      catalyst: { orchestration: { daemonWatchdog: { dlqMaxBytes: 42 } } },
    });
    try {
      expect(readDaemonWatchdogConfig(path).dlqMaxBytes).toBe(999);
    } finally {
      cleanup();
    }
  });

  test("negative / NaN env ignored (falls through to default)", () => {
    process.env.EXECUTION_CORE_DAEMON_WATCHDOG_STALENESS_MS = "-5";
    expect(readDaemonWatchdogConfig().stalenessMs).toBe(900_000);
    process.env.EXECUTION_CORE_DAEMON_WATCHDOG_STALENESS_MS = "notanumber";
    expect(readDaemonWatchdogConfig().stalenessMs).toBe(900_000);
  });
});

describe("readDaemonWatchdogConfigLayer1", () => {
  test("missing file → {} (never throws)", () => {
    expect(readDaemonWatchdogConfigLayer1("/nonexistent/xyz/config.json")).toEqual({});
  });
  test("null configPath → {}", () => {
    expect(readDaemonWatchdogConfigLayer1(null)).toEqual({});
  });
  test("absent key → {}", () => {
    const { path, cleanup } = writeL1({ catalyst: { orchestration: {} } });
    try {
      expect(readDaemonWatchdogConfigLayer1(path)).toEqual({});
    } finally {
      cleanup();
    }
  });
  test("present key returned as object", () => {
    const { path, cleanup } = writeL1({
      catalyst: { orchestration: { daemonWatchdog: { mode: "enforce", cooldownMs: 5 } } },
    });
    try {
      expect(readDaemonWatchdogConfigLayer1(path)).toEqual({ mode: "enforce", cooldownMs: 5 });
    } finally {
      cleanup();
    }
  });
});
