// drop-surface.test.ts — CTL-1818. The host-local surface that makes a DISCARDED event
// visible, and the sustained-loss alert built on it.
//
// Why this surface cannot be an event consumer: `emitDrop` already writes
// `catalyst.observability.forward_dropped` to the event log — and that event is then
// forwarded through the very path that just discarded something. An alarm sourced from the
// forwarded stream measures the SURVIVORS and reads clean during exactly the outage it
// exists to detect. So the assertions below are all about state that lives on THIS host:
// process-exact counters, a durable marker under ~/catalyst/, and the daemon's pino log
// (which Alloy ships independently of otel-forward's OTLP egress).
//
// Run: cd plugins/dev/scripts/otel-forward && bun test lib/drop-surface.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DropBucket } from "./drop-surface.ts";
import {
  DROP_SURFACE_DEFAULTS,
  buildDropMarker,
  classifyDropWindow,
  configureDropSurface,
  dropSurfaceSnapshot,
  evaluateDropSurface,
  getDropMarkerPath,
  recordDrop,
  resetDropSurfaceForTest,
  resolveDropSurfaceConfig,
} from "./drop-surface.ts";

// A pino-shaped recorder so the alarm sink can be asserted without writing a real log.
function makeLog() {
  const calls: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const mk = (level: string) => (obj: Record<string, unknown>, msg: string) =>
    calls.push({ level, obj, msg });
  return { calls, warn: mk("warn"), error: mk("error"), info: mk("info") };
}

const CFG = { windowMs: 60_000, thresholdRecords: 100, sustainMs: 30_000 };

describe("classifyDropWindow — the pure sustained-rate classifier", () => {
  const bucket = (startMs: number, records: number, reason = "aged"): [number, DropBucket] => [
    startMs,
    { records, byReason: { [reason]: records } },
  ];

  test("under the threshold is not a breach", () => {
    const v = classifyDropWindow([bucket(1_000, 99)], CFG, 10_000, null);
    expect(v.windowRecords).toBe(99);
    expect(v.breaching).toBe(false);
    expect(v.breachSinceMs).toBeNull();
    expect(v.sustained).toBe(false);
  });

  test("the threshold is inclusive (boundary-exact >=, mirroring classifyDaemonStuck)", () => {
    const v = classifyDropWindow([bucket(1_000, 100)], CFG, 10_000, null);
    expect(v.breaching).toBe(true);
    expect(v.breachSinceMs).toBe(10_000); // breach starts now when there was no prior breach
    expect(v.sustained).toBe(false); // ...but has not yet lasted the sustain window
  });

  test("a breach shorter than the sustain window does NOT alert", () => {
    const v = classifyDropWindow([bucket(1_000, 500)], CFG, 20_000, 1_000);
    expect(v.breaching).toBe(true);
    expect(v.sustainedMs).toBe(19_000);
    expect(v.sustained).toBe(false);
  });

  test("a breach that persists for the sustain window alerts, and names the reason", () => {
    const v = classifyDropWindow(
      [bucket(1_000, 400, "aged"), bucket(2_000, 10, "terminal_4xx")],
      CFG,
      31_000,
      1_000,
    );
    expect(v.sustained).toBe(true);
    expect(v.topReason).toBe("aged");
    expect(v.byReason).toEqual({ aged: 400, terminal_4xx: 10 });
  });

  test("records outside the rolling window are excluded — an old storm cannot alert forever", () => {
    // Bucket at t=1s, window 60s, now = 5 minutes later.
    const v = classifyDropWindow([bucket(1_000, 10_000)], CFG, 300_000, 1_000);
    expect(v.windowRecords).toBe(0);
    expect(v.breaching).toBe(false);
    expect(v.breachSinceMs).toBeNull(); // the breach is forgotten, so a later one is a new episode
  });

  test("a non-finite or negative count contributes 0 — a garbage reading never fabricates a breach", () => {
    const v = classifyDropWindow(
      [bucket(1_000, Number.NaN), bucket(2_000, -5_000)],
      CFG,
      10_000,
      null,
    );
    expect(v.windowRecords).toBe(0);
    expect(v.breaching).toBe(false);
  });

  test("no buckets at all is not a breach (an empty input must not read as clean-by-vacuity elsewhere)", () => {
    const v = classifyDropWindow([], CFG, 10_000, 1_000);
    expect(v.windowRecords).toBe(0);
    expect(v.breaching).toBe(false);
    expect(v.topReason).toBeNull();
  });
});

describe("resolveDropSurfaceConfig — env > file > frozen default", () => {
  const KEYS = [
    "CATALYST_FORWARD_DROP_WINDOW_MS",
    "CATALYST_FORWARD_DROP_THRESHOLD_RECORDS",
    "CATALYST_FORWARD_DROP_SUSTAIN_MS",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("defaults when nothing is supplied", () => {
    expect(resolveDropSurfaceConfig()).toEqual({ ...DROP_SURFACE_DEFAULTS });
  });

  test("a file value overrides the default and env overrides the file", () => {
    expect(resolveDropSurfaceConfig({ thresholdRecords: 7 }).thresholdRecords).toBe(7);
    process.env.CATALYST_FORWARD_DROP_THRESHOLD_RECORDS = "42";
    expect(resolveDropSurfaceConfig({ thresholdRecords: 7 }).thresholdRecords).toBe(42);
  });

  test("a malformed override is ignored rather than disabling the surface", () => {
    process.env.CATALYST_FORWARD_DROP_WINDOW_MS = "not-a-number";
    expect(resolveDropSurfaceConfig().windowMs).toBe(DROP_SURFACE_DEFAULTS.windowMs);
    process.env.CATALYST_FORWARD_DROP_WINDOW_MS = "0"; // a zero-length window can never breach
    expect(resolveDropSurfaceConfig().windowMs).toBe(DROP_SURFACE_DEFAULTS.windowMs);
  });
});

describe("recordDrop — exact counters + a durable host-local marker", () => {
  let dir: string;
  let markerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drop-surface-"));
    markerPath = join(dir, "otel-forward-drops.json");
    resetDropSurfaceForTest();
    configureDropSurface(CFG);
  });
  afterEach(() => {
    resetDropSurfaceForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  const readMarker = () => JSON.parse(readFileSync(markerPath, "utf8"));

  test("counts EVERY drop exactly, per reason, in both events and records", () => {
    const log = makeLog();
    let t = 1_000;
    for (let i = 0; i < 250; i++) recordDrop("aged", 3, { markerPath, log, now: () => (t += 10) });
    recordDrop("terminal_4xx", 7, { markerPath, log, now: () => t });

    const snap = dropSurfaceSnapshot();
    expect(snap.totals.aged).toEqual({ events: 250, records: 750 });
    expect(snap.totals.terminal_4xx).toEqual({ events: 1, records: 7 });
  });

  test("the alarm is SPARSE even though the counter is exact (the CTL-1817 discipline)", () => {
    const log = makeLog();
    let t = 1_000;
    for (let i = 0; i < 250; i++) recordDrop("aged", 1, { markerPath, log, now: () => (t += 10) });
    // First occurrence + log10 heartbeats at 10/100 → far fewer lines than records.
    const warns = log.calls.filter((c) => c.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.length).toBeLessThan(10);
    expect(dropSurfaceSnapshot().totals.aged.events).toBe(250);
  });

  test("writes an operator-readable marker naming the host, reason and counts", () => {
    const log = makeLog();
    recordDrop("aged", 12, { markerPath, log, now: () => 5_000 });
    expect(existsSync(markerPath)).toBe(true);
    const m = readMarker();
    expect(m.daemon).toBe("otel-forward");
    expect(typeof m.host).toBe("string");
    expect(m.host.length).toBeGreaterThan(0);
    expect(m.process.aged).toEqual({ events: 1, records: 12 });
    expect(m.cumulative.aged.records).toBe(12);
    expect(m.lastDrop.reason).toBe("aged");
    expect(m.window.windowMs).toBe(CFG.windowMs);
    expect(m.alert.raised).toBe(false);
  });

  test("cumulative totals carry across a restart; process totals do not", () => {
    const log = makeLog();
    recordDrop("aged", 40, { markerPath, log, now: () => 1_000 });
    // Simulate a daemon restart: process state resets, the marker on disk does not.
    resetDropSurfaceForTest();
    configureDropSurface(CFG);
    recordDrop("aged", 2, { markerPath, log, now: () => 2_000 });

    const m = readMarker();
    expect(m.process.aged.records).toBe(2); // this process only
    expect(m.cumulative.aged.records).toBe(42); // carried 40 + 2
  });

  test("never throws when the marker cannot be written — a tap is never load-bearing", () => {
    const log = makeLog();
    // A regular file where a directory would have to be — mkdir/rename cannot succeed here.
    writeFileSync(join(dir, "not-a-dir-file"), "x");
    const unwritable = join(dir, "not-a-dir-file", "drops.json");
    expect(() =>
      recordDrop("aged", 1, { markerPath: unwritable, log, now: () => 1_000 }),
    ).not.toThrow();
    // The in-memory counter is still exact — the file is the convenience, not the measurement.
    expect(dropSurfaceSnapshot().totals.aged.events).toBe(1);
  });
});

describe("sustained-loss alert — raised, latched, then cleared", () => {
  let dir: string;
  let markerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "drop-alert-"));
    markerPath = join(dir, "otel-forward-drops.json");
    resetDropSurfaceForTest();
    configureDropSurface(CFG); // window 60s, threshold 100 records, sustain 30s
  });
  afterEach(() => {
    resetDropSurfaceForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  const readMarker = () => JSON.parse(readFileSync(markerPath, "utf8"));

  test("a sustained breach raises exactly one alert naming the host and the reason", () => {
    const log = makeLog();
    // t=1s: cross the threshold. Not yet sustained.
    recordDrop("aged", 150, { markerPath, log, now: () => 1_000 });
    expect(readMarker().alert.raised).toBe(false);
    expect(log.calls.filter((c) => c.level === "error").length).toBe(0);

    // t=40s: still breaching (both drops inside the 60s window), 39s > 30s sustain.
    recordDrop("aged", 150, { markerPath, log, now: () => 40_000 });
    const errors = log.calls.filter((c) => c.level === "error");
    expect(errors.length).toBe(1);
    expect(errors[0].obj.reason).toBe("aged");
    expect(typeof errors[0].obj.host).toBe("string");

    const m = readMarker();
    expect(m.alert.raised).toBe(true);
    expect(m.alert.reason).toBe("aged");

    // t=41s: still breaching — the alert must not re-fire per record (latched episode).
    recordDrop("aged", 150, { markerPath, log, now: () => 41_000 });
    expect(log.calls.filter((c) => c.level === "error").length).toBe(1);
  });

  test("the alert clears once the window drains — evaluated even when no new drop arrives", () => {
    const log = makeLog();
    recordDrop("aged", 150, { markerPath, log, now: () => 1_000 });
    recordDrop("aged", 150, { markerPath, log, now: () => 40_000 });
    expect(readMarker().alert.raised).toBe(true);

    // No further drops. The lag timer's periodic evaluation is what clears the episode —
    // without it the marker would latch "raised" forever on a host that has recovered.
    evaluateDropSurface({ markerPath, log, now: () => 200_000 });
    const m = readMarker();
    expect(m.alert.raised).toBe(false);
    expect(m.window.records).toBe(0);
    expect(log.calls.filter((c) => c.level === "info").length).toBe(1);
  });
});

describe("buildDropMarker — the shape an operator reads", () => {
  test("carries host, pid, per-reason totals and the live window verdict", () => {
    const marker = buildDropMarker({
      nowIso: "2026-08-13T12:00:00.000Z",
      host: "mini",
      pid: 4242,
      startedAt: "2026-08-13T11:00:00.000Z",
      cfg: CFG,
      totals: { aged: { events: 3, records: 300 } },
      carried: { aged: { events: 1, records: 100 } },
      verdict: {
        windowRecords: 300,
        byReason: { aged: 300 },
        topReason: "aged",
        breaching: true,
        breachSinceMs: 1_000,
        sustainedMs: 5_000,
        sustained: false,
      },
      alert: { raised: false, sinceIso: null, reason: null },
      lastDrop: { ts: "2026-08-13T12:00:00.000Z", reason: "aged", count: 100 },
    });

    expect(marker.host).toBe("mini");
    expect(marker.pid).toBe(4242);
    expect(marker.cumulative.aged).toEqual({ events: 4, records: 400 });
    expect(marker.window.records).toBe(300);
    expect(marker.window.thresholdRecords).toBe(CFG.thresholdRecords);
    expect(marker.window.breaching).toBe(true);
  });
});

describe("getDropMarkerPath — resolved per call so a pinned CATALYST_DIR is honored", () => {
  test("lives beside the checkpoint and the DLQ under CATALYST_DIR", () => {
    const saved = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = "/tmp/ctl1818-marker-dir";
    expect(getDropMarkerPath()).toBe("/tmp/ctl1818-marker-dir/otel-forward-drops.json");
    if (saved === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = saved;
  });
});
