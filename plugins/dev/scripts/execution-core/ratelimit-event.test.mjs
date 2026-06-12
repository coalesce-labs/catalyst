// ratelimit-event.test.mjs — CTL-787. OTel account rate-limit event builder +
// best-effort appender. buildRatelimitEnvelope is asserted without touching the
// FS; emitRatelimitEvent is exercised against a temp event log.
//
// Run: cd plugins/dev/scripts/execution-core && bun test ratelimit-event.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRatelimitEnvelope,
  emitRatelimitEvent,
  RATELIMIT_EVENT_SAMPLED,
} from "./ratelimit-event.mjs";

const basePayload = {
  email: "ryan@rozich.com",
  fiveHourPct: 42,
  sevenDayPct: 17,
  fiveHourResetsAt: "2026-06-06T18:00:00Z",
  sevenDayResetsAt: "2026-06-13T00:00:00Z",
  opusPct: 12,
  sonnetPct: 5,
  subscriptionType: "active",
  rateLimitTier: "default_claude_max_20x",
};

describe("buildRatelimitEnvelope", () => {
  test("resource/service fields and severity INFO/9", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, basePayload);
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.resource["service.namespace"]).toBe("catalyst");
  });

  test("catalyst.event.* identity attributes", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, basePayload);
    expect(env.attributes["event.name"]).toBe("account.ratelimit.sampled");
    expect(env.attributes["catalyst.event.entity"]).toBe("account");
    expect(env.attributes["catalyst.event.action"]).toBe("ratelimit.sampled");
    expect(env.attributes["catalyst.event.label"]).toBe("ryan@rozich.com");
  });

  test("catalyst.* attributes present with correct values", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, basePayload);
    const a = env.attributes;
    expect(a["catalyst.account.email"]).toBe("ryan@rozich.com");
    expect(a["catalyst.ratelimit.five_hour_pct"]).toBe(42);
    expect(a["catalyst.ratelimit.seven_day_pct"]).toBe(17);
    expect(a["catalyst.ratelimit.five_hour_resets_at"]).toBe("2026-06-06T18:00:00Z");
    expect(a["catalyst.ratelimit.seven_day_resets_at"]).toBe("2026-06-13T00:00:00Z");
    expect(a["catalyst.ratelimit.seven_day_opus_pct"]).toBe(12);
    expect(a["catalyst.ratelimit.seven_day_sonnet_pct"]).toBe(5);
    expect(a["catalyst.subscription.type"]).toBe("active");
    expect(a["catalyst.ratelimit.tier"]).toBe("default_claude_max_20x");
  });

  test("zero utilization is preserved (not dropped as falsy)", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, {
      email: "ryan@rozich.com",
      fiveHourPct: 0,
      sevenDayPct: 0,
    });
    expect(env.attributes["catalyst.ratelimit.five_hour_pct"]).toBe(0);
    expect(env.attributes["catalyst.ratelimit.seven_day_pct"]).toBe(0);
  });

  test("absent keys are omitted when null", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, {
      email: "ryan@rozich.com",
      fiveHourPct: 42,
    });
    const a = env.attributes;
    expect("catalyst.ratelimit.seven_day_pct" in a).toBe(false);
    expect("catalyst.ratelimit.five_hour_resets_at" in a).toBe(false);
    expect("catalyst.ratelimit.seven_day_opus_pct" in a).toBe(false);
    expect("catalyst.ratelimit.seven_day_sonnet_pct" in a).toBe(false);
    expect("catalyst.subscription.type" in a).toBe(false);
    expect("catalyst.ratelimit.tier" in a).toBe(false);
  });

  test("catalyst.event.label falls back to 'unknown' when email absent", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, { fiveHourPct: 1 });
    expect(env.attributes["catalyst.event.label"]).toBe("unknown");
    expect("catalyst.account.email" in env.attributes).toBe(false);
  });

  test("body.payload mirrors the same fields for human readability", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, basePayload);
    expect(env.body.payload).toMatchObject({
      email: "ryan@rozich.com",
      fiveHourPct: 42,
      sevenDayPct: 17,
      fiveHourResetsAt: "2026-06-06T18:00:00Z",
      sevenDayResetsAt: "2026-06-13T00:00:00Z",
      opusPct: 12,
      sonnetPct: 5,
      subscriptionType: "active",
      rateLimitTier: "default_claude_max_20x",
    });
  });

  test("ts is a Z-suffixed timestamp with no millisecond fraction", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, basePayload);
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("injectable now() overrides timestamp", () => {
    const fixed = "2026-06-06T12:00:00Z";
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, basePayload, {
      now: () => fixed,
    });
    expect(env.ts).toBe(fixed);
    expect(env.observedTs).toBe(fixed);
  });

  test("envelope has id, traceId, spanId random hex fields", () => {
    const env = buildRatelimitEnvelope(RATELIMIT_EVENT_SAMPLED, basePayload);
    expect(env.id).toMatch(/^[0-9a-f]{16}$/);
    expect(env.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(env.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("emitRatelimitEvent", () => {
  test("appends exactly one valid JSON line and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl787-re-"));
    const logPath = join(dir, "2026-06.jsonl");
    const ok = emitRatelimitEvent(RATELIMIT_EVENT_SAMPLED, basePayload, { logPath });
    expect(ok).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.attributes["event.name"]).toBe(RATELIMIT_EVENT_SAMPLED);
    expect(parsed.attributes["catalyst.account.email"]).toBe("ryan@rozich.com");
    expect(parsed.body.payload.opusPct).toBe(12);
  });

  test("creates the parent directory when missing (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl787-re-"));
    const logPath = join(dir, "nested", "deep", "2026-06.jsonl");
    expect(emitRatelimitEvent(RATELIMIT_EVENT_SAMPLED, basePayload, { logPath })).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("returns false and does not throw for an unwritable logPath", () => {
    // Passing a directory as the logPath makes appendFileSync throw EISDIR.
    const dir = mkdtempSync(join(tmpdir(), "ctl787-re-bad-"));
    let result;
    expect(() => {
      result = emitRatelimitEvent(RATELIMIT_EVENT_SAMPLED, basePayload, { logPath: dir });
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
