// doctor-config-scope-leak.test.mjs — CTL-1214 Phase 5.
// Run: cd plugins/dev/scripts/execution-core && bun test doctor-config-scope-leak.test.mjs
//
// checkConfigScopeLeak now GRADES rather than always warning. The grading is
// load-bearing in a way most doctor checks are not: runDoctor's exit code IS the
// FAIL count, and catalyst-join.sh's do_doctor_gate activates a cluster member
// strictly on exit 0. A FAIL here fail-closes the join gate for the whole host,
// so the promotion may only fire on a config that has DECLARED it is slimmed
// (schemaVersion >= 1) — never on a fleet member that simply has not migrated.
//
// The last case asserts against THIS repo's real committed config on disk, not a
// fixture: it is the guard that keeps the fleet joinable.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkConfigScopeLeak, STATUS } from "./doctor.mjs";

const one = (deps) => {
  const checks = checkConfigScopeLeak(deps);
  expect(checks).toHaveLength(1);
  return checks[0];
};
const noHosts = { hostsJsonExists: () => false };

const cfg = (extra, { schemaVersion = 1 } = {}) =>
  JSON.stringify({
    catalyst: {
      ...(schemaVersion === null ? {} : { schemaVersion }),
      projectKey: "p",
      project: { ticketPrefix: "PROJ" },
      linear: { teamKey: "PROJ" },
      ...extra,
    },
  });

describe("checkConfigScopeLeak grading (CTL-1214 D3/D4)", () => {
  test("schemaVersion absent + node leak -> WARN (legacy repo, join gate unaffected)", () => {
    const c = one({
      ...noHosts,
      readLayer1: () => cfg({ sweep: { idleHours: 48 } }, { schemaVersion: null }),
    });
    expect(c.status).toBe(STATUS.WARN);
  });

  test("schemaVersion 1 + node leak -> FAIL, naming catalyst-config-migrate", () => {
    const c = one({ ...noHosts, readLayer1: () => cfg({ sweep: { idleHours: 48 } }) });
    expect(c.status).toBe(STATUS.FAIL);
    expect(c.detail).toContain("catalyst-config-migrate");
    expect(c.detail).toContain("sweep");
  });

  test("schemaVersion 1 + cluster leak only -> WARN, naming CTL-1885", () => {
    const c = one({
      ...noHosts,
      readLayer1: () => cfg({ monitor: { linear: { teams: [{ key: "P", vcsRepo: "a/b" }] } } }),
    });
    expect(c.status).toBe(STATUS.WARN);
    expect(c.detail).toContain("CTL-1885");
  });

  test("clean -> PASS", () => {
    const c = one({ ...noHosts, readLayer1: () => cfg({}) });
    expect(c.status).toBe(STATUS.PASS);
  });

  test("unreadable / malformed Layer-1 -> INFO, never a false PASS", () => {
    expect(one({ ...noHosts, readLayer1: () => "{ not json" }).status).toBe(STATUS.INFO);
  });

  test("an absent Layer-1 does not FAIL the join gate", () => {
    expect(one({ ...noHosts, readLayer1: () => "" }).status).not.toBe(STATUS.FAIL);
  });

  test("a hosts.json roster leak is cluster-scoped -> WARN, never FAIL", () => {
    const c = one({ hostsJsonExists: () => true, readLayer1: () => cfg({}) });
    expect(c.status).toBe(STATUS.WARN);
  });

  test("a genuinely Layer-1 orchestration stanza does not FAIL under schemaVersion 1 (D6)", () => {
    for (const stanza of [{ codex: { codexHome: "/x" } }, { executor: "sdk" }]) {
      const c = one({ ...noHosts, readLayer1: () => cfg({ orchestration: stanza }) });
      expect(c.status).toBe(STATUS.PASS);
    }
  });

  // ⚠️ THE JOIN-GATE GUARD. Asserted against the file on disk, not a fixture.
  test("THIS repo's real committed config is NOT graded FAIL", () => {
    const layer1Path = join(import.meta.dir, "..", "..", "..", "..", ".catalyst", "config.json");
    const body = readFileSync(layer1Path, "utf8");
    const c = one({ ...noHosts, readLayer1: () => body });
    expect(c.status).not.toBe(STATUS.FAIL);
    // Positive control: the fixture path CAN produce a FAIL, so "not FAIL" above
    // is a property of this config rather than of a check that never fails.
    const control = one({ ...noHosts, readLayer1: () => cfg({ sweep: { idleHours: 48 } }) });
    expect(control.status).toBe(STATUS.FAIL);
  });

  test("and it is WARN about the roster only (CTL-1885 is the remaining work)", () => {
    const layer1Path = join(import.meta.dir, "..", "..", "..", "..", ".catalyst", "config.json");
    const c = one({ ...noHosts, readLayer1: () => readFileSync(layer1Path, "utf8") });
    expect(c.status).toBe(STATUS.WARN);
    expect(c.detail).toContain("monitor.linear.teams");
    for (const gone of ["orchestration", "feedback", "sweep", "repoColors"]) {
      expect(c.detail).not.toContain(gone);
    }
  });
});
