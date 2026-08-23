// alert-emit-wiring.test.mjs — CTL-1123. The broker-side wiring of the alert-emit
// foundation: system_down promoted from a critical source's recency edge. The
// pure envelope + machines are covered in alert-emit.test.mjs.
//
// CTL-2156: the needs_human_pileup half of this file MOVED — the label-count
// alert is retired and replaced by the fleet-scoped system-trouble kinds, whose
// wiring lives in system-trouble-wiring.test.mjs.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEventLogPath } from "./config.mjs";
import {
  runWatchdogTick,
  __clearIngestionRecencyForTest,
  __setLastSeenForTest,
  __clearAlertStateForTest,
} from "./router.mjs";
import { GITHUB_SERVICE_NAME } from "./ingestion-recency.mjs";
import { GITHUB_RECENCY_DOWN_MS } from "./config.mjs";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertWorkerState,
} from "./broker-state.mjs";
import { clearInterests, clearLastHeartbeat, __resetBrokerStartedAtForTest } from "./state.mjs";

const TEN_MIN = 10 * 60_000;

function readAlertEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => String(e?.attributes?.["event.name"] ?? "").startsWith("catalyst.alert."));
}
const byLabel = (evs, label) => evs.filter((e) => e.attributes["event.label"] === label);

let dir;
let prevCatalystDir;
beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  dir = mkdtempSync(join(tmpdir(), "alert-wiring-"));
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

describe("system_down alert rides the monitor recency edge (CTL-1123)", () => {
  test("monitor sustained-stale → catalyst.alert.raised(system_down)", () => {
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
    runWatchdogTick();
    const raised = byLabel(readAlertEvents(getEventLogPath()), "system_down").filter(
      (e) => e.attributes["event.name"] === "catalyst.alert.raised",
    );
    expect(raised).toHaveLength(1);
    expect(raised[0].severityText).toBe("ERROR");
    expect(raised[0].body.payload.source).toBe("catalyst.monitor");
    // edge-triggered: a second stale tick does not re-raise
    runWatchdogTick();
    expect(
      byLabel(readAlertEvents(getEventLogPath()), "system_down").filter(
        (e) => e.attributes["event.name"] === "catalyst.alert.raised",
      ),
    ).toHaveLength(1);
  });

  test("monitor recovers → catalyst.alert.cleared(system_down)", () => {
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
    runWatchdogTick(); // raised
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now(), id: "beat-fresh" });
    runWatchdogTick(); // cleared
    const cleared = byLabel(readAlertEvents(getEventLogPath()), "system_down").filter(
      (e) => e.attributes["event.name"] === "catalyst.alert.cleared",
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0].severityText).toBe("INFO");
  });

  test("github stale does NOT raise system_down (alertKind null)", () => {
    // a fresh in-flight worker opens the github gate so github classifies stale
    upsertWorkerState({
      orchestrator: "o", ticket: "CTL-9", status: "implement", eventId: "e1", eventTs: new Date().toISOString(),
    });
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - (GITHUB_RECENCY_DOWN_MS + 60_000), id: "gh-old" });
    runWatchdogTick();
    expect(readAlertEvents(getEventLogPath())).toHaveLength(0);
  });

  test("kill-switch FILTER_ALERT_ENABLED=0 → no alert despite monitor stale", () => {
    const prev = process.env.FILTER_ALERT_ENABLED;
    process.env.FILTER_ALERT_ENABLED = "0";
    try {
      __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
      runWatchdogTick();
      expect(readAlertEvents(getEventLogPath())).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.FILTER_ALERT_ENABLED;
      else process.env.FILTER_ALERT_ENABLED = prev;
    }
  });
});
