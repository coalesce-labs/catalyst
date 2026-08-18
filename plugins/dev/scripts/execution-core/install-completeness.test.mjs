// install-completeness.test.mjs — CTL-1918.
//
// checkInstallCompleteness answers "did the install FINISH", so its whole value is in
// the difference between a step that did not happen and a step it could not measure.
// These tests hold that distinction: every "missing" assertion is paired with an
// "unknown" one over the same leg, because a check that reports a missing step for a
// file it merely failed to open sends an operator to repair something that was never
// broken — and reads identically in the report.

import { describe, expect, test } from "bun:test";
import { checkInstallCompleteness } from "./doctor.mjs";

const HOME = "/seal/home";

// A node where everything landed. Each test below removes exactly one thing from this,
// so a failure names the leg rather than the fixture.
function completeDeps(over = {}) {
  const present = new Set([
    "/seal/home/.catalyst/bin/catalyst-stack",
    "/seal/home/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist",
    "/seal/home/catalyst/execution-core/registry.json",
  ]);
  return {
    env: {},
    home: HOME,
    platform: "darwin",
    layer2: "/seal/layer2.json",
    registryPath: "/seal/home/catalyst/execution-core/registry.json",
    exists: (p) => present.has(p),
    readJson: (p) =>
      p === "/seal/layer2.json"
        ? {
            ok: true,
            value: {
              catalyst: { orchestration: { pluginDirs: ["/seal/plugin-source/plugins/dev"] } },
            },
          }
        : { ok: true, value: { projects: [{ team: "WIDGET" }] } },
    _present: present,
    ...over,
  };
}

describe("⛔ THE DEFAULTS RUN — every test below this injects them, which is how the bug shipped", () => {
  test("calling with NO deps at all does not throw", () => {
    // `catalyst-doctor` calls this with no arguments. When the check was extracted from
    // doctor.mjs it kept using doctor's `layer2Path()` as a DEFAULT PARAMETER, which is
    // not in scope here — so the real entry point died with
    // `ReferenceError: layer2Path is not defined` on every host, while every test in this
    // file passed. They all injected `layer2`, so the default was never evaluated.
    //
    // This is the only assertion in the file that exercises the production call shape.
    // Its value is not the returned status — it is that the function RUNS.
    expect(() => checkInstallCompleteness()).not.toThrow();
  });

  test("the no-deps call returns a well-formed check", () => {
    const r = checkInstallCompleteness();
    expect(r.name).toBe("install-completeness");
    expect(["pass", "warn", "info"]).toContain(r.status);
    expect(typeof r.detail).toBe("string");
  });

  test("an env-only override still resolves every other default", () => {
    // Half-injected is the shape most likely to hide a missing default.
    expect(() => checkInstallCompleteness({ env: { CATALYST_BIN_DIR: "/nope" } })).not.toThrow();
  });
});

describe("checkInstallCompleteness", () => {
  test("a finished install PASSes", () => {
    const r = checkInstallCompleteness(completeDeps());
    expect(r.status).toBe("pass");
    expect(r.name).toBe("install-completeness");
  });

  test("⛔ never FAILs, whatever is missing — doctor's FAIL count gates worker activation", () => {
    const r = checkInstallCompleteness(
      completeDeps({
        exists: () => false,
        readJson: () => ({ ok: false, value: null }),
      })
    );
    expect(r.status).not.toBe("fail");
  });

  test("missing CLIs are named, not merely counted", () => {
    const d = completeDeps();
    d._present.delete("/seal/home/.catalyst/bin/catalyst-stack");
    const r = checkInstallCompleteness(d);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("cli");
    expect(r.detail).toContain("INCOMPLETE");
  });

  test("an absent pluginDirs key is missing", () => {
    const r = checkInstallCompleteness(
      completeDeps({
        readJson: (p) =>
          p === "/seal/layer2.json"
            ? { ok: true, value: { catalyst: { orchestration: {} } } }
            : { ok: true, value: { projects: [{ team: "W" }] } },
      })
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("plugin-source");
  });

  test("⛔ an UNREADABLE Layer-2 config is unknown, NOT missing", () => {
    const r = checkInstallCompleteness(
      completeDeps({
        readJson: (p) =>
          p === "/seal/layer2.json"
            ? { ok: false, value: null }
            : { ok: true, value: { projects: [{ team: "W" }] } },
      })
    );
    // Nothing is actually absent, so this must not accuse the operator of a missing step.
    expect(r.status).toBe("info");
    expect(r.detail).toContain("could not be measured");
    expect(r.detail).not.toContain("INCOMPLETE");
  });

  test("⛔ a non-macOS host is unknown for orphan-sweep, not missing", () => {
    const d = completeDeps({ platform: "linux" });
    d._present.delete("/seal/home/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist");
    const r = checkInstallCompleteness(d);
    expect(r.status).toBe("info");
    expect(r.detail).toContain("not macOS");
  });

  test("an empty registry is missing — a daemon with no work looks exactly like a broken one", () => {
    const r = checkInstallCompleteness(
      completeDeps({
        readJson: (p) =>
          p === "/seal/layer2.json"
            ? { ok: true, value: { catalyst: { orchestration: { pluginDirs: ["/x"] } } } }
            : { ok: true, value: { projects: [] } },
      })
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("registry");
    expect(r.detail).toContain("0 project(s)");
  });

  test("⛔ an unreadable registry that EXISTS is unknown, not empty", () => {
    const r = checkInstallCompleteness(
      completeDeps({
        readJson: (p) =>
          p === "/seal/layer2.json"
            ? { ok: true, value: { catalyst: { orchestration: { pluginDirs: ["/x"] } } } }
            : { ok: false, value: null },
      })
    );
    expect(r.status).toBe("info");
    expect(r.detail).toContain("unreadable");
  });

  test("an ABSENT registry file is missing (distinct from unreadable)", () => {
    const d = completeDeps();
    d._present.delete("/seal/home/catalyst/execution-core/registry.json");
    const r = checkInstallCompleteness(d);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("no registry at");
  });

  test("CATALYST_BIN_DIR is honoured — a relocated install is not reported as missing", () => {
    const present = new Set([
      "/custom/bin/catalyst-stack",
      "/seal/home/Library/LaunchAgents/ai.coalesce.catalyst-orphan-sweep.plist",
      "/seal/home/catalyst/execution-core/registry.json",
    ]);
    const r = checkInstallCompleteness(
      completeDeps({ env: { CATALYST_BIN_DIR: "/custom/bin" }, exists: (p) => present.has(p) })
    );
    expect(r.status).toBe("pass");
  });
});
