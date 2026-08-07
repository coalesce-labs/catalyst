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
import { readAdmissionState } from "../admission-state.mjs";

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

  // CTL-1678 (Codex P1): boot-drain is authoritative — the worker-only override
  // must be inert on a node explicitly booted drained (CATALYST_BOOT_DRAINED=1).
  test("CATALYST_BOOT_DRAINED=1 makes the override inert (boot-drain wins)", () => {
    expect(
      isDrainDisabled({ CATALYST_DRAIN_DISABLED: "1", CATALYST_BOOT_DRAINED: "1" }),
    ).toBe(false);
  });

  test("CATALYST_BOOT_DRAINED off (0/absent) → override still applies", () => {
    expect(
      isDrainDisabled({ CATALYST_DRAIN_DISABLED: "1", CATALYST_BOOT_DRAINED: "0" }),
    ).toBe(true);
    expect(isDrainDisabled({ CATALYST_DRAIN_DISABLED: "1" })).toBe(true);
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

  // CTL-1678 (Codex P1): a boot-drained node keeps draining even with the override
  // also set — the override is inert (disabled:false) so boot-drain stays authoritative.
  test("flag present + override + CATALYST_BOOT_DRAINED=1 → still draining", () => {
    setFlag(true);
    expect(
      resolveDrainState(tmp, {
        env: { CATALYST_DRAIN_DISABLED: "1", CATALYST_BOOT_DRAINED: "1" },
      }),
    ).toEqual({
      flagPresent: true,
      disabled: false,
      draining: true,
    });
  });
});

describe("readAdmissionState inherits the fix (CTL-1678)", () => {
  test("flag present + CATALYST_DRAIN_DISABLED=1 → accepting:true, holdReason:null", () => {
    setFlag(true);
    process.env.CATALYST_DRAIN_DISABLED = "1";
    // Use the REAL default isDraining (which now honors the override); stub only
    // the liveness/worker seams so the assertion isolates the drain axis.
    const state = readAdmissionState({
      orchDir: tmp,
      agentsSnapshotFn: () => ({ agents: [], isFresh: true }),
      countWorkersFn: () => 0,
      maxParallelFn: () => 2,
    });
    expect(state.accepting).toBe(true);
    expect(state.holdReason).toBeNull();
  });

  test("flag present + env unset → accepting:false, holdReason:'drain' (unchanged)", () => {
    setFlag(true);
    const state = readAdmissionState({
      orchDir: tmp,
      agentsSnapshotFn: () => ({ agents: [], isFresh: true }),
      countWorkersFn: () => 0,
      maxParallelFn: () => 2,
    });
    expect(state.accepting).toBe(false);
    expect(state.holdReason).toBe("drain");
  });
});

describe("getDrainIgnoredMarkerPath", () => {
  test('=== join(dir, "drain.ignored") and distinct from the other markers', () => {
    expect(getDrainIgnoredMarkerPath(tmp)).toBe(join(tmp, "drain.ignored"));
    expect(getDrainIgnoredMarkerPath(tmp)).not.toBe(getDrainFlagPath(tmp));
    expect(getDrainIgnoredMarkerPath(tmp)).not.toBe(getDrainedMarkerPath(tmp));
  });
});

// CTL-1678 (Codex round-3 P1): the daemon-runtime env snapshot + read-side resolver.
describe("writeDaemonRuntimeEnv / readDaemonRuntimeEnv", () => {
  test("write records pid + post-precedence drainDisabled; read returns it while pid alive", async () => {
    const { writeDaemonRuntimeEnv, readDaemonRuntimeEnv } = await import("../config.mjs");
    const payload = writeDaemonRuntimeEnv(tmp, {
      env: { CATALYST_DRAIN_DISABLED: "1" },
      pid: 4242,
      now: () => "2026-08-07T00:00:00.000Z",
    });
    expect(payload).toEqual({
      pid: 4242,
      startedAt: "2026-08-07T00:00:00.000Z",
      drainDisabled: true,
      bootDrained: false,
    });
    const read = readDaemonRuntimeEnv(tmp, { isPidAlive: () => true });
    expect(read).toEqual(payload);
  });

  test("boot-drain precedence is folded at WRITE time (drainDisabled false under boot-drain)", async () => {
    const { writeDaemonRuntimeEnv } = await import("../config.mjs");
    const payload = writeDaemonRuntimeEnv(tmp, {
      env: { CATALYST_DRAIN_DISABLED: "1", CATALYST_BOOT_DRAINED: "1" },
      pid: 4242,
    });
    expect(payload.drainDisabled).toBe(false);
    expect(payload.bootDrained).toBe(true);
  });

  test("dead recording pid → null (stale marker is ignored)", async () => {
    const { writeDaemonRuntimeEnv, readDaemonRuntimeEnv } = await import("../config.mjs");
    writeDaemonRuntimeEnv(tmp, { env: {}, pid: 4242 });
    expect(readDaemonRuntimeEnv(tmp, { isPidAlive: () => false })).toBeNull();
  });

  test("absent/corrupt marker → null", async () => {
    const { readDaemonRuntimeEnv, getDaemonRuntimeEnvPath } = await import("../config.mjs");
    expect(readDaemonRuntimeEnv(tmp, { isPidAlive: () => true })).toBeNull();
    writeFileSync(getDaemonRuntimeEnvPath(tmp), "not json");
    expect(readDaemonRuntimeEnv(tmp, { isPidAlive: () => true })).toBeNull();
  });
});

describe("resolveDrainStateForRead", () => {
  test("live marker wins over caller env (post-restart file edit cannot lie)", async () => {
    const { resolveDrainStateForRead } = await import("../config.mjs");
    setFlag(true);
    // Caller env says disabled (file edited after daemon start); the RUNNING daemon
    // captured no override — status must say draining.
    const state = resolveDrainStateForRead(tmp, {
      env: { CATALYST_DRAIN_DISABLED: "1" },
      readRuntime: () => ({ pid: 4242, drainDisabled: false, bootDrained: false }),
    });
    expect(state).toMatchObject({ flagPresent: true, disabled: false, draining: true, source: "daemon-runtime", daemonPid: 4242 });
  });

  test("live marker drainDisabled → flag ignored regardless of caller env", async () => {
    const { resolveDrainStateForRead } = await import("../config.mjs");
    setFlag(true);
    const state = resolveDrainStateForRead(tmp, {
      env: {},
      readRuntime: () => ({ pid: 4242, drainDisabled: true, bootDrained: false }),
    });
    expect(state).toMatchObject({ flagPresent: true, disabled: true, draining: false, source: "daemon-runtime" });
  });

  test("no live daemon → falls back to caller env (next-start view)", async () => {
    const { resolveDrainStateForRead } = await import("../config.mjs");
    setFlag(true);
    const state = resolveDrainStateForRead(tmp, {
      env: { CATALYST_DRAIN_DISABLED: "1" },
      readRuntime: () => null,
    });
    expect(state).toMatchObject({ flagPresent: true, disabled: true, draining: false, source: "env" });
  });

  test("flag file presence is read LIVE even under a marker (sentinel stays dynamic)", async () => {
    const { resolveDrainStateForRead } = await import("../config.mjs");
    setFlag(false);
    const state = resolveDrainStateForRead(tmp, {
      env: {},
      readRuntime: () => ({ pid: 4242, drainDisabled: false, bootDrained: false }),
    });
    expect(state).toMatchObject({ flagPresent: false, draining: false, source: "daemon-runtime" });
  });
});
