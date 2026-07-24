// daemon-watchdog-predicates.mjs — CTL-1502. The two disk-only "stuck-but-alive"
// predicates for the daemon watchdog, the pure classifier, and the target
// registry. Both readers are O(1) statSync/small-JSON reads that never touch the
// watched daemon or (readDlqBytes) the bytes of the file they measure — so they
// are robust past 2 GB where the in-payload dlqDepth's whole-file readFileSync
// throws RangeError (index.ts:145, swallowed → the payload dlqDepth silently
// freezes on a huge DLQ). Missing/throwing reads return a NON-CROSSING sentinel
// (0 / false) so a read failure can never fabricate a breach.

import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Re-resolved per call so tests redirect via CATALYST_DIR — matches otel-forward's
// own resolution (index.ts:24) and config.mjs's private catalystDir().
function catalystDir() {
  return process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
}

// P1 — DLQ size via statSync (O(1); never reads bytes, so robust past 2 GB where
// the in-payload dlqDepth's readFileSync throws RangeError). Missing/throw → 0
// (non-crossing).
export function readDlqBytes(dlqPath) {
  try {
    return statSync(dlqPath).size;
  } catch {
    return 0;
  }
}

// P2 — forwarding-lag: lastForwardedTs frozen for >= stalenessMs WHILE the event
// log has fresh writes newer than lastForwardedTs (real backlog). The mtime of
// the checkpoint FILE is rewritten unconditionally every 10s (same trap as the
// heartbeat), so we key on the in-payload lastForwardedTs — it only advances on
// real forwarding progress. The backlog gate (eventLogMtime > lastForwardedTs)
// distinguishes a stuck forwarder from a legitimately idle one, so a quiet host
// never trips. Missing checkpoint / unparseable ts / unreadable event log →
// false (non-crossing).
export function readLagStuck({ checkpointPath, eventLogPath, stalenessMs, now }) {
  try {
    const { lastForwardedTs } = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const lastMs = Date.parse(lastForwardedTs);
    if (!Number.isFinite(lastMs)) return false;
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
