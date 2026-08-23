// scope-keys.test.mjs — CTL-2129 Phase 1. The scopeKeys writer is what makes
// resolveSteward return non-null: a role's manifest declares which scope keys
// (Linear project ids) it owns, and the escalation router keys off that array.
//
// Placed top-level in role-supervisor/ (not __tests__/) to match the existing
// supervisor.test.mjs / quiet-fleet.test.mjs convention and run-tests.sh's
// `../role-supervisor/*.test.mjs` glob — a test in a __tests__/ subdir would not
// be gated. Run from broker/ under `bun test ../role-supervisor/scope-keys.test.mjs`.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setScopeKeys, readManifest, writeManifest } from "./state.mjs";
import { resolveSteward } from "../execution-core/escalation-router.mjs";
import { listRoles } from "./doctor.mjs";

const dirs = [];
function tmpEnv() {
  const d = mkdtempSync(join(tmpdir(), "ctl2129-sk-"));
  dirs.push(d);
  return { CATALYST_DIR: d };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("setScopeKeys creates scopeKeys when the manifest lacks it", () => {
  const env = tmpEnv();
  const next = setScopeKeys("steward-x", ["proj-uuid-1"], env);
  expect(next).toEqual(["proj-uuid-1"]);
  expect(readManifest("steward-x", env).scopeKeys).toEqual(["proj-uuid-1"]);
});

test("setScopeKeys merges into an existing manifest, preserving scope/skill/cwd", () => {
  const env = tmpEnv();
  writeManifest(
    "steward-x",
    { role: "steward-x", scope: "P13 · Coordination SOP", skill: "catalyst-dev:steward", cwd: "/repo" },
    env,
  );
  setScopeKeys("steward-x", ["proj-uuid-1"], env);
  const m = readManifest("steward-x", env);
  expect(m.scope).toBe("P13 · Coordination SOP");
  expect(m.skill).toBe("catalyst-dev:steward");
  expect(m.cwd).toBe("/repo");
  expect(m.scopeKeys).toEqual(["proj-uuid-1"]);
});

test("setScopeKeys dedupes and is idempotent, order-stable across calls", () => {
  const env = tmpEnv();
  setScopeKeys("steward-x", ["a", "b"], env);
  const next = setScopeKeys("steward-x", ["b", "c"], env); // merge, dedupe b
  expect(next).toEqual(["a", "b", "c"]);
  // A repeat call with the same keys changes nothing.
  expect(setScopeKeys("steward-x", ["a", "b", "c"], env)).toEqual(["a", "b", "c"]);
  // Empty/whitespace/non-string keys are filtered out, never written.
  expect(setScopeKeys("steward-x", ["", null, 7], env)).toEqual(["a", "b", "c"]);
});

test("resolveSteward matches a populated scopeKey and misses a non-key (end-to-end)", () => {
  const env = tmpEnv();
  setScopeKeys("steward-x", ["proj-uuid-1"], env);
  const deps = {
    listRoles: () => listRoles(env),
    readManifest: (r) => readManifest(r, env),
  };
  expect(resolveSteward("proj-uuid-1", deps)).toEqual({ role: "steward-x", scope: "proj-uuid-1" });
  expect(resolveSteward("proj-uuid-2", deps)).toBeNull();
});

test("setScopeKeys is fail-open on a fresh role: the role dir is created and only scopeKeys is set", () => {
  const env = tmpEnv();
  setScopeKeys("steward-fresh", ["p1"], env);
  expect(existsSync(join(env.CATALYST_DIR, "roles", "steward-fresh", "manifest.json"))).toBe(true);
  const raw = JSON.parse(readFileSync(join(env.CATALYST_DIR, "roles", "steward-fresh", "manifest.json"), "utf8"));
  expect(raw).toEqual({ role: "steward-fresh", scopeKeys: ["p1"] });
});
