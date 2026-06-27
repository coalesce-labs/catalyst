// node-class-parity.test.mjs — CTL-1368. The leaf lib/node-class.mjs duplicates config.mjs's
// resolveNodeClass (so the resource builder stays a leaf, free of the heavy config.mjs
// graph). This test is the DRIFT GUARD: the two resolvers MUST return byte-identical results
// across the full input matrix (env × Layer-2, valid/invalid/non-string/empty), the same way
// host-identity has a parity contract. If config.mjs's ladder changes, this fails until the
// leaf is updated to match.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveNodeClass as leafResolve, nodeClass as leafNodeClass, NODE_CLASSES as LEAF_CLASSES } from "./node-class.mjs";
import { resolveNodeClass as canonResolve, NODE_CLASSES as CANON_CLASSES } from "../config.mjs";

const ENV = "CATALYST_NODE_CLASS";
const L2 = "CATALYST_LAYER2_CONFIG_FILE";
const saved = {};
function setEnv(k, v) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
function layer2With(nodeClassValue) {
  const dir = mkdtempSync(join(tmpdir(), "ncparity-"));
  const path = join(dir, "config.json");
  // nodeClassValue === Symbol("absent") → write a config with no node.class key
  const cfg = nodeClassValue === ABSENT ? { catalyst: { host: { name: "x" } } } : { catalyst: { node: { class: nodeClassValue } } };
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}
const ABSENT = Symbol("absent");

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

describe("node-class parity: leaf resolveNodeClass === config.mjs resolveNodeClass", () => {
  test("constants agree", () => {
    expect([...LEAF_CLASSES]).toEqual([...CANON_CLASSES]);
    expect([...LEAF_CLASSES]).toEqual(["developer", "worker", "monitor"]);
  });

  // env-driven cases (Layer-2 ignored when env is set+non-empty)
  for (const env of ["developer", "worker", "monitor", "Worker", " developer ", "MONITOR", "developr", "", "   ", undefined]) {
    test(`env=${JSON.stringify(env)} → both resolvers agree`, () => {
      setEnv(ENV, env);
      setEnv(L2, undefined); // no Layer-2 file
      expect(leafResolve()).toEqual(canonResolve());
    });
  }

  // Layer-2-driven cases (env unset) — value written into a temp Layer-2 config
  for (const l2 of [ABSENT, "developer", "worker", "monitor", "Worker", " monitor ", "developr", "", null, false, 0, []]) {
    test(`layer2 node.class=${String(l2?.toString?.() ?? l2)} → both resolvers agree`, () => {
      setEnv(ENV, undefined);
      const path = layer2With(l2);
      setEnv(L2, path);
      try {
        const a = leafResolve();
        const b = canonResolve();
        expect(a).toEqual(b);
        // nodeClass() string accessor matches resolveNodeClass().class
        expect(leafNodeClass()).toBe(a.class);
      } finally {
        rmSync(path, { force: true });
      }
    });
  }

  test("missing Layer-2 file (unreadable) → both default to worker", () => {
    setEnv(ENV, undefined);
    setEnv(L2, "/nonexistent/dir/config.json");
    expect(leafResolve()).toEqual(canonResolve());
    expect(leafResolve().class).toBe("worker");
  });
});
