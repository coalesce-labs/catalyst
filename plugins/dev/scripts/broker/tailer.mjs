// tailer.mjs — reactive event-log follow + startup replay: the execution-core
// "tailer". Watches ~/catalyst/events/YYYY-MM.jsonl, parses each appended line,
// and feeds it to the router's processEvent; on startup it replays the tail of
// the log so registrations survive a broker restart.
//
// CTL-529: final extraction of the execution-core module split. tailer.mjs
// imports config + state + router; only the index barrel imports tailer.

import { watch, openSync, fstatSync, readSync, closeSync, mkdirSync } from "node:fs";
// CTL-1529: bounded boot replay. tailParsedEvents returns the last N parsed events
// in file order from a small window near EOF.
import { tailParsedEvents, noteTornLine } from "../execution-core/event-tail.mjs";
import { checkEnvelope } from "../lib/event-envelope.mjs";
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

// CTL-1809: exported as a test seam, in the shape seedTailer already established. The live
// path is driven by an fs.watch callback, so without this the only way to exercise it is to
// start a real watcher and race a timer — which is how a flaky test that proves nothing gets
// written. Production still reaches it only through startTailing's watcher.
export function readNewEvents() {
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
        // CTL-1809: the broker's LIVE tail is the load-bearing reader of this log — it
        // routes every filter.wake, every phase-lifecycle terminal, and the ingestion-recency
        // and worker-state projections — and this drop was completely silent. Its BOOT replay
        // (tailParsedEvents above) has been counted since CTL-1809; without this the covered
        // half was the one that runs once per process and the uncounted half was the one that
        // runs for the process's whole life.
        //
        // `line` is a COMPLETE line: leftoverBuf popped the trailing partial off `lines`
        // before this loop, so an unparseable line here is real damage and not a read that
        // raced a writer mid-append. Shares event-tail.mjs's process counter deliberately —
        // one detector per process per log (see noteTornLine).
        //
        // COUNT AND ADVANCE. lastByteOffset was already moved to stat.size above, and that is
        // correct: a torn line is permanently corrupt, so re-reading it would wedge the
        // broker on damage that never resolves. The counter is a LOWER BOUND — a splice that
        // happens to parse is invisible here, which is why the write side is the fix.
        noteTornLine(line);
        continue;
      }
      // CTL-1819: envelope check on the LIVE path, for exactly the reason the torn
      // counter above is here — this loop is the load-bearing reader, and covering
      // only the boot replay (tailParsedEvents) would instrument the half that runs
      // once per process while leaving the half that runs for the process's whole
      // life blind. Same process counter, same non-gating contract: the event is
      // ROUTED regardless, so this can never change what the broker delivers.
      checkEnvelope(event);
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

// CTL-1529: this used to readFileSync the ENTIRE monthly event log (883 MB on
// mini) and split it into ~1.4M strings purely to look at `.slice(-LOOKBACK_LINES)`
// — the last 1000 lines. The broker reloads ~30 s after every merge to main, so
// that cost was paid constantly, and on a node runtime the read threw
// ERR_STRING_TOO_LONG into a bare catch: the broker silently recovered ZERO filter
// interests, so `filter.wake.*` routing went dark for every pre-existing
// registration and phase agents blocked on wakes that never came.
//
// tailParsedEvents reads a small window near EOF and parses only that, in file
// order — which is exactly what the chronological replay below needs. Replay was
// ALREADY explicitly lossy at LOOKBACK_LINES, so bounding the read changes no
// behavior. It also does the JSON parsing (and malformed-line skipping) itself.
export function loadExistingRegistrations(logPath = lastLogPath) {
  try {
    for (const event of tailParsedEvents({ path: logPath, maxLines: LOOKBACK_LINES })) {
      // CTL-1819 (Codex round 6): boot replay is the broker's OTHER read of this
      // log, and it is a genuine once-per-record consumer — it runs before the
      // live tail starts, over bytes the live tail will never re-read, so this
      // cannot double-count with the checkEnvelope in readNewEvents.
      //
      // It needs its own call because making tailParsedEvents validation-free
      // (the round-3 anti-recount fix) removed the coverage round 1 had here.
      // Without it a parseable-but-malformed recovery record — a `filter.register`
      // missing `ts` — is routed on restart with the detector silent.
      checkEnvelope(event);
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
