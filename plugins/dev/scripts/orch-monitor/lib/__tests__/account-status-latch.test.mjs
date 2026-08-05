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

describe("checkAccountStatusTransition (persist-before-emit)", () => {
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
  it("persist() failing emits NOTHING and leaves the latch un-advanced (retries next tick)", async () => {
    // HIGH finding (CTL-1653): the durable marker is the source of truth. If it
    // cannot be written we must not emit — a restart would otherwise re-announce
    // an episode whose marker never landed. The edge is preserved for retry.
    const state = { prev: false };
    let persistOk = false;
    const emitted = [];
    const emit = (e) => (emitted.push(e), true);
    await checkAccountStatusTransition(summary("rejected"), {
      emit,
      state,
      persist: () => persistOk,
    });
    expect(emitted.length).toBe(0); // persist-before-emit: no marker → no event
    expect(state.prev).toBe(false); // latch un-advanced → same edge next tick

    persistOk = true; // marker write recovers
    const edge = await checkAccountStatusTransition(summary("rejected"), {
      emit,
      state,
      persist: () => persistOk,
    });
    expect(edge).toBe("rejected");
    expect(emitted.length).toBe(1); // exactly one emit once the marker persists
    expect(state.prev).toBe(true);
  });
  it("rolls the marker back and retries when the append fails AFTER a good persist", async () => {
    // never-lose: a failed append must not leave the marker advanced (which would
    // make a restart suppress the edge). The marker is rolled back to pre-edge.
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
    // marker advanced true then rolled back to false (pre-edge)
    expect(persistCalls).toEqual([true, false]);

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
});
