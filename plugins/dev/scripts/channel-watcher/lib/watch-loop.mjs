// watch-loop.mjs — CTL-1423. The core tick function for the long-lived
// channel-watcher daemon. Pure-testable: all I/O is injectable via opts.
//
// tick() is called on each interval; it:
//   1. Reads the channel file and counts turns.
//   2. Emits a turn-detected event if the count advanced past cfg.baselineTurn.
//      Updates state.currentTurn so the caller can update its rolling baseline.
//   3. Always emits a channel.watcher.heartbeat event.
//
// Crucially, tick() NEVER calls process.exit() — a new turn emits an event and
// the loop continues, separating the observation from process lifecycle
// (phenomenon (i) vs phenomenon (ii) from the decision record).

import { readFile } from "node:fs/promises";
import { countTurns } from "./turn-parser.mjs";
import { buildWatcherHeartbeat, buildTurnDetected, appendEnvelope } from "./emit.mjs";

/**
 * tick — one watcher interval cycle.
 *
 * @param {string} channelPath  absolute path to the md-channel file
 * @param {string} logPath      absolute path to the JSONL event log
 * @param {object} cfg          watcher config (watcherId, channel, baselineTurn, host, emit)
 * @param {object} state        mutable state: { baselineTurn, currentTurn }
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn → ISO string
 */
export async function tick(channelPath, logPath, cfg, state, { now } = {}) {
  let content = "";
  try {
    content = await readFile(channelPath, "utf8");
  } catch {
    // file unreadable → no new turns
  }

  const count = countTurns(content);
  state.currentTurn = count;

  const envelopeCfg = {
    watcherId: cfg.watcherId,
    channel: cfg.channel,
    baselineTurn: cfg.baselineTurn,
    currentTurn: state.currentTurn,
    host: cfg.host,
    now,
  };

  // Emit turn-detected if the turn count advanced past the baseline.
  const turnEnvelope = buildTurnDetected(envelopeCfg);
  if (turnEnvelope) {
    await appendEnvelope(logPath, turnEnvelope);
  }

  // Always emit a heartbeat.
  const hbEnvelope = buildWatcherHeartbeat(envelopeCfg);
  await appendEnvelope(logPath, hbEnvelope);
}
