// drain-event.mjs — CTL-1095. Node drain event builder + best-effort appender.
//
// Mirrors heartbeat-event.mjs: OTel envelope, appendFileSync, never throws.
// Three event types:
//   node.drain.changed — operator toggled the drain flag (on or off)
//   node.drain.drained — last in-flight ticket landed while draining
//   node.drain.ignored — CTL-1678: the flag is present but CATALYST_DRAIN_DISABLED=1
//                        neutralized it; carries the flag mtime + a `ps` snapshot to
//                        keep gathering CTL-1675 attribution evidence. Fired once per
//                        episode via the maybeEmitDrainIgnored latch.
//
// All are best-effort: a write failure returns false and logs a warning;
// callers never branch on the return value for correctness.

import { mkdirSync, appendFileSync, existsSync, statSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  getEventLogPath,
  getHostName,
  getDrainFlagPath,
  getDrainIgnoredMarkerPath,
  isDrainDisabled,
  log,
} from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const DRAIN_CHANGED_EVENT = "node.drain.changed";
export const DRAINED_EVENT = "node.drain.drained";
export const DRAIN_IGNORED_EVENT = "node.drain.ignored";

/**
 * buildDrainChangedEnvelope — pure OTel envelope for a drain toggle.
 */
export function buildDrainChangedEnvelope({ draining, inFlightCount, now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": DRAIN_CHANGED_EVENT,
      "event.entity": "node",
      "event.action": "drain.changed",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        draining: Boolean(draining),
        inFlightCount: inFlightCount ?? 0,
      },
    },
  };
}

/**
 * buildDrainedEnvelope — pure OTel envelope for the drained sentinel.
 */
export function buildDrainedEnvelope({ inFlightCount = 0, now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": DRAINED_EVENT,
      "event.entity": "node",
      "event.action": "drain.drained",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        draining: true,
        inFlightCount: 0,
      },
    },
  };
}

/**
 * emitDrainChangedEvent — append one drain.changed envelope line. Returns true
 * on success, false on any failure (best-effort; never throws).
 */
export function emitDrainChangedEvent({
  draining,
  inFlightCount = 0,
  logPath = getEventLogPath(),
  now,
} = {}) {
  const line = `${JSON.stringify(buildDrainChangedEnvelope({ draining, inFlightCount, now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "drain-event: event append failed");
    return false;
  }
}

/**
 * emitDrainedEvent — append one drain.drained envelope line. Returns true on
 * success, false on any failure (best-effort; never throws).
 */
export function emitDrainedEvent({ logPath = getEventLogPath(), now } = {}) {
  const line = `${JSON.stringify(buildDrainedEnvelope({ now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "drain-event: event append failed");
    return false;
  }
}

/**
 * buildDrainIgnoredEnvelope — CTL-1678. Pure OTel envelope for the
 * "drain observed but ignored" tripwire. Follows buildDrainedEnvelope's shape;
 * body.payload carries the flag mtime + a truncated `ps` snapshot for attribution.
 */
export function buildDrainIgnoredEnvelope({ flagMtimeMs = null, ps = null, now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": DRAIN_IGNORED_EVENT,
      "event.entity": "node",
      "event.action": "drain.ignored",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        draining: false,
        ignored: true,
        flagMtimeMs,
        ps,
      },
    },
  };
}

/**
 * emitDrainIgnoredEvent — CTL-1678. Append one drain.ignored envelope line.
 * Returns true on success, false on any failure (best-effort; never throws).
 */
export function emitDrainIgnoredEvent({
  flagMtimeMs = null,
  ps = null,
  logPath = getEventLogPath(),
  now,
} = {}) {
  const line = `${JSON.stringify(buildDrainIgnoredEnvelope({ flagMtimeMs, ps, now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "drain-event: event append failed");
    return false;
  }
}

/**
 * defaultDrainPsSnapshot — CTL-1678. Cheap sync `ps` snapshot for the tripwire
 * payload. Fires at most once per episode (latched by maybeEmitDrainIgnored), so
 * a synchronous ps is acceptable. Best-effort, truncated, never throws.
 *
 * CTL-1678 (Codex round-4 P1): the format is `comm=`, NOT `command=`. `command`
 * includes full argv, and any host process carrying a credential in its arguments
 * (the repo's own `curl -H "Authorization: …"` invocations, a token passed as a
 * flag) would be embedded verbatim in node.drain.ignored — an event that ships off
 * this machine into Loki, where it persists. Truncating to 40 lines bounds the size,
 * not the secret. `comm` is the executable path with NO arguments on both BSD/macOS
 * and Linux, so no argv text is ever collected and there is nothing to redact — a
 * structural fix rather than a heuristic scrub (a redaction regex is exactly the
 * thing that leaks the token it fails to match). Attribution keeps what it actually
 * needs: pid, ppid, start time, and which binary is running.
 */
export function defaultDrainPsSnapshot() {
  try {
    const out = spawnSync("ps", ["-axo", "pid=,ppid=,lstart=,comm="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (out.status !== 0 || !out.stdout) return null;
    return out.stdout.split("\n").slice(0, 40).join("\n"); // bounded payload
  } catch {
    return null;
  }
}

/**
 * maybeEmitDrainIgnored — CTL-1678. The once-per-episode tripwire latch. When the
 * drain flag is physically present AND CATALYST_DRAIN_DISABLED=1 neutralizes it,
 * emit exactly one node.drain.ignored event (with the flag mtime + a `ps` snapshot)
 * and write the drain.ignored marker to dedup subsequent ticks. When the flag is
 * absent or the override is off, clear any stale marker so a re-created flag re-arms.
 *
 * CTL-1678 (Codex P2): the "flag absent → clear marker" re-arm only fires if a tick
 * actually OBSERVES the absent gap. A flag removed and re-created BETWEEN ticks (the
 * scheduler ticks ~every 30s) never presents an absent state to any tick, so the
 * stale marker would suppress the new episode forever. To distinguish episodes we
 * persist the flag's INODE in the marker: when the marker exists but the live flag's
 * inode differs from the latched one, the flag was genuinely removed and re-created
 * (a new file → a new episode) → re-emit. The inode — NOT the mtime — is the correct
 * episode discriminator: `setDrain()` unconditionally REWRITES the existing flag in
 * place (writeFileSync O_TRUNC), and a recurring external writer can overwrite the
 * SAME continuously-present file; both bump the mtime WITHOUT starting a new episode,
 * so an mtime-based re-arm would spam a fresh `node.drain.ignored` on every rewrite,
 * violating the once-per-episode contract. An in-place rewrite keeps the inode, so we
 * stay latched. If either inode is indeterminate (stat failed, or a legacy pre-inode
 * marker), we stay conservatively latched so the guarantee is never weakened into
 * per-tick spam (the rare cost: an OS that immediately reuses the freed inode number
 * misses one episode's emission — under-emit, strictly safer than mtime's over-emit).
 * Best-effort throughout; never throws. Returns { emitted, latched? }.
 */
export function maybeEmitDrainIgnored({
  orchDir,
  env = process.env,
  now,
  logPath = getEventLogPath(),
  psSnapshotFn = defaultDrainPsSnapshot,
} = {}) {
  const flagPath = getDrainFlagPath(orchDir);
  const marker = getDrainIgnoredMarkerPath(orchDir);
  const active = existsSync(flagPath) && isDrainDisabled(env);
  if (!active) {
    if (existsSync(marker)) {
      try { rmSync(marker, { force: true }); } catch { /* best-effort */ }
    }
    return { emitted: false };
  }
  let flagIno = null;
  let flagMtimeMs = null;
  try {
    const st = statSync(flagPath);
    flagIno = st.ino;
    flagMtimeMs = st.mtimeMs;
  } catch { /* best-effort */ }
  if (existsSync(marker)) {
    let latchedIno = null;
    try { latchedIno = JSON.parse(readFileSync(marker, "utf8"))?.flagIno ?? null; } catch { /* best-effort */ }
    // Re-arm ONLY on a confirmed INODE change (the flag was removed and re-created — a
    // genuinely new file); an in-place rewrite keeps the inode and stays the SAME
    // episode. Indeterminate inode → stay conservatively latched.
    const changed =
      latchedIno !== null && flagIno !== null && flagIno !== latchedIno;
    if (!changed) return { emitted: false, latched: true };
  }
  let ps = null;
  try { ps = psSnapshotFn?.() ?? null; } catch { ps = null; }
  // The event payload keeps carrying flagMtimeMs (informational); the marker persists the
  // inode as the episode discriminator (plus mtime for human debugging).
  emitDrainIgnoredEvent({ flagMtimeMs, ps, logPath, now });
  try { writeFileSync(marker, JSON.stringify({ flagIno, flagMtimeMs })); } catch { /* best-effort */ }
  return { emitted: true };
}
