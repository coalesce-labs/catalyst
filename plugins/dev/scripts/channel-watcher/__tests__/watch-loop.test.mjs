import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tick } from "../lib/watch-loop.mjs";
import { CHANNEL_WATCHER_HEARTBEAT_EVENT, CHANNEL_WATCHER_TURN_EVENT } from "../lib/heartbeat-schema.mjs";

const TURN_LINE = "### 1 | FROM: a | TO: ALL | 2026-07-03T10:00:00Z | INFO — hi";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "cw-test-"));
  const channelPath = join(dir, "test-channel.md");
  const logPath = join(dir, "events.jsonl");
  writeFileSync(channelPath, "");
  writeFileSync(logPath, "");
  return { dir, channelPath, logPath };
}

function readEvents(logPath) {
  const content = readFileSync(logPath, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map(l => JSON.parse(l));
}

const baseCfg = {
  watcherId: "w1",
  channel: "test-channel.md",
  host: "mini",
  intervalMs: 1000,
  emit: "eventlog",
};

test("tick appends a heartbeat event when no new turn", async () => {
  const { channelPath, logPath } = makeEnv();
  const state = { baselineTurn: 0, currentTurn: 0 };
  await tick(channelPath, logPath, { ...baseCfg, baselineTurn: 0 }, state, { now: () => "2026-07-03T10:00:00Z" });
  const events = readEvents(logPath);
  expect(events.length).toBe(1);
  expect(events[0].attributes["event.name"]).toBe(CHANNEL_WATCHER_HEARTBEAT_EVENT);
});

test("tick appends turn-detected when file gains a turn header, then continues (no process.exit)", async () => {
  const { channelPath, logPath } = makeEnv();
  writeFileSync(channelPath, TURN_LINE + "\n");
  const state = { baselineTurn: 0, currentTurn: 0 };
  await tick(channelPath, logPath, { ...baseCfg, baselineTurn: 0 }, state, { now: () => "2026-07-03T10:00:00Z" });
  const events = readEvents(logPath);
  // Both turn-detected AND heartbeat should land.
  const names = events.map(e => e.attributes["event.name"]);
  expect(names).toContain(CHANNEL_WATCHER_TURN_EVENT);
  expect(names).toContain(CHANNEL_WATCHER_HEARTBEAT_EVENT);
  // currentTurn was advanced in state (process did not exit).
  expect(state.currentTurn).toBe(1);
});

test("second tick after turn detected does not re-emit turn-detected", async () => {
  const { channelPath, logPath } = makeEnv();
  writeFileSync(channelPath, TURN_LINE + "\n");
  const state = { baselineTurn: 0, currentTurn: 0 };
  const nowFn = { now: () => "2026-07-03T10:00:00Z" };
  await tick(channelPath, logPath, { ...baseCfg, baselineTurn: 0 }, state, nowFn);
  // Second tick with same state — baseline is now updated, no new turn.
  await tick(channelPath, logPath, { ...baseCfg, baselineTurn: state.currentTurn }, state, nowFn);
  const events = readEvents(logPath);
  const turnEvents = events.filter(e => e.attributes["event.name"] === CHANNEL_WATCHER_TURN_EVENT);
  expect(turnEvents.length).toBe(1); // only once
});
