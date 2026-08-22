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
import { tailParsedEvents, noteTornLine, drainAndSwitch } from "../execution-core/event-tail.mjs";
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
// CTL-1929: the `github.*` dispatch gate. Imported from execution-core for the same
// reason event-tail.mjs is — the two processes share this feature's modules, and the
// gate must be the SAME decision function the producer's tests drive.
import { decideDispatch as decideGithubDispatch } from "../execution-core/github-feed-gate.mjs";
import { createGithubFeedGate } from "../execution-core/github-feed-gate-install.mjs";

// Identity-stable alias — loadExistingRegistrations reports interests.size.
const interests = getInterests();

// CTL-1330 Tier 1: broker route-timing gate + slow-route threshold. Boot-fixed
// (daemon env is set at launch); ON unless CATALYST_TICK_TIMING=off.
const BROKER_ROUTE_TIMING = process.env.CATALYST_TICK_TIMING !== "off";
const BROKER_SLOW_ROUTE_MS = Number(process.env.CATALYST_BROKER_SLOW_ROUTE_MS) || 100;

// CTL-1929: which producer's `github.*` events may drive routing on this host.
//
// ⛔ NULL UNLESS AN OPERATOR OPTS IN. `createGithubFeedGate` returns null for
// `CATALYST_GITHUB_FEED=off`, which is the default on every host, so the block in
// readNewEvents below is skipped entirely and routing is byte-identical to
// pre-CTL-1929. Resolved once at module load, matching BROKER_ROUTE_TIMING above:
// the daemon's env is fixed at launch, and a per-event config read on the tail that
// sees every event in the fleet is not something to add casually.
let _githubGate = null;
export function initGithubFeedGate(gate = undefined) {
  _githubGate = gate === undefined ? createGithubFeedGate({ orchDir: CATALYST_DIR, logger: log }) : gate;
  return _githubGate;
}
export function getGithubFeedGate() {
  return _githubGate;
}

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

// routeRawLine — the per-line pipeline: torn-line accounting, the CTL-1819
// envelope check, the CTL-1929 github-feed gate, and processEvent with its
// CTL-1330 slow-route timing.
//
// CTL-1216 extracted this from the steady-state loop so the ROLLOVER DRAIN
// routes lines through EXACTLY the same path. A second hand-written copy for
// the drain is how one of the two paths silently stops counting torn lines, or
// stops honouring the feed gate, with nothing to say so — and the drain is the
// rare path, so it is precisely the copy that would rot unnoticed.
function routeRawLine(line) {
  if (!line.trim()) return;
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
      return;
    }
    // CTL-1819: envelope check on the LIVE path, for exactly the reason the torn
    // counter above is here — this loop is the load-bearing reader, and covering
    // only the boot replay (tailParsedEvents) would instrument the half that runs
    // once per process while leaving the half that runs for the process's whole
    // life blind. Same process counter, same non-gating contract: the event is
    // ROUTED regardless, so this can never change what the broker delivers.
    checkEnvelope(event);
    // CTL-1929: WHICH producer's `github.*` events may drive routing. Both the
    // smee→webhook receiver and the GitHub feed write the same names into this one
    // log; the gate picks one per event and the loser is CAPTURED, not dropped, so
    // "did the feed miss this edge?" stays answerable after the fact.
    //
    // ⛔ SUPPRESSION IS PER NAME, AND HOW MANY NAMES IS A PROPERTY OF THIS HOST.
    // `github.pr.merged` joined the suppressible set when CTC-691 shipped (0.1.17);
    // `github.push` and `github.check_suite.completed` join it only on a replica
    // that has `push_events` (CTC-704) and `check_suites.pull_request_numbers`
    // (CTC-712, 0.1.18) respectively. The gate resolves both from the replica and
    // re-reads them on a TTL, because they arrive at a cloud-sync writer restart
    // this process never observes. A host missing either keeps smee authoritative
    // for that name no matter how healthy the producer is. See github-feed-gate.mjs
    // and github-feed-gate-install.mjs.
    //
    // ⚠️ Placed BEFORE processEvent and before the timing block, so a suppressed
    // event is neither routed nor counted as a route — a suppressed event that
    // still showed up in the slow-route histogram would make the two instruments
    // disagree about what the broker did.
    if (_githubGate) {
      const verdict = decideGithubDispatch(event, _githubGate);
      if (verdict.suppress) {
        _githubGate.capture?.append(event, verdict);
        return;
      }
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

// CTL-1809: exported as a test seam, in the shape seedTailer already established. The live
// path is driven by an fs.watch callback, so without this the only way to exercise it is to
// start a real watcher and race a timer — which is how a flaky test that proves nothing gets
// written. Production still reaches it only through startTailing's watcher.
export function readNewEvents() {
  const logPath = getEventLogPath();

  if (logPath !== lastLogPath) {
    // CTL-1216: DRAIN the old file before switching, then seed the new one at
    // byte 0 — not at its current size.
    //
    // This block used to do neither, and dropped events twice over: the old
    // file's unread tail (everything appended between the last poll and the
    // boundary) was never read by anyone, and seeding at `stat.size` also
    // skipped the new file's HEAD. The broker routes every filter.wake and every
    // phase-lifecycle terminal through here, so those are dropped WAKES, not
    // dropped metrics. Monthly rotation gave 12 such windows a year; weekly
    // gives 52, which is what makes this a prerequisite rather than a cleanup.
    const prevPath = lastLogPath;
    const prevOffset = lastByteOffset;
    const prevLeftover = leftoverBuf;

    lastLogPath = logPath;
    leftoverBuf = "";
    lastByteOffset = 0;

    if (prevPath) {
      const res = drainAndSwitch({
        oldPath: prevPath,
        oldOffset: prevOffset,
        leftover: prevLeftover,
        onLines: (drained) => {
          for (const l of drained) routeRawLine(l);
        },
      });
      if (res.truncated) {
        // Say it. A drain that reads less without reporting the shortfall is
        // indistinguishable from a file that had nothing left to give.
        log.warn(
          { path: prevPath, drained: res.drained },
          "broker: rollover drain TRUNCATED — events beyond the cap were not routed (CTL-1216)",
        );
      }
    }
    // Deliberately NO `return`: fall through and read the new file from offset 0
    // in this same pass, so its head is not left sitting until the next watch
    // event — which may never arrive if nothing further is appended.
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
      routeRawLine(line);
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
      // CTL-1819: boot replay deliberately does NOT count (Codex rounds 6+7).
      //
      // Round 6 correctly observed that this consumer routes records without
      // validating them. I added a checkEnvelope call here and justified it with
      // "boot replay runs before the live tail over bytes readNewEvents never
      // re-reads" — which round 7 then falsified: on a broker SELF-RELOAD,
      // index.mjs runs this replay first and then seeds the live tail at the
      // handoff's OLDER byte offset, so the overlap is counted twice.
      //
      // The two findings together establish that boot replay cannot be a counting
      // site without byte-range or position dedup logic. Until that exists the call
      // is removed rather than left half-right, because the fail directions are not
      // symmetric: an uncounted malformed record is SILENCE, which is recoverable
      // and shows up as a counter at zero; a double-counted one is FABRICATION in
      // the number an operator reads during an incident. That is the same rule that
      // made countEnvelopes opt-in in round 2.
      //
      // Proper boot coverage is CTL-1857.
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
