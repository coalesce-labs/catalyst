// executor-policy.test.mjs — CTL-2116 Phase 1. Pure leaf covering the fleet
// routing policy shape: reading it out of a cluster.json, normalizing a
// possibly-hostile value, and the two pure transforms the CLI needs.
// Run: cd plugins/dev/scripts/execution-core && bun test executor-policy.test.mjs
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXECUTOR_POLICY_VERSION,
  HISTORY_MAX,
  applyRouteChange,
  normalizePolicyRoutes,
  readExecutorPolicy,
  rollbackPolicy,
} from "./executor-policy.mjs";

const dirs = [];
function fixtureDir(clusterJson) {
  const dir = mkdtempSync(join(tmpdir(), "exec-policy-test-"));
  dirs.push(dir);
  if (clusterJson !== undefined) {
    writeFileSync(join(dir, "cluster.json"), JSON.stringify(clusterJson, null, 2) + "\n");
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    rmSync(d, { recursive: true, force: true });
  }
});

describe("module constants", () => {
  test("EXECUTOR_POLICY_VERSION and HISTORY_MAX are exported", () => {
    expect(EXECUTOR_POLICY_VERSION).toBe(1);
    expect(HISTORY_MAX).toBe(20);
  });
});

describe("readExecutorPolicy", () => {
  test("returns null when the cluster dir has no cluster.json", () => {
    expect(readExecutorPolicy(join(tmpdir(), "nonexistent-cluster-dir-ctl-2116"))).toBeNull();
  });

  test("returns null when cluster.json has no executorPolicy key (zero behavior change)", () => {
    const dir = fixtureDir({ schemaVersion: 1, roster: ["a"] });
    expect(readExecutorPolicy(dir)).toBeNull();
  });

  test("reads routes, updatedAt, updatedBy and history", () => {
    const dir = fixtureDir({
      schemaVersion: 1,
      roster: ["a"],
      executorPolicy: {
        routes: { triage: "codex-exec" },
        updatedAt: "2026-08-24T00:00:00Z",
        updatedBy: "ryan",
        history: [{ id: "abc123", change: { phase: "triage", from: null, to: "codex-exec" } }],
      },
    });
    const p = readExecutorPolicy(dir);
    expect(p.routes).toEqual({ triage: "codex-exec" });
    expect(p.updatedBy).toBe("ryan");
    expect(Array.isArray(p.history)).toBe(true);
  });

  test("returns null (never a partial map) for a malformed executorPolicy", () => {
    const malformed = [
      { schemaVersion: 1, roster: [], executorPolicy: "nope" },
      { schemaVersion: 1, roster: [], executorPolicy: [] },
      { schemaVersion: 1, roster: [], executorPolicy: { routes: [] } },
      { schemaVersion: 1, roster: [], executorPolicy: { routes: { triage: false } } },
    ];
    for (const clusterJson of malformed) {
      const dir = fixtureDir(clusterJson);
      expect(readExecutorPolicy(dir)).toBeNull();
    }
  });

  test("never throws on an unreadable/absent/garbage cluster.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-policy-test-"));
    dirs.push(dir);
    writeFileSync(join(dir, "cluster.json"), "{not valid json");
    expect(() => readExecutorPolicy(dir)).not.toThrow();
    expect(readExecutorPolicy(dir)).toBeNull();
  });

  test("an empty routes map is a real policy — not absent", () => {
    const dir = fixtureDir({
      schemaVersion: 1,
      roster: [],
      executorPolicy: { routes: {}, history: [] },
    });
    const p = readExecutorPolicy(dir);
    expect(p).not.toBeNull();
    expect(p.routes).toEqual({});
  });
});

describe("normalizePolicyRoutes", () => {
  test("keeps only non-empty string values", () => {
    expect(normalizePolicyRoutes({ a: "bg", b: 3, c: "", d: null })).toEqual({ a: "bg" });
  });
  test("does NOT canonicalize or validate — that stays in resolveExecutorForPhase", () => {
    expect(normalizePolicyRoutes({ a: "claude-sdk", b: "bogus" })).toEqual({
      a: "claude-sdk",
      b: "bogus",
    });
  });
});

describe("applyRouteChange", () => {
  const base = () => ({ routes: { triage: "codex-exec" }, history: [] });

  test("sets one phase and records the PRIOR value in the history entry", () => {
    const { next, entry } = applyRouteChange(base(), {
      phase: "implement",
      executor: "codex-exec",
      by: "ryan",
      host: "mini-2",
      at: "2026-08-24T00:00:00Z",
    });
    expect(next.routes).toEqual({ triage: "codex-exec", implement: "codex-exec" });
    expect(entry.change).toEqual({ phase: "implement", from: null, to: "codex-exec" });
    expect(entry.priorRoutes).toEqual({ triage: "codex-exec" });
    expect(entry.by).toBe("ryan");
  });

  test("records from: the previous value when overwriting", () => {
    const { entry } = applyRouteChange(base(), { phase: "triage", executor: "bg", by: "x" });
    expect(entry.change).toEqual({ phase: "triage", from: "codex-exec", to: "bg" });
  });

  test("all: <executor> maps EVERY known phase and records phase '*'", () => {
    const { next, entry } = applyRouteChange(base(), { all: true, executor: "bg", by: "x" });
    expect(Object.keys(next.routes)).toEqual(
      expect.arrayContaining(["triage", "implement", "pr"]),
    );
    expect(new Set(Object.values(next.routes))).toEqual(new Set(["bg"]));
    expect(entry.change.phase).toBe("*");
  });

  test("clear: <phase> deletes the key (unrouted → node default)", () => {
    const { next, entry } = applyRouteChange(base(), { phase: "triage", executor: null, by: "x" });
    expect(next.routes).toEqual({});
    expect(entry.change).toEqual({ phase: "triage", from: "codex-exec", to: null });
  });

  test("is a no-op report when the value is unchanged (no history entry minted)", () => {
    const r = applyRouteChange(base(), { phase: "triage", executor: "codex-exec", by: "x" });
    expect(r.changed).toBe(false);
    expect(r.entry).toBeNull();
  });

  test("does not mutate its input", () => {
    const frozen = Object.freeze({ routes: Object.freeze({ triage: "codex-exec" }), history: [] });
    expect(() => applyRouteChange(frozen, { phase: "pr", executor: "bg", by: "x" })).not.toThrow();
    expect(frozen.routes).toEqual({ triage: "codex-exec" });
  });

  test("bounds history to HISTORY_MAX newest-first", () => {
    let p = { routes: {}, history: [] };
    for (let i = 0; i < 40; i++) {
      p = applyRouteChange(p, {
        phase: "triage",
        executor: i % 2 ? "bg" : "codex-exec",
        by: "x",
      }).next;
    }
    expect(p.history.length).toBe(20);
    expect(p.history[0].change.to).toBeDefined();
  });
});

describe("rollbackPolicy", () => {
  test("restores priorRoutes from the newest history entry and records the rollback itself", () => {
    const after = applyRouteChange({ routes: { triage: "codex-exec" }, history: [] }, {
      phase: "implement",
      executor: "codex-exec",
      by: "ryan",
    }).next;
    const { next, entry, changed } = rollbackPolicy(after, { by: "ryan" });
    expect(changed).toBe(true);
    expect(next.routes).toEqual({ triage: "codex-exec" });
    expect(entry.change.phase).toBe("*");
    expect(entry.rollbackOf).toBe(after.history[0].id);
    // the rollback is itself in history → rollback of a rollback works
    expect(next.history[0].id).not.toBe(after.history[0].id);
  });

  test("refuses (changed:false, named reason) when history is empty", () => {
    const r = rollbackPolicy({ routes: {}, history: [] }, { by: "x" });
    expect(r.changed).toBe(false);
    expect(r.reason).toBe("no-history");
  });
});
