// liveness-deflap.test.mjs — CTL-1091 Phase 2. Unit tests for the pure
// restore-side deflap that layers on top of the surviving roster: a host that
// transitioned dead→live must be observed continuously live for holdMs before it
// re-enters the DISPATCH roster, so a flapping laptop (lid open/close) does not
// grab-then-strand new work.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDispatchRoster,
  readDeflapState,
  writeDeflapState,
  DEFLAP_STATE_FILE,
} from "./liveness-deflap.mjs";

describe("computeDispatchRoster — restore deflap (CTL-1091)", () => {
  const HOLD = 600_000; // HEARTBEAT_RESTORE_HOLD_MS

  test("keeps a freshly-restored host OUT until continuously live for the hold", () => {
    // prevState marks laptop as previously dead (liveSince:null). It is live now
    // (in survivingRoster) → first live observation → liveSince=nowMs, elapsed
    // 0 < HOLD → excluded from the dispatch roster.
    const { dispatchRoster, nextState } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: null } },
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster).toEqual(["mini"]);
    expect(nextState.laptop.liveSince).toBe(1_000);
  });

  test("admits the host once liveSince is older than the hold", () => {
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 1_000 + HOLD + 1,
    });
    expect(dispatchRoster).toEqual(["mini", "laptop"]);
  });

  test("still holds the host the tick BEFORE the hold elapses (boundary)", () => {
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 1_000 + HOLD - 1,
    });
    expect(dispatchRoster).toEqual(["mini"]);
  });

  test("preserves a continuously-live host's liveSince across ticks", () => {
    const { nextState } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 50_000,
    });
    expect(nextState.laptop.liveSince).toBe(1_000);
  });

  test("resets liveSince when the host drops out of the surviving roster (flap)", () => {
    // laptop had a live-hold running, now it is NOT in survivingRoster (shed) →
    // liveSince resets to null so a re-join restarts the whole hold.
    const { nextState, dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini"],
      roster: ["mini", "laptop"],
      prevState: { laptop: { liveSince: 1_000 } },
      holdMs: HOLD,
      nowMs: 5_000,
    });
    expect(nextState.laptop.liveSince).toBeNull();
    expect(dispatchRoster).toEqual(["mini"]);
  });

  test("never delays the SELF host, even if it looks freshly restored", () => {
    // A host never defers taking its OWN work — self is admitted regardless of hold.
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { mini: { liveSince: null } },
      holdMs: HOLD,
      nowMs: 1_000,
      self: "mini",
    });
    expect(dispatchRoster).toContain("mini");
  });

  // CTL-1091 correctness review #1 (HIGH): self must be admitted to its OWN
  // dispatch roster even when it is ABSENT from survivingRoster — a fresh daemon
  // start (self has not heartbeated yet) or a stale/laggy self-heartbeat read
  // leaves self out of the positive-liveness set. The self guard is hoisted above
  // the shed branch so self never re-homes its own HRW slice to a peer.
  test("admits SELF even when it is absent from the surviving (live) roster", () => {
    const now = 5_000;
    const { dispatchRoster, nextState } = computeDispatchRoster({
      survivingRoster: ["laptop"], // self (mini) NOT observed live this tick
      roster: ["mini", "laptop"],
      prevState: {}, // cold: nothing known about self yet
      holdMs: HOLD,
      nowMs: now,
      self: "mini",
    });
    expect(dispatchRoster).toContain("mini"); // self not shed despite absence
    expect(nextState.mini.liveSince).toBe(now - HOLD); // recorded as past the hold
  });

  test("admits SELF absent-from-feed even when prevState marks it dead (null)", () => {
    // The empirically-confirmed regression: roster=[A,B], self=A absent from the
    // live feed with a prior dead marker, B live → A must still be in the roster.
    const now = 9_000;
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["B"], // A (self) absent
      roster: ["A", "B"],
      prevState: { A: { liveSince: null } }, // A looked dead last tick
      holdMs: HOLD,
      nowMs: now,
      self: "A",
    });
    expect(dispatchRoster.slice().sort()).toEqual(["A", "B"]);
  });

  test("cold start (no prior state) admits every live host — no transient shed", () => {
    // First run / absent .liveness-deflap.json: a live host with no prior
    // observation is treated as already past the hold, NOT newly-restored, so a
    // cold start does not transiently shed every host (migration note).
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: {},
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster.slice().sort()).toEqual(["laptop", "mini"]);
  });

  test("fail-safe: an all-newly-restored fleet degrades to the surviving roster (never strands)", () => {
    // Pathological: every live host looks newly-restored → the naive filter would
    // empty the dispatch roster. The backstop degrades to the surviving roster so
    // dispatch never strands the whole board.
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop"],
      roster: ["mini", "laptop"],
      prevState: { mini: { liveSince: null }, laptop: { liveSince: null } },
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster.slice().sort()).toEqual(["laptop", "mini"]);
  });

  test("single-host roster admits the lone host unchanged", () => {
    const { dispatchRoster } = computeDispatchRoster({
      survivingRoster: ["solo"],
      roster: ["solo"],
      prevState: {},
      holdMs: HOLD,
      nowMs: 1_000,
    });
    expect(dispatchRoster).toEqual(["solo"]);
  });

  // CTL-1091 verify (phase-verify F3): pin the 3-host self-ordering so a future
  // refactor can't regress the "self admitted immediately while a restored peer is
  // held and a continuously-live peer is admitted" combination in one roster pass.
  test("3-host: self admitted immediately, restored peer held, live peer admitted", () => {
    const now = 10_000_000;
    const { dispatchRoster, nextState } = computeDispatchRoster({
      survivingRoster: ["mini", "laptop", "desktop"], // all currently live
      roster: ["mini", "laptop", "desktop"],
      prevState: {
        // desktop was continuously live and already past the hold
        desktop: { liveSince: now - HOLD - 1 },
        // laptop just came back this tick (was dead) → must be held
        laptop: { liveSince: null },
        // mini (self) has no prior entry, but self is force-admitted regardless
      },
      holdMs: HOLD,
      nowMs: now,
      self: "mini",
    });
    expect(dispatchRoster.slice().sort()).toEqual(["desktop", "mini"]);
    expect(dispatchRoster).not.toContain("laptop"); // restored peer still held
    expect(nextState.laptop.liveSince).toBe(now); // hold started this tick
    expect(nextState.mini.liveSince).toBe(now - HOLD); // self past the hold
  });
});

// CTL-1091 verify (phase-verify F2): the persisted-state I/O helpers. These
// defensive branches (corrupt/absent/non-object file → {}, unwritable → no throw)
// are the fail-safes that keep a corrupt .liveness-deflap.json from wedging a tick;
// they were only exercised incidentally by the scheduler scenarios before.
describe("readDeflapState / writeDeflapState — persisted observation state (CTL-1091)", () => {
  test("absent file → {} (cold start, no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deflap-absent-"));
    expect(readDeflapState(dir)).toEqual({});
  });

  test("corrupt (non-JSON) file → {} (no throw, does not wedge the tick)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deflap-corrupt-"));
    writeFileSync(join(dir, DEFLAP_STATE_FILE), "{not valid json");
    expect(readDeflapState(dir)).toEqual({});
  });

  // The guard is `parsed && typeof parsed === "object"`, so a JSON `null` or a
  // bare primitive coerces to {}. (A top-level JSON array is technically typeof
  // "object" and passes through, but it is harmless — it has no host-named keys,
  // so every downstream prevState[host] lookup just cold-starts.)
  test("non-object JSON (null / primitive) → {}", () => {
    const dirNull = mkdtempSync(join(tmpdir(), "deflap-null-"));
    writeFileSync(join(dirNull, DEFLAP_STATE_FILE), "null");
    expect(readDeflapState(dirNull)).toEqual({});
    const dirNum = mkdtempSync(join(tmpdir(), "deflap-num-"));
    writeFileSync(join(dirNum, DEFLAP_STATE_FILE), "42");
    expect(readDeflapState(dirNum)).toEqual({});
  });

  test("falsy orchDir → {} with no read", () => {
    expect(readDeflapState(undefined)).toEqual({});
    expect(readDeflapState("")).toEqual({});
  });

  test("round-trips a valid observation map atomically (no .tmp leftover)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deflap-rt-"));
    const state = { mini: { liveSince: 123 }, laptop: { liveSince: null } };
    writeDeflapState(dir, state);
    expect(JSON.parse(readFileSync(join(dir, DEFLAP_STATE_FILE), "utf8"))).toEqual(state);
    expect(readDeflapState(dir)).toEqual(state);
    expect(existsSync(join(dir, `${DEFLAP_STATE_FILE}.tmp.${process.pid}`))).toBe(false);
  });

  test("writeDeflapState to an unwritable dir is swallowed (best-effort, no throw)", () => {
    // A non-existent nested dir makes the tmp write fail; must NOT throw.
    const bogus = join(tmpdir(), "deflap-nope-does-not-exist", "child");
    expect(() => writeDeflapState(bogus, { mini: { liveSince: 1 } })).not.toThrow();
    expect(() => writeDeflapState(undefined, {})).not.toThrow();
  });
});
