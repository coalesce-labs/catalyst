import { describe, it, expect } from "bun:test";
import { nextAccountStatusLatch, checkAccountStatusTransition } from "../account-status-latch.mjs";

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
});
