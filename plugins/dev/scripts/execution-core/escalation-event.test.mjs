// escalation-event.test.mjs — CTL-2056.
// Unit tests for the needs-human escalation event builder + emitter.
//
// Run: cd plugins/dev/scripts/execution-core && bun test escalation-event.test.mjs

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ESCALATION_EVENT_NEEDS_HUMAN,
  buildEscalationEnvelope,
  emitEscalationEvent,
} from "./escalation-event.mjs";

// ─── buildEscalationEnvelope ──────────────────────────────────────────────────

describe("buildEscalationEnvelope", () => {
  test("sets event.entity=ticket, event.action=escalated, event.label=ticket", () => {
    const e = buildEscalationEnvelope("CTL-2056", { site: "scheduler", reason: "attempts-exhausted" });
    expect(e.attributes["event.entity"]).toBe("ticket");
    expect(e.attributes["event.action"]).toBe("escalated");
    expect(e.attributes["event.label"]).toBe("CTL-2056");
  });

  test("event.name equals ESCALATION_EVENT_NEEDS_HUMAN constant", () => {
    const e = buildEscalationEnvelope("CTL-1");
    expect(e.attributes["event.name"]).toBe(ESCALATION_EVENT_NEEDS_HUMAN);
    expect(e.attributes["event.name"]).toBe("ticket.escalated");
  });

  test("event name is namespace-safe (not phase.*/filter.*/broker.daemon/session.heartbeat)", () => {
    const name = ESCALATION_EVENT_NEEDS_HUMAN;
    expect(name.startsWith("filter.")).toBe(false);
    expect(name.startsWith("broker.daemon")).toBe(false);
    expect(name).not.toBe("session.heartbeat");
    // Not a phase.X.(complete|failed|turn-cap-exhausted|skipped).TICKET pattern
    expect(/^phase\.[^.]+\.(complete|failed|turn-cap-exhausted|skipped)\./.test(name)).toBe(false);
  });

  test("includes escalation.site and escalation.reason when provided", () => {
    const e = buildEscalationEnvelope("CTL-2056", { site: "monitor", reason: "dispatch-circuit-breaker" });
    expect(e.attributes["escalation.site"]).toBe("monitor");
    expect(e.attributes["escalation.reason"]).toBe("dispatch-circuit-breaker");
  });

  test("omits escalation.site / escalation.reason when not provided", () => {
    const e = buildEscalationEnvelope("CTL-1");
    expect("escalation.site" in e.attributes).toBe(false);
    expect("escalation.reason" in e.attributes).toBe(false);
  });

  test("injectable now() controls the envelope ts", () => {
    const FIXED_TS = "2026-08-19T23:44:00Z";
    const e = buildEscalationEnvelope("CTL-1", {}, { now: () => FIXED_TS });
    expect(e.ts).toBe(FIXED_TS);
    expect(e.observedTs).toBe(FIXED_TS);
  });

  test("has OTel envelope fields (resource, traceId, spanId, id)", () => {
    const e = buildEscalationEnvelope("CTL-1");
    expect(typeof e.traceId).toBe("string");
    expect(e.traceId).toHaveLength(32);
    expect(typeof e.spanId).toBe("string");
    expect(typeof e.id).toBe("string");
    expect(e.resource?.["service.name"]).toBe("catalyst.execution-core");
  });
});

// ─── emitEscalationEvent ─────────────────────────────────────────────────────

describe("emitEscalationEvent", () => {
  test("appends one JSONL line to logPath and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "esc-event-"));
    const logPath = join(dir, "events.jsonl");
    const FIXED_TS = "2026-08-19T23:44:00Z";
    const ok = emitEscalationEvent("CTL-2056", { site: "scheduler" }, { logPath, now: () => FIXED_TS });
    expect(ok).toBe(true);
    const line = readFileSync(logPath, "utf8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.attributes["event.entity"]).toBe("ticket");
    expect(parsed.attributes["event.action"]).toBe("escalated");
    expect(parsed.ts).toBe(FIXED_TS);
  });

  test("returns false (never throws) on a bad logPath", () => {
    const result = emitEscalationEvent("CTL-1", {}, { logPath: "/proc/impossible/path/events.jsonl" });
    expect(result).toBe(false);
  });

  test("returns false (never throws) when logPath is null", () => {
    const result = emitEscalationEvent("CTL-1", {}, { logPath: null });
    expect(result).toBe(false);
  });

  test("multiple appends accumulate as separate JSONL lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "esc-event-multi-"));
    const logPath = join(dir, "events.jsonl");
    emitEscalationEvent("CTL-1", {}, { logPath });
    emitEscalationEvent("CTL-2", {}, { logPath });
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).attributes["event.label"]).toBe("CTL-1");
    expect(JSON.parse(lines[1]).attributes["event.label"]).toBe("CTL-2");
  });
});
