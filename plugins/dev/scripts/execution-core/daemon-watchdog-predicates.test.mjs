// daemon-watchdog-predicates.test.mjs — CTL-1502. The two disk-only stuck
// predicates (statSync-based, O(1) in DLQ size) + the pure classifyDaemonStuck
// boundary-exact classifier + the target registry. All readers take explicit
// paths so no real ~/catalyst dir is touched.
//
// Run: cd plugins/dev/scripts/execution-core && bun test daemon-watchdog-predicates.test.mjs

import { test, expect, describe } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  openSync,
  ftruncateSync,
  closeSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDlqBytes,
  readLagStuck,
  classifyDaemonStuck,
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

  test("missing file → 0 (non-crossing)", () => {
    const { dir, cleanup } = tmp();
    try {
      expect(readDlqBytes(join(dir, "nope.jsonl"))).toBe(0);
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
