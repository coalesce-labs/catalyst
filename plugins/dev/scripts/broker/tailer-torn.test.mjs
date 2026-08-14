// CTL-1809: the broker's LIVE event-log tail must COUNT a torn line, not drop it silently.
// Run: bun test plugins/dev/scripts/broker/tailer-torn.test.mjs
//
// The broker is the load-bearing reader of ~/catalyst/events/YYYY-MM.jsonl: every
// filter.wake, every phase-lifecycle terminal, the ingestion-recency map and the worker-state
// projection all come off this one loop. Its BOOT replay goes through
// execution-core/event-tail.mjs (counted since CTL-1809), but readNewEvents hand-rolls its own
// read loop and its `catch { continue; }` was silent — so the counted half ran once per
// process and the uncounted half ran for the process's whole life.
//
// The survivor assertion is deliberately NOT a mock. It observes processEvent's real
// recordLastSeen fold (__getLastSeenByServiceForTest), so "the events either side of the torn
// line still reached the router" is measured at the router, not at a stub the test wrote.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedTailer, readNewEvents } from "./tailer.mjs";
import { __clearIngestionRecencyForTest, __getLastSeenByServiceForTest } from "./router.mjs";
import { getEventLogPath } from "./config.mjs";
import { tornLineCount, resetTornLineCount } from "../execution-core/event-tail.mjs";

let tmpDir;
let logPath;
let stderrChunks;
let realStderrWrite;

// One valid v2 envelope. `resource["service.name"]` + a parseable `ts` are exactly what
// recordLastSeen keys on, which is what makes arrival at the router observable.
function envelope(service, ts) {
  return JSON.stringify({
    ts,
    attributes: { "event.name": "catalyst.test.tailer-torn" },
    resource: { "service.name": service },
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-tailer-torn-"));
  process.env.CATALYST_DIR = tmpDir;
  logPath = getEventLogPath();
  mkdirSync(join(tmpDir, "events"), { recursive: true });
  __clearIngestionRecencyForTest();
  resetTornLineCount();
  // Capture stderr rather than let the warning escape into the suite output.
  stderrChunks = [];
  realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  process.stderr.write = realStderrWrite;
  resetTornLineCount();
  __clearIngestionRecencyForTest();
  rmSync(tmpDir, { recursive: true, force: true });
  // CTL-1086: restore to the hermetic preload value rather than deleting.
  const hermetic = process.env.CATALYST_HERMETIC_DIR;
  if (hermetic) {
    process.env.CATALYST_DIR = hermetic;
  } else {
    delete process.env.CATALYST_DIR;
  }
});

// Seed the tailer onto this test's log at offset 0, then drain it once. readNewEvents
// short-circuits (and only re-seeds the offset) when logPath !== lastLogPath, so the path
// must be seeded before the drain or the first call reads nothing.
function drainFrom(contents) {
  writeFileSync(logPath, contents);
  seedTailer({ logPath, byteOffset: 0 });
  readNewEvents();
}

describe("CTL-1809 — broker live tail counts torn lines", () => {
  test("a torn line between two valid events is counted, and both survivors still route", () => {
    expect(tornLineCount()).toBe(0); // positive control: the counter starts cold.

    drainFrom(
      `${envelope("catalyst.before-torn", "2026-08-13T00:00:00.000Z")}\n` +
        `TORN{"attributes":{"event.na\n` +
        `${envelope("catalyst.after-torn", "2026-08-13T00:00:01.000Z")}\n`
    );

    // The tear is now audible.
    expect(tornLineCount()).toBe(1);

    // …and it did not swallow the batch. Measured at the router's own last-seen fold.
    const seen = __getLastSeenByServiceForTest();
    expect(seen.has("catalyst.before-torn")).toBe(true);
    expect(seen.has("catalyst.after-torn")).toBe(true);
  });

  test("the drop is operator-visible on stderr, naming the counter", () => {
    drainFrom(`NOT JSON AT ALL\n`);

    expect(tornLineCount()).toBe(1);
    const err = stderrChunks.join("");
    expect(err).toContain("TORN event-log line");
    expect(err).toContain("torn_lines_total=1");
  });

  test("a clean batch counts zero — the detector is not counting healthy lines", () => {
    // The negative control for the two cases above: if this ever counted, `1` would prove
    // nothing about torn lines specifically.
    drainFrom(
      `${envelope("catalyst.clean-a", "2026-08-13T00:00:00.000Z")}\n` +
        `${envelope("catalyst.clean-b", "2026-08-13T00:00:01.000Z")}\n`
    );

    expect(tornLineCount()).toBe(0);
    expect(__getLastSeenByServiceForTest().has("catalyst.clean-b")).toBe(true);
  });

  test("a trailing partial line is NOT counted — it is an in-flight write, not damage", () => {
    // readNewEvents pops the trailing partial into leftoverBuf and never parses it. Counting
    // it would make the detector alarm on every healthy actively-written log, which is a
    // detector nobody reads. Same carve-out as scanEventsChunked's `carry`.
    drainFrom(
      `${envelope("catalyst.complete", "2026-08-13T00:00:00.000Z")}\n` + `{"attributes":{"eve`
    );

    expect(tornLineCount()).toBe(0);
    expect(__getLastSeenByServiceForTest().has("catalyst.complete")).toBe(true);
  });
});
