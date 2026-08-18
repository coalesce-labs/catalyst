// agent-session-narrator.test.mjs — CTL-1943.
//
// The load-bearing property is a TIMING one: narrating a phase must not delay the
// dispatch, because `dispatchTicket` runs inside the synchronous `schedulerTick`.
//
// ⛔ A timing test that only asserts "fast" is the classic check that cannot fail — it
// passes for a narrator that never ran, for a narrator that was never installed, and for
// a `dispatchTicket` that ignores narrators entirely. So every timing assertion here is
// paired with a NEGATIVE CONTROL on the same instrument: a deliberately BLOCKING
// narrator, measured by the same clock through the same call, which must be caught. If
// the control ever stops failing, the instrument is broken and the positive result means
// nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  NARRATOR_CALLER,
  PLAN_STATUS,
  SESSION_ROUTE_ID,
  buildSessionPayload,
  createAgentSessionNarrator,
  isClosingPhase,
  planFor,
} from "./agent-session-narrator.mjs";
import { dispatchTicket, getAgentSessionNarrator, setAgentSessionNarrator } from "./dispatch.mjs";
import { ASYNC_MAX_ATTEMPTS, NON_BLOCKING_ROUTE_IDS, createLinearWriteProxy, defaultAsyncHttpFn } from "./linear-write-proxy.mjs";
import { PHASES } from "../lib/workflow-descriptor.mjs";

/** The route the ticket says is hung: it accepts the send and never answers. */
const hungAsyncHttpFn = () => ({ dispatched: true });

const okResolver = { issue: () => ({ ok: true, issueId: "11111111-2222-3333-4444-555555555555", teamId: "t" }) };

function proxyWith(overrides = {}) {
  return createLinearWriteProxy({
    mode: "enforce",
    env: { CATALYST_CLOUD_TOKEN: "test-token", CATALYST_CLOUD_BASE_URL: "https://example.invalid/api/v1" },
    appendEvent: () => {},
    log: { warn() {}, error() {}, info() {} },
    budgetPath: "/dev/null",
    readLedgerFn: () => ({ state: "fresh" }),
    writeLedgerFn: () => {},
    asyncHttpFn: hungAsyncHttpFn,
    ...overrides,
  });
}

afterEach(() => setAgentSessionNarrator(null));

describe("CTL-1943 — the narration cannot delay the dispatch", () => {
  test("a hung session route does not delay dispatchTicket", () => {
    setAgentSessionNarrator(createAgentSessionNarrator({ proxy: proxyWith(), resolver: okResolver }));
    let dispatched = false;
    const t0 = performance.now();
    dispatchTicket("/tmp/orch", "CTL-1", "implement", { dispatch: () => { dispatched = true; return { code: 0 }; } });
    const elapsed = performance.now() - t0;
    expect(dispatched).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  test("⛔ NEGATIVE CONTROL: the same clock DOES catch a blocking narrator", () => {
    // Exactly the shape the ticket refused — a synchronous wire call in the dispatch
    // seam. Measured with `/bin/sleep`, which is what the blocking transport really does
    // (spawnSync). If this does not exceed the bound, the assertion above is vacuous.
    setAgentSessionNarrator({ narrate: () => { spawnSync("/bin/sleep", ["0.6"]); return { narrated: true }; } });
    const t0 = performance.now();
    dispatchTicket("/tmp/orch", "CTL-1", "implement", { dispatch: () => ({ code: 0 }) });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThan(500);
  });

  test("narrate returns a plain verdict, never a promise the tick could await", () => {
    const n = createAgentSessionNarrator({ proxy: proxyWith(), resolver: okResolver });
    const res = n.narrate("CTL-1", "implement");
    expect(typeof res?.then).not.toBe("function");
    expect(res.narrated).toBe(true);
  });

  test("a narrator that throws never fails the dispatch", () => {
    setAgentSessionNarrator({ narrate: () => { throw new Error("boom"); } });
    // dispatchTicket does not wrap the call, so this asserts the CONTRACT that narrate
    // is total — and documents that a narrator violating it is the caller's bug.
    expect(() => dispatchTicket("/tmp/o", "CTL-1", "implement", { dispatch: () => ({ code: 0 }) })).toThrow();
    // The real narrator honours the contract: an exploding resolver is swallowed.
    const real = createAgentSessionNarrator({
      proxy: proxyWith(),
      resolver: { issue: () => { throw new Error("replica gone"); } },
    });
    setAgentSessionNarrator(real);
    let dispatched = false;
    dispatchTicket("/tmp/o", "CTL-1", "implement", { dispatch: () => { dispatched = true; return { code: 0 }; } });
    expect(dispatched).toBe(true);
    expect(real.narrate("CTL-1", "implement")).toEqual({ narrated: false, reason: "narrator-threw" });
  });
});

describe("CTL-1943 — the default (no narrator) path stays free", () => {
  // ⛔ Every OTHER test in this tree injects or installs something. This one asserts the
  // shape the whole fleet actually runs: nothing installed. A default that no test
  // exercises is a default that ships broken (CTL-1918 shipped exactly that).
  test("with nothing installed, dispatchTicket forwards its args unchanged", () => {
    expect(getAgentSessionNarrator()).toBe(null);
    let seen = null;
    const out = dispatchTicket("/tmp/o", "CTL-9", "verify", { dispatch: (a) => { seen = a; return { code: 0 }; } });
    expect(seen).toEqual({ orchDir: "/tmp/o", ticket: "CTL-9", phase: "verify" });
    expect(out).toEqual({ code: 0 });
  });

  test("an explicit null narrator overrides an installed one", () => {
    let called = false;
    setAgentSessionNarrator({ narrate: () => { called = true; } });
    dispatchTicket("/tmp/o", "CTL-9", "verify", { dispatch: () => ({ code: 0 }), narrator: null });
    expect(called).toBe(false);
  });
});

describe("CTL-1943 — the payload matches the route contract", () => {
  test("plan is a BARE array whose entries use `content`, never `title`", () => {
    const p = buildSessionPayload({ issueId: "id", phase: "implement" });
    expect(Array.isArray(p.plan)).toBe(true);
    expect(p.plan.every((e) => typeof e.content === "string")).toBe(true);
    expect(p.plan.some((e) => "title" in e)).toBe(false);
    expect(JSON.stringify(p.plan)).not.toContain("entries");
  });

  test("the plan is never empty — the cloud refuses an empty plan on purpose", () => {
    for (const phase of [...PHASES, "remediate", "not-a-phase"]) {
      expect(buildSessionPayload({ issueId: "id", phase }).plan.length).toBeGreaterThan(0);
    }
  });

  test("the current phase is inProgress and earlier phases are completed", () => {
    const p = planFor("verify");
    const idx = PHASES.indexOf("verify");
    expect(p[idx].status).toBe(PLAN_STATUS.IN_PROGRESS);
    expect(p.slice(0, idx).every((e) => e.status === PLAN_STATUS.COMPLETED)).toBe(true);
    expect(p.slice(idx + 1).every((e) => e.status === PLAN_STATUS.PENDING)).toBe(true);
  });

  test("an unknown phase yields a plan with nothing in progress, and does not throw", () => {
    const p = planFor("remediate");
    expect(p.every((e) => e.status === PLAN_STATUS.PENDING)).toBe(true);
  });

  test("the closing phase sends a terminal `response` and completes every entry", () => {
    expect(isClosingPhase(PHASES[PHASES.length - 1])).toBe(true);
    expect(isClosingPhase("implement")).toBe(false);
    const p = buildSessionPayload({ issueId: "id", phase: PHASES[PHASES.length - 1] });
    expect(p.activity.type).toBe("response");
    expect(typeof p.activity.body).toBe("string");
    expect(p.plan.every((e) => e.status === PLAN_STATUS.COMPLETED)).toBe(true);
  });

  test("a non-closing phase sends an `action`, one of the route's accepted types", () => {
    const p = buildSessionPayload({ issueId: "id", phase: "implement" });
    expect(p.activity.type).toBe("action");
    expect(p.activity.action).toContain("implement");
    // The route refuses an unrecognized type by name rather than defaulting it.
    expect(["thought", "response", "error", "action"]).toContain(p.activity.type);
  });

  test("hostId is omitted unless supplied — identity is the key, not the payload", () => {
    expect("hostId" in buildSessionPayload({ issueId: "id", phase: "plan" })).toBe(false);
    expect(buildSessionPayload({ issueId: "id", phase: "plan", host: "mini" }).hostId).toBe("mini");
  });
});

describe("CTL-1943 — the transport asymmetry is enforced, not just documented", () => {
  test("only `session` is declared non-blocking", () => {
    expect([...NON_BLOCKING_ROUTE_IDS]).toEqual([SESSION_ROUTE_ID]);
    for (const id of ["issue-state", "label", "comment"]) {
      expect(NON_BLOCKING_ROUTE_IDS.has(id)).toBe(false);
    }
  });

  test("sendAsync REFUSES a dispatch-critical route by name", () => {
    // The regression that matters: a future caller reaching for the fast path to speed
    // up a write whose result something depends on.
    const errors = [];
    const proxy = proxyWith({ log: { warn() {}, error: (o, m) => errors.push([o, m]), info() {} } });
    for (const id of ["issue-state", "label", "comment"]) {
      const res = proxy.sendAsync({ routeId: id, ticket: "CTL-1", payload: {} });
      expect(res).toEqual({ handled: true, dispatched: false, reason: "route-not-async-eligible" });
    }
    expect(errors.length).toBe(3);
  });

  test("a narration failure is logged with BOTH the ticket and the phase", () => {
    // "narration failed" with neither is an alert nobody can act on.
    const warns = [];
    const proxy = proxyWith({
      log: { warn: (o, m) => warns.push([o, m]), error: (o, m) => warns.push([o, m]), info() {} },
      asyncHttpFn: ({ onDone }) => { onDone({ code: 22, stdout: "", stderr: "HTTP 500" }); return { dispatched: true }; },
    });
    proxy.sendAsync({ routeId: SESSION_ROUTE_ID, ticket: "CTL-77", phase: "implement", payload: { issueId: "x" }, caller: NARRATOR_CALLER });
    const hit = warns.find(([o]) => o.ticket === "CTL-77" && o.phase === "implement");
    expect(hit).toBeDefined();
  });

  test("the send spends budget SYNCHRONOUSLY, before the child is spawned", () => {
    // The ledger is an unlocked read-modify-write and is only safe because it has one
    // writer. If sendAsync recorded from its async callback, two RMW cycles could
    // interleave with `send`'s. Asserted by ordering, not by reading the code.
    const order = [];
    const proxy = proxyWith({
      readLedgerFn: () => ({ state: "fresh" }),
      writeLedgerFn: () => order.push("ledger"),
      asyncHttpFn: () => { order.push("spawn"); return { dispatched: true }; },
    });
    proxy.sendAsync({ routeId: SESSION_ROUTE_ID, ticket: "CTL-5", phase: "plan", payload: { issueId: "x" } });
    expect(order).toEqual(["ledger", "spawn"]);
  });

  test("⛔ repeated narrations of one ticket are NOT convergence-suppressed", () => {
    // CTL-1936 suppresses a repeated write whose desired state is already reached. That
    // is right for a label and WRONG for a narration: every phase must emit, and a
    // session that stops emitting goes `stale` at 30 min and then reads as "the agent
    // didn't start" — the exact failure this feature exists to prevent. The suppression
    // key is null for a session payload (it needs labelIds + mode), so this holds by
    // construction; asserted because "by construction" is how it would silently change.
    const sent = [];
    const proxy = proxyWith({ asyncHttpFn: () => { sent.push(1); return { dispatched: true }; } });
    for (const phase of ["research", "plan", "implement", "implement"]) {
      const r = proxy.sendAsync({ routeId: SESSION_ROUTE_ID, ticket: "CTL-3", phase, payload: { issueId: "x", plan: [], activity: {} } });
      expect(r.dispatched).toBe(true);
    }
    expect(sent.length).toBe(4);
  });

  test("an unresolvable ticket is a NAMED skip, never a live-Linear fallback", () => {
    const n = createAgentSessionNarrator({
      proxy: proxyWith(),
      resolver: { issue: () => ({ ok: false, reason: "replica-stale" }) },
    });
    expect(n.narrate("CTL-1", "implement")).toEqual({ narrated: false, reason: "resolve:replica-stale" });
  });

  test("⛔ a host with NO per-host key REFUSES loudly and narrates nothing", () => {
    // The negative control that caught an error in this very test file: the first cut
    // passed the wrong env var name, and the transport refused every send by name rather
    // than sending without a credential. That refusal is the behaviour, so it is asserted.
    const errors = [];
    const proxy = proxyWith({
      env: { CATALYST_CLOUD_BASE_URL: "https://example.invalid/api/v1" }, // no token
      log: { warn() {}, error: (o, m) => errors.push([o, m]), info() {} },
    });
    const res = proxy.sendAsync({ routeId: SESSION_ROUTE_ID, ticket: "CTL-2", phase: "plan", payload: { issueId: "x" } });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("no-cloud-token");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("a proxy without sendAsync yields no narrator at all", () => {
    expect(createAgentSessionNarrator({ proxy: null })).toBe(null);
    expect(createAgentSessionNarrator({ proxy: { send() {} } })).toBe(null);
  });
});


// ── Codex #3529 round 1 ────────────────────────────────────────────────────────────────

/** A curl stand-in whose stdin fails ASYNCHRONOUSLY, the way a closed pipe really does. */
function fakeCurl({ stdinError = null, closeCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.end = () => {
    if (stdinError) stdin.emit("error", new Error(stdinError));
    else queueMicrotask(() => child.emit("close", closeCode));
  };
  child.stdin = stdin;
  child.kill = () => child.emit("close", closeCode);
  child.unref = () => {};
  return child;
}

describe("round-1 P1 — an EPIPE on curl's stdin must not kill the daemon", () => {
  test("⛔ INSTRUMENT CONTROL: emit('error') with no listener really does throw", () => {
    // This is why the defect was fatal: Node re-throws an unhandled 'error' event as an
    // uncaught exception. If this control ever stops throwing, the test below is vacuous.
    const bare = new EventEmitter();
    expect(() => bare.emit("error", new Error("EPIPE"))).toThrow();
  });

  test("a stdin EPIPE is absorbed — the transport does not throw", () => {
    expect(() =>
      defaultAsyncHttpFn({
        url: "https://example.invalid/x",
        method: "POST",
        token: "t",
        body: "{}",
        spawnFn: () => fakeCurl({ stdinError: "EPIPE: broken pipe" }),
      })
    ).not.toThrow();
  });

  test("a stdin EPIPE does not settle early and discard curl's real verdict", () => {
    // `settle` is once-only, so settling on a broken stdin would throw away the answer
    // curl was about to give. The child's own close is the verdict.
    const seen = [];
    defaultAsyncHttpFn({
      url: "https://example.invalid/x", method: "POST", token: "t", body: "{}",
      onDone: (r) => seen.push(r.code),
      spawnFn: () => fakeCurl({ stdinError: "EPIPE: broken pipe", closeCode: 28 }),
    });
    expect(seen).toEqual([28]);
  });

  test("a synchronously-throwing spawn is reported, not swallowed", () => {
    const seen = [];
    const out = defaultAsyncHttpFn({
      url: "u", method: "POST", token: "t", body: "{}",
      onDone: (r) => seen.push(r.code),
      spawnFn: () => { throw new Error("ENOENT"); },
    });
    expect(out).toEqual({ dispatched: false });
    expect(seen).toEqual([127]);
  });
});

describe("round-1 P2 — a failed dispatch must not be narrated as work in progress", () => {
  test("a nonzero dispatch result narrates NOTHING", () => {
    // The defect: a plan marking the phase inProgress with no worker to correct it, so
    // Linear shows active work until the 30-minute staleness timeout — the "the agent
    // didn't start" misreading, manufactured by the feature meant to prevent it.
    const calls = [];
    setAgentSessionNarrator({ narrate: (t, p) => calls.push([t, p]) });
    dispatchTicket("/tmp/o", "CTL-8", "implement", { dispatch: () => ({ code: 1 }) });
    expect(calls).toEqual([]);
  });

  test("a successful dispatch DOES narrate — the control that keeps the above honest", () => {
    const calls = [];
    setAgentSessionNarrator({ narrate: (t, p) => calls.push([t, p]) });
    dispatchTicket("/tmp/o", "CTL-8", "implement", { dispatch: () => ({ code: 0 }) });
    expect(calls).toEqual([["CTL-8", "implement"]]);
  });

  test("the SDK path narrates: a thenable means the prelaunch signal is already written", () => {
    const calls = [];
    setAgentSessionNarrator({ narrate: (t, p) => calls.push([t, p]) });
    const pending = Promise.resolve({ code: 0 });
    dispatchTicket("/tmp/o", "CTL-8", "research", { dispatch: () => pending });
    expect(calls).toEqual([["CTL-8", "research"]]);
    return pending;
  });

  test("the dispatch result is returned UNCHANGED — narration is not in the value path", () => {
    setAgentSessionNarrator({ narrate: () => {} });
    const token = { code: 0, marker: Symbol("x") };
    expect(dispatchTicket("/tmp/o", "CTL-8", "verify", { dispatch: () => token })).toBe(token);
  });
});

describe("round-1 P2 — the budget must not be under-charged by a retry", () => {
  test("⛔ exactly ONE attempt: the retry is deleted, not accounted for", async () => {
    // Charging a retry would mean writing the ledger from the async callback, which
    // breaks the single-writer invariant the synchronous charge exists to hold. And
    // POST /agent/session APPENDS — a timeout after the cloud accepted would have
    // appended the same activity twice.
    expect(ASYNC_MAX_ATTEMPTS).toBe(1);
    let spawns = 0;
    const seen = [];
    defaultAsyncHttpFn({
      url: "u", method: "POST", token: "t", body: "{}",
      onDone: (r) => seen.push(r.attempts),
      spawnFn: () => { spawns += 1; return fakeCurl({ closeCode: 28 }); },
    });
    // The fake settles on a microtask, exactly as a real child's `close` does — so the
    // assertion has to reach the next turn or it would measure nothing.
    await Promise.resolve();
    expect(spawns).toBe(1);
    expect(seen).toEqual([1]);
  });

  test("one ledger charge per send, and the transport is invoked once", () => {
    const order = [];
    const proxy = proxyWith({
      writeLedgerFn: () => order.push("ledger"),
      asyncHttpFn: ({ onDone }) => { order.push("spawn"); onDone({ code: 28, stdout: "", stderr: "timeout" }); return { dispatched: true }; },
    });
    proxy.sendAsync({ routeId: SESSION_ROUTE_ID, ticket: "CTL-6", phase: "plan", payload: { issueId: "x" } });
    expect(order).toEqual(["ledger", "spawn"]);
  });
});
