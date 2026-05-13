// broker-key-health.test.ts — tests for HUD broker key-health helpers (CTL-343).
// Run from plugins/dev/scripts/orch-monitor: bun test cli/lib/broker-key-health.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chipLabel,
  chipColor,
  readBrokerKeyHealth,
  readBrokerState,
  brokerInterestStatus,
  interestChipColor,
  interestChipLabel,
} from "./broker-key-health.ts";

describe("chipLabel", () => {
  test("ok → 'OK'", () => expect(chipLabel("ok")).toBe("OK"));
  test("missing → 'MISS'", () => expect(chipLabel("missing")).toBe("MISS"));
  test("unauthorized → '401'", () => expect(chipLabel("unauthorized")).toBe("401"));
  test("error → 'ERR'", () => expect(chipLabel("error")).toBe("ERR"));
  test("pending → '...'", () => expect(chipLabel("pending")).toBe("..."));
});

describe("chipColor", () => {
  test("ok → green", () => expect(chipColor("ok")).toBe("green"));
  test("missing → yellow", () => expect(chipColor("missing")).toBe("yellow"));
  test("unauthorized → red", () => expect(chipColor("unauthorized")).toBe("red"));
  test("error → red", () => expect(chipColor("error")).toBe("red"));
  test("pending → cyan", () => expect(chipColor("pending")).toBe("cyan"));
});

describe("readBrokerKeyHealth", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "hud-bkh-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("returns null when file does not exist", () => {
    expect(readBrokerKeyHealth(join(tmp, "missing.json"))).toBeNull();
  });

  test("returns null when file is malformed JSON", () => {
    const target = join(tmp, "bad.json");
    writeFileSync(target, "{ not valid");
    expect(readBrokerKeyHealth(target)).toBeNull();
  });

  test("returns the keyHealth object when present", () => {
    const target = join(tmp, "good.json");
    writeFileSync(target, JSON.stringify({
      pid: 1234,
      keyHealth: { groq: { present: true, source: "config", prefix: "gsk_abc", probeStatus: "ok" } },
    }));
    const result = readBrokerKeyHealth(target);
    expect(result).not.toBeNull();
    expect(result?.groq?.present).toBe(true);
    expect(result?.groq?.probeStatus).toBe("ok");
  });

  test("returns null when state file has no keyHealth field", () => {
    const target = join(tmp, "no-key.json");
    writeFileSync(target, JSON.stringify({ pid: 1234 }));
    expect(readBrokerKeyHealth(target)).toBeNull();
  });
});

describe("CTL-352 readBrokerState", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "hud-bs-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("returns null when file does not exist", () => {
    expect(readBrokerState(join(tmp, "missing.json"))).toBeNull();
  });

  test("returns interestCount, lastWakeAt, lastRegisterAt, startedAt when present", () => {
    const target = join(tmp, "good.json");
    writeFileSync(target, JSON.stringify({
      pid: 1234,
      startedAt: "2026-05-13T03:00:00Z",
      interestCount: 3,
      lastWakeAt: "2026-05-13T04:00:00Z",
      lastRegisterAt: "2026-05-13T03:30:00Z",
      keyHealth: { groq: { present: true, source: "config", prefix: "gsk_abc", probeStatus: "ok" } },
    }));
    const result = readBrokerState(target);
    expect(result).not.toBeNull();
    expect(result?.interestCount).toBe(3);
    expect(result?.lastWakeAt).toBe("2026-05-13T04:00:00Z");
    expect(result?.lastRegisterAt).toBe("2026-05-13T03:30:00Z");
    expect(result?.startedAt).toBe("2026-05-13T03:00:00Z");
    expect(result?.groq?.probeStatus).toBe("ok");
  });

  test("tolerates absent interestCount/lastWakeAt (legacy state files)", () => {
    const target = join(tmp, "legacy.json");
    writeFileSync(target, JSON.stringify({
      pid: 1234,
      startedAt: "2026-05-13T03:00:00Z",
      keyHealth: { groq: { present: true, source: "config", prefix: "x", probeStatus: "ok" } },
    }));
    const result = readBrokerState(target);
    expect(result).not.toBeNull();
    expect(result?.interestCount).toBeUndefined();
    expect(result?.lastWakeAt).toBeUndefined();
    expect(result?.groq?.probeStatus).toBe("ok");
  });
});

describe("CTL-352 brokerInterestStatus", () => {
  const NOW = Date.parse("2026-05-13T04:00:00Z");

  test("returns 'unknown' for null state", () => {
    expect(brokerInterestStatus(null, NOW)).toBe("unknown");
  });

  test("returns 'unknown' when interestCount is missing", () => {
    expect(brokerInterestStatus({ startedAt: "2026-05-13T03:00:00Z" }, NOW)).toBe("unknown");
  });

  test("returns 'ok' when interestCount > 0", () => {
    expect(brokerInterestStatus({ interestCount: 2, startedAt: "2026-05-13T03:00:00Z" }, NOW)).toBe("ok");
  });

  test("returns 'startup' when interestCount === 0 within 5-min grace", () => {
    // started 2 minutes before NOW
    expect(brokerInterestStatus(
      { interestCount: 0, startedAt: "2026-05-13T03:58:00Z" }, NOW,
    )).toBe("startup");
  });

  test("returns 'degraded' when interestCount === 0 past 5-min grace", () => {
    // started 6 minutes before NOW
    expect(brokerInterestStatus(
      { interestCount: 0, startedAt: "2026-05-13T03:54:00Z" }, NOW,
    )).toBe("degraded");
  });

  test("returns 'unknown' when interestCount === 0 but startedAt is missing/malformed", () => {
    expect(brokerInterestStatus({ interestCount: 0 }, NOW)).toBe("unknown");
    expect(brokerInterestStatus({ interestCount: 0, startedAt: "not a date" }, NOW)).toBe("unknown");
  });
});

describe("CTL-352 interestChipColor + interestChipLabel", () => {
  test("color: ok → green, startup → yellow, degraded → red, unknown → gray", () => {
    expect(interestChipColor("ok")).toBe("green");
    expect(interestChipColor("startup")).toBe("yellow");
    expect(interestChipColor("degraded")).toBe("red");
    expect(interestChipColor("unknown")).toBe("gray");
  });

  test("label: 'N interests' for ok, '0 (starting)' for startup, '0 interests' for degraded, '?' for unknown", () => {
    expect(interestChipLabel({ interestCount: 3 }, "ok")).toBe("3 interests");
    expect(interestChipLabel({ interestCount: 1 }, "ok")).toBe("1 interest");
    expect(interestChipLabel({ interestCount: 0 }, "startup")).toBe("0 (starting)");
    expect(interestChipLabel({ interestCount: 0 }, "degraded")).toBe("0 interests");
    expect(interestChipLabel(null, "unknown")).toBe("?");
  });
});
