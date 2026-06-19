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

describe("reconcileCacheState — full pass", () => {
  test("mode=off is a no-op (never fetches or writes)", () => {
    let fetched = 0;
    const out = reconcileCacheState({
      mode: "off",
      getAll: () => [desc()],
      fetch: () => { fetched++; return { state: "Implement", labels: [] }; },
      upsert: () => { throw new Error("must not write"); },
    });
    expect(out.scanned).toBe(0);
    expect(fetched).toBe(0);
  });

  test("enforce writes ONLY the drifted field (key-presence)", () => {
    const writes = [];
    const out = reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ ticket: "CTL-764", state: "Todo", labels: ["x"] })],
      fetch: () => ({ state: "Implement", labels: ["x"] }),
      upsert: (p) => writes.push(p),
    });
    expect(out.scanned).toBe(1);
    expect(out.changed).toBe(1);
    expect(writes).toEqual([{ ticket: "CTL-764", state: "Implement" }]);
    expect("labels" in writes[0]).toBe(false); // labels matched → not written
  });

  test("shadow counts the change but writes nothing", () => {
    let wrote = false;
    const out = reconcileCacheState({
      mode: "shadow",
      getAll: () => [desc({ state: "Todo" })],
      fetch: () => ({ state: "Implement", labels: [] }),
      upsert: () => { wrote = true; },
    });
    expect(out.changed).toBe(1);
    expect(wrote).toBe(false);
  });

  test("idempotent: no drift → no write", () => {
    const writes = [];
    const out = reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ state: "Implement", labels: ["a"] })],
      fetch: () => ({ state: "Implement", labels: ["a"] }),
      upsert: (p) => writes.push(p),
    });
    expect(out.changed).toBe(0);
    expect(writes).toEqual([]);
  });

  test("terminal tickets are skipped (not fetched)", () => {
    let fetched = 0;
    const out = reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ ticket: "CTL-D", state: "Done" }), desc({ ticket: "CTL-C", state: "Canceled" })],
      fetch: () => { fetched++; return { state: "Implement", labels: [] }; },
      upsert: () => {},
    });
    expect(out.scanned).toBe(0);
    expect(fetched).toBe(0);
  });

  test("fail-soft: a fetch error counts as failed and never throws", () => {
    const out = reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ ticket: "CTL-A" }), desc({ ticket: "CTL-B", state: "Todo" })],
      fetch: (t) => (t === "CTL-A" ? { state: null, labels: null, error: "exit 1" } : { state: "Implement", labels: [] }),
      upsert: () => {},
    });
    expect(out.scanned).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.changed).toBe(1);
  });

  test("an upsert throw is fail-soft (counted failed, not changed)", () => {
    const out = reconcileCacheState({
      mode: "enforce",
      getAll: () => [desc({ state: "Todo" })],
      fetch: () => ({ state: "Implement", labels: [] }),
      upsert: () => { throw new Error("db locked"); },
    });
    expect(out.failed).toBe(1);
    expect(out.changed).toBe(0);
  });

  test("perPassCap bounds the work", () => {
    const many = Array.from({ length: 10 }, (_, i) => desc({ ticket: `CTL-${i}`, state: "Todo" }));
    let fetched = 0;
    const out = reconcileCacheState({
      mode: "enforce",
      perPassCap: 3,
      getAll: () => many,
      fetch: () => { fetched++; return { state: "Implement", labels: [] }; },
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

  test("enabled arms a timer; its pass emits an audit event", () => {
    let pass;
    const emits = [];
    startCacheReconcileTimer({
      config: { mode: "enforce", intervalMs: 1000, perPassCap: 10 },
      reconcile: () => ({ mode: "enforce", scanned: 2, changed: 1, failed: 0, tickets: [] }),
      emit: (e) => emits.push(e),
      setTimer: (fn) => { pass = fn; return 42; },
    });
    expect(typeof pass).toBe("function");
    pass();
    expect(emits).toEqual([{ kind: "cache.reconcile", mode: "enforce", scanned: 2, changed: 1, failed: 0 }]);
  });

  test("a throwing pass is caught (fail-soft) and emit failure never propagates", () => {
    let pass;
    startCacheReconcileTimer({
      config: { mode: "enforce", intervalMs: 1000, perPassCap: 10 },
      reconcile: () => { throw new Error("boom"); },
      emit: () => { throw new Error("emit boom"); },
      setTimer: (fn) => { pass = fn; return 1; },
    });
    expect(() => pass()).not.toThrow();
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

  test("reconcile pass logs through a pino-like logger without detaching", () => {
    const { logger } = pinoLikeLogger();
    expect(() =>
      reconcileCacheState({
        mode: "enforce",
        getAll: () => [{ ticket: "CTL-1", state: "Todo", labels: [] }],
        fetch: () => ({ state: "Implement", labels: [] }),
        upsert: () => {},
        logger,
      }),
    ).not.toThrow();
  });

  test("REAL pino logger: off-mode boot does not throw (end-to-end proof)", () => {
    const realLogger = pino({ level: "silent" });
    expect(() =>
      startCacheReconcileTimer({ config: { mode: "off", intervalMs: 1000, perPassCap: 10 }, logger: realLogger }),
    ).not.toThrow();
  });

  test("a garbage / missing logger is a safe no-op (never throws)", () => {
    expect(() => startCacheReconcileTimer({ config: { mode: "off", intervalMs: 1, perPassCap: 1 } })).not.toThrow();
    expect(() =>
      reconcileCacheState({ mode: "enforce", getAll: () => [{ ticket: "X", state: "Todo" }], fetch: () => ({ state: "Done", labels: [] }), upsert: () => {}, logger: 42 }),
    ).not.toThrow();
  });
});
