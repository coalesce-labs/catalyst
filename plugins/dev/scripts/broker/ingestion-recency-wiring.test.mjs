// ingestion-recency-wiring.test.mjs — CTL-1122 (PR1). The broker-side wiring:
// the seed warming the last-seen map, processEvent recording recency, and the
// watchdog tick edge-triggering catalyst.ingestion.{stale,recovered}. The pure
// envelope + state-machine units are covered in ingestion-recency.test.mjs.
//
// Time is controlled by planting last-seen timestamps relative to the real
// Date.now() runWatchdogTick reads — no clock injection needed.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEventLogPath } from "./config.mjs";
import {
  runWatchdogTick,
  processEvent,
  seedLastSeenByService,
  __clearIngestionRecencyForTest,
  __setLastSeenForTest,
  __getLastSeenByServiceForTest,
} from "./router.mjs";
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
});
