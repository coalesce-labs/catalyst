// daemon-watchdog-alert.test.mjs — CTL-1502. The out-of-band alert + recovery
// finding emitter. Three sinks (daemon pino log, marker file, best-effort event
// log) ordered by load-bearing-ness; every fn best-effort (never throws). A
// parity assertion pins the local envelope's event.name/entity/label to
// broker/alert-emit.mjs's constants so a rename there can't silently drift us.
//
// Run: cd plugins/dev/scripts/execution-core && bun test daemon-watchdog-alert.test.mjs

import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  raiseAlert,
  clearAlert,
  escalate,
  buildDaemonAlertEnvelope,
  DAEMON_STUCK_KIND,
} from "./daemon-watchdog-alert.mjs";

// Parity pin WITHOUT importing broker code at runtime (broker/config.mjs
// hard-requires pino, absent in this worktree; exec-core must not depend on
// broker either way). Scan broker/alert-emit.mjs's SOURCE for the two constant
// literals — a rename there fails this test just as a runtime import would.
const __dir = dirname(fileURLToPath(import.meta.url));
const ALERT_EMIT_SRC = readFileSync(join(__dir, "..", "broker", "alert-emit.mjs"), "utf8");
function constLiteral(name) {
  const m = new RegExp(`export const ${name} = "([^"]+)"`).exec(ALERT_EMIT_SRC);
  if (!m) throw new Error(`parity: ${name} not found in broker/alert-emit.mjs`);
  return m[1];
}
const ALERT_RAISED = constLiteral("ALERT_RAISED");
const ALERT_CLEARED = constLiteral("ALERT_CLEARED");

const TARGET = { name: "otel-forward" };

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "dw-alert-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Recording log + finding runner + fixed clock.
function makeIo(dir) {
  const calls = { log: [], findings: [] };
  return {
    io: {
      log: {
        error: (o, m) => calls.log.push(["error", o, m]),
        warn: (o, m) => calls.log.push(["warn", o, m]),
        info: (o, m) => calls.log.push(["info", o, m]),
      },
      logPath: join(dir, "events.jsonl"),
      markerDir: join(dir, "watchdog"),
      runFinding: (args) => calls.findings.push(args),
      now: () => "2026-07-23T12:00:00.000Z",
    },
    calls,
  };
}

function marker(dir, name = "otel-forward") {
  const p = join(dir, "watchdog", `${name}.alert.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("raiseAlert", () => {
  test("writes marker (raised:true), logs error, appends a raised envelope", () => {
    const { dir, cleanup } = tmp();
    const { io, calls } = makeIo(dir);
    try {
      raiseAlert(TARGET, { tripped: ["dlq"], sinceMs: 5000 }, io);

      const m = marker(dir);
      expect(m.raised).toBe(true);
      expect(m.daemon).toBe("otel-forward");
      expect(m.kind).toBe(DAEMON_STUCK_KIND);
      expect(m.tripped).toEqual(["dlq"]);
      expect(m.sinceMs).toBe(5000);
      expect(m.escalated).toBe(false);

      expect(calls.log.some(([lvl]) => lvl === "error")).toBe(true);

      const line = JSON.parse(readFileSync(io.logPath, "utf8").trim());
      expect(line.attributes["event.name"]).toBe(ALERT_RAISED);
      expect(line.attributes["event.entity"]).toBe("alert");
      expect(line.attributes["event.label"]).toBe(DAEMON_STUCK_KIND);
      expect(line.resource["service.name"]).toBe("catalyst.execution-core");
    } finally {
      cleanup();
    }
  });
});

describe("clearAlert", () => {
  test("overwrites marker (raised:false) + appends a cleared envelope", () => {
    const { dir, cleanup } = tmp();
    const { io } = makeIo(dir);
    try {
      raiseAlert(TARGET, { tripped: ["dlq"], sinceMs: 5000 }, io);
      clearAlert(TARGET, { sinceMs: 9000 }, io);

      expect(marker(dir).raised).toBe(false);

      const lines = readFileSync(io.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines[lines.length - 1].attributes["event.name"]).toBe(ALERT_CLEARED);
    } finally {
      cleanup();
    }
  });
});

describe("escalate", () => {
  test("marker escalated:true, alert stays RAISED (latched, not cleared), finding severity high", () => {
    const { dir, cleanup } = tmp();
    const { io, calls } = makeIo(dir);
    try {
      escalate(TARGET, { tripped: ["dlq", "lag"], sinceMs: 60000 }, io);

      const m = marker(dir);
      expect(m.raised).toBe(true); // latched — NOT cleared
      expect(m.escalated).toBe(true);

      // last envelope is a raised (not a cleared) event
      const lines = readFileSync(io.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines[lines.length - 1].attributes["event.name"]).toBe(ALERT_RAISED);

      // finding filed with severity high
      expect(calls.findings).toHaveLength(1);
      const args = calls.findings[0];
      expect(args).toContain("--severity");
      expect(args[args.indexOf("--severity") + 1]).toBe("high");
    } finally {
      cleanup();
    }
  });
});

describe("best-effort — never throws", () => {
  test("unwritable marker dir / log path does not throw", () => {
    // markerDir under a path whose parent is a FILE → mkdir throws internally,
    // but the fns must swallow it.
    const { dir, cleanup } = tmp();
    try {
      const badBase = join(dir, "afile");
      // write a file where a directory is expected so the nested mkdir is blocked
      writeFileSync(badBase, "block");
      const io = {
        log: { error() {}, warn() {}, info() {} },
        logPath: join(badBase, "x", "events.jsonl"),
        markerDir: join(badBase, "x", "watchdog"),
        runFinding() {},
        now: () => "2026-07-23T12:00:00.000Z",
      };
      expect(() => raiseAlert(TARGET, { tripped: ["dlq"], sinceMs: 1 }, io)).not.toThrow();
      expect(() => clearAlert(TARGET, { sinceMs: 1 }, io)).not.toThrow();
      expect(() => escalate(TARGET, { tripped: ["dlq"], sinceMs: 1 }, io)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test("a throwing runFinding is swallowed by escalate", () => {
    const { dir, cleanup } = tmp();
    try {
      const io = {
        log: { error() {}, warn() {}, info() {} },
        logPath: join(dir, "e.jsonl"),
        markerDir: join(dir, "watchdog"),
        runFinding: () => {
          throw new Error("add-finding boom");
        },
        now: () => "2026-07-23T12:00:00.000Z",
      };
      expect(() => escalate(TARGET, { tripped: ["dlq"], sinceMs: 1 }, io)).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("buildDaemonAlertEnvelope parity", () => {
  test("raised/cleared names match broker/alert-emit.mjs; service is execution-core", () => {
    const raised = buildDaemonAlertEnvelope(
      { action: "raised", tripped: ["dlq"], sinceMs: 1 },
      { now: () => "2026-07-23T12:00:00.000Z" },
    );
    expect(raised.attributes["event.name"]).toBe(ALERT_RAISED);
    expect(raised.attributes["event.entity"]).toBe("alert");
    expect(raised.attributes["event.label"]).toBe(DAEMON_STUCK_KIND);
    expect(raised.resource["service.name"]).toBe("catalyst.execution-core");
    expect(raised.severityText).toBe("ERROR");

    const cleared = buildDaemonAlertEnvelope(
      { action: "cleared", sinceMs: 1 },
      { now: () => "2026-07-23T12:00:00.000Z" },
    );
    expect(cleared.attributes["event.name"]).toBe(ALERT_CLEARED);
    expect(cleared.severityText).toBe("INFO");
  });
});
