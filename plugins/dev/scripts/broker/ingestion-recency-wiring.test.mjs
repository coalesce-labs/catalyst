// ingestion-recency-wiring.test.mjs — CTL-1122 (PR1). The broker-side wiring:
// the seed warming the last-seen map, processEvent recording recency, and the
// watchdog tick edge-triggering catalyst.ingestion.{stale,recovered}. The pure
// envelope + state-machine units are covered in ingestion-recency.test.mjs.
//
// Time is controlled by planting last-seen timestamps relative to the real
// Date.now() runWatchdogTick reads — no clock injection needed.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEventLogPath, getPrevMonthEventLogPath, GITHUB_RECENCY_DOWN_MS } from "./config.mjs";
import {
  runWatchdogTick,
  processEvent,
  seedLastSeenByService,
  __clearIngestionRecencyForTest,
  __setLastSeenForTest,
  __getLastSeenByServiceForTest,
  __getMonitorRecencyAlarmForTest,
  __getRecencyAlarmForTest,
  __clearAlertStateForTest,
} from "./router.mjs";
import { GITHUB_SERVICE_NAME, LINEAR_SERVICE_NAME } from "./ingestion-recency.mjs";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertWorkerState,
} from "./broker-state.mjs";
import { clearInterests, clearLastHeartbeat, __resetBrokerStartedAtForTest } from "./state.mjs";

function readIngestionEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => String(e?.attributes?.["event.name"] ?? "").startsWith("catalyst.ingestion."));
}

const TEN_MIN = 10 * 60_000;

let dir;
let prevCatalystDir;
beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  dir = mkdtempSync(join(tmpdir(), "ingestion-wiring-"));
  process.env.CATALYST_DIR = dir; // getEventLogPath re-reads this per call
  __clearIngestionRecencyForTest();
  __clearAlertStateForTest(); // CTL-1123: reset the shared pile-up module global
  clearInterests();
  clearLastHeartbeat();
  __resetBrokerStartedAtForTest(); // uptime 0 → no spurious broker.daemon.degraded
});
afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("seedLastSeenByService (CTL-1122)", () => {
  test("warms the map with the newest ts + id per service.name; skips legacy/no-resource", () => {
    const seedLog = join(dir, "seed.jsonl");
    writeFileSync(
      seedLog,
      [
        JSON.stringify({ ts: "2026-06-16T17:00:00Z", id: "m1", resource: { "service.name": "catalyst.monitor" } }),
        JSON.stringify({ ts: "2026-06-16T17:30:00Z", id: "m2", resource: { "service.name": "catalyst.monitor" } }),
        // out-of-order older beat must NOT regress the newest (>= guard)
        JSON.stringify({ ts: "2026-06-16T17:10:00Z", id: "m-old", resource: { "service.name": "catalyst.monitor" } }),
        JSON.stringify({ ts: "2026-06-16T17:20:00Z", id: "b1", resource: { "service.name": "catalyst.broker" } }),
        // legacy flat event (no resource block) → skipped, not a phantom service
        JSON.stringify({ event: "legacy.flat", ts: "2026-06-16T17:40:00Z" }),
        "",
      ].join("\n"),
    );
    seedLastSeenByService({ logPath: seedLog, seedBytes: 10 * 1024 * 1024 });
    const map = __getLastSeenByServiceForTest();
    expect(map.get("catalyst.monitor")).toEqual({ ts: Date.parse("2026-06-16T17:30:00Z"), id: "m2" });
    expect(map.get("catalyst.broker").id).toBe("b1");
    expect(map.has(undefined)).toBe(false);
  });

  test("missing log file is a no-op (fail-open, never throws)", () => {
    expect(() => seedLastSeenByService({ logPath: join(dir, "does-not-exist.jsonl") })).not.toThrow();
    expect(__getLastSeenByServiceForTest().size).toBe(0);
  });
});

describe("processEvent records recency (CTL-1122)", () => {
  test("a catalyst.monitor heartbeat updates the last-seen map", () => {
    processEvent({
      ts: new Date().toISOString(),
      id: "live-beat",
      resource: { "service.name": "catalyst.monitor" },
      attributes: { "event.name": "monitor.heartbeat" },
      body: { payload: null },
    });
    expect(__getLastSeenByServiceForTest().get("catalyst.monitor")?.id).toBe("live-beat");
  });
});

describe("runWatchdogTick monitor recency (CTL-1122)", () => {
  test("never-seen monitor → no alarm (fail-open)", () => {
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
  });

  test("monitor stale past the down threshold → one catalyst.ingestion.stale with caused_by", () => {
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
    runWatchdogTick();
    const evs = readIngestionEvents(getEventLogPath());
    expect(evs).toHaveLength(1);
    expect(evs[0].attributes["event.name"]).toBe("catalyst.ingestion.stale");
    expect(evs[0].attributes["event.label"]).toBe("catalyst.monitor");
    expect(evs[0].caused_by).toBe("beat-old");
    expect(evs[0].body.payload.thresholdMs).toBe(TEN_MIN);

    // a second tick while still stale must NOT re-emit (edge-triggered)
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(1);
  });

  test("stale → fresh beat → paired catalyst.ingestion.recovered", () => {
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
    runWatchdogTick();
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now(), id: "beat-fresh" });
    runWatchdogTick();
    const names = readIngestionEvents(getEventLogPath()).map((e) => e.attributes["event.name"]);
    expect(names).toContain("catalyst.ingestion.stale");
    expect(names).toContain("catalyst.ingestion.recovered");
    const rec = readIngestionEvents(getEventLogPath()).find(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.recovered",
    );
    expect(rec.caused_by).toBe("beat-fresh");
  });

  test("degraded band (3m–10m) classifies degraded but emits NOTHING", () => {
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - 5 * 60_000, id: "beat-degraded" });
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
    expect(__getMonitorRecencyAlarmForTest().lastSeverity).toBe("degraded");
  });

  test("a stale NON-monitor service does not alarm — PR1 scope is monitor-only", () => {
    __setLastSeenForTest("catalyst.broker", { ts: Date.now() - 30 * 60_000, id: "old-broker" });
    // deliberately no catalyst.monitor entry → monitor classifies unknown (fail-open)
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
  });

  test("clock-skewed-ahead monitor (future beat) never alarms — fail-open up", () => {
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() + 5 * 60_000, id: "future-beat" });
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
  });

  test("recovered payload describes the cleared outage (duration, threshold null) and never negative under skew", () => {
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
    runWatchdogTick();
    // recover via a clock-skewed-ahead fresh beat
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() + 5 * 60_000, id: "future-fresh" });
    runWatchdogTick();
    const rec = readIngestionEvents(getEventLogPath()).find(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.recovered",
    );
    expect(rec).toBeDefined();
    expect(rec.body.payload.thresholdMs).toBeNull(); // threshold is meaningless on recovered
    expect(rec.body.payload.ageMs).toBeGreaterThanOrEqual(0); // outage duration, clamped
  });
});

describe("checkMonitorRecency append-failure resilience (CTL-1122)", () => {
  test("a failed stale append does NOT latch — the next writable tick retries (no lost alarm)", () => {
    // Make the events dir unwritable: a FILE where ${CATALYST_DIR}/events should be.
    const eventsPath = join(dir, "events");
    writeFileSync(eventsPath, "x");
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
    runWatchdogTick(); // emit attempt fails (append → ENOTDIR)
    // the alarm must NOT have latched, or a stays-dead monitor would never retry
    expect(__getMonitorRecencyAlarmForTest().downEmitted).toBe(false);

    // now make the dir writable and tick again — the stale must finally land
    rmSync(eventsPath, { force: true });
    runWatchdogTick();
    const stale = readIngestionEvents(getEventLogPath()).filter(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.stale",
    );
    expect(stale).toHaveLength(1);
    expect(__getMonitorRecencyAlarmForTest().downEmitted).toBe(true);
  });
});

describe("boot-seed → first watchdog tick, end-to-end (CTL-1122)", () => {
  test("a boot-time-dead monitor seeded from the log is detected on the first tick", () => {
    const logPath = getEventLogPath();
    mkdirSync(join(dir, "events"), { recursive: true });
    // newest catalyst.monitor beat is already past the down threshold
    writeFileSync(
      logPath,
      JSON.stringify({
        ts: new Date(Date.now() - (TEN_MIN + 60_000)).toISOString(),
        id: "pre-restart-beat",
        resource: { "service.name": "catalyst.monitor" },
      }) + "\n",
    );
    seedLastSeenByService({ logPath });
    runWatchdogTick();
    const evs = readIngestionEvents(logPath).filter(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.stale",
    );
    expect(evs).toHaveLength(1);
    expect(evs[0].caused_by).toBe("pre-restart-beat");
  });

  test("month-boundary: a monitor beat only in the PRIOR month file still seeds (rollover restart)", () => {
    mkdirSync(join(dir, "events"), { recursive: true });
    // current-month file is absent; the last beat lives in the prior month
    writeFileSync(
      getPrevMonthEventLogPath(),
      JSON.stringify({
        ts: new Date(Date.now() - (TEN_MIN + 60_000)).toISOString(),
        id: "prev-month-beat",
        resource: { "service.name": "catalyst.monitor" },
      }) + "\n",
    );
    seedLastSeenByService({ logPath: getEventLogPath() }); // current month missing → prior-month fallback
    expect(__getLastSeenByServiceForTest().get("catalyst.monitor")?.id).toBe("prev-month-beat");
    runWatchdogTick();
    const evs = readIngestionEvents(getEventLogPath()).filter(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.stale",
    );
    expect(evs).toHaveLength(1);
    expect(evs[0].caused_by).toBe("prev-month-beat");
  });
});

describe("github/linear activity-gated recency (CTL-1122 PR2)", () => {
  // These tests open the broker-state DB so hasActiveWorkers (the gate input) is
  // backed by real worker_state rows. The github source is in RECENCY_SOURCES
  // with gated:true; linear is deferred. The file-level beforeEach already set
  // CATALYST_DIR and cleared the recency map.
  beforeEach(() => {
    closeBrokerStateDb(); // defensively close any leaked handle
    openBrokerStateDb(join(dir, "broker-state.db"));
  });
  afterEach(() => {
    closeBrokerStateDb();
  });

  // staleGithubMs: just past the github down threshold.
  const staleGithubMs = GITHUB_RECENCY_DOWN_MS + 60_000;

  function dispatchActiveWorker(ticket = "CTL-1") {
    // a fresh, non-terminal worker row → hasActiveWorkers() === true (gate open)
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket,
      status: "implement",
      eventId: `e-${ticket}`,
      eventTs: new Date().toISOString(),
    });
  }
  function finishWorker(ticket = "CTL-1") {
    // advance the same row to a terminal status → gate closes
    upsertWorkerState({
      orchestrator: "orch-1",
      ticket,
      status: "done",
      eventId: `done-${ticket}`,
      eventTs: new Date().toISOString(),
    });
  }

  test("(a) github silent + worker in-flight → one catalyst.ingestion.stale (label catalyst.github)", () => {
    dispatchActiveWorker();
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - staleGithubMs, id: "gh-old" });
    runWatchdogTick();
    const evs = readIngestionEvents(getEventLogPath());
    expect(evs).toHaveLength(1);
    expect(evs[0].attributes["event.name"]).toBe("catalyst.ingestion.stale");
    expect(evs[0].attributes["event.label"]).toBe(GITHUB_SERVICE_NAME);
    expect(evs[0].caused_by).toBe("gh-old");
    expect(evs[0].body.payload.thresholdMs).toBe(GITHUB_RECENCY_DOWN_MS);

    // edge-triggered: a second tick while still stale + gated-open does not re-emit
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(1);
  });

  test("(b) github silent + NO worker in-flight → gate closed, no emit", () => {
    // no worker rows at all → hasActiveWorkers() false → severity forced up
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - staleGithubMs, id: "gh-old" });
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
    expect(__getRecencyAlarmForTest(GITHUB_SERVICE_NAME).downEmitted).toBe(false);
  });

  test("(b') only terminal workers → gate closed, no github emit", () => {
    finishWorker("DONE"); // a terminal row is not active
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - staleGithubMs, id: "gh-old" });
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
  });

  test("(c) github stale gated-open, then work finishes (gate closes) → paired recovered with duration", () => {
    dispatchActiveWorker();
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - staleGithubMs, id: "gh-old" });
    runWatchdogTick(); // → stale (gate open)
    expect(
      readIngestionEvents(getEventLogPath()).filter(
        (e) => e.attributes["event.name"] === "catalyst.ingestion.stale",
      ),
    ).toHaveLength(1);

    // work finishes → gate closes; github last-seen is left UNCHANGED (still old)
    finishWorker();
    runWatchdogTick(); // gate closed → severity up → recovered
    const rec = readIngestionEvents(getEventLogPath()).find(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.recovered",
    );
    expect(rec).toBeDefined();
    expect(rec.attributes["event.label"]).toBe(GITHUB_SERVICE_NAME);
    expect(rec.body.payload.thresholdMs).toBeNull();
    expect(rec.body.payload.ageMs).toBeGreaterThanOrEqual(0); // outage duration
    // gate-driven clear: no fresh beat cleared it, so the forensic link is null
    // (not the stale pre-silence beat) — the recovered contract for CTL-1123.
    expect(rec.caused_by).toBeNull();
    expect(rec.body.payload.lastSeenAt).toBeNull();
  });

  test("(c') beat-driven recovery (a fresh github event while gated-open) → recovered names the fresh beat", () => {
    dispatchActiveWorker();
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - staleGithubMs, id: "gh-old" });
    runWatchdogTick(); // → stale
    // a fresh github webhook arrives while the fleet is still working
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now(), id: "gh-fresh" });
    runWatchdogTick(); // → recovered, beat-driven
    const rec = readIngestionEvents(getEventLogPath()).find(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.recovered",
    );
    expect(rec).toBeDefined();
    expect(rec.caused_by).toBe("gh-fresh");
    expect(rec.body.payload.ageMs).toBeGreaterThanOrEqual(0);
  });

  test("(d) linear is DEFERRED — a stale catalyst.linear with active work does not alarm", () => {
    dispatchActiveWorker();
    // even far past any plausible threshold, linear is not in RECENCY_SOURCES
    __setLastSeenForTest(LINEAR_SERVICE_NAME, { ts: Date.now() - 3 * 60 * 60_000, id: "lin-old" });
    runWatchdogTick();
    const labels = readIngestionEvents(getEventLogPath()).map((e) => e.attributes["event.label"]);
    expect(labels).not.toContain(LINEAR_SERVICE_NAME);
  });

  test("(e) per-source isolation — monitor and github alarms don't cross-contaminate", () => {
    dispatchActiveWorker();
    __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "mon-old" });
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - staleGithubMs, id: "gh-old" });
    runWatchdogTick();
    const stale = readIngestionEvents(getEventLogPath()).filter(
      (e) => e.attributes["event.name"] === "catalyst.ingestion.stale",
    );
    const labels = stale.map((e) => e.attributes["event.label"]).sort();
    expect(labels).toEqual([GITHUB_SERVICE_NAME, "catalyst.monitor"].sort());
    // each alarm latched in its own per-source state
    expect(__getMonitorRecencyAlarmForTest().downEmitted).toBe(true);
    expect(__getRecencyAlarmForTest(GITHUB_SERVICE_NAME).downEmitted).toBe(true);
  });

  test("(f) github gate open but fresh → no alarm (gating is necessary, not sufficient)", () => {
    dispatchActiveWorker();
    __setLastSeenForTest(GITHUB_SERVICE_NAME, { ts: Date.now() - 60_000, id: "gh-fresh" });
    runWatchdogTick();
    expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
  });
});

describe("kill-switch CATALYST_INGESTION_RECENCY=0 (CTL-1122)", () => {
  test("disabled → an over-down monitor produces no ingestion event", () => {
    const prev = process.env.CATALYST_INGESTION_RECENCY;
    process.env.CATALYST_INGESTION_RECENCY = "0"; // read at call time by isIngestionRecencyEnabled
    try {
      __setLastSeenForTest("catalyst.monitor", { ts: Date.now() - (TEN_MIN + 60_000), id: "beat-old" });
      runWatchdogTick();
      expect(readIngestionEvents(getEventLogPath())).toHaveLength(0);
      expect(__getMonitorRecencyAlarmForTest().downEmitted).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_INGESTION_RECENCY;
      else process.env.CATALYST_INGESTION_RECENCY = prev;
    }
  });
});
