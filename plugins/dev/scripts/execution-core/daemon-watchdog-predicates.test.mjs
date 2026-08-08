// daemon-watchdog-predicates.test.mjs — CTL-1502. The two disk-only stuck
// predicates (statSync-based, O(1) in DLQ size) + the pure classifyDaemonStuck
// boundary-exact classifier + the target registry. All readers take explicit
// paths so no real ~/catalyst dir is touched.
//
// Run: cd plugins/dev/scripts/execution-core && bun test daemon-watchdog-predicates.test.mjs

import { test, expect, describe, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  ftruncateSync,
  closeSync,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDlqBytes,
  readLagStuck,
  classifyDaemonStuck,
  forwarderEventLogPath,
  DAEMON_WATCHDOG_TARGETS,
} from "./daemon-watchdog-predicates.mjs";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "dw-pred-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("classifyDaemonStuck (pure, boundary-exact)", () => {
  test("dlqBytes >= dlqMaxBytes trips 'dlq'; below does not", () => {
    expect(classifyDaemonStuck({ dlqBytes: 100, lagStuck: false }, { dlqMaxBytes: 100 })).toEqual({
      stuck: true,
      tripped: ["dlq"],
    });
    expect(classifyDaemonStuck({ dlqBytes: 99, lagStuck: false }, { dlqMaxBytes: 100 })).toEqual({
      stuck: false,
      tripped: [],
    });
  });

  test("lagStuck true trips 'lag'", () => {
    expect(classifyDaemonStuck({ dlqBytes: 0, lagStuck: true }, { dlqMaxBytes: 100 })).toEqual({
      stuck: true,
      tripped: ["lag"],
    });
  });

  test("both trip → ['dlq','lag'], stuck true", () => {
    expect(classifyDaemonStuck({ dlqBytes: 200, lagStuck: true }, { dlqMaxBytes: 100 })).toEqual({
      stuck: true,
      tripped: ["dlq", "lag"],
    });
  });

  test("null / sentinel readings never trip", () => {
    expect(classifyDaemonStuck({ dlqBytes: null, lagStuck: false }, { dlqMaxBytes: 100 })).toEqual({
      stuck: false,
      tripped: [],
    });
    expect(classifyDaemonStuck(null, null)).toEqual({ stuck: false, tripped: [] });
    // lagStuck must be strictly true — a non-boolean truthy does not trip.
    expect(classifyDaemonStuck({ dlqBytes: 0, lagStuck: "yes" }, { dlqMaxBytes: 100 })).toEqual({
      stuck: false,
      tripped: [],
    });
  });

  test("missing DLQ (null) does NOT trip a dlqMaxBytes:0 threshold — a real 0-byte file does", () => {
    // With dlqMaxBytes:0 a missing DLQ read as 0 would satisfy `0 >= 0` and
    // wedge-restart every host with no DLQ. null (the missing sentinel) is dropped.
    expect(classifyDaemonStuck({ dlqBytes: null, lagStuck: false }, { dlqMaxBytes: 0 })).toEqual({
      stuck: false,
      tripped: [],
    });
    // A genuinely present 0-byte DLQ is a real reading and DOES cross a 0 threshold.
    expect(classifyDaemonStuck({ dlqBytes: 0, lagStuck: false }, { dlqMaxBytes: 0 })).toEqual({
      stuck: true,
      tripped: ["dlq"],
    });
  });
});

describe("readDlqBytes (statSync size, never readFileSync)", () => {
  test("present file → its byte size", () => {
    const { dir, cleanup } = tmp();
    try {
      const p = join(dir, "dlq.jsonl");
      writeFileSync(p, "abcde"); // 5 bytes
      expect(readDlqBytes(p)).toBe(5);
    } finally {
      cleanup();
    }
  });

  test("missing file → null (non-crossing, distinct from a real 0-byte DLQ)", () => {
    const { dir, cleanup } = tmp();
    try {
      expect(readDlqBytes(join(dir, "nope.jsonl"))).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("real empty file → 0 (a genuine 0-byte DLQ, NOT the missing sentinel)", () => {
    const { dir, cleanup } = tmp();
    try {
      const p = join(dir, "empty.jsonl");
      writeFileSync(p, "");
      expect(readDlqBytes(p)).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("large (>2GB) sparse file → size with NO RangeError (statSync, not readFileSync)", () => {
    const { dir, cleanup } = tmp();
    try {
      const p = join(dir, "huge.jsonl");
      const fd = openSync(p, "w");
      const THREE_GB = 3 * 1024 * 1024 * 1024;
      ftruncateSync(fd, THREE_GB); // sparse — no bytes actually written
      closeSync(fd);
      expect(readDlqBytes(p)).toBe(THREE_GB);
    } finally {
      cleanup();
    }
  });
});

// Codex P1 regression: on a fresh install (and on a legacy checkpoint)
// lastForwardedTs is absent until the FIRST batch is delivered. Before the fix
// this predicate returned false unconditionally in that state, so a forwarder
// that wedged before its first success was invisible here no matter how far the
// event log ran ahead — only a 1 GiB DLQ could trip the watchdog.
describe("readLagStuck cold start (no lastForwardedTs yet)", () => {
  const NOW = Date.parse("2026-07-23T12:00:00.000Z");
  const STALE = 900_000; // 15 min

  // The checkpoint's CREATION time stands in for "forwarding started here".
  // Node reports birthtimeMs from the real file, so age it by writing the file
  // and comparing against a `now` far enough in its future.
  function coldSetup({ eventLogMtimeMs, payload }) {
    const { dir, cleanup } = tmp();
    const checkpointPath = join(dir, "checkpoint.json");
    const eventLogPath = join(dir, "events.jsonl");
    writeFileSync(checkpointPath, JSON.stringify(payload));
    writeFileSync(eventLogPath, "x");
    if (eventLogMtimeMs != null) {
      const t = new Date(eventLogMtimeMs);
      utimesSync(eventLogPath, t, t);
    }
    const birthMs = statSync(checkpointPath).birthtimeMs;
    return { checkpointPath, eventLogPath, birthMs, cleanup };
  }

  for (const [label, payload] of [
    ["absent", {}],
    ["null", { lastForwardedTs: null }],
    ["unparseable", { lastForwardedTs: "not-a-date" }],
  ]) {
    test(`${label} lastForwardedTs + backlog older than stalenessMs → true`, () => {
      const { checkpointPath, eventLogPath, birthMs, cleanup } = coldSetup({
        payload,
        // Backlog: the log was written AFTER the checkpoint was created.
        eventLogMtimeMs: Date.now() + 1_000,
      });
      try {
        // `now` far enough past the checkpoint's birth to exceed stalenessMs.
        const now = birthMs + STALE + 60_000;
        expect(
          readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now }),
        ).toBe(true);
      } finally {
        cleanup();
      }
    });
  }

  test("cold start still within stalenessMs → false (no premature trip)", () => {
    const { checkpointPath, eventLogPath, birthMs, cleanup } = coldSetup({
      payload: {},
      eventLogMtimeMs: Date.now() + 1_000,
    });
    try {
      const now = birthMs + 1_000; // 1s in — nowhere near the 15 min threshold
      expect(
        readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now }),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("cold start with NO backlog → false (idle host never trips)", () => {
    const { checkpointPath, eventLogPath, birthMs, cleanup } = coldSetup({
      payload: {},
      eventLogMtimeMs: NOW - 10 * 86_400_000, // log untouched long before the checkpoint
    });
    try {
      const now = birthMs + STALE + 60_000;
      expect(
        readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now }),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("missing checkpoint file → false (non-crossing, unchanged)", () => {
    const { dir, cleanup } = tmp();
    try {
      expect(
        readLagStuck({
          checkpointPath: join(dir, "nope.json"),
          eventLogPath: join(dir, "events.jsonl"),
          stalenessMs: STALE,
          now: NOW,
        }),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("readLagStuck (frozen lastForwardedTs WITH fresh backlog)", () => {
  const NOW = Date.parse("2026-07-23T12:00:00.000Z");
  const STALE = 900_000; // 15 min

  function setup({ lastForwardedTs, eventLogMtimeMs, writeCheckpoint = true }) {
    const { dir, cleanup } = tmp();
    const checkpointPath = join(dir, "checkpoint.json");
    const eventLogPath = join(dir, "events.jsonl");
    if (writeCheckpoint) writeFileSync(checkpointPath, JSON.stringify({ lastForwardedTs }));
    // Write the event log and force a known mtime.
    writeFileSync(eventLogPath, "x");
    if (eventLogMtimeMs != null) {
      const t = new Date(eventLogMtimeMs);
      utimesSync(eventLogPath, t, t); // set both atime + mtime to a known instant
    }
    return { dir, checkpointPath, eventLogPath, cleanup };
  }

  test("stale lastForwardedTs AND fresh backlog → true", () => {
    const last = new Date(NOW - STALE - 60_000).toISOString(); // 16 min ago
    const { checkpointPath, eventLogPath, cleanup } = setup({
      lastForwardedTs: last,
      eventLogMtimeMs: NOW - 30_000, // event log written 30s ago (after last forward)
    });
    try {
      expect(
        readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now: NOW }),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("fresh lastForwardedTs → false (not stale)", () => {
    const last = new Date(NOW - 10_000).toISOString(); // 10s ago
    const { checkpointPath, eventLogPath, cleanup } = setup({
      lastForwardedTs: last,
      eventLogMtimeMs: NOW - 5_000,
    });
    try {
      expect(
        readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now: NOW }),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("NO backlog (event log older than lastForwardedTs) → false (idle forwarder)", () => {
    const last = new Date(NOW - STALE - 60_000).toISOString(); // stale
    const { checkpointPath, eventLogPath, cleanup } = setup({
      lastForwardedTs: last,
      eventLogMtimeMs: NOW - STALE - 120_000, // event log even older → no new work
    });
    try {
      expect(
        readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now: NOW }),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("missing checkpoint → false (non-crossing)", () => {
    const { checkpointPath, eventLogPath, cleanup } = setup({
      lastForwardedTs: null,
      eventLogMtimeMs: NOW,
      writeCheckpoint: false,
    });
    try {
      expect(
        readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now: NOW }),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("unparseable lastForwardedTs → false", () => {
    const { dir, cleanup } = tmp();
    try {
      const checkpointPath = join(dir, "c.json");
      const eventLogPath = join(dir, "e.jsonl");
      writeFileSync(checkpointPath, JSON.stringify({ lastForwardedTs: "not-a-date" }));
      writeFileSync(eventLogPath, "x");
      expect(
        readLagStuck({ checkpointPath, eventLogPath, stalenessMs: STALE, now: NOW }),
      ).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("DAEMON_WATCHDOG_TARGETS registry", () => {
  test("registers exactly one target: otel-forward, with resolved paths + restartArgs", () => {
    expect(DAEMON_WATCHDOG_TARGETS).toHaveLength(1);
    const t = DAEMON_WATCHDOG_TARGETS[0];
    expect(t.name).toBe("otel-forward");
    expect(t.dlqPath).toContain("otel-forward-dlq-otlp.jsonl");
    expect(t.checkpointPath).toContain("otel-forward.checkpoint.json");
    expect(t.restartArgs).toEqual(["forward-restart"]);
  });
});

describe("forwarderEventLogPath (matches otel-forward's tail target)", () => {
  const saved = { dir: process.env.CATALYST_DIR, events: process.env.CATALYST_EVENTS_DIR };
  afterEach(() => {
    if (saved.dir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = saved.dir;
    if (saved.events === undefined) delete process.env.CATALYST_EVENTS_DIR;
    else process.env.CATALYST_EVENTS_DIR = saved.events;
  });

  function ym() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  test("defaults to $CATALYST_DIR/events/<UTC-month>.jsonl", () => {
    process.env.CATALYST_DIR = "/tmp/cat-x";
    delete process.env.CATALYST_EVENTS_DIR;
    expect(forwarderEventLogPath()).toBe(`/tmp/cat-x/events/${ym()}.jsonl`);
  });

  test("honors CATALYST_EVENTS_DIR override (mirrors otel-forward/index.ts)", () => {
    process.env.CATALYST_DIR = "/tmp/cat-x";
    process.env.CATALYST_EVENTS_DIR = "/mnt/elsewhere/events";
    expect(forwarderEventLogPath()).toBe(`/mnt/elsewhere/events/${ym()}.jsonl`);
  });
});
