// config.test.mjs — CTL-650 Phase 4. The wait-watcher config knob:
// readWaitWatcherConfig() → { enabled, intervalMs }, default-on, env-disable via
// CATALYST_WAIT_WATCHER=0, interval from EVENT_DEBOUNCE_MS.
//
// Run: cd plugins/dev/scripts/execution-core && bun test config.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { readWaitWatcherConfig, EVENT_DEBOUNCE_MS } from "./config.mjs";

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
