import { describe, test, expect, beforeEach } from "bun:test";
import {
  stepLivenessHysteresis,
  effectiveLiveRoster,
  __resetLivenessState,
} from "./liveness-roster.mjs";

const ROSTER = ["mini", "laptop"];
const SELF = "mini";
const GRACE = 600_000;
const N = 3;
const NOW = 1_000_000_000_000;
const fresh = new Date(NOW - 1_000).toISOString();
const stale = new Date(NOW - GRACE - 1_000).toISOString();

function run(ticks, { lastSeenFor }) {
  let state = {};
  let last;
  for (let i = 0; i < ticks; i++) {
    last = stepLivenessHysteresis(state, {
      roster: ROSTER,
      self: SELF,
      lastSeen: lastSeenFor(i),
      graceMs: GRACE,
      nowMs: NOW,
      threshold: N,
    });
    state = last.state;
  }
  return last;
}

describe("stepLivenessHysteresis — shed (CTL-1091)", () => {
  test("a host down for FEWER than N consecutive ticks is NOT shed", () => {
    const r = run(N - 1, { lastSeenFor: () => ({ mini: fresh, laptop: stale }) });
    expect(r.liveHosts).toEqual(["mini", "laptop"]);
  });

  test("a host down for N consecutive ticks IS shed", () => {
    const r = run(N, { lastSeenFor: () => ({ mini: fresh, laptop: stale }) });
    expect(r.liveHosts).toEqual(["mini"]);
    expect(r.transitions).toContainEqual({ host: "laptop", to: "shed" });
  });

  test("an interleaved up tick resets the down streak (no shed until N CONSECUTIVE)", () => {
    const seq = [stale, stale, fresh, stale, stale];
    const r = run(seq.length, { lastSeenFor: (i) => ({ mini: fresh, laptop: seq[i] }) });
    expect(r.liveHosts).toEqual(["mini", "laptop"]);
  });

  test("a never-seen host (absent from lastSeen) is treated as DOWN and shed after N", () => {
    const r = run(N, { lastSeenFor: () => ({ mini: fresh }) });
    expect(r.liveHosts).toEqual(["mini"]);
  });

  test("self is NEVER shed even when self is stale / never-seen", () => {
    const r = run(N, { lastSeenFor: () => ({}) });
    expect(r.liveHosts).toContain("mini");
  });

  test("empty live roster falls back to the FULL static roster", () => {
    let state = {};
    const r = stepLivenessHysteresis(state, {
      roster: ["lonely"],
      self: "other",
      lastSeen: {},
      graceMs: GRACE,
      nowMs: NOW,
      threshold: 1,
    });
    expect(r.liveHosts).toEqual(["lonely"]);
  });
});

describe("stepLivenessHysteresis — restore (CTL-1091)", () => {
  test("a shed host is restored only after N consecutive UP ticks", () => {
    let state = {};
    let last;
    const seq = [stale, stale, stale, fresh, fresh]; // shed at 3, then 2 ups (< N)
    for (let i = 0; i < seq.length; i++) {
      last = stepLivenessHysteresis(state, {
        roster: ROSTER,
        self: SELF,
        lastSeen: { mini: fresh, laptop: seq[i] },
        graceMs: GRACE,
        nowMs: NOW,
        threshold: N,
      });
      state = last.state;
    }
    expect(last.liveHosts).toEqual(["mini"]); // 2 ups < N ⇒ still shed
  });

  test("a single up after shed does NOT restore; a down resets the up streak", () => {
    let state = {};
    let last;
    const seq = [stale, stale, stale, fresh, stale, fresh, fresh, fresh];
    for (let i = 0; i < seq.length; i++) {
      last = stepLivenessHysteresis(state, {
        roster: ROSTER,
        self: SELF,
        lastSeen: { mini: fresh, laptop: seq[i] },
        graceMs: GRACE,
        nowMs: NOW,
        threshold: N,
      });
      state = last.state;
    }
    // last 3 ticks are consecutive ups ⇒ restored
    expect(last.liveHosts).toEqual(["mini", "laptop"]);
    expect(last.transitions).toContainEqual({ host: "laptop", to: "restored" });
  });
});

describe("effectiveLiveRoster — wrapper (CTL-1091)", () => {
  beforeEach(() => __resetLivenessState());

  test("single-host roster is an EXACT no-op: heartbeats are NEVER read", () => {
    let reads = 0;
    const out = effectiveLiveRoster({
      roster: ["mini"],
      self: "mini",
      readHeartbeats: () => {
        reads++;
        return {};
      },
    });
    expect(out).toEqual(["mini"]);
    expect(reads).toBe(0);
  });

  test("multi-host reads heartbeats and caches within the TTL", () => {
    let reads = 0;
    const opts = {
      roster: ["mini", "laptop"],
      self: "mini",
      cacheMs: 30_000,
      nowMs: 1000,
      readHeartbeats: () => {
        reads++;
        return { mini: new Date(1000).toISOString() };
      },
    };
    effectiveLiveRoster(opts);
    effectiveLiveRoster({ ...opts, nowMs: 5000 }); // within TTL
    expect(reads).toBe(1); // cached
    effectiveLiveRoster({ ...opts, nowMs: 40_000 }); // past TTL
    expect(reads).toBe(2); // re-read
  });

  test("readHeartbeats throwing is fail-open (no throw, empty lastSeen)", () => {
    expect(() =>
      effectiveLiveRoster({
        roster: ["mini", "laptop"],
        self: "mini",
        readHeartbeats: () => {
          throw new Error("linear down");
        },
      })
    ).not.toThrow();
  });

  test("effectiveLiveRoster logs exactly one line per shed/restore transition", () => {
    const lines = [];
    const log = {
      info: (obj, msg) => lines.push(msg),
      debug() {},
    };
    const base = {
      roster: ["mini", "laptop"],
      self: "mini",
      graceMs: 600_000,
      threshold: 2,
      log,
      readHeartbeats: () => ({ mini: new Date(NOW).toISOString() }), // laptop never-seen
    };
    effectiveLiveRoster({ ...base, nowMs: NOW, cacheMs: 0 }); // down #1
    effectiveLiveRoster({ ...base, nowMs: NOW + 1, cacheMs: 0 }); // down #2 ⇒ shed (1 log)
    effectiveLiveRoster({ ...base, nowMs: NOW + 2, cacheMs: 0 }); // still shed (no new log)
    expect(lines.filter((m) => m.includes("shed")).length).toBe(1);
  });
});
