// system-trouble.test.mjs — CTL-2156. Unit tests for the PURE half of the
// system-trouble detector: the event→observation classifier and the trailing
// distinct-key window. The broker wiring is system-trouble-wiring.test.mjs.
//
// Run: bun test plugins/dev/scripts/broker/system-trouble.test.mjs
import { describe, test, expect } from "bun:test";
import {
  TROUBLE_RULES,
  SYSTEM_TROUBLE_KINDS,
  DEFAULT_TROUBLE_WINDOW_MS,
  classifySystemTrouble,
  makeSystemTroubleWindow,
} from "./system-trouble.mjs";
import {
  ALERT_KIND_PROVIDER_DEGRADED,
  ALERT_KIND_RATE_LIMIT_EXHAUSTED,
  ALERT_KIND_CAPACITY_UNAVAILABLE,
} from "./alert-emit.mjs";

const ev = (name, { payload = {}, attributes = {}, resource = {} } = {}) => ({
  ts: "2026-08-21T18:00:00.000Z",
  id: "e1",
  resource,
  attributes: { "event.name": name, ...attributes },
  body: { payload },
});

describe("classifySystemTrouble — provider_degraded", () => {
  test("execution-core.sdk.overloaded → provider_degraded keyed on the TICKET", () => {
    const o = classifySystemTrouble(
      ev("execution-core.sdk.overloaded", {
        payload: { ticket: "CTC-310", phase: "implement", delayMs: 833 },
      })
    );
    expect(o).toMatchObject({
      kind: ALERT_KIND_PROVIDER_DEGRADED,
      key: "ticket:CTC-310",
      active: true,
    });
    expect(o.reason).toContain("CTC-310");
  });

  test("exhausted:true is the same KEY — a retry and its exhaustion are one ticket", () => {
    const a = classifySystemTrouble(
      ev("execution-core.sdk.overloaded", { payload: { ticket: "CTC-310" } })
    );
    const b = classifySystemTrouble(
      ev("execution-core.sdk.overloaded", { payload: { ticket: "CTC-310", exhausted: true } })
    );
    expect(b.key).toBe(a.key);
    expect(b.reason).toContain("exhausted");
  });

  test("a ticket-less overload still classifies (never silently dropped)", () => {
    const o = classifySystemTrouble(ev("execution-core.sdk.overloaded", { payload: {} }));
    expect(o.kind).toBe(ALERT_KIND_PROVIDER_DEGRADED);
    expect(o.key).toBe("ticket:unknown");
  });
});

describe("classifySystemTrouble — rate_limit_exhausted", () => {
  test("account.status.changed rejected → active; any other status RETRACTS", () => {
    const bad = classifySystemTrouble(
      ev("account.status.changed", {
        attributes: { "account.handle": "acct3", "account.status": "rejected" },
      })
    );
    expect(bad).toMatchObject({
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      key: "account:acct3",
      active: true,
    });
    const good = classifySystemTrouble(
      ev("account.status.changed", {
        attributes: { "account.handle": "acct3", "account.status": "ok" },
      })
    );
    expect(good).toMatchObject({ key: "account:acct3", active: false });
  });

  test("an UNREADABLE status is no opinion (null), NOT a false retraction", () => {
    // A retraction here would silently clear a live alert on a malformed event.
    expect(classifySystemTrouble(ev("account.status.changed", { payload: {} }))).toBeNull();
  });

  test("account.ratelimit.sampled is a gauge: >= pct active, below it retracts", () => {
    const hot = classifySystemTrouble(
      ev("account.ratelimit.sampled", { payload: { email: "a@b.c", fiveHourPct: 100 } }),
      { accountExhaustedPct: 100 }
    );
    expect(hot).toMatchObject({
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      key: "account:a@b.c",
      active: true,
    });
    const cool = classifySystemTrouble(
      ev("account.ratelimit.sampled", { payload: { email: "a@b.c", fiveHourPct: 35 } }),
      { accountExhaustedPct: 100 }
    );
    expect(cool.active).toBe(false);
    // the pct threshold is honoured, not hard-coded
    expect(
      classifySystemTrouble(
        ev("account.ratelimit.sampled", { payload: { email: "a@b.c", fiveHourPct: 35 } }),
        {
          accountExhaustedPct: 30,
        }
      ).active
    ).toBe(true);
  });

  test("a missing pct is no opinion (null)", () => {
    expect(
      classifySystemTrouble(ev("account.ratelimit.sampled", { payload: { email: "a@b.c" } }))
    ).toBeNull();
  });

  test("account.ratelimit.unsampled only speaks for HTTP 429", () => {
    expect(
      classifySystemTrouble(
        ev("account.ratelimit.unsampled", {
          attributes: { "ratelimit.unsampled_http_status": 429 },
        })
      )
    ).toMatchObject({ kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED, active: true });
    expect(
      classifySystemTrouble(
        ev("account.ratelimit.unsampled", {
          attributes: { "ratelimit.unsampled_http_status": 500 },
        })
      )
    ).toBeNull();
  });

  test("linear budget/label exhaustion classify as rate_limit_exhausted", () => {
    expect(classifySystemTrouble(ev("linear.write.proxy.budget-exhausted"))).toMatchObject({
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      active: true,
    });
    expect(classifySystemTrouble(ev("linear.label.retry-exhausted"))).toMatchObject({
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      key: "linear:label-retry",
      active: true,
    });
  });
});

describe("classifySystemTrouble — capacity_unavailable", () => {
  test("new_maxParallel<=0 is trouble; >0 RETRACTS the same node", () => {
    const dead = classifySystemTrouble(
      ev("node.capacity.changed", {
        payload: {
          "host.name": "mini",
          old_maxParallel: 6,
          new_maxParallel: 0,
          reason: "mem-critical",
        },
      })
    );
    expect(dead).toMatchObject({
      kind: ALERT_KIND_CAPACITY_UNAVAILABLE,
      key: "node:mini",
      active: true,
    });
    expect(dead.reason).toContain("mem-critical");
    const alive = classifySystemTrouble(
      ev("node.capacity.changed", { payload: { "host.name": "mini", new_maxParallel: 6 } })
    );
    expect(alive).toMatchObject({ key: "node:mini", active: false });
  });

  test("an unreadable maxParallel is no opinion (null)", () => {
    expect(
      classifySystemTrouble(ev("node.capacity.changed", { payload: { "host.name": "mini" } }))
    ).toBeNull();
  });
});

describe("classifySystemTrouble — non-events and hostile input", () => {
  test("an unrelated event returns null", () => {
    // POSITIVE CONTROL: the same classifier DOES answer for a rule it knows.
    expect(
      classifySystemTrouble(ev("execution-core.sdk.overloaded", { payload: { ticket: "X-1" } }))
    ).not.toBeNull();
    expect(classifySystemTrouble(ev("github.push"))).toBeNull();
  });

  test("malformed input never throws", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { attributes: null },
      { attributes: { "event.name": 7 } },
    ]) {
      expect(() => classifySystemTrouble(bad)).not.toThrow();
      expect(classifySystemTrouble(bad)).toBeNull();
    }
  });

  test("a rule that throws is swallowed, not propagated to the broker tail", () => {
    // Freeze-proof: exercise the try/catch by handing a rule an event whose
    // payload getter throws.
    const hostile = {
      attributes: { "event.name": "execution-core.sdk.overloaded" },
      get body() {
        throw new Error("boom");
      },
    };
    expect(() => classifySystemTrouble(hostile)).not.toThrow();
    expect(classifySystemTrouble(hostile)).toBeNull();
  });

  test("every rule maps to one of the three declared kinds", () => {
    expect(SYSTEM_TROUBLE_KINDS).toHaveLength(3);
    const kinds = new Set(SYSTEM_TROUBLE_KINDS);
    for (const name of Object.keys(TROUBLE_RULES)) {
      const o = TROUBLE_RULES[name](
        ev(name, { payload: { new_maxParallel: 0, fiveHourPct: 100 } }),
        {
          accountExhaustedPct: 100,
        }
      );
      if (o) expect(kinds.has(o.kind)).toBe(true);
    }
  });
});

describe("makeSystemTroubleWindow — distinct-key level + auto-clear", () => {
  const overload = (t) => ev("execution-core.sdk.overloaded", { payload: { ticket: t } });

  test("N tickets → count N (the level is DISTINCT keys, not events)", () => {
    const w = makeSystemTroubleWindow();
    const now = 1_000_000;
    for (const t of ["A", "B", "C"]) w.observeEvent(overload(t), now);
    // repeats of the same ticket do NOT inflate the level
    for (let i = 0; i < 20; i++) w.observeEvent(overload("A"), now + i);
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, now + 100)).toBe(3);
    expect(w.keys(ALERT_KIND_PROVIDER_DEGRADED, now + 100)).toEqual([
      "ticket:A",
      "ticket:B",
      "ticket:C",
    ]);
  });

  test("EXPIRY auto-clears keys from a producer that never reports health", () => {
    const w = makeSystemTroubleWindow();
    const now = 1_000_000;
    w.observeEvent(overload("A"), now);
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, now)).toBe(1);
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, now + DEFAULT_TROUBLE_WINDOW_MS - 1)).toBe(1);
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, now + DEFAULT_TROUBLE_WINDOW_MS)).toBe(0);
  });

  test("RETRACTION auto-clears immediately, without waiting out the window", () => {
    const w = makeSystemTroubleWindow();
    const now = 1_000_000;
    w.observeEvent(
      ev("node.capacity.changed", { payload: { "host.name": "mini", new_maxParallel: 0 } }),
      now
    );
    expect(w.count(ALERT_KIND_CAPACITY_UNAVAILABLE, now)).toBe(1);
    w.observeEvent(
      ev("node.capacity.changed", { payload: { "host.name": "mini", new_maxParallel: 6 } }),
      now + 1
    );
    expect(w.count(ALERT_KIND_CAPACITY_UNAVAILABLE, now + 1)).toBe(0);
  });

  test("per-kind windowMs is honoured", () => {
    const w = makeSystemTroubleWindow({ windowMsByKind: { [ALERT_KIND_PROVIDER_DEGRADED]: 1000 } });
    const now = 0;
    w.observeEvent(overload("A"), now);
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, 999)).toBe(1);
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, 1000)).toBe(0);
  });

  test("kinds are isolated — one kind's keys never leak into another's count", () => {
    const w = makeSystemTroubleWindow();
    const now = 0;
    w.observeEvent(overload("A"), now);
    w.observeEvent(ev("linear.label.retry-exhausted"), now);
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, now)).toBe(1);
    expect(w.count(ALERT_KIND_RATE_LIMIT_EXHAUSTED, now)).toBe(1);
    expect(w.count(ALERT_KIND_CAPACITY_UNAVAILABLE, now)).toBe(0);
  });

  test("prune() bounds the maps — expired keys are deleted, not merely ignored", () => {
    const w = makeSystemTroubleWindow();
    for (let i = 0; i < 500; i++) w.observeEvent(overload(`T-${i}`), 0);
    expect(w.size(0)).toBe(500);
    w.prune(DEFAULT_TROUBLE_WINDOW_MS);
    expect(w.size(DEFAULT_TROUBLE_WINDOW_MS)).toBe(0);
  });

  test("reason() carries the most recent active detail for forensics", () => {
    const w = makeSystemTroubleWindow();
    w.observeEvent(overload("A"), 0);
    expect(w.reason(ALERT_KIND_PROVIDER_DEGRADED)).toContain("A");
    expect(w.reason(ALERT_KIND_CAPACITY_UNAVAILABLE)).toBeNull();
  });

  test("clear() resets both the keys and the reasons", () => {
    const w = makeSystemTroubleWindow();
    w.observeEvent(overload("A"), 0);
    w.clear();
    expect(w.count(ALERT_KIND_PROVIDER_DEGRADED, 0)).toBe(0);
    expect(w.reason(ALERT_KIND_PROVIDER_DEGRADED)).toBeNull();
  });

  test("observeEvent on an unrelated event is a no-op", () => {
    const w = makeSystemTroubleWindow();
    expect(w.observeEvent(ev("github.push"), 0)).toBeNull();
    expect(w.size(0)).toBe(0);
  });
});
