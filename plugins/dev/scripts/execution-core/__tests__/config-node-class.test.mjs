// config-node-class.test.mjs — tests for resolveNodeClass()/getNodeClass() in
// execution-core/config.mjs (CTL-1344). Run:
//   cd plugins/dev/scripts/execution-core && bun test config-node-class

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeClass, getNodeClass, NODE_CLASSES } from "../config.mjs";

const ENV_KEYS = ["CATALYST_NODE_CLASS", "CATALYST_LAYER2_CONFIG_FILE"];
let saved;
let tmp;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), "ctl1344-"));
  // No class set + point Layer-2 at a guaranteed-absent file so an ambient
  // ~/.config/catalyst/config.json on the dev machine never leaks into a test.
  delete process.env.CATALYST_NODE_CLASS;
  process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Write a Layer-2 config file and point the resolver at it.
function writeLayer2(obj) {
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env.CATALYST_LAYER2_CONFIG_FILE = p;
}

describe("resolveNodeClass", () => {
  test("absent everywhere → worker, inferred, recognized, source=default", () => {
    const r = resolveNodeClass();
    expect(r.class).toBe("worker");
    expect(r.source).toBe("default");
    expect(r.inferred).toBe(true);
    expect(r.recognized).toBe(true);
    expect(r.raw).toBeNull();
  });

  for (const c of ["developer", "worker", "monitor"]) {
    test(`explicit env "${c}" → that class, source=env, recognized`, () => {
      process.env.CATALYST_NODE_CLASS = c;
      const r = resolveNodeClass();
      expect(r.class).toBe(c);
      expect(r.source).toBe("env");
      expect(r.inferred).toBe(false);
      expect(r.recognized).toBe(true);
    });
  }

  test("env value is trimmed + lowercased to its canonical class", () => {
    process.env.CATALYST_NODE_CLASS = "  Developer  ";
    const r = resolveNodeClass();
    expect(r.class).toBe("developer");
    expect(r.recognized).toBe(true);
  });

  test("unrecognized explicit env → most-restrictive monitor, recognized:false (NOT worker)", () => {
    process.env.CATALYST_NODE_CLASS = "developr";
    const r = resolveNodeClass();
    expect(r.class).toBe("monitor");
    expect(r.recognized).toBe(false);
    expect(r.source).toBe("env");
    expect(r.raw).toBe("developr");
    // The footgun guard: a typo must never resolve to the work-eligible worker class.
    expect(r.class).not.toBe("worker");
  });

  test("Layer-2 catalyst.node.class is read when env is unset", () => {
    writeLayer2({ catalyst: { node: { class: "developer" } } });
    const r = resolveNodeClass();
    expect(r.class).toBe("developer");
    expect(r.source).toBe("layer2");
    expect(r.recognized).toBe(true);
  });

  test("unrecognized Layer-2 value → monitor, recognized:false, NOT worker", () => {
    writeLayer2({ catalyst: { node: { class: "wokrer" } } });
    const r = resolveNodeClass();
    expect(r.class).toBe("monitor");
    expect(r.recognized).toBe(false);
    expect(r.source).toBe("layer2");
    expect(r.class).not.toBe("worker");
  });

  // A present-but-non-string Layer-2 value is an explicit misconfiguration, NOT an
  // absent default — it must take the restrictive path so doctor can FAIL (the
  // footgun guard; flagged in code review). false / 0 / [] / {}.
  for (const [label, value] of [
    ["false", false],
    ["0", 0],
    ["empty array", []],
    ["object", { developer: true }],
  ]) {
    test(`present non-string Layer-2 value (${label}) → monitor, recognized:false, NOT worker`, () => {
      writeLayer2({ catalyst: { node: { class: value } } });
      const r = resolveNodeClass();
      expect(r.class).toBe("monitor");
      expect(r.recognized).toBe(false);
      expect(r.inferred).toBe(false);
      expect(r.source).toBe("layer2");
      expect(r.class).not.toBe("worker");
    });
  }

  test("explicit null Layer-2 value → worker (the codebase's unset sentinel)", () => {
    writeLayer2({ catalyst: { node: { class: null } } });
    const r = resolveNodeClass();
    expect(r.class).toBe("worker");
    expect(r.inferred).toBe(true);
    expect(r.recognized).toBe(true);
    expect(r.source).toBe("default");
  });

  test("empty/whitespace string Layer-2 value → worker (cleared, mirrors empty env)", () => {
    writeLayer2({ catalyst: { node: { class: "   " } } });
    const r = resolveNodeClass();
    expect(r.class).toBe("worker");
    expect(r.inferred).toBe(true);
    expect(r.source).toBe("default");
  });

  test("env overrides Layer-2", () => {
    writeLayer2({ catalyst: { node: { class: "worker" } } });
    process.env.CATALYST_NODE_CLASS = "developer";
    const r = resolveNodeClass();
    expect(r.class).toBe("developer");
    expect(r.source).toBe("env");
  });

  test("empty/whitespace env is treated as absent (falls through to Layer-2)", () => {
    process.env.CATALYST_NODE_CLASS = "   ";
    writeLayer2({ catalyst: { node: { class: "developer" } } });
    expect(resolveNodeClass().class).toBe("developer");
  });

  test("malformed Layer-2 JSON never throws → default worker", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, "{ not valid json ");
    process.env.CATALYST_LAYER2_CONFIG_FILE = p;
    expect(() => resolveNodeClass()).not.toThrow();
    const r = resolveNodeClass();
    expect(r.class).toBe("worker");
    expect(r.inferred).toBe(true);
  });

  test("Layer-2 present but no catalyst.node.class key → default worker (inferred)", () => {
    writeLayer2({ catalyst: { host: { name: "mini" } } });
    const r = resolveNodeClass();
    expect(r.class).toBe("worker");
    expect(r.inferred).toBe(true);
    expect(r.source).toBe("default");
  });
});

describe("getNodeClass", () => {
  test("returns the resolved class string (worker by default)", () => {
    expect(getNodeClass()).toBe("worker");
  });
  test("returns an explicit valid class", () => {
    process.env.CATALYST_NODE_CLASS = "developer";
    expect(getNodeClass()).toBe("developer");
  });
  test("returns the most-restrictive class for an unrecognized explicit value", () => {
    process.env.CATALYST_NODE_CLASS = "nope";
    expect(getNodeClass()).toBe("monitor");
  });
});

describe("NODE_CLASSES", () => {
  test("is the frozen canonical enum", () => {
    expect(NODE_CLASSES).toEqual(["developer", "worker", "monitor"]);
    expect(Object.isFrozen(NODE_CLASSES)).toBe(true);
  });
});
