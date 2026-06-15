// cost-cap.test.mjs — CTL-1137 cost-cap watcher: pure decision + throttle + Prom source.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  evaluateCostCap,
  shouldCheckNow,
  fetchSessionCostUsd,
  markPhaseSignalFailed,
  checkWorkerCost,
  _resetCostCapThrottle,
} from "./cost-cap.mjs";
import { readCostCapConfig } from "./config.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("evaluateCostCap — pure decision", () => {
  const base = { status: "running", sessionCost: 10, capUsd: 40 };

  it("aborts when cost >= cap", () => {
    const d = evaluateCostCap({ ...base, sessionCost: 41 });
    expect(d.action).toBe("abort");
    expect(d.costUsd).toBe(41);
    expect(d.reason).toBe("cost_cap_exceeded:$41.00>=$40.00");
  });

  it("aborts exactly AT the cap (>=, not >)", () => {
    expect(evaluateCostCap({ ...base, sessionCost: 40 }).action).toBe("abort");
  });

  it("no-op under the cap", () => {
    const d = evaluateCostCap({ ...base, sessionCost: 39.99 });
    expect(d.action).toBe("none");
    expect(d.reason).toBe("under-cap");
  });

  it("FAIL-OPEN: null cost never aborts", () => {
    expect(evaluateCostCap({ ...base, sessionCost: null }).action).toBe("none");
    expect(evaluateCostCap({ ...base, sessionCost: null }).reason).toBe("no-cost-data");
  });

  it("FAIL-OPEN: NaN/Infinity cost never aborts", () => {
    expect(evaluateCostCap({ ...base, sessionCost: NaN }).action).toBe("none");
    expect(evaluateCostCap({ ...base, sessionCost: Infinity }).action).toBe("none");
  });

  it("only running/dispatched are actionable; terminal/other never abort", () => {
    for (const status of ["complete", "failed", "done", "stalled", "aborted", "preempted", "dispatching"]) {
      expect(evaluateCostCap({ ...base, status, sessionCost: 999 }).action).toBe("none");
    }
    expect(evaluateCostCap({ ...base, status: "dispatched", sessionCost: 999 }).action).toBe("abort");
  });

  it("guards a missing/zero cap (never abort)", () => {
    expect(evaluateCostCap({ ...base, capUsd: 0, sessionCost: 999 }).action).toBe("none");
    expect(evaluateCostCap({ ...base, capUsd: undefined, sessionCost: 999 }).action).toBe("none");
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(evaluateCostCap(base))).toBe(true);
  });
});

describe("shouldCheckNow — per-session throttle", () => {
  let store;
  beforeEach(() => { store = new Map(); });

  it("checks on first sight, then suppresses within pollMs", () => {
    expect(shouldCheckNow("s1", 1000, 30_000, store)).toBe(true);
    expect(shouldCheckNow("s1", 1000 + 29_999, 30_000, store)).toBe(false);
  });

  it("checks again once pollMs has elapsed", () => {
    shouldCheckNow("s1", 1000, 30_000, store);
    expect(shouldCheckNow("s1", 1000 + 30_000, 30_000, store)).toBe(true);
  });

  it("tracks sessions independently", () => {
    expect(shouldCheckNow("a", 0, 30_000, store)).toBe(true);
    expect(shouldCheckNow("b", 0, 30_000, store)).toBe(true);
  });

  it("never checks a null/empty session", () => {
    expect(shouldCheckNow(null, 0, 30_000, store)).toBe(false);
    expect(shouldCheckNow("", 0, 30_000, store)).toBe(false);
  });

  it("module-level store is resettable for tests", () => {
    expect(shouldCheckNow("x", 0, 30_000)).toBe(true);
    expect(shouldCheckNow("x", 0, 30_000)).toBe(false);
    _resetCostCapThrottle();
    expect(shouldCheckNow("x", 0, 30_000)).toBe(true);
  });
});

describe("fetchSessionCostUsd — Prometheus source, FAIL-OPEN", () => {
  const ok = (val) => ({
    ok: true,
    json: async () => ({ status: "success", data: { result: [{ value: [1700000000, String(val)] }] } }),
  });
  const opts = (fetchImpl) => ({ promBaseUrl: "http://prom:9098", fetchImpl });

  it("returns the cumulative cost on a healthy response", async () => {
    const cost = await fetchSessionCostUsd("uuid-1", opts(async () => ok(24.97)));
    expect(cost).toBe(24.97);
  });

  it("builds the correct instant-counter sum query, URL-encoded, by session_id", async () => {
    let seen = "";
    await fetchSessionCostUsd("UUID-2", opts(async (url) => { seen = url; return ok(1); }));
    expect(seen).toContain("/api/v1/query?query=");
    expect(decodeURIComponent(seen)).toContain('sum(claude_code_cost_usage_USD_total{session_id="UUID-2"})');
  });

  it("FAIL-OPEN: returns null on non-ok HTTP", async () => {
    expect(await fetchSessionCostUsd("u", opts(async () => ({ ok: false })))).toBeNull();
  });

  it("FAIL-OPEN: returns null when Prom status != success", async () => {
    const f = async () => ({ ok: true, json: async () => ({ status: "error" }) });
    expect(await fetchSessionCostUsd("u", opts(f))).toBeNull();
  });

  it("FAIL-OPEN: returns null on an empty result set (session has no metric yet)", async () => {
    const f = async () => ({ ok: true, json: async () => ({ status: "success", data: { result: [] } }) });
    expect(await fetchSessionCostUsd("u", opts(f))).toBeNull();
  });

  it("FAIL-OPEN: returns null when fetch throws (Prom unreachable)", async () => {
    expect(await fetchSessionCostUsd("u", opts(async () => { throw new Error("ECONNREFUSED"); }))).toBeNull();
  });

  it("FAIL-OPEN: returns null with no session id or no base url", async () => {
    expect(await fetchSessionCostUsd("", opts(async () => ok(1)))).toBeNull();
    expect(await fetchSessionCostUsd("u", { promBaseUrl: "", fetchImpl: async () => ok(1) })).toBeNull();
  });

  it("FAIL-OPEN: returns null on a non-numeric metric value", async () => {
    const f = async () => ({ ok: true, json: async () => ({ status: "success", data: { result: [{ value: [1, "NaN"] }] } }) });
    expect(await fetchSessionCostUsd("u", opts(f))).toBeNull();
  });
});

describe("readCostCapConfig — defaults + precedence (SHADOW-FIRST)", () => {
  const KEYS = [
    "CATALYST_COST_CAP", "EXECUTION_CORE_COST_CAP_MODE", "EXECUTION_CORE_COST_CAP_USD",
    "EXECUTION_CORE_COST_CAP_POLL_SEC", "EXECUTION_CORE_COST_CAP_PROM_URL",
  ];
  let saved;
  beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("defaults to shadow / $40 / 30s poll / a Prom URL — never enforce by default", () => {
    const c = readCostCapConfig();
    expect(c.mode).toBe("shadow");
    expect(c.capUsd).toBe(40);
    expect(c.pollMs).toBe(30_000);
    expect(c.promBaseUrl).toContain("9098");
  });
  it("env flips mode to enforce", () => {
    process.env.EXECUTION_CORE_COST_CAP_MODE = "enforce";
    expect(readCostCapConfig().mode).toBe("enforce");
  });
  it("CATALYST_COST_CAP=0 is the kill-switch → off (overrides an enforce mode)", () => {
    process.env.CATALYST_COST_CAP = "0";
    process.env.EXECUTION_CORE_COST_CAP_MODE = "enforce";
    expect(readCostCapConfig().mode).toBe("off");
  });
  it("env overrides the cap value", () => {
    process.env.EXECUTION_CORE_COST_CAP_USD = "100";
    expect(readCostCapConfig().capUsd).toBe(100);
  });
  it("a bogus mode falls back to the shadow default (never silently enforces)", () => {
    process.env.EXECUTION_CORE_COST_CAP_MODE = "banana";
    expect(readCostCapConfig().mode).toBe("shadow");
  });
});

describe("markPhaseSignalFailed — enforce terminal-write", () => {
  let orchDir;
  beforeEach(() => { orchDir = mkdtempSync(join(tmpdir(), "ccap-")); });
  afterEach(() => { rmSync(orchDir, { recursive: true, force: true }); });

  function writeSig(ticket, phase, obj) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(obj, null, 2));
  }
  const read = (ticket, phase) =>
    JSON.parse(readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8"));

  it("rewrites the active phase signal to failed + cost-cap reason + needs-human, preserving prior fields", () => {
    writeSig("CTL-9", "implement", { status: "running", bg_job_id: "abc", startedAt: "2026-06-14T00:00:00Z" });
    const ok = markPhaseSignalFailed(orchDir, "CTL-9", "implement", {
      reason: "cost_cap_exceeded:$41.00>=$40.00", costUsd: 41, capUsd: 40, nowIso: "2026-06-14T01:00:00Z",
    });
    expect(ok).toBe(true);
    const sig = read("CTL-9", "implement");
    expect(sig.status).toBe("failed");
    expect(sig.failureReason).toBe("cost_cap_exceeded:$41.00>=$40.00");
    expect(sig.needsHuman).toBe(true);
    expect(sig.costCap).toEqual({ costUsd: 41, capUsd: 40, abortedAt: "2026-06-14T01:00:00Z" });
    expect(sig.bg_job_id).toBe("abc");          // prior fields preserved
    expect(sig.startedAt).toBe("2026-06-14T00:00:00Z");
  });

  it("is a no-op (false) when the signal is missing", () => {
    expect(markPhaseSignalFailed(orchDir, "CTL-absent", "verify", { reason: "x", costUsd: 99, capUsd: 40 })).toBe(false);
  });
});

describe("checkWorkerCost — the Pass 0c per-worker action", () => {
  function spies({ cost }) {
    const calls = { markFailed: [], reap: [] };
    return {
      calls,
      fetchCost: async () => cost,
      markFailed: (...a) => { calls.markFailed.push(a); return true; },
      reap: async (...a) => { calls.reap.push(a); },
      log: { warn: () => {} },
    };
  }
  const base = (extra) => ({
    orchDir: "/tmp/x", ticket: "CTL-1", phase: "verify", status: "running",
    sessionId: "uuid", bgJobId: "bg1", capUsd: 40, promBaseUrl: "http://p",
    ...extra,
  });

  it("ENFORCE + over-cap: terminal-writes AND reaps", async () => {
    const s = spies({ cost: 41 });
    const r = await checkWorkerCost(base({ mode: "enforce", fetchCost: s.fetchCost, markFailed: s.markFailed, reap: s.reap, log: s.log }));
    expect(r.action).toBe("aborted");
    expect(s.calls.markFailed).toHaveLength(1);
    expect(s.calls.markFailed[0][3].reason).toBe("cost_cap_exceeded:$41.00>=$40.00");
    expect(s.calls.reap).toHaveLength(1);
    expect(s.calls.reap[0]).toEqual(["phase.cost-cap.reap-requested", { ticket: "CTL-1", bgJobId: "bg1" }]);
  });

  it("SHADOW + over-cap: logs would-abort, mutates NOTHING (no markFailed, no reap)", async () => {
    const s = spies({ cost: 999 });
    const r = await checkWorkerCost(base({ mode: "shadow", fetchCost: s.fetchCost, markFailed: s.markFailed, reap: s.reap, log: s.log }));
    expect(r.action).toBe("would-abort");
    expect(s.calls.markFailed).toHaveLength(0);
    expect(s.calls.reap).toHaveLength(0);
  });

  it("under-cap: no action regardless of mode", async () => {
    const s = spies({ cost: 5 });
    const r = await checkWorkerCost(base({ mode: "enforce", fetchCost: s.fetchCost, markFailed: s.markFailed, reap: s.reap, log: s.log }));
    expect(r.action).toBe("none");
    expect(s.calls.markFailed).toHaveLength(0);
    expect(s.calls.reap).toHaveLength(0);
  });

  it("FAIL-OPEN: a null cost (Prom down) never aborts, even in enforce", async () => {
    const s = spies({ cost: null });
    const r = await checkWorkerCost(base({ mode: "enforce", fetchCost: s.fetchCost, markFailed: s.markFailed, reap: s.reap, log: s.log }));
    expect(r.action).toBe("none");
    expect(r.reason).toBe("no-cost-data");
    expect(s.calls.markFailed).toHaveLength(0);
  });
});
