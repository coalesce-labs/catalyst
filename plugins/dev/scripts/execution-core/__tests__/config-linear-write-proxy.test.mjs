// config-linear-write-proxy.test.mjs — CTL-1889 increment 1.
// Run: cd plugins/dev/scripts/execution-core && bun test __tests__/config-linear-write-proxy.test.mjs
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINEAR_WRITE_PROXY_MODES, readLinearWriteProxyConfig } from "../config.mjs";

const ENV_KEYS = ["CATALYST_LINEAR_WRITE_PROXY", "CATALYST_LAYER2_CONFIG_FILE"];
let saved;
let tmp;

/** Write a Layer-2 config and point the resolver at it. */
function layer2(obj) {
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env.CATALYST_LAYER2_CONFIG_FILE = p;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), "ctl1889-cfg-"));
  delete process.env.CATALYST_LINEAR_WRITE_PROXY;
  // Guaranteed-absent by default so a developer's real ~/.config/catalyst/config.json
  // can never leak into a test.
  process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("readLinearWriteProxyConfig — the mode ladder", () => {
  test("the mode set is exactly the three house modes", () => {
    expect([...LINEAR_WRITE_PROXY_MODES].sort()).toEqual(["enforce", "off", "shadow"]);
  });

  test("defaults to off with nothing configured anywhere", () => {
    expect(readLinearWriteProxyConfig({})).toEqual({ mode: "off", routes: null });
  });

  test.each(["shadow", "enforce", "off"])("env %p is honoured", (mode) => {
    expect(readLinearWriteProxyConfig({ CATALYST_LINEAR_WRITE_PROXY: mode }).mode).toBe(mode);
  });

  test('env "0" is the kill-switch', () => {
    layer2({ catalyst: { linearWriteProxy: { mode: "enforce" } } });
    expect(readLinearWriteProxyConfig({ CATALYST_LINEAR_WRITE_PROXY: "0" }).mode).toBe("off");
  });

  test("env overrides Layer-2", () => {
    layer2({ catalyst: { linearWriteProxy: { mode: "shadow" } } });
    expect(readLinearWriteProxyConfig({ CATALYST_LINEAR_WRITE_PROXY: "enforce" }).mode).toBe("enforce");
  });

  test("Layer-2 is honoured when the env var is absent", () => {
    layer2({ catalyst: { linearWriteProxy: { mode: "enforce" } } });
    expect(readLinearWriteProxyConfig({}).mode).toBe("enforce");
  });

  test.each([undefined, "", "ENFORCE", "enforce ", "on", "1", "true", "yes"])(
    "an unrecognised env value (%p) degrades to off, never to enforce",
    (v) => {
      expect(readLinearWriteProxyConfig({ CATALYST_LINEAR_WRITE_PROXY: v }).mode).toBe("off");
    },
  );

  test("an unrecognised env value falls THROUGH to a valid Layer-2 value rather than short-circuiting to off", () => {
    layer2({ catalyst: { linearWriteProxy: { mode: "shadow" } } });
    expect(readLinearWriteProxyConfig({ CATALYST_LINEAR_WRITE_PROXY: "ENFORCE" }).mode).toBe("shadow");
  });

  test.each(["ENFORCE", "", 7, null, {}])("an unrecognised Layer-2 mode (%p) degrades to off", (mode) => {
    layer2({ catalyst: { linearWriteProxy: { mode } } });
    expect(readLinearWriteProxyConfig({}).mode).toBe("off");
  });

  test("a malformed Layer-2 file is layer-absent, not a throw", () => {
    const p = join(tmp, "bad.json");
    writeFileSync(p, "{not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = p;
    expect(readLinearWriteProxyConfig({})).toEqual({ mode: "off", routes: null });
  });
});

describe("readLinearWriteProxyConfig — route overrides", () => {
  test("absolute string paths survive", () => {
    layer2({ catalyst: { linearWriteProxy: { mode: "enforce", routes: { label: "/v2/labels" } } } });
    expect(readLinearWriteProxyConfig({}).routes).toEqual({ label: "/v2/labels" });
  });

  test("⛔ a non-string value is DROPPED — it would concatenate as [object Object] into a URL", () => {
    layer2({ catalyst: { linearWriteProxy: { routes: { label: { path: "/x" }, comment: "/ok" } } } });
    expect(readLinearWriteProxyConfig({}).routes).toEqual({ comment: "/ok" });
  });

  test("a relative path is dropped (a route path must be absolute)", () => {
    layer2({ catalyst: { linearWriteProxy: { routes: { label: "v2/labels" } } } });
    expect(readLinearWriteProxyConfig({}).routes).toBeNull();
  });

  test("an array `routes` is ignored entirely", () => {
    layer2({ catalyst: { linearWriteProxy: { routes: ["/a"] } } });
    expect(readLinearWriteProxyConfig({}).routes).toBeNull();
  });

  test("routes are independent of mode — an operator can pre-stage paths while still off", () => {
    layer2({ catalyst: { linearWriteProxy: { routes: { comment: "/v2/c" } } } });
    expect(readLinearWriteProxyConfig({})).toEqual({ mode: "off", routes: { comment: "/v2/c" } });
  });
});
