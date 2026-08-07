// config-drain-disabled.test.mjs — tests for the CTL-1678 per-node drain
// override (isDrainDisabled / resolveDrainState / isDraining override /
// getDrainIgnoredMarkerPath) in execution-core/config.mjs. Run:
//   cd plugins/dev/scripts/execution-core && bun test config-drain-disabled

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDraining,
  isDrainDisabled,
  resolveDrainState,
  getDrainFlagPath,
  getDrainIgnoredMarkerPath,
  getDrainedMarkerPath,
} from "../config.mjs";

let saved;
let tmp;

beforeEach(() => {
  saved = process.env.CATALYST_DRAIN_DISABLED;
  // Default-delete so an ambient value on the dev machine can't leak into a test.
  delete process.env.CATALYST_DRAIN_DISABLED;
  tmp = mkdtempSync(join(tmpdir(), "ctl1678-"));
});

afterEach(() => {
  if (saved === undefined) delete process.env.CATALYST_DRAIN_DISABLED;
  else process.env.CATALYST_DRAIN_DISABLED = saved;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Write/remove the drain flag file in the temp orchDir.
function setFlag(present) {
  const p = getDrainFlagPath(tmp);
  if (present) writeFileSync(p, "");
  else rmSync(p, { force: true });
}

describe("isDrainDisabled", () => {
  test('CATALYST_DRAIN_DISABLED="1" → true', () => {
    process.env.CATALYST_DRAIN_DISABLED = "1";
    expect(isDrainDisabled()).toBe(true);
  });

  for (const v of [undefined, "0", "true", ""]) {
    test(`value ${JSON.stringify(v)} → false (strict === "1")`, () => {
      if (v === undefined) delete process.env.CATALYST_DRAIN_DISABLED;
      else process.env.CATALYST_DRAIN_DISABLED = v;
      expect(isDrainDisabled()).toBe(false);
    });
  }

  test("honors the injected env seam", () => {
    expect(isDrainDisabled({ CATALYST_DRAIN_DISABLED: "1" })).toBe(true);
    expect(isDrainDisabled({ CATALYST_DRAIN_DISABLED: "0" })).toBe(false);
    expect(isDrainDisabled({})).toBe(false);
  });
});

describe("isDraining override", () => {
  test("no flag file, env unset → false", () => {
    setFlag(false);
    expect(isDraining(tmp)).toBe(false);
  });

  test("flag present, env unset → true (unchanged legacy behavior)", () => {
    setFlag(true);
    expect(isDraining(tmp)).toBe(true);
  });

  test("CRUX: flag present + CATALYST_DRAIN_DISABLED=1 → false", () => {
    setFlag(true);
    process.env.CATALYST_DRAIN_DISABLED = "1";
    expect(isDraining(tmp)).toBe(false);
  });

  test("honors the injected env seam (flag present)", () => {
    setFlag(true);
    expect(isDraining(tmp, { env: { CATALYST_DRAIN_DISABLED: "1" } })).toBe(false);
    expect(isDraining(tmp, { env: {} })).toBe(true);
  });
});

describe("resolveDrainState", () => {
  test("flag absent, disabled off", () => {
    setFlag(false);
    expect(resolveDrainState(tmp, { env: {} })).toEqual({
      flagPresent: false,
      disabled: false,
      draining: false,
    });
  });

  test("flag present, disabled off", () => {
    setFlag(true);
    expect(resolveDrainState(tmp, { env: {} })).toEqual({
      flagPresent: true,
      disabled: false,
      draining: true,
    });
  });

  test("flag present, disabled on", () => {
    setFlag(true);
    expect(resolveDrainState(tmp, { env: { CATALYST_DRAIN_DISABLED: "1" } })).toEqual({
      flagPresent: true,
      disabled: true,
      draining: false,
    });
  });

  test("flag absent, disabled on", () => {
    setFlag(false);
    expect(resolveDrainState(tmp, { env: { CATALYST_DRAIN_DISABLED: "1" } })).toEqual({
      flagPresent: false,
      disabled: true,
      draining: false,
    });
  });
});

describe("getDrainIgnoredMarkerPath", () => {
  test('=== join(dir, "drain.ignored") and distinct from the other markers', () => {
    expect(getDrainIgnoredMarkerPath(tmp)).toBe(join(tmp, "drain.ignored"));
    expect(getDrainIgnoredMarkerPath(tmp)).not.toBe(getDrainFlagPath(tmp));
    expect(getDrainIgnoredMarkerPath(tmp)).not.toBe(getDrainedMarkerPath(tmp));
  });
});
