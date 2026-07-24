// emit.mjs — CTL-1423. Envelope builders and log-appender for the channel-watcher.
// Mirrors heartbeat-event.mjs / emitHeartbeatEvent patterns:
//   - buildWatcherHeartbeat / buildTurnDetected: pure OTel envelope builders
//   - appendEnvelope: never-throw appendFile (best-effort, mirrors emitHeartbeatEvent)

import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CHANNEL_WATCHER_SERVICE_NAME,
  CHANNEL_WATCHER_HEARTBEAT_EVENT,
  CHANNEL_WATCHER_TURN_EVENT,
} from "./heartbeat-schema.mjs";

function buildResource(host) {
  return {
    "service.name": CHANNEL_WATCHER_SERVICE_NAME,
    "service.namespace": "catalyst",
    "host.name": host ?? "unknown",
  };
}

function baseEnvelope(eventName, host, now) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: buildResource(host),
    attributes: {
      "event.name": eventName,
      "event.entity": "channel-watcher",
      "event.action": "heartbeat",
    },
    body: { payload: {} },
  };
}

/**
 * buildWatcherHeartbeat — assemble the heartbeat envelope.
 * @param {object} cfg
 * @param {string} cfg.watcherId
 * @param {string} cfg.channel
 * @param {number} cfg.baselineTurn
 * @param {number} cfg.currentTurn
 * @param {string} [cfg.host]
 * @param {Function} [cfg.now]  injectable timestamp fn
 */
export function buildWatcherHeartbeat({ watcherId, channel, baselineTurn, currentTurn, host, now } = {}) {
  const e = baseEnvelope(CHANNEL_WATCHER_HEARTBEAT_EVENT, host, now);
  e.attributes["event.action"] = "heartbeat";
  e.body.payload = {
    "watcher.id": watcherId,
    "watcher.channel": channel,
    "watcher.baseline_turn": baselineTurn,
    "watcher.current_turn": currentTurn,
    "host.name": host ?? "unknown",
  };
  return e;
}

/**
 * buildTurnDetected — assemble the turn-detected envelope, or null when no new turn.
 * @param {object} cfg
 * @param {string} cfg.watcherId
 * @param {string} cfg.channel
 * @param {number} cfg.baselineTurn
 * @param {number} cfg.currentTurn
 * @param {string} [cfg.host]
 * @param {Function} [cfg.now]
 * @returns {object|null}
 */
export function buildTurnDetected({ watcherId, channel, baselineTurn, currentTurn, host, now } = {}) {
  if (currentTurn <= baselineTurn) return null;
  const e = baseEnvelope(CHANNEL_WATCHER_TURN_EVENT, host, now);
  e.attributes["event.action"] = "turn-detected";
  e.body.payload = {
    "watcher.id": watcherId,
    "watcher.channel": channel,
    "watcher.baseline_turn": baselineTurn,
    "watcher.current_turn": currentTurn,
    "host.name": host ?? "unknown",
  };
  return e;
}

/**
 * appendEnvelope — append one envelope as a JSONL line to logPath.
 * Never throws; returns true on success, false on any error.
 */
export async function appendEnvelope(logPath, envelope) {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(envelope)}\n`);
    return true;
  } catch {
    return false;
  }
}
