// linear-write-proxy-budget.test.mjs — CTL-1936, the wired behaviour.
//
// linear-write-budget.test.mjs covers the pure decisions. These cover the thing that
// actually failed: whether the transport ASKS before it spends. Every refusal assertion
// therefore also asserts that `httpFn` was NOT called — a refusal that still costs a
// cloud call is not a fix, it is the incident with extra logging.

import { describe, expect, test } from "bun:test";
import {
  createLinearWriteProxy,
  EVENT_EXHAUSTED,
  EVENT_WOULD_BACKOFF,
} from "./linear-write-proxy.mjs";
import {
  emptyLedger,
  recordWrite,
  utcDayOf,
  DEFAULT_PER_TICKET_CAP,
} from "./linear-write-budget.mjs";

const DAY = utcDayOf(Date.parse("2026-08-18T04:00:00Z"));
const NOW = () => Date.parse("2026-08-18T04:00:00Z");

const okBody = (results) =>
  `${JSON.stringify({ outcome: "succeeded", ...(results ? { results } : {}) })}\n200`;

/** A proxy whose ledger lives in memory and whose HTTP is a counted stub.
 *  CTL-2027 Phase 3: `clock` lets a test advance time without re-building the
 *  harness (so a cool-down window can be crossed mid-test); `backpressureMode`
 *  and `cooldownMs` thread the new flag + window straight to the proxy. The
 *  write-cooldown marker store is ALSO in-memory (a plain object keyed by
 *  "ticket:route"), mirroring the ledger's own in-memory-store pattern above —
 *  hermetic, no real filesystem. */
function harness({
  ledger = emptyLedger(DAY),
  stdout = okBody(null),
  env = {},
  clock = { now: NOW() },
  backpressureMode = "off",
  cooldownMs = undefined,
} = {}) {
  const calls = [];
  const events = [];
  let stored = ledger;
  const cooldowns = {};
  const nowFn = () => clock.now;
  const proxy = createLinearWriteProxy({
    mode: "enforce",
    env: { CATALYST_CLOUD_TOKEN: "tok-abcdefghijklmnopqrstuvwxyz012345678901234567", ...env },
    nowFn,
    readLedgerFn: () =>
      stored === null ? { state: "unusable", reason: "test" } : { state: "loaded", ledger: stored },
    writeLedgerFn: (_p, l) => {
      stored = l;
    },
    httpFn: (req) => {
      calls.push(req);
      return { code: 0, stdout, stderr: "" };
    },
    appendEvent: (line) => events.push(JSON.parse(line)),
    log: { warn() {}, error() {}, info() {} },
    backpressureMode,
    ...(cooldownMs !== undefined ? { writeCooldownMs: cooldownMs } : {}),
    readWriteCooldownMarkerFn: (_dir, ticket, routeId) => cooldowns[`${ticket}:${routeId}`] ?? null,
    recordWriteCooldownFn: (_dir, ticket, routeId, now) => {
      cooldowns[`${ticket}:${routeId}`] = { failedAt: now };
    },
  });
  return {
    proxy,
    calls,
    events,
    clock,
    cooldowns,
    ledger: () => stored,
    unusable: () => (stored = null),
  };
}

const labelPayload = (ids, mode = "remove") => ({ issueId: "i-1", labelIds: ids, mode });

describe("AC2 — a runaway ticket is refused locally, without a cloud call", () => {
  test("at the per-ticket cap the write is refused and NOT sent", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-1805");
    const h = harness({ ledger: l });
    const r = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("budget:ticket-cap");
    // The whole point: a refusal at the cloud costs a budget unit; this one costs nothing.
    expect(h.calls.length).toBe(0);
  });

  test("⛔ CONTROL: another ticket's write still goes through", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP + 20; i++) l = recordWrite(l, "CTL-1805");
    const h = harness({ ledger: l });
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-999",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.applied).toBe(true);
    expect(h.calls.length).toBe(1);
  });

  test("the refusal is an EVENT, not only a log line", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-1805");
    const h = harness({ ledger: l });
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-1"]) });
    const names = h.events.map((e) => e.attributes["event.name"]);
    expect(names.some((n) => n.startsWith("linear.write.proxy.failed"))).toBe(true);
    expect(h.events[0].attributes["catalyst.linear_write_proxy.reason"]).toBe("budget:ticket-cap");
  });

  test("a refused write does not count as spend — it never left the host", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-1805");
    const before = h_total(l);
    const h = harness({ ledger: l });
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-1"]) });
    expect(h_total(h.ledger())).toBe(before);
  });
});

const h_total = (l) => l.total;

describe("AC1 — spend is recorded for writes that left the host", () => {
  test("an applied write increments the ticket and the total", () => {
    const h = harness();
    h.proxy.send({ routeId: "comment", ticket: "CTL-7", payload: { issueId: "i", body: "b" } });
    expect(h.ledger().total).toBe(1);
    expect(h.ledger().byTicket["CTL-7"]).toBe(1);
  });

  test("⛔ a FAILED write still counts — it spent a budget unit", () => {
    // Counting only successes is how the pre-CTC-674 loop spent a day invisibly: every
    // one of those calls was a 400, and every one cost budget.
    const h = harness({
      stdout: `${JSON.stringify({ outcome: "rejected", reason: "nope" })}\n400`,
    });
    const r = h.proxy.send({ routeId: "label", ticket: "CTL-8", payload: labelPayload(["lab-1"]) });
    expect(r.applied).toBe(false);
    expect(h.ledger().total).toBe(1);
  });
});

describe("AC3 — a converged removal is not re-issued", () => {
  const allAbsent = okBody([{ labelId: "lab-1", outcome: "already-absent", attempts: 1 }]);

  test("after an all-already-absent 200, the identical write is suppressed with no call", () => {
    const h = harness({ stdout: allAbsent });
    const first = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(first.applied).toBe(true);
    expect(h.calls.length).toBe(1);

    const second = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("budget:already-converged");
    expect(h.calls.length).toBe(1); // still one — nothing was sent
  });

  test("⛔ CONTROL: a genuinely-present label removes normally and is NOT marked converged", () => {
    const realRemoval = okBody([{ labelId: "lab-1", outcome: "succeeded", attempts: 1 }]);
    const h = harness({ stdout: realRemoval });
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-1"]) });
    const second = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(second.applied).toBe(true);
    expect(h.calls.length).toBe(2);
  });

  test("⛔ CONTROL: convergence on one label does not suppress a DIFFERENT label", () => {
    const h = harness({ stdout: allAbsent });
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-1"]) });
    const other = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-2"]),
    });
    expect(other.applied).toBe(true);
    expect(h.calls.length).toBe(2);
  });
});

describe("⛔ Codex #3505 P1 — convergence goes stale when the label is re-added", () => {
  const allAbsent = okBody([{ labelId: "lab-1", outcome: "already-absent", attempts: 1 }]);

  test("an ADD of the same label clears the stale remove-convergence, so the next removal is SENT", () => {
    // Without this, `clearConvergence` had no production caller at all: a converged
    // removal + a later re-add left the stale key in place, the next legitimate removal
    // was refused locally as `budget:already-converged`, and the label stayed STRANDED on
    // the ticket until the UTC day rolled — worse than the wasted call it saves.
    const h = harness({ stdout: allAbsent });
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-1"]) });
    expect(h.calls.length).toBe(1);

    // control: while converged, the removal really is suppressed
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-1"]) });
    expect(h.calls.length).toBe(1);

    // the label is re-added — the desired state recorded above is now FALSE
    const added = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"], "add"),
    });
    expect(added.applied).toBe(true);

    // …so the next removal must reach the cloud
    const removal = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(removal.applied).toBe(true);
    expect(h.calls.length).toBe(3);
  });

  test("⛔ CONTROL: adding a DIFFERENT label does not clear the convergence", () => {
    const h = harness({ stdout: allAbsent });
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-1"]) });
    h.proxy.send({ routeId: "label", ticket: "CTL-1805", payload: labelPayload(["lab-2"], "add") });
    const removal = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(removal.reason).toBe("budget:already-converged");
  });
});

describe("⛔ Codex #3505 P2 — a nonsense cap is refused, not obeyed", () => {
  test("a negative cap does NOT refuse every write", () => {
    // `Number("-1") || DEFAULT` is -1, and `spent >= -1` is true before anything is
    // spent — one character turning enforce mode into a total write outage.
    const h = harness({ env: { CATALYST_LINEAR_WRITE_TICKET_CAP: "-1" } });
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-7",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.applied).toBe(true);
  });

  test("Infinity does not silently disable the bound", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-1805");
    const h = harness({ ledger: l, env: { CATALYST_LINEAR_WRITE_TICKET_CAP: "Infinity" } });
    const r = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(r.reason).toBe("budget:ticket-cap");
  });

  test("⛔ CONTROL: a VALID override is still honoured", () => {
    // Otherwise the two assertions above would pass against a resolver that ignores the
    // env var entirely.
    let l = emptyLedger(DAY);
    for (let i = 0; i < 3; i++) l = recordWrite(l, "CTL-1805");
    const h = harness({ ledger: l, env: { CATALYST_LINEAR_WRITE_TICKET_CAP: "3" } });
    const r = h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1"]),
    });
    expect(r.reason).toBe("budget:ticket-cap");
  });
});

describe("AC4 — a write is attributable", () => {
  test("caller and labels reach BOTH the attributes and the payload", () => {
    // Attributes matter because otel-forward strips body.payload off-machine: a field
    // only in the payload is invisible to the operator asking this from Loki.
    const h = harness();
    h.proxy.send({
      routeId: "label",
      ticket: "CTL-1805",
      payload: labelPayload(["lab-1", "lab-2"]),
      caller: "clearStalledLabel",
    });
    const e = h.events.find((x) =>
      x.attributes["event.name"].startsWith("linear.write.proxy.applied")
    );
    expect(e.attributes["catalyst.linear_write_proxy.caller"]).toBe("clearStalledLabel");
    expect(e.attributes["catalyst.linear_write_proxy.labels"]).toBe("lab-1,lab-2");
    expect(e.body.payload.caller).toBe("clearStalledLabel");
    expect(e.body.payload.labels).toEqual(["lab-1", "lab-2"]);
  });
});

describe("AC5 — exhaustion raises once", () => {
  test("one event on the crossing, none on the writes after it", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < 299; i++) l = recordWrite(l, `T-${i}`);
    const h = harness({ ledger: l });
    h.proxy.send({ routeId: "comment", ticket: "T-300", payload: { issueId: "i", body: "b" } });
    const exhausted = () =>
      h.events.filter((e) => e.attributes["event.name"].startsWith(EVENT_EXHAUSTED));
    expect(exhausted().length).toBe(1);

    // Subsequent traffic is refused by the gate and must NOT re-raise.
    h.proxy.send({ routeId: "comment", ticket: "T-301", payload: { issueId: "i", body: "b" } });
    h.proxy.send({ routeId: "comment", ticket: "T-302", payload: { issueId: "i", body: "b" } });
    expect(exhausted().length).toBe(1);
  });
});

describe("an unusable ledger fails OPEN, and never silently", () => {
  test("the write still goes through when the ledger cannot be read", () => {
    // Deliberate: failing closed here turns one corrupt file into a TOTAL Linear-write
    // outage, which is worse than the runaway this bounds (the cloud's 429 still
    // backstops that). What must not happen is failing open QUIETLY.
    const h = harness();
    h.unusable();
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-7",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.applied).toBe(true);
    expect(h.calls.length).toBe(1);
  });
});

// ── CTL-2027 Phase 3 — proxy-side backpressure ────────────────────────────────
// The relocation sequence: applyLabel (COORD-236) → removeLabel (CTL-2083) →
// comment/recovery-reasoning (open, until this phase). Each fix was correct and
// each left the NEXT caller uncovered, because backpressure was fitted to the
// caller rather than to the refusal. Every caller crosses this proxy, so a fix
// here generalizes instead of relocating a fourth time.
describe("CTL-2027 Phase 3: proxy-side (ticket, route) backpressure — enforce", () => {
  test("a budget-refused COMMENT write arms backpressure (the label convergers cannot reach this route)", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-9");
    const h = harness({ ledger: l, backpressureMode: "enforce" });
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-9",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.reason).toBe("budget:ticket-cap");
    expect(h.calls.length).toBe(0);
    expect(h.cooldowns["CTL-9:comment"]).toMatchObject({ failedAt: NOW() });
  });

  test("a budget-refused SESSION write arms backpressure (the other route the convergers cannot reach)", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-10");
    const h = harness({ ledger: l, backpressureMode: "enforce" });
    // session goes through sendAsync, not send.
    h.proxy.sendAsync({
      routeId: "session",
      ticket: "CTL-10",
      payload: { issueId: "i", body: "b" },
    });
    expect(h.cooldowns["CTL-10:session"]).toMatchObject({ failedAt: NOW() });
  });

  test("the next call INSIDE the window is refused WITHOUT touching the transport, even if the ledger would now allow it", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-11");
    const h = harness({ ledger: l, backpressureMode: "enforce", cooldownMs: 60_000 });
    const first = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-11",
      payload: { issueId: "i", body: "b" },
    });
    expect(first.reason).toBe("budget:ticket-cap");
    expect(h.calls.length).toBe(0);

    // The ledger now fails OPEN (would allow) — proving the SECOND refusal below
    // is backpressure, not the pre-existing budget gate re-firing.
    h.unusable();
    const second = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-11",
      payload: { issueId: "i", body: "b" },
    });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("backpressure:cooldown");
    expect(h.calls.length).toBe(0); // still zero — no API attempt
  });

  test("POSITIVE CONTROL: OUTSIDE the window (ledger allowing) the SAME call reaches the transport exactly once", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-12");
    const h = harness({ ledger: l, backpressureMode: "enforce", cooldownMs: 60_000 });
    h.proxy.send({ routeId: "comment", ticket: "CTL-12", payload: { issueId: "i", body: "b" } });
    expect(h.calls.length).toBe(0);

    h.unusable(); // ledger now allows
    h.clock.now += 60_001; // past the window
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-12",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.applied).toBe(true);
    expect(h.calls.length).toBe(1); // proves "zero" above is measurable, not a broken harness
  });

  test("recovery-reasoning's exact live shape: route:'comment', reason:'budget:ticket-cap'", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-2015");
    const h = harness({ ledger: l, backpressureMode: "enforce" });
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-2015",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.reason).toBe("budget:ticket-cap");
    expect(h.cooldowns["CTL-2015:comment"]).toBeTruthy();
  });

  test("only BUDGET-class reasons arm it — a cloud rejection does NOT", () => {
    const rejected = `${JSON.stringify({ outcome: "rejected", reason: "nope" })}\n400`;
    const h = harness({ backpressureMode: "enforce", stdout: rejected });
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-13",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.applied).toBe(false);
    expect(h.cooldowns["CTL-13:comment"]).toBeUndefined();
    // proof it really didn't arm: the next call still reaches the transport.
    const second = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-13",
      payload: { issueId: "i", body: "b" },
    });
    expect(h.calls.length).toBe(2);
    void second;
  });

  test("only BUDGET-class reasons arm it — a validation error (no-cloud-token) does NOT", () => {
    const h = harness({ backpressureMode: "enforce", env: { CATALYST_CLOUD_TOKEN: "" } });
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-14",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.reason).toBe("no-cloud-token");
    expect(h.cooldowns["CTL-14:comment"]).toBeUndefined();
  });

  test("the LABEL path arms only ONE window, not two nested ones stacked with the converger's own cool-down", () => {
    // Simulates a caller hitting the proxy directly on the label route (the same
    // route the scheduler's convergers use). The proxy's own window must be the
    // SAME duration as the converger's (60s default), so the two cannot compound
    // into a longer effective wait for the same refused label.
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-15");
    const h = harness({ ledger: l, backpressureMode: "enforce", cooldownMs: 60_000 });
    h.proxy.send({
      routeId: "label",
      ticket: "CTL-15",
      payload: { issueId: "i", labelIds: ["lab-1"], mode: "remove" },
    });
    h.unusable();
    h.clock.now += 60_000; // exactly at the SAME window CTL-834/CTL-2083 use — not 2×
    const r = h.proxy.send({
      routeId: "label",
      ticket: "CTL-15",
      payload: { issueId: "i", labelIds: ["lab-1"], mode: "remove" },
    });
    expect(r.applied).toBe(true); // window elapsed — allowed again, not still cooled
  });
});

describe("CTL-2027 Phase 3: shadow mode observes, refuses nothing", () => {
  test("would-backoff fires but the write still proceeds normally", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < DEFAULT_PER_TICKET_CAP; i++) l = recordWrite(l, "CTL-16");
    const h = harness({ ledger: l, backpressureMode: "shadow" });
    h.proxy.send({ routeId: "comment", ticket: "CTL-16", payload: { issueId: "i", body: "b" } });
    expect(h.cooldowns["CTL-16:comment"]).toBeTruthy(); // still armed — shadow evaluates fully

    h.unusable(); // ledger now allows
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-16",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.applied).toBe(true); // shadow NEVER refuses on the strength of the cooldown
    expect(h.calls.length).toBe(1);
    const names = h.events.map((e) => e.attributes["event.name"]);
    expect(names.some((n) => n.startsWith(EVENT_WOULD_BACKOFF))).toBe(true);
  });
});

describe("CTL-2027 Phase 3: flag OFF ⇒ byte-identical behaviour", () => {
  test("a pre-armed cooldown marker is ignored entirely when the flag is off (default)", () => {
    let l = emptyLedger(DAY);
    const h = harness({ ledger: l }); // backpressureMode defaults to "off"
    h.cooldowns["CTL-17:comment"] = { failedAt: NOW() }; // pre-armed, out of band
    const r = h.proxy.send({
      routeId: "comment",
      ticket: "CTL-17",
      payload: { issueId: "i", body: "b" },
    });
    expect(r.applied).toBe(true);
    expect(h.calls.length).toBe(1);
  });

  test("EVENT_WOULD_BACKOFF is a real, distinct, namespaced event constant", () => {
    expect(EVENT_WOULD_BACKOFF).toBe("linear.write.proxy.would-backoff");
  });
});
