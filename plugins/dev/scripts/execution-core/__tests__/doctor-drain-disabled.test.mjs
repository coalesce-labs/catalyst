// doctor-drain-disabled.test.mjs — CTL-1678. Tests for checkDrainDisabled() in
// doctor.mjs. All deps are injected so the test touches no filesystem/env. The
// load-bearing invariant: NEVER emit a FAIL record (advisory only, like
// checkWorkerLabels). Run:
//   cd plugins/dev/scripts/execution-core && bun test doctor-drain-disabled

import { describe, test, expect } from "bun:test";
import { checkDrainDisabled } from "../doctor.mjs";
import { resolveDrainState as realResolveDrainState } from "../config.mjs";

// Inject a resolveDrainState stub so no real flag file / orchDir is read, and an empty
// readEnvFile so the check never touches the machine-local execution-core.env — keeping
// these cases fully hermetic. The CTL-1678 Codex-P2 env-file overlay is covered by the
// dedicated "durable override in execution-core.env" describe block below.
function deps(env, drainState) {
  return {
    env,
    orchDir: "/tmp/nonexistent-orchdir",
    resolveDrainState: () => drainState,
    readEnvFile: () => "",
  };
}

describe("checkDrainDisabled", () => {
  test("env unset → single INFO/PASS, never FAIL", () => {
    const rec = checkDrainDisabled(
      deps({}, { flagPresent: false, disabled: false, draining: false }),
    );
    expect(rec.name).toBe("drain-disabled");
    expect(["info", "pass"]).toContain(rec.status);
    expect(rec.status).not.toBe("fail");
  });

  test("flag present + env unset → not-FAIL (honors the flag)", () => {
    const rec = checkDrainDisabled(
      deps({}, { flagPresent: true, disabled: false, draining: true }),
    );
    expect(rec.status).not.toBe("fail");
  });

  test("CATALYST_DRAIN_DISABLED=1, flag absent → PASS/INFO, mentions CTL-1678", () => {
    const rec = checkDrainDisabled(
      deps(
        { CATALYST_DRAIN_DISABLED: "1" },
        { flagPresent: false, disabled: true, draining: false },
      ),
    );
    expect(rec.status).not.toBe("fail");
    expect(rec.detail).toContain("drain-disabled");
    expect(rec.detail).toContain("CTL-1678");
  });

  test("CATALYST_DRAIN_DISABLED=1, flag present → WARN (draining-but-ignored), never FAIL", () => {
    const rec = checkDrainDisabled(
      deps(
        { CATALYST_DRAIN_DISABLED: "1" },
        { flagPresent: true, disabled: true, draining: false },
      ),
    );
    expect(rec.status).toBe("warn");
    expect(rec.detail).toMatch(/present.*ignor|ignor.*present/i);
  });
});

// CTL-1678 (Codex P2): the durable override lives in the machine-local execution-core.env
// the daemon launcher sources — `catalyst-doctor` never sources it, so checkDrainDisabled
// must read that file itself and let it win over the ambient env, or it reports "honors
// the drain flag" while the daemon ignores it.
describe("checkDrainDisabled — durable override in execution-core.env", () => {
  // Capturing resolver: records the effective env checkDrainDisabled resolves against, so
  // we can assert the overlay precedence without any real flag-file/orchDir read.
  function capturingDeps(env, envFileText) {
    let seenEnv = null;
    const d = {
      env,
      orchDir: "/tmp/nonexistent-orchdir",
      readEnvFile: () => envFileText,
      resolveDrainState: (_dir, { env: e } = {}) => {
        seenEnv = e;
        return {
          flagPresent: false,
          disabled: e?.CATALYST_DRAIN_DISABLED === "1",
          draining: false,
        };
      },
    };
    return { deps: d, seen: () => seenEnv };
  }

  test("file sets CATALYST_DRAIN_DISABLED, ambient unset → resolver sees disabled", () => {
    const { deps: d, seen } = capturingDeps({}, "export CATALYST_DRAIN_DISABLED=1\n");
    const rec = checkDrainDisabled(d);
    expect(seen().CATALYST_DRAIN_DISABLED).toBe("1");
    expect(rec.status).not.toBe("fail");
    expect(rec.detail).toContain("drain-disabled");
  });

  test("file wins over ambient (ambient=0, file=1 → resolver sees 1)", () => {
    const { deps: d, seen } = capturingDeps(
      { CATALYST_DRAIN_DISABLED: "0" },
      "export CATALYST_DRAIN_DISABLED=1\n",
    );
    checkDrainDisabled(d);
    expect(seen().CATALYST_DRAIN_DISABLED).toBe("1");
  });

  test("empty file preserves ambient (ambient=1, file empty → resolver sees 1)", () => {
    const { deps: d, seen } = capturingDeps({ CATALYST_DRAIN_DISABLED: "1" }, "");
    checkDrainDisabled(d);
    expect(seen().CATALYST_DRAIN_DISABLED).toBe("1");
  });

  test("file boot-drain overlay reaches the REAL resolver (boot-drain neutralizes override)", () => {
    // Real resolveDrainState: BOOT_DRAINED=1 is authoritative, so isDrainDisabled → false
    // even with DRAIN_DISABLED=1. flag absent → INFO "honors the drain flag", never FAIL.
    const rec = checkDrainDisabled({
      env: {},
      orchDir: "/tmp/nonexistent-orchdir-ctl1678",
      resolveDrainState: realResolveDrainState,
      readEnvFile: () => "export CATALYST_DRAIN_DISABLED=1\nexport CATALYST_BOOT_DRAINED=1\n",
    });
    expect(rec.status).not.toBe("fail");
    expect(rec.detail).toContain("honors the drain flag");
  });
});

// CTL-1678 (Codex round-3 P1): a LIVE daemon's boot snapshot beats the env-file overlay.
describe("checkDrainDisabled daemon-runtime preference (round-3 P1)", () => {
  // A resolve stub that derives `disabled` from the env the check hands it, so these
  // cases observe WHICH env tier (runtime marker vs file overlay) the check chose.
  const envSensitiveResolve = (_dir, { env } = {}) => {
    const disabled = env?.CATALYST_BOOT_DRAINED === "1" ? false : env?.CATALYST_DRAIN_DISABLED === "1";
    return { flagPresent: true, disabled, draining: !disabled };
  };

  test("live marker with no override wins over a file that now says disabled", () => {
    const rec = checkDrainDisabled({
      env: {},
      orchDir: "/tmp/nonexistent-orchdir",
      resolveDrainState: envSensitiveResolve,
      // File edited AFTER daemon start:
      readEnvFile: () => "export CATALYST_DRAIN_DISABLED=1\n",
      // ...but the running daemon captured no override at boot:
      readRuntimeEnv: () => ({ pid: 4242, drainDisabled: false, bootDrained: false }),
    });
    // Honors the flag → the plain INFO branch, not the ignored/disabled branches.
    expect(rec.detail).toContain("honors the drain flag");
  });

  test("live marker with the override reports ignored even when the file was cleared", () => {
    const rec = checkDrainDisabled({
      env: {},
      orchDir: "/tmp/nonexistent-orchdir",
      resolveDrainState: envSensitiveResolve,
      readEnvFile: () => "",
      readRuntimeEnv: () => ({ pid: 4242, drainDisabled: true, bootDrained: false }),
    });
    expect(rec.status).toBe("warn");
    expect(rec.detail).toContain("IGNORED");
  });

  test("no live daemon → file overlay fallback still applies", () => {
    const rec = checkDrainDisabled({
      env: {},
      orchDir: "/tmp/nonexistent-orchdir",
      resolveDrainState: envSensitiveResolve,
      readEnvFile: () => "export CATALYST_DRAIN_DISABLED=1\n",
      readRuntimeEnv: () => null,
    });
    expect(rec.status).toBe("warn");
    expect(rec.detail).toContain("IGNORED");
  });
});
