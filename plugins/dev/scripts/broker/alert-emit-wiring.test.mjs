// alert-emit-wiring.test.mjs — CTL-1123. The broker-side wiring of the alert-emit
// foundation: system_down promoted from a critical source's recency edge, and the
// needs_human_pileup level alert from the filter-state.db label count. The pure
// envelope + machines are covered in alert-emit.test.mjs; this asserts the
// runWatchdogTick wiring + the filter-state.db count scoping.
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
  __setPileupStateForTest,
  __getPileupStateForTest,
} from "./router.mjs";
import { GITHUB_SERVICE_NAME } from "./ingestion-recency.mjs";
import { GITHUB_RECENCY_DOWN_MS } from "./config.mjs";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertTicketDescriptor,
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

describe("needs_human_pileup alert from the filter-state.db label count (CTL-1123)", () => {
  function seedTicket(ticket, state, labels) {
    upsertTicketDescriptor({ ticket, state, labels });
  }
  // persistence satisfied: aboveSince far in the past so one tick can raise.
  const persisted = () => __setPileupStateForTest({ aboveSince: 1 });

  test("3 active needs-human tickets, persisted → catalyst.alert.raised(needs_human_pileup, count 3)", () => {
    seedTicket("CTL-1", "Implement", ["needs-human"]);
    seedTicket("CTL-2", "Backlog", ["needs-input"]);
    seedTicket("CTL-3", "Plan", ["needs-human", "feature"]);
    persisted();
    runWatchdogTick();
    const raised = byLabel(readAlertEvents(getEventLogPath()), "needs_human_pileup").filter(
      (e) => e.attributes["event.name"] === "catalyst.alert.raised",
    );
    expect(raised).toHaveLength(1);
    expect(raised[0].body.payload.count).toBe(3);
    expect(raised[0].body.payload.threshold).toBe(3);
    expect(__getPileupStateForTest().raised).toBe(true);
  });

  test("count EXCLUDES Done/Canceled + removed tickets (cache-drift scoping)", () => {
    seedTicket("CTL-1", "Implement", ["needs-human"]); // counts
    seedTicket("CTL-2", "Backlog", ["needs-input"]); // counts
    seedTicket("CTL-3", "Done", ["needs-human"]); // excluded (terminal)
    seedTicket("CTL-4", "Canceled", ["needs-human"]); // excluded (terminal)
    upsertTicketDescriptor({ ticket: "CTL-5", state: "Implement", labels: ["needs-human"], removed: true }); // excluded
    persisted();
    runWatchdogTick();
    // only 2 active → below threshold 3 → no raise (proves the 3 excluded weren't counted)
    expect(readAlertEvents(getEventLogPath())).toHaveLength(0);
  });

  test("pile-up clears when the active count drops below threshold", () => {
    seedTicket("CTL-1", "Implement", ["needs-human"]);
    seedTicket("CTL-2", "Implement", ["needs-human"]);
    seedTicket("CTL-3", "Implement", ["needs-human"]);
    persisted();
    runWatchdogTick(); // raised
    // two get resolved (labels cleared) → count drops to 1
    upsertTicketDescriptor({ ticket: "CTL-2", labels: [] });
    upsertTicketDescriptor({ ticket: "CTL-3", labels: [] });
    runWatchdogTick(); // cleared
    const cleared = byLabel(readAlertEvents(getEventLogPath()), "needs_human_pileup").filter(
      (e) => e.attributes["event.name"] === "catalyst.alert.cleared",
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0].body.payload.count).toBe(1);
    expect(__getPileupStateForTest().raised).toBe(false);
  });

  test("below threshold → no alert", () => {
    seedTicket("CTL-1", "Implement", ["needs-human"]);
    persisted();
    runWatchdogTick();
    expect(readAlertEvents(getEventLogPath())).toHaveLength(0);
  });
});
