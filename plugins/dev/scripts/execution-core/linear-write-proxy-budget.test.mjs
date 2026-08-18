// linear-write-proxy-budget.test.mjs — CTL-1936, the wired behaviour.
//
// linear-write-budget.test.mjs covers the pure decisions. These cover the thing that
// actually failed: whether the transport ASKS before it spends. Every refusal assertion
// therefore also asserts that `httpFn` was NOT called — a refusal that still costs a
// cloud call is not a fix, it is the incident with extra logging.

import { describe, expect, test } from "bun:test";
import { createLinearWriteProxy, EVENT_EXHAUSTED } from "./linear-write-proxy.mjs";
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

/** A proxy whose ledger lives in memory and whose HTTP is a counted stub. */
function harness({ ledger = emptyLedger(DAY), stdout = okBody(null), env = {} } = {}) {
  const calls = [];
  const events = [];
  let stored = ledger;
  const proxy = createLinearWriteProxy({
    mode: "enforce",
    env: { CATALYST_CLOUD_TOKEN: "tok-abcdefghijklmnopqrstuvwxyz012345678901234567", ...env },
    nowFn: NOW,
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
  });
  return { proxy, calls, events, ledger: () => stored, unusable: () => (stored = null) };
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
