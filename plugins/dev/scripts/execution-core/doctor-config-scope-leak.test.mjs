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

  // ── CTL-1214 remediation: a malformed schemaVersion is NOT a scope leak ────
  //
  // `hard = errors.length > 0` conflated two unrelated error classes, so a
  // malformed `catalyst.schemaVersion` FAILED this check with a message that
  // named no leaked key and asserted a schemaVersion the config did not have.
  // runDoctor returns the FAIL count as its exit code and catalyst-join.sh gates
  // member activation on exit 0, so that mislabel fail-closed the join gate on a
  // hand-edit typo. The scope-leak verdict now keys off the error CLASS, and the
  // schema error gets its own named check.
  describe("malformed schemaVersion is graded as a schema problem, not a scope leak", () => {
    const byName = (checks, name) => checks.find((c) => c.name === name);

    // The exact shape this repo's own committed config has today: the ONLY leak
    // is the cluster-scoped roster (CTL-1885 owns it), which is never FAIL-able.
    const CLUSTER_ONLY_LEAK = {
      monitor: { linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] } },
    };

    for (const bad of [0, "1", 1.5, -1]) {
      test(`schemaVersion ${JSON.stringify(bad)} + cluster-only leak -> scope-leak is NOT FAIL`, () => {
        const checks = checkConfigScopeLeak({
          ...noHosts,
          readLayer1: () => cfg(CLUSTER_ONLY_LEAK, { schemaVersion: bad }),
        });
        const leak = byName(checks, "config-scope-leak");
        expect(leak).toBeDefined();
        expect(leak.status).not.toBe(STATUS.FAIL);
        // and the message no longer claims a schemaVersion the config lacks
        expect(leak.detail).not.toContain("declares schemaVersion >= 1");
      });

      test(`schemaVersion ${JSON.stringify(bad)} is SURFACED under its own check`, () => {
        const checks = checkConfigScopeLeak({
          ...noHosts,
          readLayer1: () => cfg(CLUSTER_ONLY_LEAK, { schemaVersion: bad }),
        });
        const schema = byName(checks, "config-layer1-schema");
        expect(schema).toBeDefined();
        expect(schema.status).toBe(STATUS.WARN);
        expect(schema.detail).toContain("catalyst.schemaVersion");
        // never FAIL: it must not become a second back door into the join gate
        expect(schema.status).not.toBe(STATUS.FAIL);
      });
    }

    // NEGATIVE CONTROLS. Without these, every assertion above could pass from a
    // check that never emits and a verdict that is never FAIL.
    test("a WELL-FORMED schemaVersion emits NO schema check", () => {
      for (const good of [1, 2]) {
        const checks = checkConfigScopeLeak({
          ...noHosts,
          readLayer1: () => cfg(CLUSTER_ONLY_LEAK, { schemaVersion: good }),
        });
        expect(byName(checks, "config-layer1-schema")).toBeUndefined();
        expect(byName(checks, "config-scope-leak").status).toBe(STATUS.WARN);
      }
    });

    test("the FAIL path still fires for a real node-scoped leak under schemaVersion 1", () => {
      const checks = checkConfigScopeLeak({
        ...noHosts,
        readLayer1: () => cfg({ sweep: { idleHours: 48 } }, { schemaVersion: 1 }),
      });
      expect(byName(checks, "config-scope-leak").status).toBe(STATUS.FAIL);
      expect(byName(checks, "config-layer1-schema")).toBeUndefined();
    });

    test("a malformed schemaVersion does NOT suppress a real node-scoped leak's WARN", () => {
      // A bogus version does not opt in, so the node leak is a deprecation, not
      // a hard error — but it must still be reported, alongside the schema WARN.
      const checks = checkConfigScopeLeak({
        ...noHosts,
        readLayer1: () => cfg({ sweep: { idleHours: 48 } }, { schemaVersion: 0 }),
      });
      expect(byName(checks, "config-scope-leak").status).toBe(STATUS.WARN);
      expect(byName(checks, "config-scope-leak").detail).toContain("sweep");
      expect(byName(checks, "config-layer1-schema").status).toBe(STATUS.WARN);
    });
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

  // CTL-1214 remediation (verify regression_risk 5, medium): the FAIL detail used
  // to assert one blanket cause — "leaving them here silently overrides the node
  // config" — which is the WRONG direction for 4 of the 7 node-scoped rows. These
  // three cases pin the per-knob wording in BOTH directions, so a regression to a
  // single blanket sentence fails rather than merely reading plausibly.
  test("FAIL detail says OVERRIDES for a bash-read (layer1-wins) leak", () => {
    const c = one({ ...noHosts, readLayer1: () => cfg({ sweep: { idleHours: 48 } }) });
    expect(c.status).toBe(STATUS.FAIL);
    expect(c.detail).toContain("catalyst.sweep");
    expect(c.detail).toContain("OVERRIDES");
    // The opposite clause must be ABSENT — a message carrying both would be
    // unfalsifiable and would "pass" this assertion for the wrong reason.
    expect(c.detail).not.toContain("SHADOWED");
  });

  test("FAIL detail says SHADOWED for a JS-read (destination-wins) leak", () => {
    const c = one({
      ...noHosts,
      readLayer1: () => cfg({ orchestration: { worktreeRefresh: { enabled: true } } }),
    });
    expect(c.status).toBe(STATUS.FAIL);
    expect(c.detail).toContain("catalyst.orchestration.worktreeRefresh");
    expect(c.detail).toContain("SHADOWED");
    expect(c.detail).not.toContain("OVERRIDES");
  });

  test("a mixed leak names BOTH consequences, each against its own knob", () => {
    const c = one({
      ...noHosts,
      readLayer1: () =>
        cfg({
          sweep: { idleHours: 48 },
          orchestration: { worktreeRefresh: { enabled: true } },
        }),
    });
    expect(c.status).toBe(STATUS.FAIL);
    // Scope the assertions to the CONSEQUENCE clause. The leak enumeration ahead
    // of it already names every leaked key, so a bare indexOf over the whole
    // detail matches there and proves nothing about the per-knob attribution.
    const marker = "Precedence differs by knob — ";
    const at = c.detail.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const clause = c.detail.slice(at + marker.length);
    const overrides = clause.indexOf("OVERRIDES");
    const shadowed = clause.indexOf("SHADOWED");
    expect(overrides).toBeGreaterThan(-1);
    expect(shadowed).toBeGreaterThan(-1);
    // sweep is the layer1-wins row, so within the clause it sits on the
    // OVERRIDES side; worktreeRefresh (destination-wins) sits on the SHADOWED side.
    expect(clause.indexOf("catalyst.sweep")).toBeLessThan(overrides);
    expect(clause.indexOf("catalyst.orchestration.worktreeRefresh")).toBeGreaterThan(overrides);
    expect(clause.indexOf("catalyst.orchestration.worktreeRefresh")).toBeLessThan(shadowed);
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
