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
  QUOTA_EXHAUSTION_LABEL_REASONS,
  isQuotaExhaustionLabelReason,
  classifySystemTrouble,
  makeSystemTroubleWindow,
} from "./system-trouble.mjs";
// ⛔ Imported, never re-typed: these are the PRODUCER's vocabulary. A literal copy
// here would keep passing after the producer renamed a reason, which is exactly how
// the ungated rule survived review in the first place.
import { THROTTLED_LABEL_REASONS } from "../execution-core/label-failure-class.mjs";
import { REASONS as LINEAR_WRITE_BUDGET_REASONS } from "../execution-core/linear-write-budget.mjs";
import {
  ALERT_KIND_PROVIDER_DEGRADED,
  ALERT_KIND_RATE_LIMIT_EXHAUSTED,
  ALERT_KIND_CAPACITY_UNAVAILABLE,
  ALERT_KIND_SYSTEM_STALL,
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
    // The real envelope carries BOTH fields — measured: 84/84 events this month.
    const bad = classifySystemTrouble(
      ev("account.status.changed", {
        attributes: {
          "account.handle": "acct3",
          "account.email": "ryan.rozich@gmail.com",
          "account.status": "rejected",
        },
      })
    );
    expect(bad).toMatchObject({
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      key: "account:ryan.rozich@gmail.com",
      active: true,
    });
    const good = classifySystemTrouble(
      ev("account.status.changed", {
        attributes: {
          "account.handle": "acct3",
          "account.email": "ryan.rozich@gmail.com",
          "account.status": "ok",
        },
      })
    );
    expect(good).toMatchObject({ key: "account:ryan.rozich@gmail.com", active: false });
  });

  test("⛔ ONE account is ONE key across BOTH producers — status + gauge agree", () => {
    // THE DEFECT THIS PINS: status.changed keyed on `acct1` while the gauge keyed on
    // `ryan@rozich.com`, so ONE rate-limited account counted as TWO. The level IS the
    // distinct-key count — it is the number the alert reports.
    const w = makeSystemTroubleWindow();
    w.observeEvent(
      ev("account.status.changed", {
        attributes: {
          "account.handle": "acct1",
          "account.email": "ryan@rozich.com",
          "account.status": "rejected",
        },
        payload: { node: "mini", handle: "acct1", status: "rejected" },
      }),
      0
    );
    w.observeEvent(
      ev("account.ratelimit.sampled", {
        payload: { email: "ryan@rozich.com", fiveHourPct: 100 },
        attributes: { "account.email": "ryan@rozich.com" },
      }),
      0
    );
    expect(w.count(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toBe(1); // ← ONE, not 2
    expect(w.keys(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toEqual(["account:ryan@rozich.com"]);

    // POSITIVE CONTROL: a DIFFERENT account really does add a second key, so the 1
    // above is "they collapsed", not "the window cannot count".
    w.observeEvent(
      ev("account.ratelimit.sampled", {
        payload: { email: "ryan@getadva.ai", fiveHourPct: 100 },
      }),
      0
    );
    expect(w.count(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toBe(2);
  });

  test("⛔ the gauge's retraction clears the status-changed key too (cross-producer)", () => {
    // With split keys the recovering account cleared only its email-keyed twin and
    // the handle-keyed twin held the alert up until the window aged out.
    const w = makeSystemTroubleWindow();
    w.observeEvent(
      ev("account.status.changed", {
        attributes: {
          "account.handle": "acct1",
          "account.email": "ryan@rozich.com",
          "account.status": "rejected",
        },
      }),
      0
    );
    expect(w.count(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toBe(1);
    w.observeEvent(
      ev("account.ratelimit.sampled", { payload: { email: "ryan@rozich.com", fiveHourPct: 12 } }),
      0
    );
    expect(w.count(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toBe(0);
  });

  test("an email-less status event still keys on the handle (degrade, never collapse)", () => {
    const o = classifySystemTrouble(
      ev("account.status.changed", {
        attributes: { "account.handle": "acct9", "account.status": "rejected" },
      })
    );
    expect(o.key).toBe("account:acct9");
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

  test("linear budget exhaustion classifies as rate_limit_exhausted", () => {
    expect(classifySystemTrouble(ev("linear.write.proxy.budget-exhausted"))).toMatchObject({
      kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
      active: true,
    });
  });

  describe("linear.label.retry-exhausted is gated on the REASON (measured false positive)", () => {
    const retry = (reason) =>
      ev("linear.label.retry-exhausted", {
        payload: {
          "host.name": "mini",
          ticket: "CTL-1805",
          label: "needs-human",
          attempts: 5,
          reason,
        },
      });

    test("a genuine quota reason raises, keyed on the HOST", () => {
      for (const why of ["rate-limited", "budget:day-exhausted"]) {
        expect(classifySystemTrouble(retry(why))).toMatchObject({
          kind: ALERT_KIND_RATE_LIMIT_EXHAUSTED,
          key: "linear:label-retry:mini",
          active: true,
        });
      }
    });

    test("⛔ the reasons ACTUALLY seen in the log are NO OPINION, not an alert", () => {
      // Measured on ~/catalyst/events/2026-08.jsonl: all 75 occurrences carried
      // `budget:ticket-cap` (47) or `cloud:label-rejected` (28) — a per-ticket write
      // guard and a deterministic cloud rejection. Neither is a quota, and with
      // FILTER_RATE_LIMIT_THRESHOLD=1 / PERSISTENCE_MS=0 each one raised a
      // fleet-wide "rate limit exhausted" on the next watchdog tick.
      for (const why of [
        "budget:ticket-cap",
        "budget:already-converged",
        "cloud:label-rejected",
        "missing-label",
        "team-mismatch",
        "exclusive-conflict",
        "transient",
        "unauthorized", // a 403 is a CREDENTIAL failure, not a spent quota
      ]) {
        expect(classifySystemTrouble(retry(why))).toBeNull();
      }
    });

    test("a MISSING reason is no opinion — never a blanket raise, never a retraction", () => {
      expect(classifySystemTrouble(ev("linear.label.retry-exhausted"))).toBeNull();
      expect(classifySystemTrouble(retry(undefined))).toBeNull();
    });

    test("a non-quota event cannot RETRACT a live quota alert", () => {
      const w = makeSystemTroubleWindow();
      w.observeEvent(retry("rate-limited"), 0);
      expect(w.count(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toBe(1);
      w.observeEvent(retry("budget:ticket-cap"), 0);
      expect(w.count(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toBe(1); // still up
    });

    test("two hosts out of budget are two keys under ONE alert", () => {
      const w = makeSystemTroubleWindow();
      const onHost = (host) =>
        ev("linear.label.retry-exhausted", {
          payload: { "host.name": host, reason: "budget:day-exhausted" },
        });
      w.observeEvent(onHost("mini"), 0);
      w.observeEvent(onHost("mini2"), 0);
      expect(w.keys(ALERT_KIND_RATE_LIMIT_EXHAUSTED, 0)).toEqual([
        "linear:label-retry:mini",
        "linear:label-retry:mini2",
      ]);
    });

    test("the quota set is PINNED to the producer's own vocabulary, not re-typed", () => {
      // If the producer renames either reason this fails instead of going silently inert.
      expect(THROTTLED_LABEL_REASONS.has("rate-limited")).toBe(true);
      expect(QUOTA_EXHAUSTION_LABEL_REASONS.has("rate-limited")).toBe(true);
      expect(QUOTA_EXHAUSTION_LABEL_REASONS.has(LINEAR_WRITE_BUDGET_REASONS.DAY_EXHAUSTED)).toBe(
        true
      );
      // and the per-ticket guards are deliberately OUT
      expect(QUOTA_EXHAUSTION_LABEL_REASONS.has(LINEAR_WRITE_BUDGET_REASONS.TICKET_CAP)).toBe(
        false
      );
      expect(QUOTA_EXHAUSTION_LABEL_REASONS.has(LINEAR_WRITE_BUDGET_REASONS.CONVERGED)).toBe(false);
      expect(isQuotaExhaustionLabelReason(null)).toBe(false);
      expect(isQuotaExhaustionLabelReason("rate-limited")).toBe(true);
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

  test("⚠️ ARMED BUT UNPROVEN — the values this host actually emits never raise", () => {
    // Every autotune result goes through clampToBounds, which RAISES it to
    // executionCore.minParallel (1 on every configured host here), so `<= 0` is
    // unreachable in practice. Measured 2026-08-21: all 22 node.capacity.changed
    // events that month carried 1 (mem-critical ×11), 6 (cold-start-seed ×10) or 4.
    // This pins the reading so nobody mistakes the rule for capacity COVERAGE.
    for (const [next, reason] of [
      [1, "mem-critical"],
      [4, "cold-start-seed"],
      [6, "cold-start-seed"],
    ]) {
      const o = classifySystemTrouble(
        ev("node.capacity.changed", {
          payload: { "host.name": "mini", old_maxParallel: 6, new_maxParallel: next, reason },
        })
      );
      expect(o.active).toBe(false); // a retraction, never a raise
    }
    // POSITIVE CONTROL — the rule is not simply dead: an unclamped host (minParallel
    // unset, so clampToBounds is a no-op — CTL-665) reaching 0 DOES raise.
    expect(
      classifySystemTrouble(
        ev("node.capacity.changed", {
          payload: { "host.name": "mini", old_maxParallel: 1, new_maxParallel: 0 },
        })
      ).active
    ).toBe(true);
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

  test("every rule maps to one of the declared kinds", () => {
    // CTL-2159 added a fourth: system_stall, fed by `ticket.escalated` carrying
    // the classifier's own SYSTEM verdict. It exists because the other three are
    // keyed on provider / account / node TELEMETRY and cover roughly three of the
    // ~35 reason tokens the classifier calls SYSTEM — leaving spent retry budgets,
    // watchdog kills and wedged workers with NO per-ticket artifact and NO alert.
    expect(SYSTEM_TROUBLE_KINDS).toHaveLength(4);
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

describe("⛔ CTL-2159 — system_stall: the escalation classes that had no telemetry", () => {
  const esc = (attrs, payload = {}) =>
    ev("ticket.escalated", { attributes: attrs, payload });

  test("a SYSTEM-class escalation is trouble, keyed on the TICKET (fan-in)", () => {
    const o = classifySystemTrouble(
      esc(
        { "escalation.stall_class": "system", "escalation.reason": "attempts-exhausted" },
        { ticket: "CTL-900", reason: "attempts-exhausted", stallClass: "system" }
      )
    );
    expect(o).toEqual({
      kind: ALERT_KIND_SYSTEM_STALL,
      key: "ticket:CTL-900",
      active: true,
      reason: "CTL-900 stalled on a system condition (attempts-exhausted)",
    });
  });

  test("N system stalls are N distinct keys under ONE alert — and ZERO per-ticket artifacts", () => {
    const w = makeSystemTroubleWindow();
    const now = 2_000_000;
    for (const t of ["CTL-1", "CTL-2", "CTL-3", "CTL-1"]) {
      w.observeEvent(
        esc({ "escalation.stall_class": "system" }, { ticket: t }),
        now
      );
    }
    expect(w.count(ALERT_KIND_SYSTEM_STALL, now)).toBe(3);
  });

  test("ASK / MOOT / HELD are NO OPINION — never counted, never a retraction", () => {
    for (const klass of ["ask", "moot", "held"]) {
      expect(
        classifySystemTrouble(esc({ "escalation.stall_class": klass }, { ticket: "CTL-9" }))
      ).toBeNull();
    }
    // POSITIVE CONTROL: the same instrument, same event name, only the class
    // differing, DOES return an observation — so the nulls above are "no opinion",
    // not "the rule is unreachable".
    expect(
      classifySystemTrouble(esc({ "escalation.stall_class": "system" }, { ticket: "CTL-9" }))
    ).not.toBeNull();
  });

  test("a class-less escalation is NO OPINION (never a false raise)", () => {
    expect(classifySystemTrouble(esc({}, { ticket: "CTL-9" }))).toBeNull();
  });

  test("the payload carries the class when the attribute does not", () => {
    const o = classifySystemTrouble(esc({}, { ticket: "CTL-9", stallClass: "system" }));
    expect(o?.kind).toBe(ALERT_KIND_SYSTEM_STALL);
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
    w.observeEvent(
      ev("linear.label.retry-exhausted", {
        payload: { "host.name": "mini", reason: "rate-limited" },
      }),
      now
    );
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
