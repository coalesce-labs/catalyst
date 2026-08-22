// system-trouble-wiring.test.mjs — CTL-2156. The broker-side wiring of the
// SYSTEM-trouble alert: tail → classifier → trailing window → level alarm → ONE
// fleet-scoped catalyst.alert.{raised,cleared} per kind.
//
// THE PROPERTY UNDER TEST is the fan-in, and it is the whole reason this ticket
// exists. Measured on 86 items flagged as "waiting on a human", 41 were the model
// provider being overloaded — escalated ONE TICKET AT A TIME. So:
//
//   • N tickets hit by one overload → EXACTLY ONE `raised`, never N.
//   • ZERO per-ticket artifacts — no label write, no ask, no comment.
//   • Condition ends → EXACTLY ONE `cleared`, with no human action.
//
// Every "zero" assertion below is paired with a POSITIVE CONTROL run through the
// same instrument, so "nothing was written" can be told apart from "I could not
// look".
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEventLogPath } from "./config.mjs";
import {
  runWatchdogTick,
  __clearIngestionRecencyForTest,
  __clearAlertStateForTest,
  __setTroubleAlarmForTest,
  __getTroubleAlarmForTest,
  __observeSystemTroubleForTest,
  __troubleWindowCountForTest,
  processEvent,
} from "./router.mjs";
import {
  ALERT_KIND_PROVIDER_DEGRADED,
  ALERT_KIND_RATE_LIMIT_EXHAUSTED,
  ALERT_KIND_CAPACITY_UNAVAILABLE,
} from "./alert-emit.mjs";
import { openBrokerStateDb, closeBrokerStateDb, getAllTicketDescriptors } from "./broker-state.mjs";
import { clearInterests, clearLastHeartbeat, __resetBrokerStartedAtForTest } from "./state.mjs";

// ── event fixtures: the REAL producer shapes, copied from live envelopes ──────
function overloadEvent(ticket, { exhausted = false } = {}) {
  return {
    ts: new Date().toISOString(),
    id: `ovl-${ticket}`,
    resource: { "service.name": "catalyst.execution-core" },
    attributes: { "event.name": "execution-core.sdk.overloaded" },
    body: { payload: { ticket, phase: "implement", attempt: 0, delayMs: 833, exhausted } },
  };
}
function accountStatusEvent(handle, status) {
  return {
    ts: new Date().toISOString(),
    id: `acct-${handle}-${status}`,
    resource: { "service.name": "catalyst.agent" },
    attributes: {
      "event.name": "account.status.changed",
      "account.handle": handle,
      "account.status": status,
    },
    body: { payload: { node: "mini", handle, status } },
  };
}
function capacityEvent(host, newMaxParallel, reason = "mem-critical") {
  return {
    ts: new Date().toISOString(),
    id: `cap-${host}-${newMaxParallel}`,
    resource: { "service.name": "catalyst.execution-core" },
    attributes: { "event.name": "node.capacity.changed", "event.label": host },
    body: {
      payload: { "host.name": host, old_maxParallel: 6, new_maxParallel: newMaxParallel, reason },
    },
  };
}

function readEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const alertsOf = (logPath) =>
  readEvents(logPath).filter((e) =>
    String(e?.attributes?.["event.name"] ?? "").startsWith("catalyst.alert.")
  );
const raisedOf = (logPath, kind) =>
  alertsOf(logPath).filter(
    (e) =>
      e.attributes["event.name"] === "catalyst.alert.raised" && e.attributes["event.label"] === kind
  );
const clearedOf = (logPath, kind) =>
  alertsOf(logPath).filter(
    (e) =>
      e.attributes["event.name"] === "catalyst.alert.cleared" &&
      e.attributes["event.label"] === kind
  );

// persistence satisfied: aboveSince far in the past so ONE tick can raise. The
// timing itself is covered by the pure nextLevelAlarmState unit tests.
const persisted = (kind) => __setTroubleAlarmForTest(kind, { aboveSince: 1 });

let dir;
let prevCatalystDir;
beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  dir = mkdtempSync(join(tmpdir(), "system-trouble-"));
  process.env.CATALYST_DIR = dir;
  closeBrokerStateDb();
  openBrokerStateDb(join(dir, "broker-state.db"));
  __clearIngestionRecencyForTest();
  __clearAlertStateForTest();
  clearInterests();
  clearLastHeartbeat();
  __resetBrokerStartedAtForTest();
});
afterEach(() => {
  closeBrokerStateDb();
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("provider_degraded — N overloaded tickets produce ONE alert (CTL-2156)", () => {
  test("6 tickets overloaded → EXACTLY ONE catalyst.alert.raised(provider_degraded)", () => {
    const tickets = ["CTL-1", "CTL-2", "CTL-3", "CTC-9", "CTC-10", "ADV-4"];
    for (const t of tickets) __observeSystemTroubleForTest(overloadEvent(t));
    // the level is the DISTINCT-KEY count, not the event count
    expect(__troubleWindowCountForTest(ALERT_KIND_PROVIDER_DEGRADED)).toBe(6);

    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();

    const log = getEventLogPath();
    const raised = raisedOf(log, ALERT_KIND_PROVIDER_DEGRADED);
    expect(raised).toHaveLength(1); // ← ONE, not 6
    expect(raised[0].severityText).toBe("ERROR");
    expect(raised[0].body.payload.count).toBe(6);
    expect(raised[0].body.payload.threshold).toBe(2);
    // the affected set travels IN the single alert
    for (const t of tickets) expect(raised[0].body.payload.source).toContain(t);
  });

  test("repeat overloads on the SAME tickets do not re-raise (edge-triggered)", () => {
    for (const t of ["CTL-1", "CTL-2"]) __observeSystemTroubleForTest(overloadEvent(t));
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();
    expect(raisedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);

    // the outage continues: more overload events on the same and new tickets
    for (const t of ["CTL-1", "CTL-2", "CTL-3"]) {
      __observeSystemTroubleForTest(overloadEvent(t, { exhausted: true }));
    }
    runWatchdogTick();
    runWatchdogTick();
    expect(raisedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);
  });

  test("ZERO per-ticket artifacts are written for the overloaded tickets", () => {
    const tickets = ["CTL-1", "CTL-2", "CTL-3", "CTL-4"];
    for (const t of tickets) __observeSystemTroubleForTest(overloadEvent(t, { exhausted: true }));
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();

    const log = getEventLogPath();
    const all = readEvents(log);

    // POSITIVE CONTROL for the reader: it DOES see the one alert it should.
    expect(
      all.filter((e) => e.attributes?.["event.label"] === ALERT_KIND_PROVIDER_DEGRADED)
    ).toHaveLength(1);

    // No Linear write of any kind (label / comment / ask) was emitted.
    const linearWrites = all.filter((e) =>
      /^linear\.(label|write|issue|comment)/.test(String(e.attributes?.["event.name"] ?? ""))
    );
    expect(linearWrites).toEqual([]);

    // No per-ticket event at all: every event in the log is the fleet-scoped
    // alert, whose event.entity is "alert".
    expect(new Set(all.map((e) => e.attributes?.["event.entity"]))).toEqual(new Set(["alert"]));

    // And no ticket descriptor was created/labelled in the broker's own store.
    // POSITIVE CONTROL: the accessor is live — it returns an array, and the same
    // accessor is what the (now-retired) label-count detector read from.
    const descriptors = getAllTicketDescriptors();
    expect(Array.isArray(descriptors)).toBe(true);
    expect(descriptors.filter((d) => tickets.includes(d.ticket))).toEqual([]);
  });

  test("condition ends → EXACTLY ONE catalyst.alert.cleared, with no human action", () => {
    const now = Date.now();
    for (const t of ["CTL-1", "CTL-2", "CTL-3"])
      __observeSystemTroubleForTest(overloadEvent(t), now);
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();
    expect(raisedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);
    expect(__getTroubleAlarmForTest(ALERT_KIND_PROVIDER_DEGRADED).raised).toBe(true);

    // The provider recovers: no producer says "I'm fine", the keys simply stop
    // being refreshed. Re-observe them far enough in the past that the trailing
    // window has aged them out — the AUTO-CLEAR backstop.
    __clearAlertStateForTest();
    __setTroubleAlarmForTest(ALERT_KIND_PROVIDER_DEGRADED, { raised: true, raisedAt: now });
    for (const t of ["CTL-1", "CTL-2", "CTL-3"]) {
      __observeSystemTroubleForTest(overloadEvent(t), now - 3_600_000); // 1h ago
    }
    expect(__troubleWindowCountForTest(ALERT_KIND_PROVIDER_DEGRADED)).toBe(0);
    runWatchdogTick();

    const cleared = clearedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].severityText).toBe("INFO");
    expect(cleared[0].body.payload.count).toBe(0);
    expect(__getTroubleAlarmForTest(ALERT_KIND_PROVIDER_DEGRADED).raised).toBe(false);

    // still edge-triggered: a further quiet tick does not re-clear
    runWatchdogTick();
    expect(clearedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);
  });

  test("ONE overloaded ticket is below threshold → no alert", () => {
    __observeSystemTroubleForTest(overloadEvent("CTL-1"));
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();
    // POSITIVE CONTROL: the reader finds the alert once a second ticket joins.
    expect(alertsOf(getEventLogPath())).toHaveLength(0);
    __observeSystemTroubleForTest(overloadEvent("CTL-2"));
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();
    expect(raisedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);
  });
});

describe("rate_limit_exhausted (CTL-2156)", () => {
  test("a rejected account raises once; the same account un-rejecting clears once", () => {
    __observeSystemTroubleForTest(accountStatusEvent("acct3", "rejected"));
    persisted(ALERT_KIND_RATE_LIMIT_EXHAUSTED);
    runWatchdogTick();
    const log = getEventLogPath();
    expect(raisedOf(log, ALERT_KIND_RATE_LIMIT_EXHAUSTED)).toHaveLength(1);

    // RETRACTION — an edge-accurate auto-clear, not a window timeout.
    __observeSystemTroubleForTest(accountStatusEvent("acct3", "ok"));
    expect(__troubleWindowCountForTest(ALERT_KIND_RATE_LIMIT_EXHAUSTED)).toBe(0);
    runWatchdogTick();
    expect(clearedOf(log, ALERT_KIND_RATE_LIMIT_EXHAUSTED)).toHaveLength(1);
  });

  test("three accounts rejected at once is still ONE alert", () => {
    for (const h of ["acct1", "acct2", "acct3"]) {
      __observeSystemTroubleForTest(accountStatusEvent(h, "rejected"));
    }
    persisted(ALERT_KIND_RATE_LIMIT_EXHAUSTED);
    runWatchdogTick();
    const raised = raisedOf(getEventLogPath(), ALERT_KIND_RATE_LIMIT_EXHAUSTED);
    expect(raised).toHaveLength(1);
    expect(raised[0].body.payload.count).toBe(3);
  });
});

describe("capacity_unavailable (CTL-2156)", () => {
  test("maxParallel→0 raises; maxParallel→6 retracts and clears", () => {
    __observeSystemTroubleForTest(capacityEvent("mini", 0));
    persisted(ALERT_KIND_CAPACITY_UNAVAILABLE);
    runWatchdogTick();
    const log = getEventLogPath();
    expect(raisedOf(log, ALERT_KIND_CAPACITY_UNAVAILABLE)).toHaveLength(1);

    __observeSystemTroubleForTest(capacityEvent("mini", 6, "mem-ok"));
    runWatchdogTick();
    expect(clearedOf(log, ALERT_KIND_CAPACITY_UNAVAILABLE)).toHaveLength(1);
  });

  test("a non-zero capacity change never raises", () => {
    __observeSystemTroubleForTest(capacityEvent("mini", 1));
    persisted(ALERT_KIND_CAPACITY_UNAVAILABLE);
    runWatchdogTick();
    expect(alertsOf(getEventLogPath())).toHaveLength(0);
    // POSITIVE CONTROL: the same host at 0 does raise through this same path.
    __observeSystemTroubleForTest(capacityEvent("mini", 0));
    persisted(ALERT_KIND_CAPACITY_UNAVAILABLE);
    runWatchdogTick();
    expect(raisedOf(getEventLogPath(), ALERT_KIND_CAPACITY_UNAVAILABLE)).toHaveLength(1);
  });
});

describe("kinds are independent, and the live tail feeds the detector (CTL-2156)", () => {
  test("provider and capacity alarms raise separately, one alert each", () => {
    for (const t of ["CTL-1", "CTL-2"]) __observeSystemTroubleForTest(overloadEvent(t));
    __observeSystemTroubleForTest(capacityEvent("mini", 0));
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    persisted(ALERT_KIND_CAPACITY_UNAVAILABLE);
    runWatchdogTick();
    const log = getEventLogPath();
    expect(raisedOf(log, ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);
    expect(raisedOf(log, ALERT_KIND_CAPACITY_UNAVAILABLE)).toHaveLength(1);
    expect(raisedOf(log, ALERT_KIND_RATE_LIMIT_EXHAUSTED)).toHaveLength(0);
  });

  test("processEvent (the LIVE tail path) folds overloads into the window", () => {
    // Proves the detector is wired to real ingestion, not only to the test seam.
    for (const t of ["CTL-1", "CTL-2"]) processEvent(overloadEvent(t));
    expect(__troubleWindowCountForTest(ALERT_KIND_PROVIDER_DEGRADED)).toBe(2);
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();
    expect(raisedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);
  });

  test("kill-switch FILTER_ALERT_ENABLED=0 → no alert despite a live outage", () => {
    const prev = process.env.FILTER_ALERT_ENABLED;
    process.env.FILTER_ALERT_ENABLED = "0";
    try {
      for (const t of ["CTL-1", "CTL-2", "CTL-3"]) __observeSystemTroubleForTest(overloadEvent(t));
      persisted(ALERT_KIND_PROVIDER_DEGRADED);
      runWatchdogTick();
      expect(alertsOf(getEventLogPath())).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.FILTER_ALERT_ENABLED;
      else process.env.FILTER_ALERT_ENABLED = prev;
    }
    // POSITIVE CONTROL: with the switch restored, the same state raises.
    persisted(ALERT_KIND_PROVIDER_DEGRADED);
    runWatchdogTick();
    expect(raisedOf(getEventLogPath(), ALERT_KIND_PROVIDER_DEGRADED)).toHaveLength(1);
  });
});
