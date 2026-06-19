// cache-reconcile.test.mjs — CTL-1277 broker-side state+labels reconcile.
// Pure decision + injectable IO: no linearis spawn, no DB.

import { describe, test, expect } from "bun:test";
import pino from "pino";
import {
  extractState,
  decideReconcile,
  reconcileCacheState,
  readCacheReconcileConfig,
  startCacheReconcileTimer,
  rotateWindow,
} from "./cache-reconcile.mjs";

// pinoLikeLogger — methods THROW if invoked with the wrong `this`, exactly like
// pino (which dereferences this[msgPrefixSym]). Reproduces the CTL-1277 broker
// boot-crash: the old wiring pulled the method out of the logger and called it
// detached.
function pinoLikeLogger() {
  const calls = [];
  const logger = {
    info(obj, msg) { if (this !== logger) throw new TypeError("detached this"); calls.push(["info", obj, msg]); },
    warn(obj, msg) { if (this !== logger) throw new TypeError("detached this"); calls.push(["warn", obj, msg]); },
    debug(obj, msg) { if (this !== logger) throw new TypeError("detached this"); calls.push(["debug", obj, msg]); },
  };
  return { logger, calls };
}

describe("extractState", () => {
  test("pulls state.name from a linearis read object", () => {
    expect(extractState({ state: { id: "x", name: "Implement" } })).toBe("Implement");
  });
  test("returns null for absent/malformed/blank state", () => {
    expect(extractState({})).toBeNull();
    expect(extractState({ state: null })).toBeNull();
    expect(extractState({ state: [] })).toBeNull();
    expect(extractState({ state: { name: "" } })).toBeNull();
    expect(extractState(null)).toBeNull();
  });
});

describe("decideReconcile — pure drift decision", () => {
  test("drifted state → writeState, carries the new value", () => {
    const d = decideReconcile({ current: { state: "Todo" }, fetchedState: "Implement", fetchedLabels: null });
    expect(d.writeState).toBe(true);
    expect(d.state).toBe("Implement");
    expect(d.changed).toBe(true);
    expect(d.writeLabels).toBe(false);
  });

  test("case-insensitive state match is NOT a write", () => {
    const d = decideReconcile({ current: { state: "Implement" }, fetchedState: "implement", fetchedLabels: null });
    expect(d.writeState).toBe(false);
    expect(d.changed).toBe(false);
  });

  test("drifted labels → writeLabels (order-insensitive)", () => {
    const d = decideReconcile({
      current: { state: "Todo", labels: ["a", "b"] },
      fetchedState: "Todo",
      fetchedLabels: ["b", "c"],
    });
    expect(d.writeLabels).toBe(true);
    expect(d.labels).toEqual(["b", "c"]);
    expect(d.writeState).toBe(false);
  });

  test("same label set (reordered) is NOT a write", () => {
    const d = decideReconcile({
      current: { state: "Todo", labels: ["a", "b"] },
      fetchedState: "Todo",
      fetchedLabels: ["b", "a"],
    });
    expect(d.writeLabels).toBe(false);
    expect(d.changed).toBe(false);
  });

  test("null fetched fields leave everything untouched (unknown)", () => {
    const d = decideReconcile({ current: { state: "Todo", labels: ["a"] }, fetchedState: null, fetchedLabels: null });
    expect(d.changed).toBe(false);
    expect(d.writeState).toBe(false);
    expect(d.writeLabels).toBe(false);
  });

  test("KEY-PRESENCE: only drifted fields are present in the decision", () => {
    const d = decideReconcile({ current: { state: "Todo", labels: ["a"] }, fetchedState: "Implement", fetchedLabels: ["a"] });
    expect(d.writeState).toBe(true);
    expect(d.writeLabels).toBe(false);
    expect(d.state).toBe("Implement");
    expect(d.labels).toBeUndefined();
  });
});

const desc = (over = {}) => ({ ticket: "CTL-1", state: "Todo", labels: [], ...over });

describe("reconcileCacheState — full pass (async, CTL-1282)", () => {
  test("mode=off is a no-op (never fetches or writes)", async () => {
    let fetched = 0;
    const out = await reconcileCacheState({
      mode: "off",
      getAll: () => [desc()],
      fetch: async () => { fetched++; return { state: "Implement", labels: [] }; },
      upsert: () => { throw new Error("must not write"); },
    });
    expect(out.scanned).toBe(0);
    expect(fetched).toBe(0);
  });

  test("enforce writes ONLY the drifted field (key-presence)", async () => {
    const writes = [];
    const out = await reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ ticket: "CTL-764", state: "Todo", labels: ["x"] })],
      fetch: async () => ({ state: "Implement", labels: ["x"] }),
      upsert: (p) => writes.push(p),
    });
    expect(out.scanned).toBe(1);
    expect(out.changed).toBe(1);
    expect(writes).toEqual([{ ticket: "CTL-764", state: "Implement" }]);
    expect("labels" in writes[0]).toBe(false); // labels matched → not written
  });

  test("shadow counts the change but writes nothing", async () => {
    let wrote = false;
    const out = await reconcileCacheState({
      mode: "shadow",
      getAll: () => [desc({ state: "Todo" })],
      fetch: async () => ({ state: "Implement", labels: [] }),
      upsert: () => { wrote = true; },
    });
    expect(out.changed).toBe(1);
    expect(wrote).toBe(false);
  });

  test("idempotent: no drift → no write", async () => {
    const writes = [];
    const out = await reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ state: "Implement", labels: ["a"] })],
      fetch: async () => ({ state: "Implement", labels: ["a"] }),
      upsert: (p) => writes.push(p),
    });
    expect(out.changed).toBe(0);
    expect(writes).toEqual([]);
  });

  test("terminal tickets are skipped (not fetched)", async () => {
    let fetched = 0;
    const out = await reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ ticket: "CTL-D", state: "Done" }), desc({ ticket: "CTL-C", state: "Canceled" })],
      fetch: async () => { fetched++; return { state: "Implement", labels: [] }; },
      upsert: () => {},
    });
    expect(out.scanned).toBe(0);
    expect(fetched).toBe(0);
  });

  test("fail-soft: a fetch error counts as failed and never throws", async () => {
    const out = await reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ ticket: "CTL-A" }), desc({ ticket: "CTL-B", state: "Todo" })],
      fetch: async (t) => (t === "CTL-A" ? { state: null, labels: null, error: "exit 1" } : { state: "Implement", labels: [] }),
      upsert: () => {},
    });
    expect(out.scanned).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.changed).toBe(1);
  });

  test("a REJECTED fetch promise is fail-soft (counted failed, never throws)", async () => {
    const out = await reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ ticket: "CTL-A", state: "Todo" })],
      fetch: async () => { throw new Error("spawn EPIPE"); },
      upsert: () => {},
    });
    expect(out.scanned).toBe(1);
    expect(out.failed).toBe(1);
  });

  test("an upsert throw is fail-soft (counted failed, not changed)", async () => {
    const out = await reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ state: "Todo" })],
      fetch: async () => ({ state: "Implement", labels: [] }),
      upsert: () => { throw new Error("db locked"); },
    });
    expect(out.failed).toBe(1);
    expect(out.changed).toBe(0);
  });

  test("perPassCap bounds the work", async () => {
    const many = Array.from({ length: 10 }, (_, i) => desc({ ticket: `CTL-${i}`, state: "Todo" }));
    let fetched = 0;
    const out = await reconcileCacheState({
      mode: "enforce",
      perPassCap: 3,
      getAll: () => many,
      fetch: async () => { fetched++; return { state: "Implement", labels: [] }; },
      upsert: () => {},
    });
    expect(out.scanned).toBe(3);
    expect(fetched).toBe(3);
  });
});

describe("readCacheReconcileConfig", () => {
  test("defaults to off", () => {
    expect(readCacheReconcileConfig({}).mode).toBe("off");
  });
  test("honors shadow/enforce, rejects garbage", () => {
    expect(readCacheReconcileConfig({ CATALYST_CACHE_RECONCILE: "shadow" }).mode).toBe("shadow");
    expect(readCacheReconcileConfig({ CATALYST_CACHE_RECONCILE: "enforce" }).mode).toBe("enforce");
    expect(readCacheReconcileConfig({ CATALYST_CACHE_RECONCILE: "yolo" }).mode).toBe("off");
  });
  test("interval + cap parse with sane fallbacks", () => {
    const c = readCacheReconcileConfig({ CATALYST_CACHE_RECONCILE_INTERVAL_MS: "60000", CATALYST_CACHE_RECONCILE_CAP: "5" });
    expect(c.intervalMs).toBe(60000);
    expect(c.perPassCap).toBe(5);
    expect(readCacheReconcileConfig({ CATALYST_CACHE_RECONCILE_INTERVAL_MS: "nope" }).intervalMs).toBeGreaterThan(0);
  });
});

describe("startCacheReconcileTimer", () => {
  test("mode=off → no timer (returns null)", () => {
    let armed = false;
    const id = startCacheReconcileTimer({
      config: { mode: "off", intervalMs: 1000, perPassCap: 10 },
      setTimer: () => { armed = true; return 1; },
    });
    expect(id).toBeNull();
    expect(armed).toBe(false);
  });

  test("enabled arms a timer; its async pass emits an audit event", async () => {
    let pass;
    const emits = [];
    startCacheReconcileTimer({
      config: { mode: "enforce", intervalMs: 1000, perPassCap: 10 },
      reconcile: async () => ({ mode: "enforce", scanned: 2, changed: 1, failed: 0, tickets: [] }),
      emit: (e) => emits.push(e),
      setTimer: (fn) => { pass = fn; return 42; },
    });
    expect(typeof pass).toBe("function");
    await pass();
    expect(emits).toEqual([{ kind: "cache.reconcile", mode: "enforce", scanned: 2, changed: 1, failed: 0 }]);
  });

  test("a throwing pass is caught (fail-soft) and emit failure never propagates", async () => {
    let pass;
    startCacheReconcileTimer({
      config: { mode: "enforce", intervalMs: 1000, perPassCap: 10 },
      reconcile: async () => { throw new Error("boom"); },
      emit: () => { throw new Error("emit boom"); },
      setTimer: (fn) => { pass = fn; return 1; },
    });
    await expect(pass()).resolves.toBeUndefined();
  });

  test("re-entrancy guard: an overlapping tick is SKIPPED while a pass runs (CTL-1282)", async () => {
    let pass;
    let passCount = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    startCacheReconcileTimer({
      config: { mode: "enforce", intervalMs: 1, perPassCap: 10 },
      reconcile: async () => { passCount++; await gate; return { mode: "enforce", scanned: 0, changed: 0, failed: 0, tickets: [] }; },
      setTimer: (fn) => { pass = fn; return 1; },
    });
    const first = pass();      // running=true, awaits the gate
    await pass();              // fires mid-pass → must skip (no second reconcile)
    expect(passCount).toBe(1);
    release();
    await first;              // first completes, running=false
    await pass();             // now free → a real second pass runs
    expect(passCount).toBe(2);
  });
});

// CTL-1277 hotfix: the broker crashed at boot because the wiring detached the
// pino method from its instance. These reproduce the exact crash and guard it.
describe("logger binding (broker boot-crash regression)", () => {
  test("OFF-mode startup log does NOT throw with a pino-like logger (the prod crash)", () => {
    const { logger, calls } = pinoLikeLogger();
    expect(() =>
      startCacheReconcileTimer({ config: { mode: "off", intervalMs: 1000, perPassCap: 10 }, logger }),
    ).not.toThrow();
    expect(calls.some(([lvl]) => lvl === "info")).toBe(true); // the "disabled" line logged, bound
  });

  test("enabled startup log is bound (this === logger)", () => {
    const { logger, calls } = pinoLikeLogger();
    expect(() =>
      startCacheReconcileTimer({
        config: { mode: "enforce", intervalMs: 1000, perPassCap: 10 },
        logger,
        setTimer: () => 1,
      }),
    ).not.toThrow();
    expect(calls.some(([, obj]) => obj && obj.mode === "enforce")).toBe(true);
  });

  test("reconcile pass logs through a pino-like logger without detaching", async () => {
    const { logger } = pinoLikeLogger();
    await expect(
      reconcileCacheState({
        mode: "enforce",
        getAll: () => [{ ticket: "CTL-1", state: "Todo", labels: [] }],
        fetch: async () => ({ state: "Implement", labels: [] }),
        upsert: () => {},
        logger,
      }),
    ).resolves.toBeDefined();
  });

  test("REAL pino logger: off-mode boot does not throw (end-to-end proof)", () => {
    const realLogger = pino({ level: "silent" });
    expect(() =>
      startCacheReconcileTimer({ config: { mode: "off", intervalMs: 1000, perPassCap: 10 }, logger: realLogger }),
    ).not.toThrow();
  });

  test("a garbage / missing logger is a safe no-op (never throws)", async () => {
    expect(() => startCacheReconcileTimer({ config: { mode: "off", intervalMs: 1, perPassCap: 1 } })).not.toThrow();
    await expect(
      reconcileCacheState({ mode: "enforce", getAll: () => [{ ticket: "X", state: "Todo" }], fetch: async () => ({ state: "Done", labels: [] }), upsert: () => {}, logger: 42 }),
    ).resolves.toBeDefined();
  });
});

// ─── CTL-1288: rotation cursor + active-pipeline priority ────────────────────
describe("rotateWindow (CTL-1288)", () => {
  const L = (...ids) => ids.map((id) => ({ ticket: id })); // ticket-sorted list

  test("n<=0 or empty list → empty window, cursor unchanged", () => {
    expect(rotateWindow(L("CTL-1", "CTL-2"), null, 0)).toEqual({ window: [], nextCursor: null });
    expect(rotateWindow([], "CTL-5", 3)).toEqual({ window: [], nextCursor: "CTL-5" });
  });

  test("null cursor starts at the beginning; nextCursor is the last taken", () => {
    const { window, nextCursor } = rotateWindow(L("CTL-1", "CTL-2", "CTL-3"), null, 2);
    expect(window.map((d) => d.ticket)).toEqual(["CTL-1", "CTL-2"]);
    expect(nextCursor).toBe("CTL-2");
  });

  test("cursor resumes at the first ticket strictly greater than it", () => {
    const { window, nextCursor } = rotateWindow(L("CTL-1", "CTL-2", "CTL-3", "CTL-4"), "CTL-2", 2);
    expect(window.map((d) => d.ticket)).toEqual(["CTL-3", "CTL-4"]);
    expect(nextCursor).toBe("CTL-4");
  });

  test("removed cursor ticket → resumes at the next-greater (resilient to churn)", () => {
    // "CTL-2" no longer in the list; resume at CTL-3 (first > CTL-2).
    const { window } = rotateWindow(L("CTL-1", "CTL-3", "CTL-4"), "CTL-2", 1);
    expect(window.map((d) => d.ticket)).toEqual(["CTL-3"]);
  });

  test("cursor at/after the end wraps to the start", () => {
    const { window, nextCursor } = rotateWindow(L("CTL-1", "CTL-2", "CTL-3"), "CTL-9", 2);
    expect(window.map((d) => d.ticket)).toEqual(["CTL-1", "CTL-2"]);
    expect(nextCursor).toBe("CTL-2");
  });

  test("n >= list length covers the whole list with NO duplicates", () => {
    const { window } = rotateWindow(L("CTL-1", "CTL-2", "CTL-3"), "CTL-2", 99);
    expect(window.map((d) => d.ticket).sort()).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
    expect(new Set(window.map((d) => d.ticket)).size).toBe(3); // no double-fetch
  });

  test("successive passes advance through the whole list, then wrap", () => {
    const list = L("CTL-1", "CTL-2", "CTL-3", "CTL-4", "CTL-5");
    let cursor = null;
    const seen = [];
    for (let pass = 0; pass < 3; pass++) {
      const r = rotateWindow(list, cursor, 2);
      seen.push(r.window.map((d) => d.ticket));
      cursor = r.nextCursor;
    }
    expect(seen).toEqual([["CTL-1", "CTL-2"], ["CTL-3", "CTL-4"], ["CTL-5", "CTL-1"]]);
  });
});

describe("reconcileCacheState two-tier selection (CTL-1288)", () => {
  // a board with active-pipeline rows + more Backlog than the remaining cap
  const board = () => [
    desc({ ticket: "CTL-100", state: "PR" }),
    desc({ ticket: "CTL-101", state: "Implement" }),
    desc({ ticket: "CTL-B1", state: "Backlog" }),
    desc({ ticket: "CTL-B2", state: "Backlog" }),
    desc({ ticket: "CTL-B3", state: "Backlog" }),
    desc({ ticket: "CTL-D1", state: "Done" }), // terminal — never reconciled
  ];

  test("active-pipeline rows are reconciled EVERY pass regardless of cursor", async () => {
    const fetchedAll = [];
    // tiny cap: 2 active + 1 backlog slot. Run two passes; active must appear both.
    let cursor = null;
    for (let pass = 0; pass < 2; pass++) {
      const fetched = [];
      const out = await reconcileCacheState({
        mode: "enforce", perPassCap: 3, cursor,
        getAll: () => board(),
        fetch: async (t) => { fetched.push(t); return { state: "Backlog", labels: [] }; },
        upsert: () => {},
      });
      cursor = out.nextCursor;
      fetchedAll.push(fetched);
    }
    // CTL-100 (PR) and CTL-101 (Implement) fetched on BOTH passes; never terminal CTL-D1.
    for (const f of fetchedAll) {
      expect(f).toContain("CTL-100");
      expect(f).toContain("CTL-101");
      expect(f).not.toContain("CTL-D1");
    }
  });

  test("Backlog is rotated across passes; whole Backlog covered, no per-pass duplicates", async () => {
    let cursor = null;
    const backlogSeen = new Set();
    for (let pass = 0; pass < 3; pass++) {
      const fetched = [];
      const out = await reconcileCacheState({
        mode: "enforce", perPassCap: 3, cursor,
        getAll: () => board(),
        fetch: async (t) => { fetched.push(t); return { state: "Backlog", labels: [] }; },
        upsert: () => {},
      });
      cursor = out.nextCursor;
      // exactly one backlog per pass (cap 3 - 2 active = 1 remaining), no dupes within a pass
      const bl = fetched.filter((t) => t.startsWith("CTL-B"));
      expect(bl.length).toBe(1);
      bl.forEach((t) => backlogSeen.add(t));
    }
    expect([...backlogSeen].sort()).toEqual(["CTL-B1", "CTL-B2", "CTL-B3"]); // all 3 covered over 3 passes
  });

  test("a PR-state phantom (cache=PR, live=Done) is corrected in ONE pass (active tier)", async () => {
    const writes = [];
    const out = await reconcileCacheState({
      mode: "enforce", perPassCap: 250, cursor: null,
      getAll: () => [desc({ ticket: "CTL-1191", state: "PR" })],
      fetch: async () => ({ state: "Done", labels: [] }),
      upsert: (p) => writes.push(p),
    });
    expect(out.changed).toBe(1);
    expect(writes).toEqual([{ ticket: "CTL-1191", state: "Done" }]);
  });

  test("a pass never issues more than perPassCap fetches (rate-limit bound)", async () => {
    const many = Array.from({ length: 500 }, (_, i) => desc({ ticket: `CTL-B${String(i).padStart(3, "0")}`, state: "Backlog" }));
    let fetches = 0;
    const out = await reconcileCacheState({
      mode: "enforce", perPassCap: 50, cursor: null,
      getAll: () => many,
      fetch: async () => { fetches++; return { state: "Backlog", labels: [] }; },
      upsert: () => {},
    });
    expect(fetches).toBeLessThanOrEqual(50);
    expect(out.scanned).toBeLessThanOrEqual(50);
  });

  test("returns a per-tier nextCursor so the timer can thread it across passes", async () => {
    const out = await reconcileCacheState({
      mode: "shadow", perPassCap: 1, cursor: null,
      getAll: () => [desc({ ticket: "CTL-B1", state: "Backlog" }), desc({ ticket: "CTL-B2", state: "Backlog" })],
      fetch: async () => ({ state: "Backlog", labels: [] }),
      upsert: () => {},
    });
    expect(out.nextCursor.backlog).toBe("CTL-B1");
    expect(out.nextCursor).toHaveProperty("active");
  });

  // ── CTL-1288 verify-workflow regression: active>=budget must NOT starve either tier ──
  test("active tier rotates when it exceeds its budget — no active-tail starvation", async () => {
    // 5 active, cap=4 → backlogReserve=1, activeBudget=3 → active rotates 3/pass,
    // all 5 covered within 2 passes; backlog still gets its reserve.
    const rows = () => [
      ...["CTL-A1", "CTL-A2", "CTL-A3", "CTL-A4", "CTL-A5"].map((t) => desc({ ticket: t, state: "PR" })),
      desc({ ticket: "CTL-Z1", state: "Backlog" }),
    ];
    let cursor = { active: null, backlog: null };
    const activeSeen = new Set();
    let backlogTotal = 0;
    for (let pass = 0; pass < 2; pass++) {
      const fetched = [];
      const out = await reconcileCacheState({
        mode: "enforce", perPassCap: 4, cursor,
        getAll: rows, fetch: async (t) => { fetched.push(t); return { state: "PR", labels: [] }; }, upsert: () => {},
      });
      cursor = out.nextCursor;
      expect(fetched.length).toBeLessThanOrEqual(4); // cap bound holds under overflow
      fetched.filter((t) => t.startsWith("CTL-A")).forEach((t) => activeSeen.add(t));
      backlogTotal += fetched.filter((t) => t.startsWith("CTL-Z")).length;
    }
    expect([...activeSeen].sort()).toEqual(["CTL-A1", "CTL-A2", "CTL-A3", "CTL-A4", "CTL-A5"]); // tail NOT starved
    expect(backlogTotal).toBeGreaterThanOrEqual(1); // backlog got the reserve despite active overflow
  });

  test("Backlog keeps its reserve when active fills the cap (no Backlog starvation)", async () => {
    // 10 active, cap=5 → backlogReserve=1, activeBudget=4 → backlog ALWAYS gets ≥1.
    const rows = () => [
      ...Array.from({ length: 10 }, (_, i) => desc({ ticket: `CTL-A${i}`, state: "Implement" })),
      desc({ ticket: "CTL-Z1", state: "Backlog" }), desc({ ticket: "CTL-Z2", state: "Backlog" }),
    ];
    let cursor = { active: null, backlog: null };
    const backlogSeen = new Set();
    for (let pass = 0; pass < 2; pass++) {
      const fetched = [];
      const out = await reconcileCacheState({
        mode: "enforce", perPassCap: 5, cursor,
        getAll: rows, fetch: async (t) => { fetched.push(t); return { state: "Implement", labels: [] }; }, upsert: () => {},
      });
      cursor = out.nextCursor;
      expect(fetched.length).toBeLessThanOrEqual(5);
      const bl = fetched.filter((t) => t.startsWith("CTL-Z"));
      expect(bl.length).toBeGreaterThanOrEqual(1); // reserve floor honored every pass
      bl.forEach((t) => backlogSeen.add(t));
    }
    expect([...backlogSeen].sort()).toEqual(["CTL-Z1", "CTL-Z2"]); // backlog fully covered, never starved
  });
});
