// state.test.mjs — CTL-2095. Tests for writeActivity and markComplete.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifest, readManifest, writeActivity, markComplete } from "./state.mjs";
import { roleFiles } from "./paths.mjs";
import { mkdirSync } from "node:fs";

let passes = 0, failures = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS: ${name}`); passes++; }
  catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failures++; }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "state-test-"));
  const env = { CATALYST_DIR: dir };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedRole(env, role, manifest = {}) {
  mkdirSync(roleFiles(role, env).dir, { recursive: true });
  writeManifest(role, { role, scope: "test", skill: "catalyst-dev:steward", cwd: "/tmp", activity: {}, scope_active: true, ...manifest }, env);
}

console.log("1. writeActivity: merges into manifest.activity");
t("writeActivity({inFlightTickets:2}) merges without clobbering other fields", () => {
  const s = scratch();
  seedRole(s.env, "r1", { activity: { inFlightTickets: 0, openAsksRaised: 5 } });
  writeActivity("r1", { inFlightTickets: 2 }, s.env);
  const m = readManifest("r1", s.env);
  assert.equal(m.activity.inFlightTickets, 2, "inFlightTickets should be updated");
  assert.equal(m.activity.openAsksRaised, 5, "openAsksRaised should be preserved (not clobbered)");
  assert.equal(m.scope, "test", "top-level manifest fields must not be clobbered");
  s.cleanup();
});

t("writeActivity result is visible via readManifest", () => {
  const s = scratch();
  seedRole(s.env, "r2", { activity: {} });
  writeActivity("r2", { inFlightTickets: 7, openAsksRaised: 1, humanCommentNewerThanLastReply: true }, s.env);
  const m = readManifest("r2", s.env);
  assert.equal(m.activity.inFlightTickets, 7);
  assert.equal(m.activity.openAsksRaised, 1);
  assert.equal(m.activity.humanCommentNewerThanLastReply, true);
  s.cleanup();
});

t("writeActivity is atomic (manifest readable after write)", () => {
  const s = scratch();
  seedRole(s.env, "r3", { activity: {} });
  writeActivity("r3", { inFlightTickets: 3 }, s.env);
  // If the write is atomic, readManifest should never return null or partial data.
  const m = readManifest("r3", s.env);
  assert.ok(m !== null, "manifest must be readable after writeActivity");
  assert.equal(m.activity.inFlightTickets, 3);
  s.cleanup();
});

console.log("2. markComplete: zeroes activity and sets scope_active:false");
t("markComplete sets scope_active:false and zeroes all activity fields", () => {
  const s = scratch();
  seedRole(s.env, "r4", { activity: { inFlightTickets: 2, openAsksRaised: 1, humanCommentNewerThanLastReply: true }, scope_active: true });
  markComplete("r4", s.env);
  const m = readManifest("r4", s.env);
  assert.equal(m.scope_active, false, "scope_active must be false");
  assert.equal(m.activity.inFlightTickets ?? 0, 0, "inFlightTickets must be zeroed");
  assert.equal(m.activity.openAsksRaised ?? 0, 0, "openAsksRaised must be zeroed");
  assert.equal(m.activity.humanCommentNewerThanLastReply ?? false, false, "humanCommentNewerThanLastReply must be false");
  s.cleanup();
});

t("markComplete does not clobber other manifest fields", () => {
  const s = scratch();
  seedRole(s.env, "r5", { scope: "P13 · MyScope", activity: { inFlightTickets: 1 }, scope_active: true });
  markComplete("r5", s.env);
  const m = readManifest("r5", s.env);
  assert.equal(m.scope, "P13 · MyScope", "scope must be preserved");
  assert.equal(m.skill, "catalyst-dev:steward", "skill must be preserved");
  s.cleanup();
});

console.log(`\nstate.test.mjs: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
