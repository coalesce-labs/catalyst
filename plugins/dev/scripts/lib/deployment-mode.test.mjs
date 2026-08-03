import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DEPLOYMENT_MODES, resolveDeploymentMode, getDeploymentMode } from "./deployment-mode.mjs";

// Fixture-file helpers. Every test builds its own tmp dir so parallel test
// runs never collide, and points layer1ConfigPath/layer2ConfigPath at the
// fixture directly rather than touching process.env or a real config file.
let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "deployment-mode-test-"));
  _tmpDirs.push(dir);
  return dir;
}
function writeConfig(dir, name, mode) {
  const path = resolve(dir, name);
  const body = mode === undefined ? {} : { catalyst: { deployment: { mode } } };
  writeFileSync(path, JSON.stringify(body));
  return path;
}
function missingPath(dir, name) {
  // Never written — exercises the "absent file" rung without touching disk.
  return resolve(dir, name);
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
});

describe("DEPLOYMENT_MODES", () => {
  test("is the frozen 3-value enum", () => {
    expect(DEPLOYMENT_MODES).toEqual(["single-host", "cluster", "cloud"]);
    expect(Object.isFrozen(DEPLOYMENT_MODES)).toBe(true);
  });
  test("mutation attempts do not change the enum (strict-mode ESM throws)", () => {
    expect(() => {
      DEPLOYMENT_MODES.push("both");
    }).toThrow();
    expect(DEPLOYMENT_MODES).toEqual(["single-host", "cluster", "cloud"]);
  });
});

describe("resolveDeploymentMode — the validity ladder", () => {
  test("nothing set anywhere ⇒ constant default, inferred, recognized", () => {
    const dir = fixtureDir();
    const r = resolveDeploymentMode({
      env: {},
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    });
    expect(r).toEqual({ mode: "single-host", source: "default", inferred: true, recognized: true, raw: null });
  });

  test("env wins over everything else", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", "cloud");
    const l1 = writeConfig(dir, "layer1.json", "cluster");
    const r = resolveDeploymentMode({
      env: { CATALYST_DEPLOYMENT_MODE: "cluster" },
      layer1ConfigPath: l1,
      layer2ConfigPath: l2,
    });
    expect(r).toEqual({ mode: "cluster", source: "env", inferred: false, recognized: true, raw: "cluster" });
  });

  test("Layer-2 wins when env is absent", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", "cloud");
    const l1 = writeConfig(dir, "layer1.json", "cluster");
    const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r).toEqual({ mode: "cloud", source: "layer2", inferred: false, recognized: true, raw: "cloud" });
  });

  test("Layer-1 wins when env and Layer-2 are both absent", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "layer1.json", "cluster");
    const r = resolveDeploymentMode({
      env: {},
      layer1ConfigPath: l1,
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    });
    expect(r).toEqual({ mode: "cluster", source: "layer1", inferred: false, recognized: true, raw: "cluster" });
  });

  test("Layer-2 present but key absent ⇒ falls through to Layer-1", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", undefined); // {} — no catalyst.deployment.mode key
    const l1 = writeConfig(dir, "layer1.json", "cloud");
    const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r.source).toBe("layer1");
    expect(r.mode).toBe("cloud");
  });

  test("Layer-2 file missing on disk ⇒ falls through to Layer-1 (never throws)", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "layer1.json", "cluster");
    const r = resolveDeploymentMode({
      env: {},
      layer1ConfigPath: l1,
      layer2ConfigPath: missingPath(dir, "does-not-exist.json"),
    });
    expect(r).toEqual({ mode: "cluster", source: "layer1", inferred: false, recognized: true, raw: "cluster" });
  });

  test("Layer-2 malformed JSON ⇒ treated as absent, falls through (never throws)", () => {
    const dir = fixtureDir();
    const l2 = resolve(dir, "layer2.json");
    writeFileSync(l2, "{not valid json");
    const l1 = writeConfig(dir, "layer1.json", "cloud");
    const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r).toEqual({ mode: "cloud", source: "layer1", inferred: false, recognized: true, raw: "cloud" });
  });

  test("explicit JSON null at Layer-2 ⇒ unset sentinel, falls through to Layer-1", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", null);
    const l1 = writeConfig(dir, "layer1.json", "cluster");
    const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r).toEqual({ mode: "cluster", source: "layer1", inferred: false, recognized: true, raw: "cluster" });
  });

  test("explicit JSON null at env ⇒ unset sentinel, falls through past env", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", "cloud");
    const r = resolveDeploymentMode({
      env: { CATALYST_DEPLOYMENT_MODE: null },
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: l2,
    });
    expect(r.source).toBe("layer2");
    expect(r.mode).toBe("cloud");
  });

  test("empty-string env ⇒ cleared, falls through to Layer-2", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", "cluster");
    const r = resolveDeploymentMode({
      env: { CATALYST_DEPLOYMENT_MODE: "" },
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: l2,
    });
    expect(r.source).toBe("layer2");
    expect(r.mode).toBe("cluster");
  });

  test("whitespace-only env ⇒ cleared after trim, falls through", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", "cluster");
    const r = resolveDeploymentMode({
      env: { CATALYST_DEPLOYMENT_MODE: "   " },
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: l2,
    });
    expect(r.source).toBe("layer2");
    expect(r.mode).toBe("cluster");
  });

  test("mixed-case / boundary-whitespace value normalizes to canonical member", () => {
    const dir = fixtureDir();
    const r = resolveDeploymentMode({
      env: { CATALYST_DEPLOYMENT_MODE: "  Cluster  " },
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    });
    expect(r).toEqual({ mode: "cluster", source: "env", inferred: false, recognized: true, raw: "  Cluster  " });
  });
});

describe("resolveDeploymentMode — soft-failure degradations", () => {
  test("present-but-non-string env value degrades to single-host, recognized:false, AT the env source", () => {
    const dir = fixtureDir();
    const r = resolveDeploymentMode({
      env: { CATALYST_DEPLOYMENT_MODE: 123 },
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    });
    expect(r).toEqual({ mode: "single-host", source: "env", inferred: false, recognized: false, raw: 123 });
  });

  test("present-but-non-string Layer-2 value (boolean) degrades AT layer2, does not fall through", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", true);
    const l1 = writeConfig(dir, "layer1.json", "cluster"); // must be ignored — layer2 already settled
    const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r).toEqual({ mode: "single-host", source: "layer2", inferred: false, recognized: false, raw: true });
  });

  test("present-but-non-string Layer-1 value (array) degrades AT layer1", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "layer1.json", []);
    const r = resolveDeploymentMode({
      env: {},
      layer1ConfigPath: l1,
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    });
    expect(r).toEqual({ mode: "single-host", source: "layer1", inferred: false, recognized: false, raw: [] });
  });

  test("unrecognized string (typo) at env degrades to single-host, source env", () => {
    const dir = fixtureDir();
    const r = resolveDeploymentMode({
      env: { CATALYST_DEPLOYMENT_MODE: "clustre" },
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    });
    expect(r).toEqual({
      mode: "single-host",
      source: "env",
      inferred: false,
      recognized: false,
      raw: "clustre",
    });
  });

  test("unrecognized string (typo) at Layer-2 degrades AT layer2, does not fall through to a valid Layer-1", () => {
    const dir = fixtureDir();
    const l2 = writeConfig(dir, "layer2.json", "clustre");
    const l1 = writeConfig(dir, "layer1.json", "cluster");
    const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 });
    expect(r).toEqual({
      mode: "single-host",
      source: "layer2",
      inferred: false,
      recognized: false,
      raw: "clustre",
    });
  });

  test("unrecognized string (typo) at Layer-1 degrades to single-host, source layer1", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "layer1.json", "clowd");
    const r = resolveDeploymentMode({
      env: {},
      layer1ConfigPath: l1,
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    });
    expect(r).toEqual({ mode: "single-host", source: "layer1", inferred: false, recognized: false, raw: "clowd" });
  });
});

describe("resolveDeploymentMode — never throws", () => {
  test("default env param (process.env) is accepted with no options object", () => {
    expect(() => resolveDeploymentMode()).not.toThrow();
  });
  test("layer1/layer2 paths pointing at a directory (not a file) degrade gracefully", () => {
    const dir = fixtureDir();
    const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: dir, layer2ConfigPath: dir });
    expect(r.source).toBe("default");
    expect(r.mode).toBe("single-host");
  });
});

describe("getDeploymentMode", () => {
  test("returns the resolved mode string", () => {
    const mode = getDeploymentMode();
    expect(DEPLOYMENT_MODES).toContain(mode);
  });

  test("warns at most once per distinct message (dedup Set), never throws on repeat calls", () => {
    const dir = fixtureDir();
    // Deterministic fixture, not the real process.env/filesystem: an
    // unrecognized string at env forces the !recognized WARN branch to fire
    // on every call (unlike the ambient environment, which may already be
    // explicit/recognized and never warn at all — a prior version of this
    // test called bare getDeploymentMode() and could pass vacuously with an
    // empty `calls` array whenever the warn path didn't fire).
    const opts = {
      env: { CATALYST_DEPLOYMENT_MODE: "warn-dedup-fixture-typo-ctl-1617" },
      layer1ConfigPath: missingPath(dir, "layer1.json"),
      layer2ConfigPath: missingPath(dir, "layer2.json"),
    };

    const original = console.warn;
    const calls = [];
    console.warn = (...args) => calls.push(args.join(" "));
    try {
      getDeploymentMode(opts);
      getDeploymentMode(opts);
      getDeploymentMode(opts);
    } finally {
      console.warn = original;
    }
    // The warn path must actually have fired at least once — this is the
    // assertion the vacuous bare-call version could never make.
    expect(calls.length).toBeGreaterThan(0);
    // Every emitted warning line is unique — no message repeats across the
    // three calls (the dedup Set collapses repeats to zero further prints):
    // three identical-fixture calls produce exactly one warn line.
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls.length).toBe(1);
  });
});
