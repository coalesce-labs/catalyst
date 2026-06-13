// cli/drain.test.mjs — CTL-1095. Unit tests for setDrain / readDrainStatus.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cli/drain.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDrain, readDrainStatus } from "./drain.mjs";

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ctl1095-cli-drain-"));
  // Create workers dir so listInFlightTickets has somewhere to scan
  mkdirSync(join(tmp, "workers"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("setDrain (CTL-1095)", () => {
  test("setDrain creates flag and returns draining:true + inFlightCount:0", () => {
    const r = setDrain(tmp, { off: false });
    expect(r.draining).toBe(true);
    expect(existsSync(join(tmp, "drain"))).toBe(true);
    expect(r.inFlightCount).toBe(0);
  });

  test("setDrain --off removes flag and returns draining:false", () => {
    writeFileSync(join(tmp, "drain"), "");
    const r = setDrain(tmp, { off: true });
    expect(r.draining).toBe(false);
    expect(existsSync(join(tmp, "drain"))).toBe(false);
  });

  test("setDrain --off on already-not-draining is a no-op", () => {
    const r = setDrain(tmp, { off: true });
    expect(r.draining).toBe(false);
    expect(existsSync(join(tmp, "drain"))).toBe(false);
  });

  test("setDrain when already draining is idempotent", () => {
    writeFileSync(join(tmp, "drain"), "");
    const r = setDrain(tmp, { off: false });
    expect(r.draining).toBe(true);
    expect(existsSync(join(tmp, "drain"))).toBe(true);
  });
});

describe("readDrainStatus (CTL-1095)", () => {
  test("returns draining:false + inFlightCount:0 when no flag", () => {
    const s = readDrainStatus(tmp);
    expect(s.draining).toBe(false);
    expect(s.inFlightCount).toBe(0);
  });

  test("returns draining:true when flag is present", () => {
    writeFileSync(join(tmp, "drain"), "");
    const s = readDrainStatus(tmp);
    expect(s.draining).toBe(true);
  });

  test("inFlightCount reflects in-flight workers", () => {
    // Seed one running worker signal
    const wDir = join(tmp, "workers", "CTL-test");
    mkdirSync(wDir, { recursive: true });
    writeFileSync(join(wDir, "phase-implement.json"), JSON.stringify({
      ticket: "CTL-test", phase: "implement", status: "running",
    }));
    const s = readDrainStatus(tmp);
    expect(s.inFlightCount).toBe(1);
  });
});
