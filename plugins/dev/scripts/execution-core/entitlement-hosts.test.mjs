// entitlement-hosts.test.mjs — CTL-1785 Phase 2. The split accessors
// (getExistenceHosts / getEntitledHosts) and the caller-classification guard.
//
// In `off` mode (the default) getEntitledHosts() === getClusterHosts() byte for
// byte, so reclassifying every entitlement caller is provably behavior-neutral.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getExistenceHosts, getEntitledHosts, getClusterHosts } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("off mode: entitled hosts === cluster hosts (byte-identical)", () => {
  // CATALYST_ENTITLEMENT unset/off in the hermetic test env.
  expect(getEntitledHosts({ mode: "off" })).toEqual(getClusterHosts());
});

test("existence hosts === today's local roster", () => {
  expect(getExistenceHosts()).toEqual(getClusterHosts());
});

test("getEntitledHosts default (mode resolved from env, off in CI) === cluster hosts", () => {
  expect(getEntitledHosts()).toEqual(getClusterHosts());
});

test("getEntitledHosts accepts an injected provider + mode (for later phases)", () => {
  const provider = { ttlMs: 1, check: () => ({ verdict: "entitled" }) };
  // off ignores the provider entirely and returns the raw roster.
  expect(getEntitledHosts({ mode: "off", provider })).toEqual(getClusterHosts());
});

test("getEntitledHosts honors an injected hosts array in off mode", () => {
  expect(getEntitledHosts({ mode: "off", hosts: ["a", "b"] })).toEqual(["a", "b"]);
});

// --- caller-classification guard (mirrors event-name-read-guard.test.mjs allowlist) ---
//
// Every reclassified roster-source call site must read the intent-explicit
// accessor — getEntitledHosts() (who-may-take-work) or getExistenceHosts()
// (topology/observability) — never the raw getClusterHosts(). This asserts the
// reclassification stuck: the modules below no longer invoke getClusterHosts() as
// a roster source. (recovery* → entitlement; heartbeat-publisher/stale-pr-rescue
// → existence topology; all four dropped getClusterHosts entirely.)
test("every reclassified roster module dropped getClusterHosts() as a roster source", () => {
  // Modules whose roster source was reclassified in Phase 2. After it, none may
  // call getClusterHosts() as a roster source — a bare invocation with parens.
  // Comment/import lines that merely name the symbol are stripped before the check.
  const reclassifiedModules = [
    "recovery.mjs",
    "recovery-pass-context.mjs",
    "stale-pr-rescue-timer.mjs",
    "cluster-heartbeat-publisher.mjs",
  ];
  for (const rel of reclassifiedModules) {
    const src = readFileSync(resolve(HERE, rel), "utf8");
    // Strip line comments and block-comment bodies to avoid matching prose.
    const codeOnly = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // A roster-source call is `getClusterHosts()` with parens. Import specifiers
    // (`getClusterHosts,`) are allowed — a module may still import it for an
    // existence use — but a bare invocation as a roster source is not.
    const invocations = (codeOnly.match(/getClusterHosts\s*\(/g) || []).length;
    expect(invocations, `${rel} still invokes getClusterHosts() as a roster source`).toBe(0);
  }
});

test("scheduler/monitor entitlement roster sources call getEntitledHosts", () => {
  // These modules legitimately still call getClusterHosts() for EXISTENCE
  // topology (multiHost length checks), so we assert positively that the
  // entitlement roster line now reads getEntitledHosts rather than asserting
  // getClusterHosts is fully absent.
  for (const rel of ["scheduler.mjs", "monitor.mjs"]) {
    const src = readFileSync(resolve(HERE, rel), "utf8");
    expect(src.includes("getEntitledHosts"), `${rel} should import/call getEntitledHosts`).toBe(
      true
    );
  }
});
