// fleet-health-event.test.mjs — CTL-1165 D5. OTel fleet-health event builder +
// best-effort appender. buildFleetHealthEnvelope is asserted without touching
// the FS; emitFleetHealthEvent is exercised against a temp event log. Mirrors
// memory-event.test.mjs / heartbeat-event.test.mjs.
//
// Run: cd plugins/dev/scripts/execution-core && bun test fleet-health-event.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFleetHealthEnvelope,
  emitFleetHealthEvent,
  FLEET_HEALTH_DEGRADED,
} from "./fleet-health-event.mjs";

const basePayload = {
  jobsCount: 750,
  agentsCount: 14,
  procsCount: 52,
  swapUsedMb: 5000,
  tripped: ["jobs", "agents"],
  sustained_n: 1,
};

describe("buildFleetHealthEnvelope", () => {
  test("degraded event has WARN severity and the canonical event name", () => {
    const env = buildFleetHealthEnvelope(basePayload);
    expect(env.severityText).toBe("WARN");
    expect(env.severityNumber).toBe(13);
    expect(env.attributes["event.name"]).toBe(FLEET_HEALTH_DEGRADED);
    expect(env.attributes["event.action"]).toBe("degraded");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
  });

  test("host lives in the resource block, NOT in the dotted event name", () => {
    const env = buildFleetHealthEnvelope(basePayload);
    // The monitor composes fleet.health.degraded.<host> from resource; the
    // emitted event.name stays the bare 'fleet.health.degraded'.
    expect(env.attributes["event.name"]).toBe("fleet.health.degraded");
    expect(env.attributes["event.name"]).not.toMatch(/fleet\.health\.degraded\./);
    expect(typeof env.resource["host.name"]).toBe("string");
    expect("host.id" in env.resource).toBe(true);
  });

  test("body.payload carries all four readings + tripped + sustained_n", () => {
    const env = buildFleetHealthEnvelope(basePayload);
    expect(env.body.payload).toMatchObject({
      jobsCount: 750,
      agentsCount: 14,
      procsCount: 52,
      swapUsedMb: 5000,
      tripped: ["jobs", "agents"],
      sustained_n: 1,
    });
  });

  test("null/sentinel readings survive into the payload untouched", () => {
    const env = buildFleetHealthEnvelope({
      jobsCount: null,
      agentsCount: null,
      procsCount: null,
      swapUsedMb: 0,
      tripped: [],
      sustained_n: 1,
    });
    expect(env.body.payload.jobsCount).toBe(null);
    expect(env.body.payload.swapUsedMb).toBe(0);
    expect(env.body.payload.tripped).toEqual([]);
  });

  test("ts is a Z-suffixed timestamp with no millisecond fraction", () => {
    const env = buildFleetHealthEnvelope(basePayload);
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("injectable now() overrides the timestamp", () => {
    const fixed = "2026-06-14T12:00:00Z";
    const env = buildFleetHealthEnvelope(basePayload, { now: () => fixed });
    expect(env.ts).toBe(fixed);
    expect(env.observedTs).toBe(fixed);
  });

  test("envelope has id random hex field", () => {
    const env = buildFleetHealthEnvelope(basePayload);
    expect(env.id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("emitFleetHealthEvent", () => {
  test("appends exactly one valid WARN JSON line and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1165-fhe-"));
    const logPath = join(dir, "2026-06.jsonl");
    const ok = emitFleetHealthEvent(basePayload, { logPath });
    expect(ok).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.attributes["event.name"]).toBe(FLEET_HEALTH_DEGRADED);
    expect(parsed.severityText).toBe("WARN");
    expect(parsed.body.payload.jobsCount).toBe(750);
  });

  test("creates the parent directory when missing (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1165-fhe-"));
    const logPath = join(dir, "nested", "deep", "2026-06.jsonl");
    expect(emitFleetHealthEvent(basePayload, { logPath })).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("returns false and does not throw for an unwritable logPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1165-fhe-bad-"));
    let result;
    expect(() => {
      // logPath is the dir itself (not a file) — appendFileSync throws EISDIR
      result = emitFleetHealthEvent(basePayload, { logPath: dir });
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
