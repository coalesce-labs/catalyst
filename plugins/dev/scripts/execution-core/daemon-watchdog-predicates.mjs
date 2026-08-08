// daemon-watchdog-predicates.mjs — CTL-1502. The two disk-only "stuck-but-alive"
// predicates for the daemon watchdog, the pure classifier, and the target
// registry. Both readers are O(1) statSync/small-JSON reads that never touch the
// watched daemon or (readDlqBytes) the bytes of the file they measure — so they
// are robust past 2 GB where the in-payload dlqDepth's whole-file readFileSync
// throws RangeError (index.ts:145, swallowed → the payload dlqDepth silently
// freezes on a huge DLQ). Missing/throwing reads return a NON-CROSSING sentinel
// (null / false) so a read failure can never fabricate a breach — the classifier
// guards `dlqBytes != null`, so a null read never trips even a `dlqMaxBytes: 0`
// threshold (a real 0-byte file is distinct: it reads as the number 0).

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Re-resolved per call so tests redirect via CATALYST_DIR — matches otel-forward's
// own resolution (index.ts:24) and config.mjs's private catalystDir().
function catalystDir() {
  return process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
}

// P1 — DLQ size via statSync (O(1); never reads bytes, so robust past 2 GB where
// the in-payload dlqDepth's readFileSync throws RangeError). Missing/throw → null
// (non-crossing) — NOT 0: a missing DLQ file must be distinguishable from a real
// empty one, or a `dlqMaxBytes: 0` threshold would treat every host with no DLQ
// as stuck (`0 >= 0`). The classifier's `dlqBytes != null` guard drops null.
export function readDlqBytes(dlqPath) {
  try {
    return statSync(dlqPath).size;
  } catch {
    return null;
  }
}

// The forwarder's INPUT log — the file otel-forward tails and appends to. Resolved
// exactly as otel-forward/index.ts (CATALYST_EVENTS_DIR override, then UTC month),
// and recomputed per call so an execution-core daemon that stays up across a UTC
// month rollover follows the new file instead of statting the prior month (CTL-1502
// Codex P1). Distinct from config.mjs getEventLogPath(): that is the emitter path
// (where the watchdog writes its OWN alert event); this is the file whose staleness
// the lag predicate measures, which must match the forwarder's tail target.
export function forwarderEventLogPath() {
  const eventsDir = process.env.CATALYST_EVENTS_DIR ?? join(catalystDir(), "events");
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(eventsDir, `${ym}.jsonl`);
}

// P2 — forwarding-lag: lastForwardedTs frozen for >= stalenessMs WHILE the event
// log has fresh writes newer than lastForwardedTs (real backlog). The mtime of
// the checkpoint FILE is rewritten unconditionally every 10s (same trap as the
// heartbeat), so we key on the in-payload lastForwardedTs — it only advances on
// real forwarding progress. The backlog gate (eventLogMtime > lastForwardedTs)
// distinguishes a stuck forwarder from a legitimately idle one, so a quiet host
// never trips. Missing checkpoint / unparseable ts / unreadable event log →
// false (non-crossing).
export function readLagStuck({
  checkpointPath,
  eventLogPath,
  stalenessMs,
  now,
  coldStartBaselineMs,
}) {
  try {
    const { lastForwardedTs } = JSON.parse(readFileSync(checkpointPath, "utf8"));
    let lastMs = Date.parse(lastForwardedTs);
    if (!Number.isFinite(lastMs)) {
      // Codex P1 — COLD-START baseline. `lastForwardedTs` is legitimately absent
      // on a fresh install (and on a legacy checkpoint) until the FIRST batch is
      // successfully delivered. Returning false here left a forwarder that wedges
      // (or whose every delivery fails) before that first success undetectable by
      // this predicate indefinitely, no matter how far the event log ran ahead —
      // the watchdog could only act once the DLQ crossed its 1 GiB default.
      //
      // The baseline is CALLER-SUPPLIED (the probe's first-observation time for
      // this target), deliberately NOT a filesystem timestamp:
      //   - mtime/ctime are rewritten unconditionally every 10s — the same trap
      //     the lastForwardedTs keying exists to avoid.
      //   - birthtimeMs is 0 on Linux under Bun (the fleet's CI + server
      //     runtime), so a birthtime baseline silently degrades to "never
      //     detect" on exactly the hosts that matter (Codex P1, round 4).
      // The probe stamps `firstSeenAt` on a target's first tick and passes it
      // here, which is runtime- and filesystem-independent. Worst case it delays
      // detection to stalenessMs after the probe starts, which is the correct
      // conservative direction. Absent/invalid → the pre-existing non-crossing
      // false, never an invented baseline that could fake a breach.
      if (!Number.isFinite(coldStartBaselineMs) || coldStartBaselineMs <= 0) return false;
      lastMs = coldStartBaselineMs;
    }
    const eventLogMtimeMs = statSync(eventLogPath).mtimeMs; // throws → caught → false
    const backlog = eventLogMtimeMs > lastMs; // fresh work after the last forward
    return backlog && now - lastMs >= stalenessMs;
  } catch {
    return false;
  }
}

// Pure classifier — boundary-exact >=, mirrors classifyFleetHealth. null/sentinel
// readings never trip (`null >= n` is false); lagStuck must be STRICTLY true so a
// non-boolean sentinel cannot fake a breach.
export function classifyDaemonStuck(readings, thresholds) {
  const { dlqBytes, lagStuck } = readings ?? {};
  const { dlqMaxBytes } = thresholds ?? {};
  const tripped = [];
  if (dlqBytes != null && dlqBytes >= dlqMaxBytes) tripped.push("dlq");
  if (lagStuck === true) tripped.push("lag");
  return { stuck: tripped.length > 0, tripped };
}

// Descriptor registry — one entry per watched daemon (RECENCY_SOURCES-shaped).
// First ship: otel-forward only; a second daemon is a one-line addition here.
// `restartArgs` are passed verbatim to catalyst-monitor.sh (Phase 1's
// forward-restart). Paths resolve CATALYST_DIR at import; production pins it at
// daemon launch, and the probe's readers are fully injectable for tests.
export const DAEMON_WATCHDOG_TARGETS = [
  {
    name: "otel-forward",
    dlqPath: join(catalystDir(), "otel-forward-dlq-otlp.jsonl"),
    checkpointPath: join(catalystDir(), "otel-forward.checkpoint.json"),
    restartArgs: ["forward-restart"],
  },
];
