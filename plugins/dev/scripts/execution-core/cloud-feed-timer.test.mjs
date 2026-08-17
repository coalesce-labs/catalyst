// cloud-feed-timer.test.mjs — CTL-1847.
//
// The tick's job is to run the producer and route what it makes by mode. The
// failure that matters most is the quiet one: a mode that looks armed and
// writes nowhere.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REPLICA_STALE_MS,
  EVENT_WOULD_DISPATCH,
  defaultReplicaFresh,
  buildWouldDispatchEvent,
  createModeSink,
  startCloudFeedTimer,
} from "./cloud-feed-timer.mjs";

const plan = { account: "tenant-0", shadowPath: "/tmp/unused-shadow.jsonl", mode: "diff" };

/** A fake shadow sink so no file is touched. */
const fakeShadow = () => {
  const written = [];
  return {
    factory: () => ({
      emit: (e) => written.push(e),
      path: plan.shadowPath,
      stats: () => ({ written: written.length, failed: 0, classes: {} }),
    }),
    written,
  };
};

const feedEvent = (name) => ({
  ts: "2026-08-16T20:00:00Z",
  attributes: { "event.name": name, "linear.issue.identifier": "CTL-1", "linear.team.key": "CTL" },
  body: { message: name, payload: { source: "cloud-feed", ticket: "CTL-1" } },
});

describe("createModeSink — enforce", () => {
  test("appends the event ITSELF to the event log, and to the shadow file", () => {
    const shadow = fakeShadow();
    const appended = [];
    const sink = createModeSink(plan, {
      mode: "enforce",
      eventLogPath: "/tmp/fake-events.jsonl",
      appendFn: (_p, line) => appended.push(JSON.parse(line)),
      makeShadow: shadow.factory,
    });
    const e = feedEvent("linear.issue.state_changed");
    sink.emit(e);

    // The event log gets the real event — that is what monitor.mjs dispatches.
    expect(appended).toHaveLength(1);
    // The event-log copy carries the emission-time authority stamp (round 6).
    expect(appended[0].body.payload.feedAuthority).toBe(false); // authorityNow defaults to false
    expect({ ...appended[0], body: { ...appended[0].body, payload: { ...appended[0].body.payload, feedAuthority: undefined } } })
      .toMatchObject({ attributes: e.attributes });
    // The shadow file still gets it too: the harness's feed-side input must not
    // change shape at the moment of cutover.
    expect(shadow.written).toEqual([e]);
    expect(sink.stats().logged).toBe(1);
  });

  test("writes to the event log for every dispatch class", () => {
    const appended = [];
    const sink = createModeSink(plan, {
      mode: "enforce",
      appendFn: (_p, line) => appended.push(JSON.parse(line)),
      makeShadow: fakeShadow().factory,
    });
    for (const n of ["linear.issue.state_changed", "linear.issue.updated", "linear.comment.created"]) {
      sink.emit(feedEvent(n));
    }
    expect(appended).toHaveLength(3);
    expect(sink.stats().logged).toBe(3);
  });
});

describe("createModeSink — shadow", () => {
  test("appends a would-dispatch OBSERVATION, never the event itself", () => {
    // Re-emitting the real name with a "shadow" flag would fire every wait-for
    // subscriber and the monitor's handlers on an event we are declining to act on.
    const appended = [];
    const sink = createModeSink(plan, {
      mode: "shadow",
      appendFn: (_p, line) => appended.push(JSON.parse(line)),
      makeShadow: fakeShadow().factory,
    });
    sink.emit(feedEvent("linear.issue.state_changed"));

    expect(appended).toHaveLength(1);
    expect(appended[0].attributes["event.name"]).toBe(EVENT_WOULD_DISPATCH);
    expect(appended[0].attributes["event.name"]).not.toBe("linear.issue.state_changed");
    expect(appended[0].body.payload.wouldDispatch).toBe("linear.issue.state_changed");
    expect(sink.stats().observed).toBe(1);
    expect(sink.stats().logged).toBe(0);
  });

  test("still writes the real event to the shadow file", () => {
    const shadow = fakeShadow();
    const sink = createModeSink(plan, {
      mode: "shadow",
      appendFn: () => {},
      makeShadow: shadow.factory,
    });
    const e = feedEvent("linear.comment.created");
    sink.emit(e);
    expect(shadow.written).toEqual([e]);
  });
});

describe("createModeSink — invariants across modes", () => {
  test("non-dispatch-class events reach the shadow file but never the event log", () => {
    for (const mode of ["shadow", "enforce"]) {
      const shadow = fakeShadow();
      const appended = [];
      const sink = createModeSink(plan, {
        mode,
        appendFn: (_p, l) => appended.push(l),
        makeShadow: shadow.factory,
      });
      sink.emit(feedEvent("linear.issue.priority_changed"));
      expect(shadow.written).toHaveLength(1);
      expect(appended).toHaveLength(0);
    }
  });

  test("the shadow write happens FIRST and is allowed to throw", () => {
    // The sweep's last-contiguous-success cursor rule depends on that throw:
    // swallowing it would advance the cursor past an event never recorded.
    const sink = createModeSink(plan, {
      mode: "enforce",
      appendFn: () => {},
      makeShadow: () => ({
        emit: () => {
          throw new Error("disk full");
        },
        path: "x",
        stats: () => ({}),
      }),
    });
    expect(() => sink.emit(feedEvent("linear.issue.state_changed"))).toThrow("disk full");
  });

  test("⛔ in ENFORCE an event-log append failure THROWS (Codex P1)", () => {
    // In enforce the append IS the dispatch. Swallowing it would let the sweep
    // settle the emission, advance the cursor past this edge, and never retry —
    // while the gate suppresses smee's copy. The throw is what engages the
    // sweep's last-contiguous-success rule so the next tick re-emits.
    const sink = createModeSink(plan, {
      mode: "enforce",
      appendFn: () => {
        throw new Error("EROFS");
      },
      makeShadow: fakeShadow().factory,
    });
    expect(() => sink.emit(feedEvent("linear.issue.state_changed"))).toThrow("EROFS");
    expect(sink.stats().logged).toBe(0);
  });

  test("NEGATIVE CONTROL: in SHADOW the same failure does NOT throw", () => {
    // The would-dispatch line is telemetry; nothing dispatches from it and smee
    // is still authoritative, so losing one must not stall the cursor.
    const sink = createModeSink(plan, {
      mode: "shadow",
      appendFn: () => {
        throw new Error("EROFS");
      },
      makeShadow: fakeShadow().factory,
    });
    expect(() => sink.emit(feedEvent("linear.issue.state_changed"))).not.toThrow();
    expect(sink.stats().appendFailed).toBe(1);
    expect(sink.stats().observed).toBe(0);
  });
});

describe("buildWouldDispatchEvent", () => {
  test("carries the observed name, ticket and account", () => {
    const ev = buildWouldDispatchEvent(feedEvent("linear.issue.updated"), { account: "tenant-0" });
    expect(ev.attributes["event.name"]).toBe(EVENT_WOULD_DISPATCH);
    expect(ev.attributes["cloud_feed.would_dispatch.name"]).toBe("linear.issue.updated");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-1");
    expect(ev.body.payload.account).toBe("tenant-0");
    expect(ev.body.payload.teamKey).toBe("CTL");
  });
});

describe("startCloudFeedTimer", () => {
  test("off ⇒ returns null and schedules NOTHING", () => {
    let scheduled = 0;
    const handle = startCloudFeedTimer({
      mode: "off",
      setIntervalFn: () => {
        scheduled += 1;
        return 1;
      },
    });
    expect(handle).toBe(null);
    expect(scheduled).toBe(0);
  });

  test.each([undefined, null, "", "ENFORCE", "on", 1])("an unrecognized mode (%p) also starts nothing", (mode) => {
    let scheduled = 0;
    expect(startCloudFeedTimer({ mode, setIntervalFn: () => (scheduled += 1) })).toBe(null);
    expect(scheduled).toBe(0);
  });

  test("shadow/enforce schedule a tick and return a stop handle", () => {
    for (const mode of ["shadow", "enforce"]) {
      let cleared = null;
      const handle = startCloudFeedTimer({
        mode,
        plans: [],
        runOnceFn: () => [],
        setIntervalFn: () => "H",
        clearIntervalFn: (h) => (cleared = h),
      });
      expect(handle).not.toBe(null);
      handle.stop();
      expect(cleared).toBe("H");
    }
  });

  test("⛔ passes botUserIds into runOnce — the standalone runner never did", () => {
    // classifyEdge's self-echo decline could not fire in any shadow window to
    // date because linear-feed-shadow-run.mjs omitted this argument entirely.
    let seen;
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "shadow",
      plans: [],
      botUserIds: new Set(["bot-1"]),
      runOnceFn: (args) => {
        seen = args;
        return [];
      },
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(seen.botUserIds).toBeDefined();
    expect([...seen.botUserIds]).toEqual(["bot-1"]);
  });

  test("plans are resolved with mode 'diff' — the shipping edge source", () => {
    let planArgs;
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      orchDir: "/orch",
      planTenantsFn: (a) => {
        planArgs = a;
        return [];
      },
      runOnceFn: () => [],
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(planArgs).toEqual({ orchDir: "/orch", mode: "diff" });
  });

  test("a THROWING tick never propagates — the daemon must not die with it", () => {
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      plans: [],
      runOnceFn: () => {
        throw new Error("replica gone");
      },
      setIntervalFn: () => "H",
    });
    expect(() => handle.tick()).not.toThrow();
    expect(handle.tick()).toBe(null);
  });

  test("the interval floors at 5s so a bad config cannot busy-spin", () => {
    let ms;
    startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "shadow",
      intervalSec: 0,
      plans: [],
      runOnceFn: () => [],
      setIntervalFn: (_fn, m) => {
        ms = m;
        return "H";
      },
    });
    expect(ms).toBe(5000);
  });

  test("⛔ isReady() is FALSE until a real non-seeding sweep completes (Codex P1)", () => {
    const seeding = [{ account: "tenant-0", skipped: null, sweep: { mode: "seeded", seeded: 4000 } }];
    const real = [{ account: "tenant-0", skipped: null, sweep: { mode: "resume", stoppedEarly: false, edges: { failed: 0 }, comments: { failed: 0 } } }];
    let reports = seeding;
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      plans: [],
      runOnceFn: () => reports,
      setIntervalFn: () => "H",
    });
    expect(handle.isReady()).toBe(false); // before any tick
    handle.tick();
    expect(handle.isReady()).toBe(false); // the SEEDING tick must not arm it
    reports = real;
    handle.tick();
    expect(handle.isReady()).toBe(true); // a real sweep does
  });

  test("⛔ a sweep that FAILED to emit does NOT arm readiness (Codex P1 round 2)", () => {
    // runDiffSweep catches an emit failure and returns stoppedEarly + failed
    // counts WITHOUT setting r.error, so mode is still "resume". Arming on that
    // would suppress every webhook copy while nothing replaced it — a total
    // dispatch outage with the gate reporting itself healthy.
    const cases = [
      { label: "stoppedEarly", sweep: { mode: "resume", stoppedEarly: true, edges: { failed: 0 }, comments: { failed: 0 } } },
      { label: "edge failures", sweep: { mode: "resume", edges: { failed: 3 }, comments: { failed: 0 } } },
      { label: "comment failures", sweep: { mode: "resume", edges: { failed: 0 }, comments: { failed: 1 } } },
    ];
    for (const c of cases) {
      const handle = startCloudFeedTimer({
        replicaFreshFn: () => true,
        mode: "enforce",
        plans: [],
        runOnceFn: () => [{ account: "tenant-0", skipped: null, sweep: c.sweep }],
        setIntervalFn: () => "H",
      });
      handle.tick();
      expect(handle.isReady()).toBe(false);
    }
  });

  test("NEGATIVE CONTROL: a clean zero-failure sweep DOES arm it", () => {
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      plans: [],
      runOnceFn: () => [
        { account: "tenant-0", skipped: null, sweep: { mode: "resume", stoppedEarly: false, edges: { failed: 0 }, comments: { failed: 0 } } },
      ],
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(handle.isReady()).toBe(true);
  });

  test("a skipped or errored tenant does NOT arm readiness", () => {
    for (const reports of [
      [{ account: "tenant-0", skipped: "replica-absent" }],
      [{ account: "tenant-0", skipped: null, error: "boom" }],
      [],
    ]) {
      const handle = startCloudFeedTimer({
        replicaFreshFn: () => true,
        mode: "enforce",
        plans: [],
        runOnceFn: () => reports,
        setIntervalFn: () => "H",
      });
      handle.tick();
      expect(handle.isReady()).toBe(false);
    }
  });

  // ⛔ TABLE-DRIVEN: every way runDiffSweep can fail to emit must leave enforce
  // UNARMED (COORD ask, after Codex found three variants across three rounds).
  // The bug was never one predicate — it was that each fix enumerated only the
  // failure shapes known at the time. This table is the place a fourth variant
  // gets added, so it cannot re-appear as a silent arming.
  const OK = { mode: "resume", stoppedEarly: false, edges: { failed: 0, byReason: {} }, comments: { failed: 0, byReason: {} } };
  const FAILURE_SHAPES = [
    ["still seeding", { ...OK, mode: "seeded" }],
    ["stopped early", { ...OK, stoppedEarly: true }],
    ["edge emit failures", { ...OK, edges: { failed: 2, byReason: {} } }],
    ["comment emit failures", { ...OK, comments: { failed: 1, byReason: {} } }],
    ["edge cursor unwritable", { ...OK, edges: { failed: 0, byReason: { "cursor-write-failed:EACCES": 1 } } }],
    ["comment cursor unwritable", { ...OK, comments: { failed: 0, byReason: { "cursor-write-failed:ENOSPC": 1 } } }],
    ["cursor failure with an unknown errno", { ...OK, edges: { failed: 0, byReason: { "cursor-write-failed:unknown": 1 } } }],
    // Round 4: a SECOND cursor reason my prefix match missed.
    ["edge cursor init failed", { ...OK, edges: { failed: 0, byReason: { "cursor-init-failed:EACCES": 1 } } }],
    ["comment cursor init failed", { ...OK, comments: { failed: 0, byReason: { "cursor-init-failed:EROFS": 1 } } }],
    // ⭐ The point of deriving readiness positively: a reason nobody has thought
    // of yet must disqualify WITHOUT a code change here. If this row ever needs
    // a new prefix added to make it pass, the enumeration bug is back.
    ["a completely unknown future reason", { ...OK, edges: { failed: 0, byReason: { "some-reason-invented-in-2027": 1 } } }],
    ["an unknown reason on the comment side", { ...OK, comments: { failed: 0, byReason: { "totally-new-thing": 4 } } }],
  ];

  test.each(FAILURE_SHAPES)("readiness stays UNARMED: %s", (_label, sweep) => {
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      plans: [],
      runOnceFn: () => [{ account: "tenant-0", skipped: null, sweep }],
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(handle.isReady()).toBe(false);
  });

  test("NEGATIVE CONTROL for the whole table: the clean shape DOES arm", () => {
    // Without this, every row above would pass against a predicate that never arms.
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      plans: [],
      runOnceFn: () => [{ account: "tenant-0", skipped: null, sweep: OK }],
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(handle.isReady()).toBe(true);
  });

  test("cursor failures are matched by PREFIX — the reason carries an errno suffix", () => {
    // An equality check on "cursor-write-failed" would match nothing at all.
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      plans: [],
      runOnceFn: () => [
        { account: "tenant-0", skipped: null, sweep: { ...OK, comments: { failed: 0, byReason: { "cursor-write-failed:EROFS": 3 } } } },
      ],
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(handle.isReady()).toBe(false);
  });

  test("⛔ a RE-SEED after arming un-arms it (found by reasoning, not review)", () => {
    // `seeded` means "baseline built", not "has emitted". If the last-seen store
    // is lost after arming, the next tick re-seeds, emits nothing, and absorbs
    // every intervening change — while a latched readiness keeps suppressing
    // smee. Those events would reach nobody.
    const clean = { mode: "resume", stoppedEarly: false, edges: { failed: 0, byReason: {} }, comments: { failed: 0, byReason: {} } };
    let reports = [{ account: "tenant-0", skipped: null, sweep: clean }];
    const handle = startCloudFeedTimer({ replicaFreshFn: () => true, mode: "enforce", plans: [], runOnceFn: () => reports, setIntervalFn: () => "H" });
    handle.tick();
    expect(handle.isReady()).toBe(true);

    reports = [{ account: "tenant-0", skipped: null, sweep: { ...clean, mode: "seeded" } }];
    handle.tick();
    expect(handle.isReady()).toBe(false); // un-armed: smee is authoritative again

    reports = [{ account: "tenant-0", skipped: null, sweep: clean }];
    handle.tick();
    expect(handle.isReady()).toBe(true); // and it re-arms on the next clean sweep
  });

  test("⛔ ANY unhealthy report un-arms — readiness is not latched (Codex P1 round 5)", () => {
    // This test previously asserted the OPPOSITE (a latch surviving transient
    // failure). That was the defect: with the replica gone or the store failing
    // to open, runOnce reports an error, emits nothing, and a latched readiness
    // kept enforce suppressing every webhook copy indefinitely. Second time one
    // of my own tests has pinned behaviour that turned out to be the bug.
    const OKS = { mode: "resume", stoppedEarly: false, edges: { failed: 0, byReason: {} }, comments: { failed: 0, byReason: {} } };
    const unhealthy = [
      ["tenant error", [{ account: "t0", skipped: null, error: "replica gone" }]],
      ["tenant skipped", [{ account: "t0", skipped: "replica-absent" }]],
      ["re-seed", [{ account: "t0", skipped: null, sweep: { ...OKS, mode: "seeded" } }]],
      ["emit failures", [{ account: "t0", skipped: null, sweep: { ...OKS, edges: { failed: 1, byReason: {} } } }]],
      ["no tenants at all", []],
    ];
    for (const [label, bad] of unhealthy) {
      let reports = [{ account: "t0", skipped: null, sweep: OKS }];
      const handle = startCloudFeedTimer({ replicaFreshFn: () => true, mode: "enforce", plans: [], runOnceFn: () => reports, setIntervalFn: () => "H" });
      handle.tick();
      expect(handle.isReady()).toBe(true);
      reports = bad;
      handle.tick();
      expect(handle.isReady(), `should un-arm on: ${label}`).toBe(false);
      // ...and re-arm once healthy again.
      reports = [{ account: "t0", skipped: null, sweep: OKS }];
      handle.tick();
      expect(handle.isReady()).toBe(true);
    }
  });

  test("EVERY tenant must be clean — a healthy one cannot mask a failing one", () => {
    const OKS = { mode: "resume", stoppedEarly: false, edges: { failed: 0, byReason: {} }, comments: { failed: 0, byReason: {} } };
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "enforce",
      plans: [],
      runOnceFn: () => [
        { account: "t0", skipped: null, sweep: OKS },
        { account: "t1", skipped: null, error: "boom" },
      ],
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(handle.isReady()).toBe(false);
  });

  test("onReport receives the per-tenant reports", () => {
    const reports = [{ account: "tenant-0", skipped: null }];
    let got;
    const handle = startCloudFeedTimer({
      replicaFreshFn: () => true,
      mode: "shadow",
      plans: [],
      runOnceFn: () => reports,
      onReport: (r) => (got = r),
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(got).toEqual(reports);
  });
});

// ── CTL-1847 (Codex P1 round 6): a frozen replica must not stay armed ────────
describe("⛔ replica freshness is required for readiness", () => {
  const OKS = { mode: "resume", stoppedEarly: false, edges: { failed: 0, byReason: {} }, comments: { failed: 0, byReason: {} } };
  const report = [{ account: "tenant-0", skipped: null, sweep: OKS }];

  test("a STALE replica un-arms even though the sweep looks perfect", () => {
    // When cloud-sync stalls while its SQLite file stays readable, every query
    // returns an empty page — zero rows, zero failures, zero byReason. A sweep
    // over a frozen replica is indistinguishable from a quiet fleet.
    const handle = startCloudFeedTimer({
      mode: "enforce",
      plans: [{ account: "tenant-0", dbPath: "/tmp/x.db" }],
      runOnceFn: () => report,
      replicaFreshFn: () => false,
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(handle.isReady()).toBe(false);
  });

  test("NEGATIVE CONTROL: the same sweep with a FRESH replica arms", () => {
    const handle = startCloudFeedTimer({
      mode: "enforce",
      plans: [{ account: "tenant-0", dbPath: "/tmp/x.db" }],
      runOnceFn: () => report,
      replicaFreshFn: () => true,
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect(handle.isReady()).toBe(true);
  });

  test("defaultReplicaFresh fails CLOSED on absent/unreadable/malformed/stale", () => {
    const NOW = 1_000_000_000;
    const now = () => NOW;
    const cases = [
      ["absent", () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }],
      ["malformed json", () => "not json"],
      ["no heartbeat field", () => JSON.stringify({ pid: 1 })],
      ["heartbeat not a number", () => JSON.stringify({ heartbeat: "soon" })],
      ["stale heartbeat", () => JSON.stringify({ heartbeat: NOW - 10 * 60 * 1000 })],
    ];
    for (const [label, readFileFn] of cases) {
      expect(defaultReplicaFresh("/tmp/x.db", { now, readFileFn }), label).toBe(false);
    }
    // ...and a positive control, so the above cannot pass against a probe that
    // always returns false.
    expect(defaultReplicaFresh("/tmp/x.db", { now, readFileFn: () => JSON.stringify({ heartbeat: NOW - 1000 }) })).toBe(true);
  });

  test("an empty/invalid dbPath is not fresh", () => {
    expect(defaultReplicaFresh("")).toBe(false);
    expect(defaultReplicaFresh(undefined)).toBe(false);
  });
});

// ── CTL-1847 (Codex P1 round 6): the tenant plan is re-read every tick ───────
describe("⛔ tenant scope is not cached at startup", () => {
  test("planTenants is called on EVERY tick, so a new team is picked up", () => {
    // The plan used to be resolved once and cached forever. monitor.mjs reads
    // the LIVE registry for routing, so a team added to registry.json afterwards
    // was suppressed by the gate while the feed never produced anything for it —
    // a whole team silently undispatched until the daemon happened to restart.
    let calls = 0;
    const handle = startCloudFeedTimer({
      mode: "enforce",
      orchDir: "/orch",
      planTenantsFn: () => {
        calls += 1;
        return [];
      },
      runOnceFn: () => [],
      replicaFreshFn: () => true,
      setIntervalFn: () => "H",
    });
    handle.tick();
    handle.tick();
    handle.tick();
    expect(calls).toBe(3);
  });

  test("a team appearing mid-run reaches the sweep", () => {
    let teams = ["CTL"];
    let seenPlans = null;
    const handle = startCloudFeedTimer({
      mode: "enforce",
      orchDir: "/orch",
      planTenantsFn: () => teams.map((t) => ({ account: "tenant-0", dbPath: "/tmp/x.db", teams: new Set([t]) })),
      runOnceFn: ({ plans }) => {
        seenPlans = plans;
        return [];
      },
      replicaFreshFn: () => true,
      setIntervalFn: () => "H",
    });
    handle.tick();
    expect([...seenPlans[0].teams]).toEqual(["CTL"]);
    teams = ["CTC"]; // registry.json gains a project
    handle.tick();
    expect([...seenPlans[0].teams]).toEqual(["CTC"]);
  });

  test("NEGATIVE CONTROL: an explicitly injected plan list is still respected", () => {
    // Callers (and tests) that pass `plans` must not have it silently re-planned.
    let calls = 0;
    const handle = startCloudFeedTimer({
      mode: "enforce",
      plans: [{ account: "tenant-0", dbPath: "/tmp/x.db" }],
      planTenantsFn: () => { calls += 1; return []; },
      runOnceFn: () => [],
      replicaFreshFn: () => true,
      setIntervalFn: () => "H",
    });
    handle.tick();
    handle.tick();
    expect(calls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTL-1901 — the stamp must carry the readiness the tick STARTED with.
//
// This is a WIRING test, not a value test. cloud-feed-gate's exactly-once
// argument rests on an edge's webhook twin and its feed copy being decided under
// the SAME readiness value: the twin under rₖ (readiness while the edge
// happened), the feed copy under whatever this tick stamps with. That holds only
// while `runOnce` is called BEFORE `ready` is recomputed. Recompute first and
// every feed copy is stamped rₖ₊₁ instead — exactly-once breaks at every
// transition and NOTHING reddens, because each individual value is still
// "correct". Pinning the value without pinning the order is the shape that has
// already shipped unverified on this feature three times.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ CTL-1901 — authority is sampled BEFORE readiness is recomputed", () => {
  const OKS = { mode: "resume", stoppedEarly: false, edges: { failed: 0, byReason: {} }, comments: { failed: 0, byReason: {} } };
  const DIRTY = { ...OKS, edges: { failed: 1, byReason: {} } };

  const run = (sweeps) => {
    const sampled = [];
    let reports;
    let handle;
    const runOnceFn = () => {
      // What the sink's `authorityNow()` would return for everything this sweep
      // emits — read at the same point in the tick the real sink reads it.
      sampled.push(handle.isReady());
      return reports;
    };
    handle = startCloudFeedTimer({
      mode: "enforce",
      plans: [],
      runOnceFn,
      replicaFreshFn: () => true,
      setIntervalFn: () => "H",
    });
    const after = [];
    for (const s of sweeps) {
      reports = [{ account: "t0", skipped: null, sweep: s }];
      handle.tick();
      after.push(handle.isReady());
    }
    return { sampled, after };
  };

  test("the UN-ARMING tick stamps TRUE — the value its edges' webhook twins were decided under", () => {
    // The exact CTL-1901 sequence: armed, then a sweep goes dirty. Its edges
    // must still be stamped authoritative, because their twins were captured
    // under the readiness that was in force when they happened.
    const { sampled, after } = run([OKS, DIRTY]);
    expect(after).toEqual([true, false]); // it really did un-arm on tick 2
    expect(sampled[1]).toBe(true); // ...and tick 2 still stamped TRUE
  });

  test("the RE-ARMING tick stamps FALSE — the mirror of the same rule", () => {
    // Its edges happened while unarmed, so their twins already dispatched via
    // smee. Stamping them true would deliver each of them a second time.
    const { sampled, after } = run([DIRTY, OKS]);
    expect(after).toEqual([false, true]);
    expect(sampled[1]).toBe(false);
  });

  test("NEGATIVE CONTROL: in a steady state the sampled value tracks readiness", () => {
    // Without this, the two above would pass against a stamp hardwired to the
    // previous tick's value in a way that never converged.
    const { sampled, after } = run([OKS, OKS, OKS]);
    expect(after).toEqual([true, true, true]);
    expect(sampled).toEqual([false, true, true]); // false only on the very first tick
  });
});
