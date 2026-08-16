// cloud-feed-timer.test.mjs — CTL-1847.
//
// The tick's job is to run the producer and route what it makes by mode. The
// failure that matters most is the quiet one: a mode that looks armed and
// writes nowhere.

import { describe, expect, test } from "bun:test";
import {
  EVENT_WOULD_DISPATCH,
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
    expect(appended[0]).toEqual(e);
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
        mode: "enforce",
        plans: [],
        runOnceFn: () => reports,
        setIntervalFn: () => "H",
      });
      handle.tick();
      expect(handle.isReady()).toBe(false);
    }
  });

  test("readiness never goes back to false once armed", () => {
    // Un-arming would flap dispatch between two sources; a transient failing
    // tick is already handled by the sweep's own cursor rules.
    let reports = [{ account: "tenant-0", skipped: null, sweep: { mode: "resume", stoppedEarly: false, edges: { failed: 0 }, comments: { failed: 0 } } }];
    const handle = startCloudFeedTimer({ mode: "enforce", plans: [], runOnceFn: () => reports, setIntervalFn: () => "H" });
    handle.tick();
    expect(handle.isReady()).toBe(true);
    reports = [{ account: "tenant-0", skipped: null, error: "transient" }];
    handle.tick();
    expect(handle.isReady()).toBe(true);
  });

  test("onReport receives the per-tenant reports", () => {
    const reports = [{ account: "tenant-0", skipped: null }];
    let got;
    const handle = startCloudFeedTimer({
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
