// github-feed-seen.mjs — CTL-1929. The durable suppression set that makes the
// emit/cursor split safe.
//
// ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
// `github-feed-source.mjs` emits every row past the cursor immediately but only
// ADVANCES the cursor to `now - settleMs`, so a row arriving late with an older
// stamp is still ahead of the cursor and gets re-read. That is what makes a late
// arrival a duplicate instead of a permanent loss — 37% of rows arrive more than
// 60 s after their own event time on this fleet, tail 333 s.
//
// ⛔ The broker will NOT absorb those duplicates for us. It dedups on the envelope's
// `id`, which is a fresh UUID per emission (`canonical-event.mjs`), so two emissions
// of one edge are two different ids and BOTH route and BOTH wake. The Linear leg
// never needed this: it keys emission on `issue_history.id`, a PRIMARY KEY of an
// append-only log, so an overlapping sweep is a no-op by construction. Our tables
// have no log to key on, so the same guarantee has to be stored.
//
// ── ⭐ WHY IT IS BOUNDED BY CONSTRUCTION, NOT BY A POLICY ───────────────────
// A suppression set that grows forever is a liability, and one trimmed by an
// arbitrary "keep the last N" is worse — it evicts on volume, so a busy hour
// silently re-opens the duplicates it exists to stop.
//
// This one has an exact, provable retention bound: **a row is re-readable only
// while it is at or after the cursor.** Once the cursor passes a key, the source's
// keyset can never return that row again, so its entry can never be consulted.
// Pruning at the cursor's own position is therefore lossless BY DEFINITION, and the
// set's size is bounded by the number of edges inside one settle window rather than
// by uptime or traffic. `pruneBefore(cursorTs)` is the whole retention policy.
//
// ⚠️ Prune AFTER the cursor is durably written, never before. Pruning first and then
// failing to persist the cursor would leave a window that is both re-readable and
// unsuppressed — the one ordering that produces the duplicate storm this module is
// here to prevent.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function defaultSeenPath(orchDir, account = "tenant-0") {
  return join(orchDir, `github-feed-seen-${account}.db`);
}

/**
 * Open (creating if needed) the suppression set.
 *
 * Unlike the read source this handle is READ-WRITE, and it is a separate database
 * from the replica on purpose: the replica is owned by the cloud-sync writer and
 * this producer must never hold a write handle on it.
 */
export function createSeenStore({ path } = {}) {
  if (typeof path !== "string" || path === "") {
    throw new Error("createSeenStore: path is required");
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 250");
  db.run("CREATE TABLE IF NOT EXISTS seen (edge_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS idx_seen_ts ON seen (ts)");
  // `meta` carries the durable "this producer has run before" flag. It is deliberately
  // independent of the cursor file, so losing the cursor cannot ALSO lose the knowledge
  // that we had one — that distinction is what stops a lost cursor from cold-starting
  // at `now` and silently skipping everything since the last good position.
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const qHas = db.query("SELECT 1 FROM seen WHERE edge_id = $id LIMIT 1");
  const qAdd = db.query("INSERT OR IGNORE INTO seen (edge_id, ts) VALUES ($id, $ts)");
  const qPrune = db.query("DELETE FROM seen WHERE ts < $before");
  const qCount = db.query("SELECT count(*) AS n FROM seen");
  const qGetMeta = db.query("SELECT value FROM meta WHERE key = $k");
  const qSetMeta = db.query("INSERT INTO meta (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = $v");

  return {
    /** Has this edge already been emitted? */
    has: (edgeId) => typeof edgeId === "string" && edgeId !== "" && qHas.get({ $id: edgeId }) !== null,

    /**
     * Record an emitted edge. `INSERT OR IGNORE` so a re-record is a no-op and the
     * ORIGINAL emission timestamp is kept — refreshing it on every re-read would
     * push the entry forward and defeat the cursor-based prune.
     */
    add(edgeId, ts) {
      if (typeof edgeId !== "string" || edgeId === "") return false;
      qAdd.run({ $id: edgeId, $ts: Number.isInteger(ts) ? ts : 0 });
      return true;
    },

    /**
     * Drop entries the source can no longer return. Pass the DURABLE cursor position,
     * after it has been written — see the header for why the order matters.
     *
     * ⚠️ Strictly `<`, never `<=`. A row sharing the cursor's exact millisecond but
     * carrying a HIGHER id is still re-readable — the keyset's tie-break is
     * `ts = since AND id > sinceId` — and a timestamp-only prune cannot distinguish
     * it from one already passed. Keeping both is the conservative direction; the
     * alternative silently drops the suppression entry for a row that can still come
     * back, which is a duplicate. The residue is bounded by one millisecond's worth
     * of edges, so the retention argument in the header is unaffected.
     */
    pruneBefore(cursorTs) {
      if (!Number.isInteger(cursorTs)) return 0;
      return qPrune.run({ $before: cursorTs }).changes ?? 0;
    },

    size: () => qCount.get().n,

    /**
     * Durable "this STREAM has emitted before", for `resolveStartPosition`.
     *
     * ⛔ Per stream, not per producer, because the cursors are per stream. A single
     * global flag is wrong in a way that hides the thing it exists to detect: the
     * first stream to emit would set it, and then every OTHER stream's absent cursor
     * — on the very same first run — reads as "we HAD a position and lost it" rather
     * than "first run". Measured on a real replica replay before this was fixed: 8
     * spurious `cursor-vanished-after-first-run` declines in one cold start. Each one
     * takes the bounded-lookback reset path and raises a WARN, so a genuine cursor
     * loss becomes indistinguishable from ordinary startup noise.
     */
    everRan: (streamKey) => qGetMeta.get({ $k: `everRan:${streamKey}` })?.value === "1",
    markRan(streamKey) {
      qSetMeta.run({ $k: `everRan:${streamKey}`, $v: "1" });
    },

    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
