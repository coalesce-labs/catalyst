// dead-man.test.mjs — CTL-2000. The out-of-fleet dead-man alarm's fire/latch
// decision, with every I/O seam injected. Covers the three Codex P1 fixes:
//   * the turn signal is injectable, so a fresh turn keeps `turnFresh` reachable
//     and the alarm does not page a concierge that has spoken recently;
//   * the human is reached as an ASK (Options + Default), not a bare alert;
//   * a delivery that FAILS is not latched as delivered — the next tick re-fires
//     instead of going silent forever.
// CTC-2981: the alarm is a catalyst.alert.raised event (alarm.mjs), not a
// channel post, and a recovery clears it.
//
// Placed top-level in role-supervisor/ (not __tests__/) to match the
// supervisor.test.mjs convention and run-tests.sh's `../role-supervisor/*.test.mjs`
// glob — a test in a __tests__/ subdir would not be gated.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeadManOnce } from "./dead-man.mjs";
import { roleFiles } from "./paths.mjs";
import { eventLogPath, ALARM_REFRESH_MS } from "./alarm.mjs";

const now = 1_000_000_000_000;
const M = 60_000;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "dead-man-test-"));
  const env = { CATALYST_DIR: dir };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Seed the concierge heartbeat file with a chosen ts (or omit for "no heartbeat").
function seedHeartbeat(env, ageMs, extra = {}) {
  const f = roleFiles("concierge", env).heartbeat;
  mkdirSync(join(f, ".."), { recursive: true });
  if (ageMs !== null) writeFileSync(f, JSON.stringify({ role: "concierge", ts: now - ageMs, pid: 1, ...extra }));
}

const sinkOk = () => true;
const sinkFail = () => false;

test("P1: a stale heartbeat but a FRESH turn does NOT fire", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M); // heartbeat dead
  const r = runDeadManOnce({
    now, env: s.env,
    alarm: sinkOk,
    lastTurnMs: () => now - 5 * M, // concierge spoke 5m ago → alive
  });
  expect(r.fired).toBe(false);
  s.cleanup();
});

test("P1: BOTH signals stale fires and reaches the human as an ASK (Options + Default)", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  const bodies = [];
  const r = runDeadManOnce({
    now, env: s.env,
    alarm: (input) => { bodies.push(input.reason); return true; },
    lastTurnMs: () => now - 45 * M, // no genuine turn for 45m
  });
  expect(r.fired).toBe(true);
  expect(r.target).toBe("ask");
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("Options");
  expect(bodies[0]).toContain("Default");
  s.cleanup();
});

test("P1: a delivery that fails on BOTH sinks is NOT latched — the next tick re-fires", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  const first = runDeadManOnce({
    now, env: s.env,
    alarm: sinkFail,
    lastTurnMs: () => now - 45 * M,
  });
  expect(first.fired).toBe(true);
  expect(first.delivered).toBe(false);
  const latch = JSON.parse(readFileSync(join(s.dir, "roles", ".dead-man-latch.json"), "utf8"));
  expect(latch.pushed).toBe(false); // undelivered → not suppressed

  const second = runDeadManOnce({
    now: now + 60_000, env: s.env,
    alarm: sinkFail,
    lastTurnMs: () => now - 45 * M,
  });
  expect(second.fired).toBe(true); // re-fires instead of going silent forever
  s.cleanup();
});

test("P1: a delivered alarm IS latched — the next tick does not double-page", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  const first = runDeadManOnce({
    now, env: s.env,
    alarm: sinkOk, // the event log accepted it → delivered
    lastTurnMs: () => now - 45 * M,
  });
  expect(first.delivered).toBe(true);
  const second = runDeadManOnce({
    now: now + 60_000, env: s.env,
    alarm: sinkOk,
    lastTurnMs: () => now - 46 * M,
  });
  expect(second.fired).toBe(false); // alreadyPushed suppresses the repeat
  s.cleanup();
});

test("P1: a recovered concierge (fresh heartbeat AND fresh turn) clears the latch — turnFresh is reachable", () => {
  const s = scratch();
  // First: fire and latch on a dead concierge.
  seedHeartbeat(s.env, 40 * M);
  runDeadManOnce({ now, env: s.env, alarm: sinkOk, lastTurnMs: () => now - 45 * M });
  expect(existsSync(join(s.dir, "roles", ".dead-man-latch.json"))).toBe(true);
  // Then: heartbeat fresh AND a genuine channel turn fresh → re-arm (clear latch).
  seedHeartbeat(s.env, 1 * M);
  const r = runDeadManOnce({ now, env: s.env, alarm: sinkOk, lastTurnMs: () => now - 2 * M });
  expect(r.recovered).toBe(true);
  expect(existsSync(join(s.dir, "roles", ".dead-man-latch.json"))).toBe(false);
  s.cleanup();
});

test("CTC-2981: with no turn source, a fresh heartbeat alone re-arms and clears the alert", () => {
  const s = scratch();
  const calls = [];
  const alarm = (input) => { calls.push(input); return true; };
  seedHeartbeat(s.env, 40 * M); // no last_turn_ts recorded → null turn
  const fired = runDeadManOnce({ now, env: s.env, alarm });
  expect(fired.fired).toBe(true);
  seedHeartbeat(s.env, 1 * M);
  const r = runDeadManOnce({ now, env: s.env, alarm });
  expect(r.recovered).toBe(true);
  expect(calls.map((c) => c.action)).toEqual(["raised", "cleared"]);
  expect(calls.every((c) => c.kind === "concierge_dead")).toBe(true);
  s.cleanup();
});

test("CTC-2981: the default turn source is the heartbeat's last_turn_ts", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M, { last_turn_ts: now - 5 * M }); // heartbeat stale, turn fresh
  const r = runDeadManOnce({ now, env: s.env, alarm: sinkOk });
  expect(r.fired).toBe(false);
  expect(r.lastTurnAgeMs).toBe(5 * M);
  s.cleanup();
});

test("CTC-2981: the default alarm appends one catalyst.alert.raised to the event log, and nothing touches comms/", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  const r = runDeadManOnce({ now, env: { ...s.env, HOME: s.dir } });
  expect(r.fired).toBe(true);
  expect(r.delivered).toBe(true);
  const lines = readFileSync(eventLogPath({ env: s.env, now }), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0].attributes["event.name"]).toBe("catalyst.alert.raised");
  expect(lines[0].attributes["event.label"]).toBe("concierge_dead");
  expect(lines[0].body.payload.target).toBe("ask");
  expect(lines[0].body.payload.reason).toContain("Default if no reply");
  expect(existsSync(join(s.dir, "comms"))).toBe(false);
  s.cleanup();
});

// ── CTC-2981 review: month rotation and a durable clear ─────────────────────
const lastMonth = Date.UTC(2001, 7, 20); // `now` above is 2001-09-09
const latchFile = (dir) => join(dir, "roles", ".dead-man-latch.json");

test("CTC-2981: a latch raised last month is raised again into this month's log while the concierge is still dead", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  mkdirSync(join(s.dir, "roles"), { recursive: true });
  writeFileSync(latchFile(s.dir), JSON.stringify({ pushed: true, fired_at: lastMonth, log_month: "2001-08", logged_at: lastMonth }));
  const r = runDeadManOnce({ now, env: s.env });
  expect(r.reraised).toBe(true);
  const lines = readFileSync(eventLogPath({ env: s.env, now }), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0].attributes["event.name"]).toBe("catalyst.alert.raised");
  expect(lines[0].attributes["event.label"]).toBe("concierge_dead");
  expect(JSON.parse(readFileSync(latchFile(s.dir), "utf8")).log_month).toBe("2001-09");
  // Same month now: no second raise.
  const again = runDeadManOnce({ now: now + M, env: s.env });
  expect(again.reraised).toBeUndefined();
  expect(readFileSync(eventLogPath({ env: s.env, now }), "utf8").trim().split("\n")).toHaveLength(1);
  s.cleanup();
});

test("CTC-2981: a pre-upgrade latch (no log_month) is not proof of a logged raise, even from earlier this month", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  mkdirSync(join(s.dir, "roles"), { recursive: true });
  // Delivered only to the removed channel sinks, ten minutes ago, same month.
  writeFileSync(latchFile(s.dir), JSON.stringify({ pushed: true, fired_at: now - 10 * M }));
  const calls = [];
  const r = runDeadManOnce({ now, env: s.env, alarm: (i) => { calls.push(i.action); return true; } });
  expect(r.reraised).toBe(true);
  expect(calls).toEqual(["raised"]);
  s.cleanup();
});

test("CTC-2981: an unwritable log keeps the latch on recovery, and a later tick clears it", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  expect(runDeadManOnce({ now, env: s.env }).delivered).toBe(true);
  seedHeartbeat(s.env, 1 * M);

  const logFile = eventLogPath({ env: s.env, now });
  const eventsDir = join(s.dir, "events");
  chmodSync(logFile, 0o400);
  chmodSync(eventsDir, 0o500);
  const failed = runDeadManOnce({ now, env: s.env });
  chmodSync(eventsDir, 0o700);
  chmodSync(logFile, 0o600);
  expect(failed.recovered).toBe(true);
  expect(failed.cleared).toBe(false);
  expect(existsSync(latchFile(s.dir))).toBe(true);

  const ok = runDeadManOnce({ now, env: s.env });
  expect(ok.cleared).toBe(true);
  expect(existsSync(latchFile(s.dir))).toBe(false);
  const names = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).attributes["event.name"]);
  expect(names).toEqual(["catalyst.alert.raised", "catalyst.alert.cleared"]);
  s.cleanup();
});

test("CTC-2981: while the concierge stays dead, the alarm is raised again every ALARM_REFRESH_MS", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  const logLines = () => readFileSync(eventLogPath({ env: s.env, now }), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(runDeadManOnce({ now, env: s.env }).fired).toBe(true);

  const early = runDeadManOnce({ now: now + ALARM_REFRESH_MS - M, env: s.env });
  expect(early.reraised).toBeUndefined();
  expect(logLines()).toHaveLength(1);

  const due = runDeadManOnce({ now: now + ALARM_REFRESH_MS, env: s.env });
  expect(due.fired).toBe(false);
  expect(due.reraised).toBe(true);
  expect(logLines().map((e) => e.attributes["event.name"])).toEqual(["catalyst.alert.raised", "catalyst.alert.raised"]);
  expect(JSON.parse(readFileSync(latchFile(s.dir), "utf8")).fired_at).toBe(now); // same episode
  s.cleanup();
});

// ── CTC-2981 round 5: the clear is the exact complement of the raise ────────
function latchedDead(s) {
  seedHeartbeat(s.env, 40 * M);
  expect(runDeadManOnce({ now, env: s.env, alarm: sinkOk, lastTurnMs: () => now - 45 * M }).fired).toBe(true);
  expect(existsSync(latchFile(s.dir))).toBe(true);
}

test("CTC-2981: a latched alarm clears when the heartbeat is fresh again, even with the turn still stale", () => {
  const s = scratch();
  latchedDead(s);
  seedHeartbeat(s.env, 1 * M);
  const calls = [];
  const r = runDeadManOnce({ now, env: s.env, alarm: (i) => { calls.push(i.action); return true; }, lastTurnMs: () => now - 45 * M });
  expect(r.recovered).toBe(true);
  expect(r.cleared).toBe(true);
  expect(calls).toEqual(["cleared"]);
  expect(existsSync(latchFile(s.dir))).toBe(false);
  s.cleanup();
});

test("CTC-2981: a latched alarm clears when a turn is fresh again, even with the heartbeat still stale", () => {
  const s = scratch();
  latchedDead(s);
  const calls = [];
  const r = runDeadManOnce({ now, env: s.env, alarm: (i) => { calls.push(i.action); return true; }, lastTurnMs: () => now - 2 * M });
  expect(r.recovered).toBe(true);
  expect(calls).toEqual(["cleared"]);
  expect(existsSync(latchFile(s.dir))).toBe(false);
  s.cleanup();
});

test("CTC-2981: with both signals still stale the alarm stays raised and is not cleared", () => {
  const s = scratch();
  latchedDead(s);
  const calls = [];
  const r = runDeadManOnce({ now: now + M, env: s.env, alarm: (i) => { calls.push(i.action); return true; }, lastTurnMs: () => now - 46 * M });
  expect(r.recovered).toBe(false);
  expect(calls).toEqual([]);
  expect(existsSync(latchFile(s.dir))).toBe(true);
  s.cleanup();
});
