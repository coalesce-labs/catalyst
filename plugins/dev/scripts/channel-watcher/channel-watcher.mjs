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
import { eventLogBasenameFor, resolveRotationScheme } from "../lib/event-log-paths.mjs";

// Resolve config from env (with defaults).
const WATCHER_CHANNEL = process.env.CATALYST_WATCHER_CHANNEL ?? "";
if (!WATCHER_CHANNEL) {
  process.stderr.write("channel-watcher: CATALYST_WATCHER_CHANNEL is required\n");
  process.exit(1);
}

// Default the watcher id to host + full channel PATH (not the bare basename), so
// two watchers on the same host tailing different files that share a basename get
// distinct identities. The broker keys its dead-man tracker on
// (host, watcherId, channel); a shared default id would let the surviving
// watcher's heartbeats mask the other's death.
const WATCHER_ID = process.env.CATALYST_WATCHER_ID ?? `${hostname()}:${WATCHER_CHANNEL}`;

// Validate the heartbeat interval: a 0/negative/malformed CATALYST_WATCHER_INTERVAL_MS
// (e.g. an env-file typo like `abc`) makes parseInt yield NaN/≤0, which Bun coerces
// to a ~1ms setInterval that floods the shared event log and pins broker/CPU/disk.
// Fall back to the 30s default and floor at 1s.
const INTERVAL_DEFAULT_MS = 30000;
const INTERVAL_FLOOR_MS = 1000;
let INTERVAL_MS = parseInt(process.env.CATALYST_WATCHER_INTERVAL_MS ?? String(INTERVAL_DEFAULT_MS), 10);
if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS < INTERVAL_FLOOR_MS) {
  if (process.env.CATALYST_WATCHER_INTERVAL_MS !== undefined) {
    process.stderr.write(
      `channel-watcher: invalid CATALYST_WATCHER_INTERVAL_MS=${JSON.stringify(process.env.CATALYST_WATCHER_INTERVAL_MS)} — using ${INTERVAL_DEFAULT_MS}ms\n`,
    );
  }
  INTERVAL_MS = INTERVAL_DEFAULT_MS;
}
const CATALYST_DIR = process.env.CATALYST_DIR ?? `${process.env.HOME ?? homedir()}/catalyst`;

// CTL-1216: the filename is resolved by lib/event-log-paths.mjs; CATALYST_DIR
// stays this module's own captured root.
function getEventLogPath() {
  return join(CATALYST_DIR, "events", eventLogBasenameFor(new Date(), resolveRotationScheme({ env: process.env })));
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

let _tickRunning = false;
async function runTick() {
  // Serialize ticks: if channel/log I/O runs longer than the interval, setInterval
  // would start a second runTick before this one advances cfg.baselineTurn — both
  // would observe the same old baseline and append a DUPLICATE turn-detected for
  // the same turn. Skip the overlapping run instead.
  if (_tickRunning) return;
  _tickRunning = true;
  try {
    logDaemonHeartbeat();
    await tick(WATCHER_CHANNEL, getEventLogPath(), cfg, state);
    // Advance the rolling baseline so turn-detected fires once per turn — but ONLY
    // when the turn-detected event was durably appended (state.turnEmitted). A
    // failed append leaves the baseline in place so the next tick retries it rather
    // than losing the turn permanently.
    if (state.currentTurn > cfg.baselineTurn && state.turnEmitted !== false) {
      cfg.baselineTurn = state.currentTurn;
    }
  } catch (err) {
    process.stderr.write(`channel-watcher: tick error: ${err?.message}\n`);
  } finally {
    _tickRunning = false;
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
