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
