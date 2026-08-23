// layer2-fallback.test.mjs — CTL-1214 Phase 1. The Layer-2 arm of the three JS
// readers whose relocated knobs were Layer-1-ONLY before this ticket.
//
// WHY A DEDICATED FILE. readExecutionCoreConcurrencyLayer2 is exported from
// scheduler.mjs and its existing coverage lives in scheduler.test.mjs — which
// is NOT in .github/workflows/execution-core-tests.yml's allowlist (verified:
// the only occurrence of `scheduler.test.mjs` in that file is a comment on line
// 1339, and no `run:` line names it; positive control: the same grep for
// `deployment-mode-parity.test.sh` returns its own run line). CI there runs an
// explicit list, never a glob, so an assertion added to scheduler.test.mjs
// gates nothing. This file is registered as its own list entry in the same
// change that adds it.
//
// THE DEFECT BEING GUARDED. Four relocated categories are read from Layer-1
// ONLY and every one of those readers is fail-open to a code default. Slimming
// the committed config therefore does not error — it SILENTLY reverts each knob.
// These tests assert the fallback resolves the real value, and (the sharp half)
// that it is not the silent default.
//
// Run: cd plugins/dev/scripts/execution-core && bun test layer2-fallback.test.mjs

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLayer2MergedFrom } from "./config.mjs";
import { readExecutionCoreConcurrencyLayer2, mergeExecutionCoreConcurrency } from "./scheduler.mjs";
import { readLinearReconcileConfig } from "./linear-reconcile-timer.mjs";

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// Build a hermetic Layer-2 root. The siblings resolve off the returned file's
// OWN directory (as resolveNodeConfigPath does), so a fixture never reaches into
// the developer's real ~/.config/catalyst — a suite whose verdict depended on the
// host it ran on would be worthless here.
function mkLayer2({ legacy, node, secrets } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ctl1214-l2-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, typeof legacy === "string" ? legacy : JSON.stringify(legacy ?? {}));
  if (node !== undefined) {
    writeFileSync(join(dir, "node.json"), typeof node === "string" ? node : JSON.stringify(node));
  }
  if (secrets !== undefined) {
    writeFileSync(
      join(dir, "cluster-secrets.json"),
      typeof secrets === "string" ? secrets : JSON.stringify(secrets),
    );
  }
  return path;
}

function mkLayer1(obj) {
  const dir = mkdtempSync(join(tmpdir(), "ctl1214-l1-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj));
  return path;
}

describe("readLayer2MergedFrom (CTL-1214)", () => {
  it("composes config.json < node.json < cluster-secrets.json", () => {
    const p = mkLayer2({
      legacy: { catalyst: { a: "c", keptFromLegacy: 1 } },
      node: { catalyst: { a: "n", keptFromNode: 2 } },
      secrets: { catalyst: { a: "s" } },
    });
    const merged = readLayer2MergedFrom(p).catalyst;
    expect(merged.a).toBe("s");
    expect(merged.keptFromLegacy).toBe(1);
    expect(merged.keptFromNode).toBe(2);
  });

  it("deep-merges rather than replacing a nested object", () => {
    const p = mkLayer2({
      legacy: { catalyst: { sweep: { idleHours: 48, intervalHours: 1 } } },
      node: { catalyst: { sweep: { maxRemovalsPerRun: 10 } } },
    });
    expect(readLayer2MergedFrom(p).catalyst.sweep).toEqual({
      idleHours: 48,
      intervalHours: 1,
      maxRemovalsPerRun: 10,
    });
  });

  it("treats a malformed layer as layer-ABSENT, keeping the others", () => {
    const p = mkLayer2({
      legacy: { catalyst: { sweep: { intervalHours: 1 } } },
      node: "{ not json at all",
    });
    expect(readLayer2MergedFrom(p).catalyst.sweep.intervalHours).toBe(1);
  });

  it("returns an empty catalyst block for a falsy path (never throws)", () => {
    expect(readLayer2MergedFrom(null)).toEqual({ catalyst: {} });
    expect(readLayer2MergedFrom("")).toEqual({ catalyst: {} });
  });

  it("does not read the ambient ~/.config/catalyst when given a fixture root", () => {
    // Positive control for hermeticity: a fixture whose node.json sets a value
    // the real host does not have, plus the absence of any real-host key.
    const p = mkLayer2({ legacy: {}, node: { catalyst: { ctl1214Probe: "fixture-only" } } });
    const merged = readLayer2MergedFrom(p).catalyst;
    expect(merged.ctl1214Probe).toBe("fixture-only");
    expect(merged.linear?.bot).toBeUndefined();
  });
});

describe("readExecutionCoreConcurrencyLayer2 — node.json (CTL-1214)", () => {
  it("resolves a value written ONLY to node.json", () => {
    const p = mkLayer2({
      legacy: {},
      node: { catalyst: { orchestration: { executionCore: { maxParallel: 7 } } } },
    });
    expect(readExecutionCoreConcurrencyLayer2(p)).toEqual({ maxParallel: 7 });
  });

  it("does NOT shadow a legacy config.json value when node.json omits the field", () => {
    const p = mkLayer2({
      legacy: { catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } },
      node: { catalyst: { orchestration: { executionCore: { minParallel: 2 } } } },
    });
    // This is the live shape on this host: maxParallel:4 is machine-canonical in
    // the legacy file (CTL-678). A replace-instead-of-merge would drop it.
    expect(readExecutionCoreConcurrencyLayer2(p)).toEqual({ maxParallel: 4, minParallel: 2 });
  });

  it("node.json wins per field over the legacy file", () => {
    const p = mkLayer2({
      legacy: { catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } },
      node: { catalyst: { orchestration: { executionCore: { maxParallel: 9 } } } },
    });
    expect(readExecutionCoreConcurrencyLayer2(p).maxParallel).toBe(9);
  });

  it("keeps the {}-on-any-miss contract", () => {
    expect(readExecutionCoreConcurrencyLayer2(null)).toEqual({});
    expect(readExecutionCoreConcurrencyLayer2("")).toEqual({});
    expect(readExecutionCoreConcurrencyLayer2("/no/such/dir/config.json")).toEqual({});
    expect(readExecutionCoreConcurrencyLayer2(mkLayer2({ legacy: { catalyst: {} } }))).toEqual({});
  });

  it("a non-object executionCore is {} , never a crash", () => {
    const p = mkLayer2({ legacy: { catalyst: { orchestration: { executionCore: "nope" } } } });
    expect(readExecutionCoreConcurrencyLayer2(p)).toEqual({});
  });

  it("mergeExecutionCoreConcurrency still gets the whole picture end-to-end", () => {
    // The slimmed-repo shape: Layer-1 carries nothing, node.json carries it all.
    const l2 = mkLayer2({
      legacy: { catalyst: { orchestration: { executionCore: { maxParallel: 4 } } } },
      node: {
        catalyst: {
          orchestration: { executionCore: { minParallel: 1, maxParallelCeiling: 40 } },
        },
      },
    });
    const merged = mergeExecutionCoreConcurrency({}, readExecutionCoreConcurrencyLayer2(l2));
    expect(merged.maxParallel).toBe(4);
    expect(merged.minParallel).toBe(1);
    expect(merged.maxParallelCeiling).toBe(40);
  });
});

describe("readLinearReconcileConfig — node.json (CTL-1214)", () => {
  // CATALYST_RECONCILE_MODE is the documented hardest per-node override and it is
  // SET in a live phase-agent environment. Strip it around these cases or every
  // .mode assertion measures the ambient env instead of the resolution ladder.
  let savedMode;
  beforeEach(() => {
    savedMode = process.env.CATALYST_RECONCILE_MODE;
    delete process.env.CATALYST_RECONCILE_MODE;
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.CATALYST_RECONCILE_MODE;
    else process.env.CATALYST_RECONCILE_MODE = savedMode;
  });

  it("resolves .mode written ONLY to node.json", () => {
    const l1 = mkLayer1({ catalyst: { projectKey: "x" } });
    const l2 = mkLayer2({
      legacy: {},
      node: { catalyst: { orchestration: { reconcile: { mode: "notify", intervalSeconds: 600 } } } },
    });
    expect(readLinearReconcileConfig(l1, l2)).toEqual({ mode: "notify", intervalSeconds: 600 });
  });

  it("CATALYST_RECONCILE_MODE still beats both layers", () => {
    process.env.CATALYST_RECONCILE_MODE = "off";
    const l1 = mkLayer1({ catalyst: { orchestration: { reconcile: { mode: "write" } } } });
    const l2 = mkLayer2({
      legacy: {},
      node: { catalyst: { orchestration: { reconcile: { mode: "notify" } } } },
    });
    expect(readLinearReconcileConfig(l1, l2).mode).toBe("off");
  });

  it("Layer-2 wins per field; Layer-1 fills the rest (D8)", () => {
    const l1 = mkLayer1({
      catalyst: { orchestration: { reconcile: { mode: "notify", intervalSeconds: 600 } } },
    });
    const l2 = mkLayer2({
      legacy: {},
      node: { catalyst: { orchestration: { reconcile: { mode: "write" } } } },
    });
    expect(readLinearReconcileConfig(l1, l2)).toEqual({ mode: "write", intervalSeconds: 600 });
  });

  it("a legacy config.json value is not shadowed when node.json omits the field", () => {
    const l1 = mkLayer1({ catalyst: {} });
    const l2 = mkLayer2({
      legacy: { catalyst: { orchestration: { reconcile: { mode: "notify" } } } },
      node: { catalyst: { orchestration: { reconcile: { intervalSeconds: 900 } } } },
    });
    expect(readLinearReconcileConfig(l1, l2)).toEqual({ mode: "notify", intervalSeconds: 900 });
  });

  it("un-slimmed repo: Layer-1 alone still resolves (back-compat)", () => {
    const l1 = mkLayer1({
      catalyst: { orchestration: { reconcile: { mode: "notify", intervalSeconds: 600 } } },
    });
    const l2 = mkLayer2({ legacy: {} });
    expect(readLinearReconcileConfig(l1, l2)).toEqual({ mode: "notify", intervalSeconds: 600 });
  });

  it("malformed Layer-2 leaves Layer-1 intact and never throws", () => {
    const l1 = mkLayer1({ catalyst: { orchestration: { reconcile: { mode: "notify" } } } });
    const l2 = mkLayer2({ legacy: "{ not json", node: "{ also not json" });
    expect(() => readLinearReconcileConfig(l1, l2)).not.toThrow();
    expect(readLinearReconcileConfig(l1, l2)).toEqual({ mode: "notify" });
  });
});
