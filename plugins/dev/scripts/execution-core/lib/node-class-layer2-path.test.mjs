// node-class-layer2-path.test.mjs — CTL-1616 PR6 (design §8/§9). lib/node-class.mjs's
// getLayer2ConfigPath dual-read shadow-diff: computes BOTH the legacy homedir-only chain
// (CATALYST_LAYER2_CONFIG_FILE || ~/.config/catalyst/config.json) AND the registry's
// canonical resolveLayer2Path chain (CATALYST_LAYER2_CONFIG_FILE > CATALYST_MACHINE_CONFIG >
// XDG_CONFIG_HOME > ~/.config/catalyst) on every call; agreement stays silent, a divergence
// warns once (console.warn — this is a zero-import leaf, no pino/log import) and the NEW
// (canonical) path wins. Mirrors execution-core/config.test.mjs's equivalent suite for
// config.mjs's own getLayer2ConfigPath.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { getLayer2ConfigPath } from "./node-class.mjs";

const ENV_KEYS = ["CATALYST_LAYER2_CONFIG_FILE", "CATALYST_MACHINE_CONFIG", "XDG_CONFIG_HOME"];
let saved = {};
let warnCalls;
let origWarn;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  warnCalls = [];
  origWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  saved = {};
  console.warn = origWarn;
});

describe("node-class.mjs getLayer2ConfigPath — CTL-1616 PR6 dual-read shadow-diff", () => {
  test("agree case: no overrides at all — silent, returns the homedir default", () => {
    const expected = resolve(homedir(), ".config", "catalyst", "config.json");
    expect(getLayer2ConfigPath()).toBe(expected);
    expect(warnCalls.length).toBe(0);
  });

  test("agree case: CATALYST_LAYER2_CONFIG_FILE set — both chains check it first, silent", () => {
    process.env.CATALYST_LAYER2_CONFIG_FILE = "/explicit/nc-pr6-agree/config.json";
    expect(getLayer2ConfigPath()).toBe("/explicit/nc-pr6-agree/config.json");
    expect(warnCalls.length).toBe(0);
  });

  test("differ case: CATALYST_MACHINE_CONFIG set (legacy ignores it) — warns once, the LEGACY path wins (observe-only until the reader sweep)", () => {
    process.env.CATALYST_MACHINE_CONFIG = "/machine/nc-pr6-machine-config-test/config.json";
    const result = getLayer2ConfigPath();
    expect(result).toBe(resolve(homedir(), ".config", "catalyst", "config.json"));
    expect(warnCalls.length).toBe(1);
    const msg = warnCalls[0][0];
    expect(msg).toContain(resolve(homedir(), ".config", "catalyst", "config.json"));
    expect(msg).toContain("/machine/nc-pr6-machine-config-test/config.json");
  });

  test("differ case: XDG_CONFIG_HOME set (legacy ignores it) — warns once, the LEGACY path wins (observe-only until the reader sweep)", () => {
    process.env.XDG_CONFIG_HOME = "/xdg/nc-pr6-xdg-test";
    const result = getLayer2ConfigPath();
    expect(result).toBe(resolve(homedir(), ".config", "catalyst", "config.json"));
    expect(warnCalls.length).toBe(1);
  });

  test("dedup: repeated calls with the SAME divergence warn only once", () => {
    process.env.CATALYST_MACHINE_CONFIG = "/machine/nc-pr6-dedup-test/config.json";
    getLayer2ConfigPath();
    getLayer2ConfigPath();
    getLayer2ConfigPath();
    expect(warnCalls.length).toBe(1);
  });
});
