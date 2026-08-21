// linear-write-budget.test.mjs — CTL-1936.
//
// The ticket's own negative control is the load-bearing one and it is asserted below:
// a host legitimately doing a full day's writes across MANY tickets must not be
// throttled. "A cap that fires on healthy fan-out is a worse defect than the one it
// replaces." Every throttle assertion here is therefore paired with that fan-out case.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DAILY_BUDGET,
  DEFAULT_PER_TICKET_CAP,
  REASONS,
  classifyExhaustion,
  classifyWrite,
  clearConvergence,
  convergenceKeyFor,
  emptyLedger,
  markExhaustionAnnounced,
  noteConvergence,
  readLedger,
  recordWrite,
  rollToDay,
  utcDayOf,
} from "./linear-write-budget.mjs";

const DAY = "2026-08-18";
const spend = (ledger, ticket, n) => {
  let l = ledger;
  for (let i = 0; i < n; i++) l = recordWrite(l, ticket);
  return l;
};

describe("AC1 — a host knows what it has spent", () => {
  test("writes are counted per ticket and in total", () => {
    let l = spend(emptyLedger(DAY), "CTL-1", 3);
    l = spend(l, "CTL-2", 2);
    expect(l.total).toBe(5);
    expect(l.byTicket["CTL-1"]).toBe(3);
    expect(l.byTicket["CTL-2"]).toBe(2);
  });

  test("the reset is by UTC DAY KEY, not by process start", () => {
    const yesterday = spend(emptyLedger("2026-08-17"), "CTL-1", 299);
    const rolled = rollToDay(yesterday, DAY);
    expect(rolled.day).toBe(DAY);
    expect(rolled.total).toBe(0);
    // …and the same ledger on the SAME day is untouched — a restart must not reset it.
    const same = rollToDay(spend(emptyLedger(DAY), "CTL-1", 7), DAY);
    expect(same.total).toBe(7);
  });

  test("utcDayOf is UTC, not local — the cloud budget resets on the UTC boundary", () => {
    // 2026-08-18T02:39Z is still Aug 17 in US Central; the ledger must say Aug 18.
    expect(utcDayOf(Date.parse("2026-08-18T02:39:00Z"))).toBe("2026-08-18");
  });
});

describe("readLedger is TRI-STATE and never grants a budget out of a broken file", () => {
  const read = (payload) =>
    readLedger("/x", {
      readFileFn: () => {
        if (payload instanceof Error) throw payload;
        return payload;
      },
    });

  test("absent → fresh", () => {
    const e = new Error("nope");
    e.code = "ENOENT";
    expect(read(e).state).toBe("fresh");
  });

  test("⛔ unreadable is NOT fresh", () => {
    const e = new Error("boom");
    e.code = "EACCES";
    expect(read(e).state).toBe("unusable");
  });

  test("⛔ unparseable is NOT fresh", () => {
    expect(read("{not json").state).toBe("unusable");
  });

  test("⛔ a null/array total is malformed, not zero", () => {
    // Number(null) and Number([]) are both 0, which reads as "nothing spent yet" and
    // hands a runaway a full budget out of a file that is telling us it is broken.
    expect(read(JSON.stringify({ day: DAY, total: null, byTicket: {} })).state).toBe("unusable");
    expect(read(JSON.stringify({ day: DAY, total: [], byTicket: {} })).state).toBe("unusable");
    expect(read(JSON.stringify({ day: DAY, total: 5, byTicket: [] })).state).toBe("unusable");
  });

  test("a well-formed ledger loads", () => {
    const r = read(JSON.stringify({ day: DAY, total: 4, byTicket: { "CTL-1": 4 } }));
    expect(r.state).toBe("loaded");
    expect(r.ledger.total).toBe(4);
  });
});

describe("AC2 — one ticket cannot spend the whole budget", () => {
  test("a ticket at its cap is refused LOCALLY with a named reason", () => {
    const l = spend(emptyLedger(DAY), "CTL-1805", DEFAULT_PER_TICKET_CAP);
    const v = classifyWrite({ ledger: l, ticket: "CTL-1805" });
    expect(v.allow).toBe(false);
    expect(v.reason).toBe(REASONS.TICKET_CAP);
  });

  test("writes for OTHER tickets still go through", () => {
    const l = spend(emptyLedger(DAY), "CTL-1805", DEFAULT_PER_TICKET_CAP + 20);
    expect(classifyWrite({ ledger: l, ticket: "CTL-999" }).allow).toBe(true);
  });

  test("⛔ THE NEGATIVE CONTROL: a full day's writes spread over many tickets is NOT throttled", () => {
    // 300 writes across 60 tickets — a legitimately busy host. A cap that fires here is
    // a worse defect than the runaway it replaces.
    let l = emptyLedger(DAY);
    for (let i = 0; i < 60; i++) l = spend(l, `CTL-${i}`, 5);
    expect(l.total).toBe(300);
    for (let i = 0; i < 60; i++) {
      expect(classifyWrite({ ledger: l, ticket: `CTL-${i}`, dailyBudget: 10_000 }).allow).toBe(
        true
      );
    }
  });

  test("the runaway's real shape is caught: 302 on one ticket, 5 elsewhere", () => {
    let l = spend(emptyLedger(DAY), "CTL-1805", 302);
    l = spend(l, "CTL-OTHER", 5);
    expect(classifyWrite({ ledger: l, ticket: "CTL-1805" }).reason).toBe(REASONS.TICKET_CAP);
    // and the collateral the incident actually caused is prevented:
    expect(classifyWrite({ ledger: l, ticket: "CTL-OTHER", dailyBudget: 10_000 }).allow).toBe(true);
  });

  test("the per-ticket reason wins over the host-wide one", () => {
    // Naming the host would send an operator after a fleet problem instead of one caller.
    const l = spend(emptyLedger(DAY), "CTL-1805", DEFAULT_DAILY_BUDGET);
    expect(classifyWrite({ ledger: l, ticket: "CTL-1805" }).reason).toBe(REASONS.TICKET_CAP);
  });

  test("a host genuinely out of budget says so", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < 300; i++) l = recordWrite(l, `T-${i}`);
    expect(classifyWrite({ ledger: l, ticket: "T-NEW" }).reason).toBe(REASONS.DAY_EXHAUSTED);
  });
});

describe("AC3 — a converged write is not re-issued", () => {
  const key = convergenceKeyFor({
    routeId: "label",
    ticket: "CTL-1805",
    payload: { labelIds: ["lab-1"], mode: "remove" },
  });

  test("a key is derived from route + ticket + mode + label ids", () => {
    expect(key).toBe("label:CTL-1805:remove:lab-1");
  });

  test("after convergence the identical write is suppressed", () => {
    const l = noteConvergence(emptyLedger(DAY), key);
    const v = classifyWrite({ ledger: l, ticket: "CTL-1805", convergenceKey: key });
    expect(v.allow).toBe(false);
    expect(v.reason).toBe(REASONS.CONVERGED);
  });

  test("⛔ CONTROL: a DIFFERENT label on the same ticket still goes through", () => {
    const l = noteConvergence(emptyLedger(DAY), key);
    const other = convergenceKeyFor({
      routeId: "label",
      ticket: "CTL-1805",
      payload: { labelIds: ["lab-2"], mode: "remove" },
    });
    expect(classifyWrite({ ledger: l, ticket: "CTL-1805", convergenceKey: other }).allow).toBe(
      true
    );
  });

  test("⛔ CONTROL: an ADD of the same label is a different desired state", () => {
    const l = noteConvergence(emptyLedger(DAY), key);
    const add = convergenceKeyFor({
      routeId: "label",
      ticket: "CTL-1805",
      payload: { labelIds: ["lab-1"], mode: "add" },
    });
    expect(classifyWrite({ ledger: l, ticket: "CTL-1805", convergenceKey: add }).allow).toBe(true);
  });

  test("clearing convergence lets a genuinely-present label remove again", () => {
    let l = noteConvergence(emptyLedger(DAY), key);
    l = clearConvergence(l, key);
    expect(classifyWrite({ ledger: l, ticket: "CTL-1805", convergenceKey: key }).allow).toBe(true);
  });

  test("⛔ convergence is NOT a failure — it touches no failure counter here", () => {
    // Folding `already-absent` into the CTL-1078 removal-failure count would restore the
    // old throttle by re-introducing a lie: the write succeeded.
    const l = noteConvergence(emptyLedger(DAY), key);
    expect(l.total).toBe(0);
    expect(l.byTicket).toEqual({});
  });
});

describe("AC5 — the exhausted state is loud, exactly once", () => {
  test("no announcement below the budget", () => {
    expect(classifyExhaustion(spend(emptyLedger(DAY), "T", 299)).announce).toBe(false);
  });

  test("announces on the first crossing", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < 300; i++) l = recordWrite(l, `T-${i}`);
    const v = classifyExhaustion(l);
    expect(v.exhausted).toBe(true);
    expect(v.announce).toBe(true);
  });

  test("⛔ and NOT again — a storm must not emit one alarm per refused write", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < 300; i++) l = recordWrite(l, `T-${i}`);
    l = markExhaustionAnnounced(l);
    const v = classifyExhaustion(l);
    expect(v.exhausted).toBe(true);
    expect(v.announce).toBe(false);
  });

  test("the latch does not survive the day roll", () => {
    let l = emptyLedger("2026-08-17");
    for (let i = 0; i < 300; i++) l = recordWrite(l, `T-${i}`);
    const rolled = rollToDay(markExhaustionAnnounced(l), DAY);
    expect(classifyExhaustion(rolled).exhausted).toBe(false);
    expect(rolled.exhaustedAnnounced).toBe(false);
  });
});
