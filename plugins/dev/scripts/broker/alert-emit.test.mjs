// Unit tests for the CTL-1123 broker alert-emit foundation. Run:
//   bun test plugins/dev/scripts/broker/alert-emit.test.mjs
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALERT_RAISED,
  ALERT_CLEARED,
  ALERT_KIND_SYSTEM_DOWN,
  ALERT_KIND_NEEDS_HUMAN_PILEUP,
  NEEDS_HUMAN_LABELS,
  buildAlertEnvelope,
  emitAlertEvent,
  initialPileupState,
  nextPileupAlarmState,
} from "./alert-emit.mjs";
// Parity: the canonical taxonomy source (monitor-tree; imported in TEST only).
import {
  ATTENTION_LABEL_NEEDS_HUMAN,
  ATTENTION_LABEL_NEEDS_INPUT,
} from "../orch-monitor/lib/board-data.mjs";

const NOW = () => "2026-06-18T20:00:00.000Z";

describe("buildAlertEnvelope (CTL-1123)", () => {
  test("raised → catalyst.alert.raised, entity/action/label, ERROR, broker emitter", () => {
    const e = buildAlertEnvelope(
      { action: "raised", kind: ALERT_KIND_SYSTEM_DOWN, reason: "monitor silent", source: "catalyst.monitor", causedBy: "beat-1" },
      { now: NOW },
    );
    expect(e.attributes["event.name"]).toBe(ALERT_RAISED);
    expect(e.attributes["event.entity"]).toBe("alert");
    expect(e.attributes["event.action"]).toBe("raised");
    expect(e.attributes["event.label"]).toBe("system_down");
    expect(e.severityText).toBe("ERROR");
    expect(e.resource["service.name"]).toBe("catalyst.broker");
    expect(e.caused_by).toBe("beat-1");
    expect(e.body.payload).toMatchObject({ kind: "system_down", source: "catalyst.monitor", reason: "monitor silent" });
  });

  test("cleared → catalyst.alert.cleared, INFO, count/threshold in payload", () => {
    const e = buildAlertEnvelope(
      { action: "cleared", kind: ALERT_KIND_NEEDS_HUMAN_PILEUP, count: 0, threshold: 3, sinceMs: 600000 },
      { now: NOW },
    );
    expect(e.attributes["event.name"]).toBe(ALERT_CLEARED);
    expect(e.attributes["event.action"]).toBe("cleared");
    expect(e.attributes["event.label"]).toBe("needs_human_pileup");
    expect(e.severityText).toBe("INFO");
    expect(e.body.payload).toMatchObject({ kind: "needs_human_pileup", count: 0, threshold: 3, sinceMs: 600000 });
  });
});

describe("emitAlertEvent (CTL-1123)", () => {
  test("appends one JSON line and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-emit-"));
    try {
      const logPath = join(dir, "events", "2026-06.jsonl");
      const ok = emitAlertEvent(
        { action: "raised", kind: ALERT_KIND_SYSTEM_DOWN, source: "catalyst.monitor" },
        { logPath, now: NOW },
      );
      expect(ok).toBe(true);
      expect(existsSync(logPath)).toBe(true);
      const line = JSON.parse(readFileSync(logPath, "utf8").trim());
      expect(line.attributes["event.name"]).toBe(ALERT_RAISED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append failure returns false and never throws (unwritable path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alert-emit-"));
    try {
      // a FILE where the events dir should be → mkdir/append ENOTDIR
      const filePath = join(dir, "blocker");
      writeFileSync(filePath, "x");
      const logPath = join(filePath, "nested", "2026-06.jsonl");
      let ok;
      expect(() => {
        ok = emitAlertEvent({ action: "raised", kind: ALERT_KIND_SYSTEM_DOWN }, { logPath, now: NOW });
      }).not.toThrow();
      expect(ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nextPileupAlarmState — level debounce (CTL-1123)", () => {
  const T = 3; // threshold
  const P = 300_000; // persistence 5m
  const C = 3_600_000; // cooldown 1h
  const step = (prev, count, nowMs) => nextPileupAlarmState(prev, { count, threshold: T, nowMs, persistenceMs: P, cooldownMs: C });

  test("below threshold → never raises", () => {
    const r = step(initialPileupState(), 2, 1_000);
    expect(r.emit).toBeNull();
    expect(r.state.raised).toBe(false);
  });

  test("at/above threshold but within persistence window → no raise yet", () => {
    let s = initialPileupState();
    let r = step(s, 5, 0); // aboveSince=0, not yet persisted
    expect(r.emit).toBeNull();
    r = step(r.state, 5, P - 1); // still inside window
    expect(r.emit).toBeNull();
    expect(r.state.raised).toBe(false);
  });

  test("sustained past persistence → raises exactly once (edge-triggered)", () => {
    let r = step(initialPileupState(), 5, 0);
    r = step(r.state, 5, P); // persistence elapsed → raise
    expect(r.emit).toBe("raised");
    expect(r.state.raised).toBe(true);
    r = step(r.state, 6, P + 60_000); // still above → no re-emit
    expect(r.emit).toBeNull();
  });

  test("drop below threshold while raised → clears and arms cooldown", () => {
    let r = step(initialPileupState(), 5, 0);
    r = step(r.state, 5, P); // raised
    r = step(r.state, 1, P + 1000); // drop → cleared
    expect(r.emit).toBe("cleared");
    expect(r.state.raised).toBe(false);
    expect(r.state.clearedAt).toBe(P + 1000);
  });

  test("re-raise within cooldown is deferred, then fires once cooldown expires", () => {
    let r = step(initialPileupState(), 5, 0);
    r = step(r.state, 5, P); // raised
    const clearAt = P + 1000;
    r = step(r.state, 0, clearAt); // cleared, cooldown armed
    // count climbs again immediately and persists, but we are inside cooldown
    r = step(r.state, 5, clearAt + 10); // aboveSince set
    r = step(r.state, 5, clearAt + P + 10); // persisted but still < cooldown after clear
    expect(r.emit).toBeNull(); // deferred by cooldown
    expect(r.state.raised).toBe(false);
    // once cooldown has elapsed since the clear, the sustained pile-up raises
    r = step(r.state, 5, clearAt + C + 1);
    expect(r.emit).toBe("raised");
  });

  test("a one-tick spike (above then immediately below) never raises", () => {
    let r = step(initialPileupState(), 9, 0); // spike, aboveSince=0
    r = step(r.state, 0, 1000); // gone before persistence
    expect(r.emit).toBeNull();
    expect(r.state.raised).toBe(false);
    expect(r.state.aboveSince).toBeNull();
  });
});

describe("needs-human label taxonomy parity (CTL-1123)", () => {
  test("NEEDS_HUMAN_LABELS matches board-data's canonical ATTENTION_LABEL_* constants", () => {
    // Guards against a silent taxonomy drift (CTL-995): if board-data renames the
    // labels, this fails so the broker's pile-up count is updated in lockstep.
    expect(new Set(NEEDS_HUMAN_LABELS)).toEqual(
      new Set([ATTENTION_LABEL_NEEDS_HUMAN, ATTENTION_LABEL_NEEDS_INPUT]),
    );
  });
});
