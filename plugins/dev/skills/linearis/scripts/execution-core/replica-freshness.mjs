// replica-freshness.mjs — the replica writer-LIVENESS gate, extracted from
// replica-read.mjs (CTL-1958) so it can be shared without dragging in a SQLite
// backend. replica-read.mjs top-level `import { Database } from "bun:sqlite"`,
// which is unloadable under plain `node` — and the CTL-1958 comment-read leaf that
// also needs this gate is imported by the node-run owner comms tools. This module
// imports ONLY node:fs, so it loads identically under node and bun. There is exactly
// ONE implementation of the gate (this one); replica-read.mjs re-exports it.
import { statSync } from "node:fs";

// isReplicaFresh(dbPath) — a WRITER-LIVENESS proxy. A dead writer must stop the
// replica from serving, so callers fall through / warn.
//
// CTL-1397 (4/n): gate on the cloud-sync writer's HEARTBEAT file
// `<db>.writer.lock`, NOT the db/`-wal` mtime. The `-wal` mtime only advances on an
// actual APPLY, so during a QUIET Linear feed (live writer, no issue updates) it
// goes stale within the threshold even though the replica is perfectly current. The
// writer touches `.writer.lock` every few seconds regardless of data changes, so its
// mtime tracks the WRITER being alive. Fall back to the db/`-wal` mtime only when the
// lock is absent (bootstrap / an older writer without the heartbeat file). Threshold
// = CATALYST_LINEAR_REPLICA_STALE_MS (default 5 min). Returns true when fresh, false
// when absent/stale/unstattable.
export function isReplicaFresh(dbPath) {
  const thresholdMs = Number(process.env.CATALYST_LINEAR_REPLICA_STALE_MS) || 300_000;
  // Preferred signal: the writer's heartbeat lock (advances on liveness, not on data
  // changes). Present → it is authoritative (a present-but-stale lock means the writer
  // died, so we do NOT serve even if a recent apply left `-wal` fresh).
  try {
    const lock = statSync(dbPath + ".writer.lock");
    return Date.now() - lock.mtimeMs <= thresholdMs;
  } catch {
    /* lock absent → fall back to the db/-wal mtime liveness proxy below */
  }
  let newest;
  try {
    newest = statSync(dbPath).mtimeMs; // throws if the file is absent → not fresh
  } catch {
    return false;
  }
  try {
    const wal = statSync(dbPath + "-wal");
    if (wal.size > 0) newest = Math.max(newest, wal.mtimeMs);
  } catch {
    /* -wal absent → main DB mtime only */
  }
  return Date.now() - newest <= thresholdMs;
}
