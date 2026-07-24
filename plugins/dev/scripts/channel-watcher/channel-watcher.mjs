#!/usr/bin/env bun
// channel-watcher.mjs — CTL-1423. Long-lived channel-watcher daemon.
// Watches a single md-channel file by turn-header count; emits a
// channel.watcher.turn-detected event when a new turn appears and a
// channel.watcher.heartbeat on every interval — WITHOUT exiting on a new turn
// (phenomenon (i) vs phenomenon (ii) distinction per the decision record).
//
// Config via env vars:
//   CATALYST_WATCHER_ID         watcher identity (default: hostname)
//   CATALYST_WATCHER_CHANNEL    path to the md-channel file (required)
//   CATALYST_WATCHER_INTERVAL_MS  heartbeat interval (default: 30000)
//   CATALYST_DIR                catalyst home dir for the event log
//
// Supervision: run via launchd KeepAlive (see launch.sh) — if this process
// dies, launchd restarts it within seconds.

import { readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { tick } from "./lib/watch-loop.mjs";
import { countTurns } from "./lib/turn-parser.mjs";

// Resolve config from env (with defaults).
const WATCHER_CHANNEL = process.env.CATALYST_WATCHER_CHANNEL ?? "";
if (!WATCHER_CHANNEL) {
  process.stderr.write("channel-watcher: CATALYST_WATCHER_CHANNEL is required\n");
  process.exit(1);
}

const WATCHER_ID = process.env.CATALYST_WATCHER_ID ?? hostname();
const INTERVAL_MS = parseInt(process.env.CATALYST_WATCHER_INTERVAL_MS ?? "30000", 10);
const CATALYST_DIR = process.env.CATALYST_DIR ?? `${process.env.HOME ?? homedir()}/catalyst`;

function getEventLogPath() {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(CATALYST_DIR, "events", `${month}.jsonl`);
}

// Compute baseline: the turn count at startup time.
let baselineTurn = 0;
try {
  const content = readFileSync(WATCHER_CHANNEL, "utf8");
  baselineTurn = countTurns(content);
} catch {
  // file not yet present — baseline stays 0
}

const channelName = WATCHER_CHANNEL.split("/").pop() ?? WATCHER_CHANNEL;
const cfg = {
  watcherId: WATCHER_ID,
  channel: channelName,
  baselineTurn,
  host: hostname(),
  emit: "eventlog",
};

const state = { baselineTurn, currentTurn: baselineTurn };

process.stderr.write(
  `channel-watcher: started — id=${WATCHER_ID} channel=${channelName} baseline=${baselineTurn} interval=${INTERVAL_MS}ms\n`,
);

// Log the daemon-heartbeat marker to stderr for Alloy→Loki (mirrors daemon-heartbeat.mjs).
function logDaemonHeartbeat() {
  process.stderr.write(`{"level":"info","hb":true,"component":"channel-watcher","msg":"daemon heartbeat"}\n`);
}

async function runTick() {
  try {
    logDaemonHeartbeat();
    await tick(WATCHER_CHANNEL, getEventLogPath(), cfg, state);
    // After each tick, advance the baselineTurn so turn-detected fires once per turn.
    if (state.currentTurn > cfg.baselineTurn) {
      cfg.baselineTurn = state.currentTurn;
    }
  } catch (err) {
    process.stderr.write(`channel-watcher: tick error: ${err?.message}\n`);
  }
}

// Fire once immediately then on the interval. The interval is the daemon's
// reason to exist and is deliberately NOT unref()'d: a ref'd timer is what
// holds the event loop open so the process actually loops. Node/bun signal
// listeners and an unref'd timer do NOT keep the loop alive — unref'ing the
// sole timer makes the process exit cleanly (code 0) after a single tick, and
// the plist's KeepAlive={SuccessfulExit:false} would then leave the watcher
// permanently down (turn-detection never fires; the broker dead-man's switch
// raises a false system_down). Mirrors catalyst-agent.mjs / updater.mjs.
runTick();
const timer = setInterval(runTick, INTERVAL_MS);

// Clean shutdown on SIGTERM.
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.stderr.write("channel-watcher: shutting down (SIGTERM)\n");
  process.exit(0);
});

process.on("SIGINT", () => {
  clearInterval(timer);
  process.exit(0);
});
