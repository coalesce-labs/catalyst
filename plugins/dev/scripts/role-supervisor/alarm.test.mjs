// alarm.test.mjs — CTC-2981. The out-of-fleet instruments raise their alarm on
// the shared event log as catalyst.alert.{raised,cleared}, the topic the board's
// fleet-alert strip already folds. Pinned here: the event names match the
// broker's, the envelope folds into a board row, the append is what "delivered"
// means, and the quiet-fleet / holding-sentinel shells clear the alert once no
// role is latched.
//
// Top-level in role-supervisor/ so run-tests.sh's `../role-supervisor/*.test.mjs`
// glob gates it.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALERT_RAISED,
  ALERT_CLEARED,
  ROLE_ALARM_KIND,
  ROLE_ALARM_SERVICE,
  ALARM_REFRESH_MS,
  buildRoleAlarmEnvelope,
  emitRoleAlarm,
  eventLogPath,
} from "./alarm.mjs";
import { ALERT_RAISED as BROKER_RAISED, ALERT_CLEARED as BROKER_CLEARED } from "../broker/alert-emit.mjs";
import { foldFleetAlerts, ALERT_KIND_TITLES } from "../orch-monitor/lib/fleet-alerts.mjs";
import { runQuietFleetOnce } from "./quiet-fleet.mjs";
import { runHoldingSentinelOnce } from "./holding-sentinel.mjs";
import { roleFiles } from "./paths.mjs";

const now = Date.UTC(2026, 8, 25, 12, 0, 0);
const M = 60_000;
const quiet = { write: () => true };

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "role-alarm-test-"));
  return { dir, env: { CATALYST_DIR: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedRole(env, role, ageMs) {
  const f = roleFiles(role, env);
  mkdirSync(f.dir, { recursive: true });
  writeFileSync(f.manifest, JSON.stringify({ role, scope: role, scope_active: true }));
  writeFileSync(f.heartbeat, JSON.stringify({ role, ts: now - ageMs, pid: 1 }));
}

const readLog = (env) =>
  readFileSync(eventLogPath({ env, now }), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("the alert event names match the broker's alert topic", () => {
  expect(ALERT_RAISED).toBe(BROKER_RAISED);
  expect(ALERT_CLEARED).toBe(BROKER_CLEARED);
});

test("every role-alarm kind has a board title", () => {
  for (const kind of Object.values(ROLE_ALARM_KIND)) expect(ALERT_KIND_TITLES[kind]).toBeTruthy();
});

test("a raised envelope folds into one board row, and its clear removes it", () => {
  const raised = buildRoleAlarmEnvelope(
    { action: "raised", kind: ROLE_ALARM_KIND.CONCIERGE_DEAD, instrument: "dead-man", reason: "down", source: "concierge", target: "ask" },
    { now },
  );
  expect(raised.resource["service.name"]).toBe(ROLE_ALARM_SERVICE);
  expect(raised.severityText).toBe("ERROR");
  expect(raised.attributes["event.label"]).toBe("concierge_dead");
  const rows = foldFleetAlerts([raised]);
  expect(rows).toHaveLength(1);
  expect(rows[0].reason).toBe("down");

  const cleared = buildRoleAlarmEnvelope({ action: "cleared", kind: ROLE_ALARM_KIND.CONCIERGE_DEAD, instrument: "dead-man" }, { now });
  expect(foldFleetAlerts([raised, cleared])).toHaveLength(0);
});

test("emitRoleAlarm appends to the UTC-month event log under CATALYST_DIR and writes one stderr line", () => {
  const s = scratch();
  const err = [];
  const ok = emitRoleAlarm(
    { action: "raised", kind: ROLE_ALARM_KIND.ROLE_SILENT, instrument: "quiet-fleet", reason: "r", source: "steward-x" },
    { env: s.env, now, stderr: { write: (l) => err.push(l) } },
  );
  expect(ok).toBe(true);
  expect(eventLogPath({ env: s.env, now })).toBe(join(s.dir, "events", "2026-09.jsonl"));
  expect(readLog(s.env)).toHaveLength(1);
  expect(err).toHaveLength(1);
  expect(err[0]).toContain("quiet-fleet alert raised role_silent (steward-x)");
  s.cleanup();
});

test("emitRoleAlarm returns false, never throws, when the event log cannot be written", () => {
  const s = scratch();
  mkdirSync(join(s.dir, "events"));
  chmodSync(join(s.dir, "events"), 0o500);
  const ok = emitRoleAlarm({ action: "raised", kind: ROLE_ALARM_KIND.ROLE_SILENT, instrument: "quiet-fleet" }, { env: s.env, now, stderr: quiet });
  chmodSync(join(s.dir, "events"), 0o700);
  expect(ok).toBe(false);
  s.cleanup();
});

test("quiet-fleet raises for a silent role, and clears only once no role is latched", () => {
  const s = scratch();
  const calls = [];
  const postPage = (page) => { calls.push(["raised", page.role]); return true; };
  const clearPages = () => { calls.push(["cleared"]); return true; };
  seedRole(s.env, "a", 12 * M);
  seedRole(s.env, "b", 12 * M);
  runQuietFleetOnce({ now, env: s.env, roles: ["a", "b"], postPage, clearPages });
  expect(calls).toEqual([["raised", "a"], ["raised", "b"]]);

  seedRole(s.env, "a", 1 * M); // a recovers, b still silent → no clear
  const mid = runQuietFleetOnce({ now, env: s.env, roles: ["a", "b"], postPage, clearPages });
  expect(mid.recovered).toEqual(["a"]);
  expect(mid.cleared).toBe(false);

  seedRole(s.env, "b", 1 * M); // b recovers too → clear
  const done = runQuietFleetOnce({ now, env: s.env, roles: ["a", "b"], postPage, clearPages });
  expect(done.cleared).toBe(true);
  expect(calls.at(-1)).toEqual(["cleared"]);
  s.cleanup();
});

test("holding-sentinel raises role_restarting on the event log and clears it when the role beats again", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 16 * M);
  const noRestart = () => false;
  const first = runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart: noRestart });
  expect(first.acted[0].posted).toBe(true);

  seedRole(s.env, "steward-x", 1 * M);
  const second = runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart: noRestart });
  expect(second.cleared).toBe(true);

  const log = readLog(s.env);
  expect(log.map((e) => e.attributes["event.name"])).toEqual([ALERT_RAISED, ALERT_CLEARED]);
  expect(log.every((e) => e.attributes["event.label"] === "role_restarting")).toBe(true);
  expect(log[0].body.payload.reason).toContain("steward/steward-x is being restarted");
  s.cleanup();
});

// ── CTC-2981 review: month rotation and durable clears ──────────────────────
const lastMonth = Date.UTC(2026, 7, 31, 23, 0, 0);
const latchFile = (env, role, name) => join(roleFiles(role, env).dir, name);
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const exists = (f) => { try { readFileSync(f); return true; } catch { return false; } };

// Make this month's event log unwritable; returns the undo.
function lockLog(env) {
  const dir = join(env.CATALYST_DIR, "events");
  const file = eventLogPath({ env, now });
  mkdirSync(dir, { recursive: true });
  if (exists(file)) chmodSync(file, 0o400);
  chmodSync(dir, 0o500);
  return () => {
    chmodSync(dir, 0o700);
    if (exists(file)) chmodSync(file, 0o600);
  };
}

test("quiet-fleet: a latch raised last month is raised again into this month's log while the role is still silent, once", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 40 * M);
  const f = latchFile(s.env, "steward-x", ".quiet-fleet-latch.json");
  writeFileSync(f, JSON.stringify({ role: "steward-x", liveness: "dead", count: 1, first_paged_at: lastMonth, last_paged_at: lastMonth, posted: true, target: "concierge", tag: "instrument/quiet-fleet", log_month: "2026-08", logged_at: lastMonth }));

  const r = runQuietFleetOnce({ now, env: s.env, roles: ["steward-x"] });
  expect(r.pages).toHaveLength(0);
  expect(r.reraised).toEqual([{ role: "steward-x", posted: true }]);
  const log = readLog(s.env);
  expect(log).toHaveLength(1);
  expect(log[0].attributes["event.name"]).toBe(ALERT_RAISED);
  expect(log[0].attributes["event.label"]).toBe("role_silent");
  expect(log[0].body.payload.source).toBe("steward-x");
  expect(readJson(f).log_month).toBe("2026-09");
  expect(readJson(f).count).toBe(1); // a re-raise does not advance the escalation ladder

  const again = runQuietFleetOnce({ now: now + M, env: s.env, roles: ["steward-x"] });
  expect(again.reraised).toEqual([]);
  expect(readLog(s.env)).toHaveLength(1);
  s.cleanup();
});

test("holding-sentinel: a reply latched last month is raised again this month, without a second restart", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 40 * M);
  const f = latchFile(s.env, "steward-x", ".holding-sentinel-latch.json");
  writeFileSync(f, JSON.stringify({ role: "steward-x", silence_ms: 16 * M, posted: true, restart_requested: true, posted_at: lastMonth, log_month: "2026-08", logged_at: lastMonth }));
  let restarts = 0;
  const requestRestart = () => { restarts += 1; return true; };

  const r = runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart });
  expect(r.reraised).toEqual([{ role: "steward-x", posted: true }]);
  expect(restarts).toBe(0);
  const log = readLog(s.env);
  expect(log).toHaveLength(1);
  expect(log[0].attributes["event.label"]).toBe("role_restarting");
  expect(readJson(f).log_month).toBe("2026-09");

  runHoldingSentinelOnce({ now: now + M, env: s.env, roles: ["steward-x"], requestRestart });
  expect(readLog(s.env)).toHaveLength(1);
  s.cleanup();
});

test("quiet-fleet: an unwritable log keeps the latch on recovery, and a later tick clears it", () => {
  const s = scratch();
  const f = latchFile(s.env, "steward-x", ".quiet-fleet-latch.json");
  seedRole(s.env, "steward-x", 40 * M);
  runQuietFleetOnce({ now, env: s.env, roles: ["steward-x"] });
  expect(exists(f)).toBe(true);

  seedRole(s.env, "steward-x", 1 * M);
  const unlock = lockLog(s.env);
  const failed = runQuietFleetOnce({ now, env: s.env, roles: ["steward-x"] });
  unlock();
  expect(failed.cleared).toBe(false);
  expect(exists(f)).toBe(true);

  const ok = runQuietFleetOnce({ now, env: s.env, roles: ["steward-x"] });
  expect(ok.cleared).toBe(true);
  expect(exists(f)).toBe(false);
  expect(readLog(s.env).map((e) => e.attributes["event.name"])).toEqual([ALERT_RAISED, ALERT_CLEARED]);
  s.cleanup();
});

test("holding-sentinel: an unwritable log keeps the latch on recovery, and a later tick clears it", () => {
  const s = scratch();
  const f = latchFile(s.env, "steward-x", ".holding-sentinel-latch.json");
  const requestRestart = () => false;
  seedRole(s.env, "steward-x", 16 * M);
  runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart });
  expect(exists(f)).toBe(true);

  seedRole(s.env, "steward-x", 1 * M);
  const unlock = lockLog(s.env);
  const failed = runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart });
  unlock();
  expect(failed.cleared).toBe(false);
  expect(exists(f)).toBe(true);

  const ok = runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart });
  expect(ok.cleared).toBe(true);
  expect(exists(f)).toBe(false);
  expect(readLog(s.env).map((e) => e.attributes["event.name"])).toEqual([ALERT_RAISED, ALERT_CLEARED]);
  s.cleanup();
});

test("quiet-fleet: a pre-upgrade latch (no log_month) from earlier THIS month is raised on the next tick", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 40 * M);
  const f = latchFile(s.env, "steward-x", ".quiet-fleet-latch.json");
  writeFileSync(f, JSON.stringify({ role: "steward-x", liveness: "dead", count: 1, first_paged_at: now - 10 * M, last_paged_at: now - 10 * M, posted: true }));
  const r = runQuietFleetOnce({ now, env: s.env, roles: ["steward-x"] });
  expect(r.reraised).toEqual([{ role: "steward-x", posted: true }]);
  expect(readLog(s.env)).toHaveLength(1);
  expect(readJson(f).logged_at).toBe(now);
  s.cleanup();
});

test("holding-sentinel: a pre-upgrade latch (no log_month) from earlier THIS month is raised on the next tick", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 40 * M);
  const f = latchFile(s.env, "steward-x", ".holding-sentinel-latch.json");
  writeFileSync(f, JSON.stringify({ role: "steward-x", silence_ms: 16 * M, posted: true, restart_requested: true, posted_at: now - 10 * M }));
  const r = runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart: () => true });
  expect(r.reraised).toEqual([{ role: "steward-x", posted: true }]);
  expect(readLog(s.env)).toHaveLength(1);
  s.cleanup();
});

test("quiet-fleet: a standing alarm is raised again once ALARM_REFRESH_MS has passed, without a new page", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 40 * M);
  const f = latchFile(s.env, "steward-x", ".quiet-fleet-latch.json");
  expect(runQuietFleetOnce({ now, env: s.env, roles: ["steward-x"] }).pages).toHaveLength(1);

  const early = runQuietFleetOnce({ now: now + ALARM_REFRESH_MS - M, env: s.env, roles: ["steward-x"] });
  expect(early.reraised).toEqual([]);
  expect(readLog(s.env)).toHaveLength(1);

  const due = runQuietFleetOnce({ now: now + ALARM_REFRESH_MS, env: s.env, roles: ["steward-x"] });
  expect(due.pages).toHaveLength(0);
  expect(due.reraised).toEqual([{ role: "steward-x", posted: true }]);
  expect(readLog(s.env).map((e) => e.attributes["event.name"])).toEqual([ALERT_RAISED, ALERT_RAISED]);
  expect(readJson(f).count).toBe(1);
  expect(readJson(f).logged_at).toBe(now + ALARM_REFRESH_MS);
  s.cleanup();
});

test("holding-sentinel: a standing alarm is raised again once ALARM_REFRESH_MS has passed, without a restart", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 16 * M);
  let restarts = 0;
  const requestRestart = () => { restarts += 1; return true; };
  runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart });
  expect(restarts).toBe(1);

  runHoldingSentinelOnce({ now: now + ALARM_REFRESH_MS - M, env: s.env, roles: ["steward-x"], requestRestart });
  expect(readLog(s.env)).toHaveLength(1);

  const due = runHoldingSentinelOnce({ now: now + ALARM_REFRESH_MS, env: s.env, roles: ["steward-x"], requestRestart });
  expect(due.reraised).toEqual([{ role: "steward-x", posted: true }]);
  expect(readLog(s.env)).toHaveLength(2);
  expect(restarts).toBe(1);
  s.cleanup();
});

// ── CTC-2981 round 3: the page names the rung the router selected ───────────
// No path delivers into a running steward/concierge session (see quiet-fleet.mjs
// defaultPostPage), so the alert itself must say who has to act.
test("quiet-fleet: a silent role in a steward's scope raises an alert addressed to that steward", () => {
  const s = scratch();
  seedRole(s.env, "worker-role", 40 * M);
  seedRole(s.env, "steward-p13", 1 * M);
  const m = roleFiles("steward-p13", s.env).manifest;
  writeFileSync(m, JSON.stringify({ role: "steward-p13", scope: "P13", scope_active: true, scopeKeys: ["worker-role"] }));

  const r = runQuietFleetOnce({ now, env: s.env, roles: ["worker-role", "steward-p13"] });
  expect(r.pages.map((p) => [p.role, p.target, p.steward])).toEqual([["worker-role", "steward", "steward-p13"]]);
  const log = readLog(s.env);
  expect(log).toHaveLength(1);
  expect(log[0].body.payload.target).toBe("steward");
  expect(log[0].body.payload.reason).toContain("→ steward steward-p13");
  expect(log[0].body.payload.source).toBe("worker-role");
  expect(readJson(latchFile(s.env, "worker-role", ".quiet-fleet-latch.json")).steward).toBe("steward-p13");
  s.cleanup();
});

test("quiet-fleet: with no steward for the scope, the alert is addressed to the concierge", () => {
  const s = scratch();
  seedRole(s.env, "worker-role", 40 * M);
  runQuietFleetOnce({ now, env: s.env, roles: ["worker-role"] });
  const log = readLog(s.env);
  expect(log[0].body.payload.target).toBe("concierge");
  expect(log[0].body.payload.reason).toContain("→ concierge");
  s.cleanup();
});

// ── CTC-2981 round 5: clear is the complement of the page rule ──────────────
const quietScope = (env, role) =>
  writeFileSync(roleFiles(role, env).manifest, JSON.stringify({ role, scope: role, scope_active: false }));

test("quiet-fleet: a latched role whose scope goes quiet clears the alert even while still silent", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 40 * M);
  runQuietFleetOnce({ now, env: s.env, roles: ["steward-x"] });
  quietScope(s.env, "steward-x");
  const r = runQuietFleetOnce({ now: now + M, env: s.env, roles: ["steward-x"] });
  expect(r.recovered).toEqual(["steward-x"]);
  expect(r.cleared).toBe(true);
  expect(exists(latchFile(s.env, "steward-x", ".quiet-fleet-latch.json"))).toBe(false);
  s.cleanup();
});

test("holding-sentinel: a latched role whose scope goes quiet clears the alert even while still silent", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 16 * M);
  runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart: () => false });
  quietScope(s.env, "steward-x");
  const r = runHoldingSentinelOnce({ now: now + M, env: s.env, roles: ["steward-x"], requestRestart: () => false });
  expect(r.recovered).toEqual(["steward-x"]);
  expect(r.cleared).toBe(true);
  expect(exists(latchFile(s.env, "steward-x", ".holding-sentinel-latch.json"))).toBe(false);
  s.cleanup();
});

test("holding-sentinel: a latched role whose heartbeat goes missing stays raised (absence is not evidence of life)", () => {
  const s = scratch();
  seedRole(s.env, "steward-x", 16 * M);
  runHoldingSentinelOnce({ now, env: s.env, roles: ["steward-x"], requestRestart: () => false });
  rmSync(roleFiles("steward-x", s.env).heartbeat);
  const r = runHoldingSentinelOnce({ now: now + M, env: s.env, roles: ["steward-x"], requestRestart: () => false });
  expect(r.recovered).toEqual([]);
  expect(exists(latchFile(s.env, "steward-x", ".holding-sentinel-latch.json"))).toBe(true);
  s.cleanup();
});
