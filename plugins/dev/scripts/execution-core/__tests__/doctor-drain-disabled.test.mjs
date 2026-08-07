// doctor-drain-disabled.test.mjs — CTL-1678. Tests for checkDrainDisabled() in
// doctor.mjs. All deps are injected so the test touches no filesystem/env. The
// load-bearing invariant: NEVER emit a FAIL record (advisory only, like
// checkWorkerLabels). Run:
//   cd plugins/dev/scripts/execution-core && bun test doctor-drain-disabled

import { describe, test, expect } from "bun:test";
import { checkDrainDisabled } from "../doctor.mjs";

// Inject a resolveDrainState stub so no real flag file / orchDir is read.
function deps(env, drainState) {
  return {
    env,
    orchDir: "/tmp/nonexistent-orchdir",
    resolveDrainState: () => drainState,
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
