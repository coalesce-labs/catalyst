import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nextAccountStatusLatch,
  checkAccountStatusTransition,
  getAccountStatusLatchPath,
  __resetAccountStatusLatchForTest,
} from "../account-status-latch.mjs";

describe("nextAccountStatusLatch (pure edge)", () => {
  it("ok→rejected trips with emit='rejected'", () =>
    expect(nextAccountStatusLatch(false, { trip: true, clear: false })).toEqual({
      latched: true,
      emit: "rejected",
    }));
  it("rejected→ok clears with emit='recovered'", () =>
    expect(nextAccountStatusLatch(true, { trip: false, clear: true })).toEqual({
      latched: false,
      emit: "recovered",
    }));
  it("no edge → emit:null", () => {
    expect(nextAccountStatusLatch(true, { trip: true, clear: false }).emit).toBeNull();
    expect(nextAccountStatusLatch(false, { trip: false, clear: false }).emit).toBeNull();
  });
});

describe("checkAccountStatusTransition (emit-then-advance)", () => {
  const summary = (status) => ({
    node: "mini-2",
    status,
    active: { label: "acctA", email: "a@x.io", bindingWindow: "seven_day" },
  });
  it("emits ONE event on ok→rejected with node + handle + new status", async () => {
    const events = [];
    const emit = (env) => {
      events.push(env);
      return true;
    };
    const state = { prev: false }; // injected in-memory latch for the test
    await checkAccountStatusTransition(summary("rejected"), { emit, state, persist: () => true });
    await checkAccountStatusTransition(summary("rejected"), { emit, state, persist: () => true }); // no re-emit
    expect(events.length).toBe(1);
    const a = events[0].attributes;
    expect(a["event.name"]).toBe("account.status.changed");
    expect(a["account.handle"]).toBe("acctA");
    expect(a["account.status"]).toBe("rejected");
    expect(events[0].resource["host.name"]).toBeDefined();
  });
  it("does NOT advance the latch when emit fails (retries same edge next tick)", async () => {
    const state = { prev: false };
    let ok = false;
    const emit = () => ok; // first tick fails, second succeeds
    await checkAccountStatusTransition(summary("rejected"), { emit, state, persist: () => true });
    expect(state.prev).toBe(false); // not advanced
    ok = true;
    const emitted = [];
    await checkAccountStatusTransition(summary("rejected"), {
      emit: (e) => (emitted.push(e), true),
      state,
      persist: () => true,
    });
    expect(emitted.length).toBe(1);
    expect(state.prev).toBe(true);
  });
  it("degraded/allowed_warning and error do NOT trip the rejected latch", async () => {
    const events = [];
    const state = { prev: false };
    await checkAccountStatusTransition(summary("degraded"), {
      emit: (e) => (events.push(e), true),
      state,
      persist: () => true,
    });
    await checkAccountStatusTransition(summary("error"), {
      emit: (e) => (events.push(e), true),
      state,
      persist: () => true,
    });
    expect(events.length).toBe(0);
  });
  it("emit-then-advance: a failed marker write still emits + advances (in-memory authoritative)", async () => {
    // CTL-1653 (2nd verify): the never-lose fix. The append is the source of truth,
    // NOT the marker. A transient marker-write failure must NOT swallow a real
    // transition — the event is emitted and the in-memory latch advances; only the
    // durable copy lags (the module path retries it via _persistPending next tick).
    const state = { prev: false };
    const emitted = [];
    const emit = (e) => (emitted.push(e), true);
    const edge = await checkAccountStatusTransition(summary("rejected"), {
      emit,
      state,
      persist: () => false, // marker write fails
    });
    expect(edge).toBe("rejected"); // emitted despite the failed marker write
    expect(emitted.length).toBe(1);
    expect(state.prev).toBe(true); // in-memory advanced (authoritative)

    // Still rejected: already latched → no re-emit even after the write recovers.
    const noEdge = await checkAccountStatusTransition(summary("rejected"), {
      emit,
      state,
      persist: () => true,
    });
    expect(noEdge).toBeNull();
    expect(emitted.length).toBe(1);
  });
  it("append failing does NOT touch the marker and retries the SAME edge next tick", async () => {
    // never-lose: the marker is written only AFTER a successful append, so a failed
    // append leaves both the latch un-advanced AND the marker untouched (no bogus
    // rollback dance) — the identical edge is recomputed and retried next tick.
    const state = { prev: false };
    const persistCalls = [];
    const persist = ({ latched }) => (persistCalls.push(latched), true);
    let emitOk = false;
    await checkAccountStatusTransition(summary("rejected"), {
      emit: () => emitOk, // append fails
      state,
      persist,
    });
    expect(state.prev).toBe(false); // un-advanced
    expect(persistCalls).toEqual([]); // marker never touched on a failed append

    emitOk = true;
    const emitted = [];
    const edge = await checkAccountStatusTransition(summary("rejected"), {
      emit: (e) => (emitted.push(e), true),
      state,
      persist,
    });
    expect(edge).toBe("rejected");
    expect(emitted.length).toBe(1);
    expect(state.prev).toBe(true);
    expect(persistCalls).toEqual([true]); // persisted once, AFTER the good append
  });
});

describe("checkAccountStatusTransition durable marker + restart (real disk)", () => {
  let dir = null;
  const summary = (status) => ({
    node: "mini-2",
    status,
    active: { label: "acctA", email: "a@x.io", bindingWindow: "seven_day" },
  });
  afterEach(() => {
    __resetAccountStatusLatchForTest();
    delete process.env.CATALYST_DIR;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });
  it("a restart mid-'rejected' episode does NOT re-emit; the 'ok' edge emits exactly one 'recovered'", async () => {
    // medium coverage (CTL-1653): exercise the REAL persistLatchToDisk + hydrateLatch
    // over a temp CATALYST_DIR, the exact path the injected-state unit tests bypass.
    dir = mkdtempSync(join(tmpdir(), "acct-latch-"));
    process.env.CATALYST_DIR = dir;
    // Simulate an open episode persisted by a prior process, then a restart.
    writeFileSync(getAccountStatusLatchPath(), JSON.stringify({ latched: true, ts: 1 }));
    __resetAccountStatusLatchForTest(); // clears hydration flag → next tick re-reads disk

    const emitted = [];
    const emit = (e) => (emitted.push(e), true);

    // Post-restart tick still sees 'rejected': already latched → NO re-emit.
    const noEdge = await checkAccountStatusTransition(summary("rejected"), { emit });
    expect(noEdge).toBeNull();
    expect(emitted.length).toBe(0);

    // Account recovers: the ok edge emits exactly one 'recovered' and clears disk.
    const edge = await checkAccountStatusTransition(summary("ok"), { emit });
    expect(edge).toBe("recovered");
    expect(emitted.length).toBe(1);
    expect(emitted[0].attributes["account.status"]).toBe("ok");
    expect(JSON.parse(readFileSync(getAccountStatusLatchPath(), "utf8")).latched).toBe(false);
  });
  it("_persistPending: a failed post-emit marker write is retried next tick without re-emitting", async () => {
    // CTL-1653 (2nd verify): ports broker-degraded.mjs's Codex #2740 reconcile. A
    // post-emit marker write that fails must NOT be swallowed (memory would outrun
    // disk and a restart could re-emit a duplicate edge) — it is retried on the next
    // module-path tick, and that retry NEVER re-emits (in-memory stays authoritative).
    dir = mkdtempSync(join(tmpdir(), "acct-latch-"));
    process.env.CATALYST_DIR = dir;
    __resetAccountStatusLatchForTest();

    const emitted = [];
    const emit = (e) => (emitted.push(e), true);
    // A fake persist we can fail then heal (module path → _persistPending is tracked).
    let persistOk = false;
    const persistCalls = [];
    const persist = ({ latched }) => (persistCalls.push({ latched, ok: persistOk }), persistOk);

    // Tick 1: ok→rejected. Append succeeds; the marker write FAILS → edge still emits,
    // in-memory latch advances, _persistPending is armed.
    const edge1 = await checkAccountStatusTransition(summary("rejected"), { emit, persist });
    expect(edge1).toBe("rejected");
    expect(emitted.length).toBe(1);
    expect(persistCalls).toEqual([{ latched: true, ok: false }]);

    // Tick 2: still rejected (no new edge). The reconcile retries the marker write —
    // now succeeding — and emits NOTHING (already latched).
    persistOk = true;
    const edge2 = await checkAccountStatusTransition(summary("rejected"), { emit, persist });
    expect(edge2).toBeNull();
    expect(emitted.length).toBe(1); // no duplicate
    // The reconcile fired with the authoritative latched=true, and it landed.
    expect(persistCalls).toEqual([
      { latched: true, ok: false },
      { latched: true, ok: true },
    ]);
  });
});
