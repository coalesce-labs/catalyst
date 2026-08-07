// cli/drain.test.mjs — CTL-1095. Unit tests for setDrain / readDrainStatus.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cli/drain.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDrain, readDrainStatus, formatDrainStatus } from "./drain.mjs";

let tmp;
let savedDisabled;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ctl1095-cli-drain-"));
  // Create workers dir so listInFlightTickets has somewhere to scan
  mkdirSync(join(tmp, "workers"), { recursive: true });
  savedDisabled = process.env.CATALYST_DRAIN_DISABLED;
  delete process.env.CATALYST_DRAIN_DISABLED;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedDisabled === undefined) delete process.env.CATALYST_DRAIN_DISABLED;
  else process.env.CATALYST_DRAIN_DISABLED = savedDisabled;
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

describe("readDrainStatus third state (CTL-1678)", () => {
  test("flag present + env unset → draining:true, flagPresent:true, disabled:false", () => {
    writeFileSync(join(tmp, "drain"), "");
    const s = readDrainStatus(tmp);
    expect(s.draining).toBe(true);
    expect(s.flagPresent).toBe(true);
    expect(s.disabled).toBe(false);
  });

  test("flag present + CATALYST_DRAIN_DISABLED=1 → draining:false, flagPresent:true, disabled:true", () => {
    writeFileSync(join(tmp, "drain"), "");
    process.env.CATALYST_DRAIN_DISABLED = "1";
    const s = readDrainStatus(tmp);
    expect(s.draining).toBe(false);
    expect(s.flagPresent).toBe(true);
    expect(s.disabled).toBe(true);
  });

  test("no flag + CATALYST_DRAIN_DISABLED=1 → draining:false, flagPresent:false, disabled:true", () => {
    process.env.CATALYST_DRAIN_DISABLED = "1";
    const s = readDrainStatus(tmp);
    expect(s.draining).toBe(false);
    expect(s.flagPresent).toBe(false);
    expect(s.disabled).toBe(true);
  });
});

describe("formatDrainStatus (CTL-1678)", () => {
  test("draining → the land-count line", () => {
    expect(formatDrainStatus({ draining: true, inFlightCount: 2, flagPresent: true, disabled: false }))
      .toContain("draining");
  });

  test("flag present but IGNORED", () => {
    const line = formatDrainStatus({ draining: false, inFlightCount: 0, flagPresent: true, disabled: true });
    expect(line).toContain("IGNORED");
    expect(line).toContain("CATALYST_DRAIN_DISABLED=1");
  });

  test("drain-disabled, no flag", () => {
    const line = formatDrainStatus({ draining: false, inFlightCount: 0, flagPresent: false, disabled: true });
    expect(line).toContain("drain disabled");
    expect(line).toContain("CATALYST_DRAIN_DISABLED=1");
  });

  test("plain not-draining", () => {
    const line = formatDrainStatus({ draining: false, inFlightCount: 0, flagPresent: false, disabled: false });
    expect(line).toContain("not draining");
    expect(line).not.toContain("IGNORED");
  });
});
