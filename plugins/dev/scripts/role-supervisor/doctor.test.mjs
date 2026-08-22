// doctor.test.mjs — CTL-2095. Tests for the completed/stopped visibility fix.
// A deliberately-stopped role must NOT be rendered as a red DEAD row.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleRow, formatReport, report } from "./doctor.mjs";
import { writeManifest, beat } from "./state.mjs";
import { roleFiles } from "./paths.mjs";

let passes = 0, failures = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS: ${name}`); passes++; }
  catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failures++; }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  const env = { CATALYST_DIR: dir };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedRole(env, role, { manifest = {}, heartbeatState = "running", heartbeatAgeMs = 0 } = {}) {
  mkdirSync(roleFiles(role, env).dir, { recursive: true });
  writeManifest(role, {
    role, scope: "P13", skill: "catalyst-dev:steward", cwd: "/tmp",
    activity: {}, scope_active: true, status_doc_updated_at: Date.now() - 60_000,
    ...manifest,
  }, env);
  const now = Date.now() - heartbeatAgeMs;
  beat(role, { now, state: heartbeatState, scope: "P13" }, env);
}

const FORTY_FIVE_MIN_MS = 45 * 60 * 1000;

// ── The load-bearing case: a stopped role must not be DEAD ──────────────────
console.log("1. a stopped role is NOT rendered as dead");
t("heartbeat state=stopped aged 45 min → liveness=stopped, red=false", () => {
  const s = scratch();
  seedRole(s.env, "done-role", {
    manifest: { scope_active: false },
    heartbeatState: "stopped",
    heartbeatAgeMs: FORTY_FIVE_MIN_MS,
  });
  const now = Date.now();
  const row = roleRow("done-role", { now }, s.env);
  assert.equal(row.red, false, `stopped role must not be red; problems: ${JSON.stringify(row.problems)}`);
  assert.notEqual(row.liveness, "dead", "liveness must not be 'dead' for a deliberately stopped role");
  assert.ok(
    row.liveness === "stopped" || row.liveness === "completed",
    `liveness should be 'stopped' or 'completed', got '${row.liveness}'`,
  );
  assert.equal(row.problems.length, 0, `no problems expected for a completed role; got: ${JSON.stringify(row.problems)}`);
  s.cleanup();
});

t("scope_active=false + stopped heartbeat → liveness=completed (the AC4 name)", () => {
  const s = scratch();
  seedRole(s.env, "completed-role", {
    manifest: { scope_active: false },
    heartbeatState: "stopped",
    heartbeatAgeMs: FORTY_FIVE_MIN_MS,
  });
  const row = roleRow("completed-role", { now: Date.now() }, s.env);
  // When the scope is quiet AND the heartbeat says stopped, the preferred liveness label is "completed".
  assert.equal(row.liveness, "completed", `expected 'completed', got '${row.liveness}'`);
  s.cleanup();
});

t("formatReport renders a completed role as a pass line, not FAIL", () => {
  const s = scratch();
  seedRole(s.env, "fmtdone", {
    manifest: { scope_active: false },
    heartbeatState: "stopped",
    heartbeatAgeMs: FORTY_FIVE_MIN_MS,
  });
  const rep = report({ now: Date.now() }, s.env);
  const out = formatReport(rep);
  assert.match(out, /pass.*fmtdone|fmtdone.*pass/, "completed role must appear as 'pass'");
  assert.doesNotMatch(out.toUpperCase(), /FAIL.*fmtdone|fmtdone.*FAIL/, "completed role must NOT appear as 'FAIL'");
  s.cleanup();
});

// ── Positive control: a RUNNING role that went silent is still dead ──────────
console.log("2. positive control: a running-but-silent role is still DEAD");
t("heartbeat state=running aged 45 min → liveness=dead, red=true", () => {
  const s = scratch();
  seedRole(s.env, "wedged-role", {
    manifest: { scope_active: true },
    heartbeatState: "running",
    heartbeatAgeMs: FORTY_FIVE_MIN_MS,
  });
  const row = roleRow("wedged-role", { now: Date.now() }, s.env);
  assert.equal(row.liveness, "dead", `expected dead for silent running role, got '${row.liveness}'`);
  assert.equal(row.red, true, "a dead running role must be red");
  s.cleanup();
});

t("scope_active=true + stopped heartbeat = NOT completed (the role stopped while work was in flight)", () => {
  const s = scratch();
  seedRole(s.env, "premature-stop", {
    manifest: { scope_active: true },
    heartbeatState: "stopped",
    heartbeatAgeMs: FORTY_FIVE_MIN_MS,
  });
  const row = roleRow("premature-stop", { now: Date.now() }, s.env);
  // A role that stopped while scope was still active is NOT "completed" — it just stopped.
  // It should still be recognisable as stopped (not dead) but may carry a warning.
  assert.notEqual(row.liveness, "dead", "stopped heartbeat → not dead (the heartbeat is the evidence)");
  assert.notEqual(row.liveness, "completed", "scope still active → not completed");
  s.cleanup();
});

// ── Never-booted role stays MISSING ─────────────────────────────────────────
console.log("3. a role that never booted stays MISSING");
t("no heartbeat → liveness=missing, red=true", () => {
  const s = scratch();
  mkdirSync(roleFiles("never-booted", s.env).dir, { recursive: true });
  writeManifest("never-booted", { role: "never-booted", scope: "x", skill: "catalyst-dev:steward", cwd: "/tmp", activity: {}, scope_active: true }, s.env);
  // No beat() call.
  const row = roleRow("never-booted", { now: Date.now() }, s.env);
  assert.equal(row.liveness, "missing", `expected missing, got '${row.liveness}'`);
  assert.equal(row.red, true, "a role that never booted must be red");
  s.cleanup();
});

console.log(`\ndoctor.test.mjs: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
