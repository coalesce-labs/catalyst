// tailer.mjs — reactive event-log follow + startup replay: the execution-core
// "tailer". Watches ~/catalyst/events/YYYY-MM.jsonl, parses each appended line,
// and feeds it to the router's processEvent; on startup it replays the tail of
// the log so registrations survive a broker restart.
//
// CTL-529: final extraction of the execution-core module split. tailer.mjs
// imports config + state + router; only the index barrel imports tailer.

import { watch, openSync, fstatSync, readSync, closeSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { getEventLogPath, log, CATALYST_DIR, LOOKBACK_LINES } from "./config.mjs";
import {
  processEvent,
  getEventName,
  handleRegister,
  handleDeregister,
  handleAgentCheckin,
  handleAgentCheckout,
  handleOrchestratorStatus,
  handleOrchestratorTerminated,
  isOrchestratorStatusFresh,
} from "./router.mjs";
import { getInterests } from "./state.mjs";

// Identity-stable alias — loadExistingRegistrations reports interests.size.
const interests = getInterests();

// CTL-1330 Tier 1: broker route-timing gate + slow-route threshold. Boot-fixed
// (daemon env is set at launch); ON unless CATALYST_TICK_TIMING=off.
const BROKER_ROUTE_TIMING = process.env.CATALYST_TICK_TIMING !== "off";
const BROKER_SLOW_ROUTE_MS = Number(process.env.CATALYST_BROKER_SLOW_ROUTE_MS) || 100;

// --- Reactive event log tailing ---
let lastByteOffset = 0;
let lastLogPath = "";
let leftoverBuf = "";
let eventsWatcher = null;

// CTL-529: main() seeds the tailer's log path + byte offset through this setter
// — an ESM importer cannot assign the module bindings directly. loadExistingRegistrations
// defaults its logPath arg to lastLogPath, so main() must seed the path before
// calling it on startup.
export function seedTailer({ logPath, byteOffset } = {}) {
  if (logPath !== undefined) lastLogPath = logPath;
  if (byteOffset !== undefined) lastByteOffset = byteOffset;
}

// CTL-529: close the fs.watch handle — used by the daemon shutdown path.
export function stopTailing() {
  eventsWatcher?.close();
}

// CTL-1077: expose the tailer's current byte offset so the broker self-reload
// path can write a gap-free handoff file for its successor.
export function getLastByteOffset() {
  return lastByteOffset;
}

function readNewEvents() {
  const logPath = getEventLogPath();

  if (logPath !== lastLogPath) {
    lastLogPath = logPath;
    leftoverBuf = "";
    try {
      const fd = openSync(logPath, "r");
      const stat = fstatSync(fd);
      lastByteOffset = stat.size;
      closeSync(fd);
    } catch {
      lastByteOffset = 0;
    }
    return;
  }

  try {
    const fd = openSync(logPath, "r");
    const stat = fstatSync(fd);
    if (stat.size <= lastByteOffset) {
      closeSync(fd);
      return;
    }
    const newByteCount = stat.size - lastByteOffset;
    const buf = Buffer.alloc(newByteCount);
    readSync(fd, buf, 0, newByteCount, lastByteOffset);
    closeSync(fd);
    lastByteOffset = stat.size;

    const text = leftoverBuf + buf.toString("utf8");
    const lines = text.split("\n");
    leftoverBuf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // CTL-1330 Tier 1: time each route; surface ONLY slow routes (default
      // >100ms) so we catch a broker-side hot-loop stall without flooding Loki —
      // the broker routes every appended event. ON by default (CATALYST_TICK_TIMING).
      if (BROKER_ROUTE_TIMING) {
        const t0 = performance.now();
        processEvent(event);
        const total_ms = Math.round((performance.now() - t0) * 10) / 10;
        if (total_ms >= BROKER_SLOW_ROUTE_MS) {
          log.warn({ event_name: getEventName(event), total_ms }, "broker: slow route (CTL-1330)");
        }
      } else {
        processEvent(event);
      }
    }
  } catch {
    // Log file not yet created or transient read error
  }
}

export function startTailing() {
  const eventsDir = resolve(CATALYST_DIR, "events");
  mkdirSync(eventsDir, { recursive: true });
  eventsWatcher = watch(eventsDir, (eventType, filename) => {
    if (eventType !== "change") return;
    if (filename !== null && filename !== basename(getEventLogPath())) return;
    readNewEvents();
  });
}

export function loadExistingRegistrations(logPath = lastLogPath) {
  try {
    const content = readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines.slice(-LOOKBACK_LINES)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const name = getEventName(event);
      if (name === "filter.register") handleRegister(event);
      if (name === "filter.deregister") handleDeregister(event);
      // CTL-381: accept the legacy orchestrator.-prefixed alias on replay too.
      if (name === "agent.checkin" || name === "orchestrator.agent.checkin")
        handleAgentCheckin(event);
      if (name === "agent.checkout" || name === "orchestrator.agent.checkout")
        handleAgentCheckout(event);
      // CTL-507: replay orchestrator.status so activeOrchestrators survives a
      // broker restart. Chronological replay + the terminate block below mean a
      // status followed by a completed/failed resolves to set-then-delete. The
      // freshness gate skips ancient status events so a long-dead orchestrator
      // is not resurrected.
      if (name === "orchestrator.status" && isOrchestratorStatusFresh(event)) {
        handleOrchestratorStatus(event);
      }
      if (name === "orchestrator-completed" || name === "orchestrator-failed") {
        handleOrchestratorTerminated(event);
      }
    }
    if (interests.size) {
      log.info({ count: interests.size }, "recovered interests from log");
    }
  } catch {
    // No log file yet — fine
  }
}
