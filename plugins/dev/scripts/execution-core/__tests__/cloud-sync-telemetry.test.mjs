// cloud-sync-telemetry.test.mjs — CTL-1395. Tests the pure freshness-telemetry helpers.
// CTL-1508 adds: exitAfterClose (bounded exit paths), the frame-silence classifier arm,
// and the self-heal breadcrumb helpers.
import { describe, test, expect } from "bun:test";
import {
  classifyStall,
  clearSelfHealBreadcrumb,
  exitAfterClose,
  freshnessFields,
  readReplicaCounts,
  writeSelfHealBreadcrumb,
} from "../cloud-sync-telemetry.mjs";

const NOW = 1_800_000_000_000;

describe("freshnessFields", () => {
  test("staleness = whole seconds since maxUpdatedMs", () => {
    const f = freshnessFields({ rows: 2878, maxUpdatedMs: NOW - 90_000, status: "live", cursor: 311476, hostName: "mini", now: NOW });
    expect(f["catalyst.linear.replica.staleness"]).toBe(90);
    expect(f["catalyst.linear.replica.rows"]).toBe(2878);
    expect(f["catalyst.linear.replica.status"]).toBe("live");
    expect(f["catalyst.linear.replica.cursor"]).toBe(311476);
    expect(f["host.name"]).toBe("mini");
  });

  test("staleness is null (not a bogus number) when maxUpdatedMs is null / 0 / NaN", () => {
    for (const mx of [null, undefined, 0, NaN, "nope"]) {
      expect(freshnessFields({ maxUpdatedMs: mx, now: NOW })["catalyst.linear.replica.staleness"]).toBeNull();
    }
  });

  test("staleness never negative (clamped to 0) for a future timestamp", () => {
    expect(freshnessFields({ maxUpdatedMs: NOW + 5_000, now: NOW })["catalyst.linear.replica.staleness"]).toBe(0);
  });

  test("rows: null stays null; a value coerces to a number", () => {
    expect(freshnessFields({ rows: null, now: NOW })["catalyst.linear.replica.rows"]).toBeNull();
    expect(freshnessFields({ rows: "45805", now: NOW })["catalyst.linear.replica.rows"]).toBe(45805);
    expect(freshnessFields({ rows: 0, now: NOW })["catalyst.linear.replica.rows"]).toBe(0);
  });

  test("missing optional fields → nulls, never throws", () => {
    const f = freshnessFields();
    expect(f["catalyst.linear.replica.status"]).toBeNull();
    expect(f["catalyst.linear.replica.cursor"]).toBeNull();
    expect(f["host.name"]).toBeNull();
  });

  test("carries no secret-shaped keys/values (NAME-only telemetry)", () => {
    const f = freshnessFields({ rows: 1, maxUpdatedMs: NOW, status: "live", cursor: 1, hostName: "mini", now: NOW });
    expect(JSON.stringify(f)).not.toMatch(/token|secret|lin_|Bearer/i);
  });

  test("frame_staleness = whole seconds since lastFrameAt (CTL-1508)", () => {
    const f = freshnessFields({ lastFrameAt: NOW - 45_000, now: NOW });
    expect(f["catalyst.linear.replica.frame_staleness"]).toBe(45);
  });

  test("frame_staleness is null (never a bogus number) when lastFrameAt is absent — older SDK / pre-first-frame", () => {
    for (const lf of [null, undefined, 0, NaN, "nope"]) {
      expect(freshnessFields({ lastFrameAt: lf, now: NOW })["catalyst.linear.replica.frame_staleness"]).toBeNull();
    }
  });
});

describe("classifyStall", () => {
  const STALL = 600_000;

  test("QUIET-BUT-HEALTHY: cursor stalled past the window but SDK status live → NOT a stall (no alert, no restart) — the Codex P1/P2 false-kill guard", () => {
    const c = classifyStall({ rows: 2878, stalledMs: STALL + 5_000, stallMs: STALL, status: "live" });
    expect(c.cursorStalled).toBe(true); // cursor IS silent
    expect(c.sdkUnhealthy).toBe(false); // but the socket is healthy
    expect(c.genuine).toBe(false);
    expect(c.alert).toBe(false);
    expect(c.restart).toBe(false);
    expect(c.displayStatus).toBe("live"); // reports its real status, not "stalled"
  });

  test("GENUINE: cursor stalled past the window AND an unhealthy SDK status → alert + self-heal restart", () => {
    for (const status of ["reconnecting", "error", "stopped"]) {
      const c = classifyStall({ rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status });
      expect(c.cursorStalled).toBe(true);
      expect(c.sdkUnhealthy).toBe(true);
      expect(c.genuine).toBe(true);
      expect(c.alert).toBe(true);
      expect(c.restart).toBe(true);
      expect(c.displayStatus).toBe("stalled");
    }
  });

  test("unhealthy SDK status but cursor still advancing (within window) → NOT a stall (the SDK owns its own reconnect/backoff)", () => {
    const c = classifyStall({ rows: 2878, stalledMs: 5_000, stallMs: STALL, status: "reconnecting" });
    expect(c.cursorStalled).toBe(false);
    expect(c.genuine).toBe(false);
    expect(c.restart).toBe(false);
    expect(c.displayStatus).toBe("reconnecting");
  });

  test("pre-seed window (rows 0 / null) is never a stall — no cursor yet", () => {
    for (const rows of [0, null]) {
      const c = classifyStall({ rows, stalledMs: STALL + 60_000, stallMs: STALL, status: "error" });
      expect(c.cursorStalled).toBe(false);
      expect(c.genuine).toBe(false);
      expect(c.restart).toBe(false);
    }
  });

  test("healthy transient states (connecting/resyncing) are NOT liveness failures", () => {
    for (const status of ["connecting", "resyncing"]) {
      const c = classifyStall({ rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status });
      expect(c.sdkUnhealthy).toBe(false);
      expect(c.genuine).toBe(false);
      expect(c.restart).toBe(false);
    }
  });

  test("defaults are safe — no args never throws and is not a stall", () => {
    const c = classifyStall();
    expect(c.genuine).toBe(false);
    expect(c.restart).toBe(false);
    expect(c.displayStatus).toBe("live");
  });

  // --- CTL-1508: the frame-silence arm (SDK 0.6.0 lastFrameAt) ---

  test("OLDER-SDK PARITY: lastFrameAt null/undefined is bit-identical to the status-only classifier across the whole matrix", () => {
    const matrix = [
      { rows: 2878, stalledMs: STALL + 5_000, stallMs: STALL, status: "live" },
      { rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status: "reconnecting" },
      { rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status: "error" },
      { rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status: "stopped" },
      { rows: 2878, stalledMs: 5_000, stallMs: STALL, status: "reconnecting" },
      { rows: 0, stalledMs: STALL + 60_000, stallMs: STALL, status: "error" },
      { rows: null, stalledMs: STALL + 60_000, stallMs: STALL, status: "error" },
      { rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status: "connecting" },
      { rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status: "resyncing" },
    ];
    for (const args of matrix) {
      // lastFrameAt omitted vs explicit null vs undefined (an older SDK's absent getter)
      // must all produce the same result object — frame-silence never asserts.
      const base = classifyStall({ ...args, now: NOW });
      expect(base.frameSilent).toBe(false);
      expect(classifyStall({ ...args, lastFrameAt: null, now: NOW })).toEqual(base);
      expect(classifyStall({ ...args, lastFrameAt: undefined, now: NOW })).toEqual(base);
    }
  });

  test("HALF-OPEN CAUGHT: cursor stalled + status latched 'live' + NO inbound frames for the window → GENUINE (the 18.5h RCA shape)", () => {
    const c = classifyStall({ rows: 2878, stalledMs: STALL + 5_000, stallMs: STALL, status: "live", lastFrameAt: NOW - STALL - 5_000, now: NOW });
    expect(c.cursorStalled).toBe(true);
    expect(c.sdkUnhealthy).toBe(false); // status is lying ("live") — onclose never fired
    expect(c.frameSilent).toBe(true); // but zero inbound bytes (not even pongs) proves it
    expect(c.genuine).toBe(true);
    expect(c.alert).toBe(true);
    expect(c.restart).toBe(true);
    expect(c.displayStatus).toBe("stalled");
  });

  test("QUIET-BUT-PONGING: cursor stalled + status live + lastFrameAt fresh (watchdog pongs arriving) → NOT a stall", () => {
    // A healthy quiet feed receives pongs every ~90s, so lastFrameAt stays fresh even
    // when the cursor is frozen — the false-kill guard now has a POSITIVE proof of life.
    const c = classifyStall({ rows: 2878, stalledMs: STALL + 5_000, stallMs: STALL, status: "live", lastFrameAt: NOW - 60_000, now: NOW });
    expect(c.cursorStalled).toBe(true);
    expect(c.frameSilent).toBe(false);
    expect(c.genuine).toBe(false);
    expect(c.restart).toBe(false);
    expect(c.displayStatus).toBe("live");
  });

  test("frameStallMs defaults to stallMs (boundary: exactly-stallMs-old frames assert; one ms fresher does not)", () => {
    const at = (lastFrameAt, extra = {}) =>
      classifyStall({ rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status: "live", lastFrameAt, now: NOW, ...extra });
    expect(at(NOW - STALL).frameSilent).toBe(true);
    expect(at(NOW - STALL + 1).frameSilent).toBe(false);
    // An explicit frameStallMs overrides the stallMs default.
    expect(at(NOW - 100_000, { frameStallMs: 90_000 }).frameSilent).toBe(true);
    expect(at(NOW - 100_000, { frameStallMs: 120_000 }).frameSilent).toBe(false);
  });

  test("frame-silence WITHOUT cursor-stall never asserts genuine — pre-seed (rows 0/null) and advancing-cursor stay guarded", () => {
    for (const rows of [0, null]) {
      const c = classifyStall({ rows, stalledMs: STALL + 60_000, stallMs: STALL, status: "live", lastFrameAt: NOW - STALL - 60_000, now: NOW });
      expect(c.genuine).toBe(false);
      expect(c.restart).toBe(false);
    }
    const advancing = classifyStall({ rows: 2878, stalledMs: 5_000, stallMs: STALL, status: "live", lastFrameAt: NOW - STALL - 60_000, now: NOW });
    expect(advancing.genuine).toBe(false);
  });

  test("frame-silence AND unhealthy status together are still one genuine stall (both confirmations reported)", () => {
    const c = classifyStall({ rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status: "error", lastFrameAt: NOW - STALL - 1, now: NOW });
    expect(c.sdkUnhealthy).toBe(true);
    expect(c.frameSilent).toBe(true);
    expect(c.genuine).toBe(true);
    expect(c.displayStatus).toBe("stalled");
  });
});

describe("readReplicaCounts", () => {
  test("HIT: reads COUNT + MAX(updated_at) via the SqlExecutor", () => {
    const sql = { exec: () => ({ toArray: () => [{ n: 2878, mx: NOW - 1000 }] }) };
    expect(readReplicaCounts(sql)).toEqual({ rows: 2878, maxUpdatedMs: NOW - 1000 });
  });

  test("empty table → rows 0, maxUpdatedMs null", () => {
    const sql = { exec: () => ({ toArray: () => [{ n: 0, mx: null }] }) };
    expect(readReplicaCounts(sql)).toEqual({ rows: 0, maxUpdatedMs: null });
  });

  test("FAIL-OPEN: a throwing executor (locked/mid-apply DB) → both null, never throws", () => {
    const sql = { exec: () => { throw new Error("database is locked"); } };
    expect(readReplicaCounts(sql)).toEqual({ rows: null, maxUpdatedMs: null });
  });
});

describe("exitAfterClose (CTL-1508)", () => {
  // Fake timer registry: captures {fn, ms, unrefd} without ever arming a real timer, so
  // tests fire timers deterministically and NEVER wait wall-clock time.
  const makeTimers = () => {
    const scheduled = [];
    const setTimeoutFn = (fn, ms) => {
      const t = { fn, ms, unrefd: false, unref() { this.unrefd = true; return this; } };
      scheduled.push(t);
      return t;
    };
    return { scheduled, setTimeoutFn };
  };
  // Drain the microtask queue (the closePromise .then chain) via one real 0ms macrotask.
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("close resolves fast → exit(exitCode) exactly once; the later timers are no-ops (no double-fire)", async () => {
    const calls = [];
    const { scheduled, setTimeoutFn } = makeTimers();
    exitAfterClose({ closePromise: Promise.resolve(), exitCode: 0, timeoutMs: 3_000, exit: (c) => calls.push(c), setTimeoutFn });
    await flush();
    expect(calls).toEqual([0]); // the SIGTERM contract: exit 0 (launchd must NOT restart)
    for (const t of scheduled) t.fn(); // deadline + failsafe fire later → guarded no-ops
    expect(calls).toEqual([0]);
  });

  test("close never settles → the deadline timer fires exit at timeoutMs (the hung-close strand fixed)", () => {
    const calls = [];
    const { scheduled, setTimeoutFn } = makeTimers();
    exitAfterClose({ closePromise: new Promise(() => {}), exitCode: 1, timeoutMs: 3_000, exit: (c) => calls.push(c), setTimeoutFn });
    expect(scheduled.map((t) => t.ms)).toEqual([3_000, 4_000]); // deadline + failsafe(+1s)
    scheduled[0].fn();
    expect(calls).toEqual([1]); // the stall contract: exit 1 (launchd restarts)
    scheduled[1].fn(); // failsafe after the deadline already fired → no double-fire
    expect(calls).toEqual([1]);
  });

  test("failsafe path: unref'd (never holds the process open) and still exits if only IT fires", () => {
    const calls = [];
    const { scheduled, setTimeoutFn } = makeTimers();
    exitAfterClose({ closePromise: new Promise(() => {}), exitCode: 1, timeoutMs: 3_000, exit: (c) => calls.push(c), setTimeoutFn });
    const [deadline, failsafe] = scheduled;
    expect(failsafe.unrefd).toBe(true); // the belt-and-braces timer must not keep us alive
    expect(deadline.unrefd).toBe(false); // the primary deadline stays ref'd on purpose
    failsafe.fn(); // wedged-deadline scenario: the failsafe alone still exits
    expect(calls).toEqual([1]);
    deadline.fn();
    expect(calls).toEqual([1]);
  });

  test("a REJECTING close still exits exactly once with the requested code (no unhandled rejection)", async () => {
    const calls = [];
    const { scheduled, setTimeoutFn } = makeTimers();
    exitAfterClose({ closePromise: Promise.reject(new Error("socket already dead")), exitCode: 1, timeoutMs: 3_000, exit: (c) => calls.push(c), setTimeoutFn });
    await flush();
    expect(calls).toEqual([1]);
    for (const t of scheduled) t.fn();
    expect(calls).toEqual([1]);
  });
});

describe("self-heal breadcrumb (CTL-1508)", () => {
  const PATH = "/x/cloud-sync.selfheal.json";

  test("writes {ts, cursor, stalledMs, sdkStatus, expectRestart:true} atomically via tmp+rename", () => {
    const ops = [];
    const ok = writeSelfHealBreadcrumb(
      PATH,
      { cursor: 311476, stalledMs: 601_000, sdkStatus: "live" },
      {
        writeFile: (p, data) => ops.push(["write", p, data]),
        rename: (from, to) => ops.push(["rename", from, to]),
        now: () => NOW,
      },
    );
    expect(ok).toBe(true);
    // tmp FIRST, then rename onto the final path — CTL-1509's responder reads this file
    // from another process and must never observe a torn write.
    expect(ops.map((o) => o[0])).toEqual(["write", "rename"]);
    expect(ops[0][1]).toBe(`${PATH}.tmp`);
    expect(JSON.parse(ops[0][2])).toEqual({ ts: NOW, cursor: 311476, stalledMs: 601_000, sdkStatus: "live", expectRestart: true });
    expect(ops[1]).toEqual(["rename", `${PATH}.tmp`, PATH]);
  });

  test("FAIL-OPEN: a throwing fs never throws out — the breadcrumb must never block the self-heal exit", () => {
    expect(
      writeSelfHealBreadcrumb(PATH, { cursor: 1 }, { writeFile: () => { throw new Error("EROFS"); }, rename: () => {}, now: () => NOW }),
    ).toBe(false);
    expect(
      writeSelfHealBreadcrumb(PATH, { cursor: 1 }, { writeFile: () => {}, rename: () => { throw new Error("EXDEV"); }, now: () => NOW }),
    ).toBe(false);
  });

  test("clear-on-live unlinks the breadcrumb; a missing file (ENOENT) is the fail-open normal case", () => {
    const unlinked = [];
    expect(clearSelfHealBreadcrumb(PATH, { unlink: (p) => unlinked.push(p) })).toBe(true);
    expect(unlinked).toEqual([PATH]);
    const enoent = () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; };
    expect(clearSelfHealBreadcrumb(PATH, { unlink: enoent })).toBe(false); // no throw
  });
});
