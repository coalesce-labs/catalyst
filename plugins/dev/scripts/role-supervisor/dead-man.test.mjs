// dead-man.test.mjs — CTL-2000. The out-of-fleet dead-man alarm's fire/latch
// decision, with every I/O seam injected. Covers the three Codex P1 fixes:
//   * the channel-turn signal is read from a POPULATED source (injected here),
//     so a fresh channel turn keeps `turnFresh` reachable and the alarm does not
//     page a concierge that has spoken recently;
//   * the human is reached as an ASK (Options + Default), not a bare alert;
//   * a delivery that FAILS on both sinks is not latched as delivered — the next
//     tick re-fires instead of going silent forever.
//
// Placed top-level in role-supervisor/ (not __tests__/) to match the
// supervisor.test.mjs convention and run-tests.sh's `../role-supervisor/*.test.mjs`
// glob — a test in a __tests__/ subdir would not be gated.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeadManOnce } from "./dead-man.mjs";
import { roleFiles } from "./paths.mjs";

const now = 1_000_000_000_000;
const M = 60_000;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "dead-man-test-"));
  const env = { CATALYST_DIR: dir };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Seed the concierge heartbeat file with a chosen ts (or omit for "no heartbeat").
function seedHeartbeat(env, ageMs) {
  const f = roleFiles("concierge", env).heartbeat;
  mkdirSync(join(f, ".."), { recursive: true });
  if (ageMs !== null) writeFileSync(f, JSON.stringify({ role: "concierge", ts: now - ageMs, pid: 1 }));
}

const sinkOk = () => true;
const sinkFail = () => false;

test("P1: a stale heartbeat but a FRESH channel turn does NOT fire (turn read from a populated source)", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M); // heartbeat dead
  const r = runDeadManOnce({
    now, env: s.env,
    pushHuman: sinkOk, postChannel: sinkOk,
    lastChannelTurnMs: () => now - 5 * M, // concierge spoke 5m ago → alive
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
    pushHuman: (b) => { bodies.push(b); return true; },
    postChannel: sinkOk,
    lastChannelTurnMs: () => now - 45 * M, // no genuine turn for 45m
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
    pushHuman: sinkFail, postChannel: sinkFail,
    lastChannelTurnMs: () => now - 45 * M,
  });
  expect(first.fired).toBe(true);
  expect(first.delivered).toBe(false);
  const latch = JSON.parse(readFileSync(join(s.dir, "roles", ".dead-man-latch.json"), "utf8"));
  expect(latch.pushed).toBe(false); // undelivered → not suppressed

  const second = runDeadManOnce({
    now: now + 60_000, env: s.env,
    pushHuman: sinkFail, postChannel: sinkFail,
    lastChannelTurnMs: () => now - 45 * M,
  });
  expect(second.fired).toBe(true); // re-fires instead of going silent forever
  s.cleanup();
});

test("P1: a delivered alarm IS latched — the next tick does not double-page", () => {
  const s = scratch();
  seedHeartbeat(s.env, 40 * M);
  const first = runDeadManOnce({
    now, env: s.env,
    pushHuman: sinkOk, postChannel: sinkFail, // one sink accepted → delivered
    lastChannelTurnMs: () => now - 45 * M,
  });
  expect(first.delivered).toBe(true);
  const second = runDeadManOnce({
    now: now + 60_000, env: s.env,
    pushHuman: sinkOk, postChannel: sinkOk,
    lastChannelTurnMs: () => now - 46 * M,
  });
  expect(second.fired).toBe(false); // alreadyPushed suppresses the repeat
  s.cleanup();
});

test("P1: a recovered concierge (fresh heartbeat AND fresh turn) clears the latch — turnFresh is reachable", () => {
  const s = scratch();
  // First: fire and latch on a dead concierge.
  seedHeartbeat(s.env, 40 * M);
  runDeadManOnce({ now, env: s.env, pushHuman: sinkOk, postChannel: sinkOk, lastChannelTurnMs: () => now - 45 * M });
  expect(existsSync(join(s.dir, "roles", ".dead-man-latch.json"))).toBe(true);
  // Then: heartbeat fresh AND a genuine channel turn fresh → re-arm (clear latch).
  seedHeartbeat(s.env, 1 * M);
  const r = runDeadManOnce({ now, env: s.env, pushHuman: sinkOk, postChannel: sinkOk, lastChannelTurnMs: () => now - 2 * M });
  expect(r.recovered).toBe(true);
  expect(existsSync(join(s.dir, "roles", ".dead-man-latch.json"))).toBe(false);
  s.cleanup();
});
