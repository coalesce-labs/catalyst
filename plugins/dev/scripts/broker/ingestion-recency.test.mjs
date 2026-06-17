// ingestion-recency.test.mjs — CTL-1122 (PR1). Spec for the broker-side
// ingestion-silence alarm: the envelope factory + the edge-trigger/holddown
// state machine. Pure units — no time injection needed beyond the explicit
// nowMs/now seams.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildIngestionRecencyEnvelope,
  emitIngestionRecencyEvent,
  initialRecencyAlarmState,
  nextRecencyAlarmState,
  INGESTION_STALE,
  INGESTION_RECOVERED,
  MONITOR_SERVICE_NAME,
} from "./ingestion-recency.mjs";

const FIXED = () => "2026-06-16T18:00:00Z";

describe("buildIngestionRecencyEnvelope (CTL-1122)", () => {
  test("stale: ERROR envelope keyed for the silent source with caused_by", () => {
    const ev = buildIngestionRecencyEnvelope(
      {
        action: "stale",
        sourceName: MONITOR_SERVICE_NAME,
        ageMs: 720_000,
        thresholdMs: 600_000,
        lastSeenAt: "2026-06-16T17:48:00Z",
        causedBy: "evt-last-monitor-beat",
      },
      { now: FIXED },
    );
    expect(ev.attributes["event.name"]).toBe(INGESTION_STALE);
    expect(ev.attributes["event.name"]).toBe("catalyst.ingestion.stale");
    expect(ev.attributes["event.entity"]).toBe("ingestion");
    expect(ev.attributes["event.action"]).toBe("stale");
    // the SILENT source goes in event.label — not the broker (the emitter).
    expect(ev.attributes["event.label"]).toBe("catalyst.monitor");
    expect(ev.severityText).toBe("ERROR");
    expect(ev.severityNumber).toBe(17);
    // emitter identity is the broker (the surviving observer).
    expect(ev.resource["service.name"]).toBe("catalyst.broker");
    expect(ev.resource["host.name"]).toBeDefined();
    // forensic link to the last beat we saw.
    expect(ev.caused_by).toBe("evt-last-monitor-beat");
    // ages live in the payload, not the name.
    expect(ev.body.payload).toEqual({
      source: "catalyst.monitor",
      ageMs: 720_000,
      thresholdMs: 600_000,
      lastSeenAt: "2026-06-16T17:48:00Z",
    });
    expect(ev.ts).toBe("2026-06-16T18:00:00Z");
    expect(ev.id).toMatch(/[0-9a-f-]{8,}/);
  });

  test("recovered: INFO envelope, distinct event name", () => {
    const ev = buildIngestionRecencyEnvelope(
      { action: "recovered", sourceName: MONITOR_SERVICE_NAME, causedBy: "evt-fresh-beat" },
      { now: FIXED },
    );
    expect(ev.attributes["event.name"]).toBe(INGESTION_RECOVERED);
    expect(ev.attributes["event.action"]).toBe("recovered");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
    expect(ev.caused_by).toBe("evt-fresh-beat");
  });

  test("caused_by defaults to null when the source was never observed", () => {
    const ev = buildIngestionRecencyEnvelope({ action: "stale", sourceName: "x" }, { now: FIXED });
    expect(ev.caused_by).toBeNull();
    expect(ev.body.payload.ageMs).toBeNull();
  });
});

describe("emitIngestionRecencyEvent (CTL-1122)", () => {
  test("appends a single JSON line to the log and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "ingestion-recency-"));
    const logPath = join(dir, "events.jsonl");
    try {
      const ok = emitIngestionRecencyEvent(
        { action: "stale", sourceName: MONITOR_SERVICE_NAME, causedBy: "c1" },
        { logPath, now: FIXED },
      );
      expect(ok).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.attributes["event.name"]).toBe(INGESTION_STALE);
      expect(parsed.caused_by).toBe("c1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never throws + returns false on an unwritable path", () => {
    // A directory that cannot be created (a file masquerading as a parent dir).
    const dir = mkdtempSync(join(tmpdir(), "ingestion-recency-"));
    const notADir = join(dir, "iam-a-file");
    rmSync(notADir, { force: true });
    writeFileSync(notADir, "x");
    try {
      const ok = emitIngestionRecencyEvent(
        { action: "stale", sourceName: "x" },
        { logPath: join(notADir, "nested", "events.jsonl"), now: FIXED },
      );
      expect(ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nextRecencyAlarmState — edge-trigger + holddown (CTL-1122)", () => {
  const step = (state, severity, nowMs, opts = {}) =>
    nextRecencyAlarmState(state, { severity, nowMs, holddownMs: 600_000, recoveryHoldMs: 0, ...opts });

  test("first sustained down → stale (once), re-down → no re-emit", () => {
    let st = initialRecencyAlarmState();
    let r = step(st, "down", 1_000);
    expect(r.emit).toBe("stale");
    expect(r.state.downEmitted).toBe(true);

    r = step(r.state, "down", 61_000);
    expect(r.emit).toBeNull(); // already alarming — no spam
    expect(r.state.downEmitted).toBe(true);
  });

  test("down → up → recovered (paired), then clean stays silent", () => {
    let r = step(initialRecencyAlarmState(), "down", 1_000);
    expect(r.emit).toBe("stale");
    r = step(r.state, "up", 61_000);
    expect(r.emit).toBe("recovered");
    expect(r.state.downEmitted).toBe(false);
    expect(r.state.recoveredAt).toBe(61_000);
    r = step(r.state, "up", 121_000);
    expect(r.emit).toBeNull();
  });

  test("degraded mid-outage holds the alarm open; only clean up recovers", () => {
    let r = step(initialRecencyAlarmState(), "down", 1_000);
    expect(r.emit).toBe("stale");
    r = step(r.state, "degraded", 61_000);
    expect(r.emit).toBeNull();
    expect(r.state.downEmitted).toBe(true); // still in outage
    r = step(r.state, "up", 121_000);
    expect(r.emit).toBe("recovered");
  });

  test("unknown (never-seen / read error) never alarms — fail-open", () => {
    let r = step(initialRecencyAlarmState(), "unknown", 1_000);
    expect(r.emit).toBeNull();
    expect(r.state.downEmitted).toBe(false);
    // and a clean source likewise stays silent
    r = step(r.state, "up", 2_000);
    expect(r.emit).toBeNull();
  });

  test("holddown suppresses a flap but DEFERS — a sustained death still alarms", () => {
    // outage → recovered at t=61s
    let r = step(initialRecencyAlarmState(), "down", 1_000);
    r = step(r.state, "up", 61_000);
    expect(r.emit).toBe("recovered");

    // dies again 2 min later — within the 10 min holddown → suppressed AND deferred
    r = step(r.state, "down", 181_000);
    expect(r.emit).toBeNull();
    expect(r.state.downEmitted).toBe(false); // NOT latched — re-checked next tick

    // still down just before the holddown expires → still suppressed
    r = step(r.state, "down", 660_000); // 61s + 600s holddown = 661s; 660s < that
    expect(r.emit).toBeNull();

    // holddown elapsed (>= 661s) → the real death finally alarms (never masked)
    r = step(r.state, "down", 662_000);
    expect(r.emit).toBe("stale");
    expect(r.state.downEmitted).toBe(true);
  });

  test("a flap fully contained within the holddown is suppressed — no stale, no recovered", () => {
    // outage → recovered at t=61s
    let r = step(initialRecencyAlarmState(), "down", 1_000);
    r = step(r.state, "up", 61_000);
    expect(r.emit).toBe("recovered");
    // dies again within the 10 min holddown → deferred (no stale)
    r = step(r.state, "down", 120_000);
    expect(r.emit).toBeNull();
    expect(r.state.downEmitted).toBe(false);
    // ...and self-heals before the holddown expires → no recovered either (nothing was latched)
    r = step(r.state, "up", 180_000);
    expect(r.emit).toBeNull();
    expect(r.state.downEmitted).toBe(false);
  });

  test("recoveryHoldMs requires sustained up before recovered", () => {
    let r = step(initialRecencyAlarmState(), "down", 1_000, { recoveryHoldMs: 60_000 });
    expect(r.emit).toBe("stale");
    // first up — starts the recovery clock, not yet long enough
    r = step(r.state, "up", 30_000, { recoveryHoldMs: 60_000 });
    expect(r.emit).toBeNull();
    expect(r.state.upHoldSince).toBe(30_000);
    // a flap back to down resets the recovery clock
    r = step(r.state, "down", 40_000, { recoveryHoldMs: 60_000 });
    expect(r.emit).toBeNull();
    expect(r.state.upHoldSince).toBeNull();
    // sustained up past the hold → recovered
    r = step(r.state, "up", 50_000, { recoveryHoldMs: 60_000 });
    expect(r.emit).toBeNull();
    r = step(r.state, "up", 115_000, { recoveryHoldMs: 60_000 });
    expect(r.emit).toBe("recovered");
  });
});
