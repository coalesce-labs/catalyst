// feed-progress.mjs — CTL-1902. The ONE module that owns the ingest-evidence
// record: its path, its shape, and the verdict read off it. Imported by the
// WRITER (cloud-sync.mjs, which publishes it) and by the READER
// (cloud-feed-timer.mjs, whose readiness consults it).
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
// cloud-feed readiness used to be satisfied by `<db>.writer.lock`'s heartbeat.
// That file is written by the SDK's `CatalystReplica` and records that the
// WRITER PROCESS is alive. It says nothing about whether replica changes are
// ARRIVING — and cloud-sync.mjs says so itself, in its own words:
//
//   "the apply cadence goes stale on a quiet feed, which is why writer liveness
//    keys on the `.writer.lock` heartbeat, not cursor movement"   (~line 492)
//
// with a documented incident (the 18.5 h silent freeze, CTL-1420) where the
// heartbeat kept beating against a frozen cursor. So a half-open or frozen feed
// kept enforce armed while live webhook events were suppressed and no
// replacements were produced. Readiness has to be evidence about the FEED.
//
// ── ⛔ THE TRAP: "CURSOR FROZEN ⇒ BROKEN" IS FALSE ──────────────────────────
// CTL-1902's own acceptance criterion says "writer heartbeat fresh + sync cursor
// frozen ⇒ NOT ready". Implemented literally that is a REGRESSION, not a fix: a
// healthy QUIET feed freezes the cursor identically to a dead socket. cloud-sync
// documents this as the reason its own stall detector refuses to fire on
// cursor-silence alone, and it reproduces on the live fleet — measured on mini-2
// 2026-08-17T03:4xZ, successive freshness lines carried
// `replica.cursor` FROZEN at 1146621 while `frame_staleness` was 5 s and 11 s.
// That is a perfectly current node. Gating readiness on cursor movement would
// have un-armed the feed through every quiet window — i.e. most of the night —
// and it would have looked like a safety improvement while removing the feature.
//
// The signal that separates "quiet" from "dead" is the one cloud-sync already
// computes for exactly that purpose: `lastFrameAt` — epoch-ms of the last INBOUND
// socket bytes of ANY kind, watchdog pongs included. The SDK pings after ~90 s of
// idle, so a healthy quiet feed keeps it fresh while a half-open socket freezes
// it. That is the property readiness needs: not "did rows change" (a fact about
// Linear) but "is this node still being spoken to" (a fact about the feed).
//
// Pure except for `readFeedProgress`. Every verdict is NAMED, and every failure
// to look is a distinct reason from a look that succeeded — "I could not tell"
// must never render as "it is fine".

import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const FEED_PROGRESS_SUFFIX = ".feed-progress.json";

/**
 * How stale the published RECORD itself may be. Deliberately generous relative
 * to the writer's 30 s heartbeat: this bounds "the writer stopped publishing",
 * not "the feed went quiet".
 */
export const DEFAULT_RECORD_STALE_MS = 3 * 60 * 1000;

/**
 * How long inbound frame silence is tolerated. The SDK pings after ~90 s idle,
 * so 5 min is several missed keepalives — long enough that a healthy-but-idle
 * socket never trips it, short enough to catch a half-open one well inside the
 * 30 s dispatch cadence's tolerance for stale authority.
 */
export const DEFAULT_FRAME_STALE_MS = 5 * 60 * 1000;

export function feedProgressPath(dbPath) {
  if (typeof dbPath !== "string" || dbPath === "") return null;
  return `${dbPath}${FEED_PROGRESS_SUFFIX}`;
}

/**
 * buildFeedProgressRecord — the published shape, from values the writer's
 * telemetry tick already has in hand. Pure.
 *
 * `lastFrameAt` is carried as the RAW epoch-ms, not as a pre-computed staleness:
 * the reader has its own clock and its own tick, and a staleness computed at
 * publish time would silently age into a lie between publish and read.
 */
export function buildFeedProgressRecord({
  now = Date.now(),
  cursor = null,
  lastFrameAt = null,
  status = null,
  rows = null,
  maxUpdatedMs = null,
  genuineStall = false,
  pid = null,
} = {}) {
  return {
    updatedAt: now,
    cursor: Number.isFinite(cursor) ? cursor : null,
    lastFrameAt: Number.isFinite(lastFrameAt) ? lastFrameAt : null,
    status: typeof status === "string" ? status : null,
    rows: Number.isFinite(rows) ? rows : null,
    maxUpdatedMs: Number.isFinite(maxUpdatedMs) ? maxUpdatedMs : null,
    genuineStall: genuineStall === true,
    pid: Number.isFinite(pid) ? pid : null,
  };
}

/**
 * writeFeedProgress — atomic publish (tmp + rename), so a reader mid-write never
 * parses a half-written record and never has to distinguish that from a corrupt
 * one. FAIL-OPEN by contract: the caller is a telemetry tick and must never be
 * taken down by its own observability. Returns true only on a completed rename.
 */
export function writeFeedProgress(dbPath, record, { writeFile = writeFileSync, rename = renameSync } = {}) {
  const path = feedProgressPath(dbPath);
  if (!path) return false;
  const tmp = `${path}.tmp`;
  try {
    writeFile(tmp, `${JSON.stringify(record)}\n`);
    rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * readFeedProgress — the only I/O on the read side. Returns either
 * `{ ok: true, record }` or `{ ok: false, reason }`, never a bare null: "absent"
 * and "malformed" are different facts and the caller reports which.
 */
export function readFeedProgress(dbPath, { readFile = readFileSync } = {}) {
  const path = feedProgressPath(dbPath);
  if (!path) return { ok: false, reason: "no-db-path" };
  let raw;
  try {
    raw = readFile(path, "utf8");
  } catch (err) {
    return { ok: false, reason: err?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== "object") return { ok: false, reason: "malformed" };
    return { ok: true, record };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/**
 * classifyFeedHealth — the verdict. Pure.
 *
 * ⛔ FAIL-CLOSED AND POSITIVE. `healthy: true` requires evidence that the feed is
 * being spoken to. Every other outcome — including every way of failing to LOOK —
 * is `healthy: false` with a distinct reason, so an unarmed producer is always
 * diagnosable and "could not tell" is never laundered into "fine".
 *
 * Order matters only for which reason is reported first; every branch is
 * disqualifying.
 *
 * @returns {{healthy: boolean, reason: string, frameStalenessMs: number|null, recordAgeMs: number|null}}
 */
export function classifyFeedHealth(
  read,
  { now = Date.now(), recordStaleMs = DEFAULT_RECORD_STALE_MS, frameStaleMs = DEFAULT_FRAME_STALE_MS } = {},
) {
  if (!read || read.ok !== true) {
    return { healthy: false, reason: read?.reason ?? "absent", frameStalenessMs: null, recordAgeMs: null };
  }
  const r = read.record;

  // The record must itself be current, or everything in it is a claim about a
  // moment that has passed. This subsumes the old writer-liveness check: a dead
  // writer stops publishing, so the record goes stale.
  const updatedAt = Number.isFinite(r.updatedAt) ? r.updatedAt : null;
  if (updatedAt === null) {
    return { healthy: false, reason: "record-no-timestamp", frameStalenessMs: null, recordAgeMs: null };
  }
  const recordAgeMs = now - updatedAt;
  // A record from the FUTURE is not evidence — a skewed or rolled-back clock on
  // either side would otherwise make an arbitrarily old record look brand new.
  if (recordAgeMs < 0) {
    return { healthy: false, reason: "record-ahead-of-clock", frameStalenessMs: null, recordAgeMs };
  }
  if (recordAgeMs > recordStaleMs) {
    return { healthy: false, reason: "record-stale", frameStalenessMs: null, recordAgeMs };
  }

  // The writer's OWN stall verdict (classifyStall). It already requires an
  // independent transport-liveness failure and never fires on a quiet feed, so
  // when it does fire it is strictly stronger evidence than anything derivable
  // here. Honour it rather than re-deriving it.
  if (r.genuineStall === true) {
    return { healthy: false, reason: "genuine-stall", frameStalenessMs: null, recordAgeMs };
  }

  // The discriminator. Absent ⇒ we cannot tell quiet from dead, which is NOT
  // health: an older SDK with no `lastFrameAt` getter degrades to un-armed
  // rather than to trusted.
  const lastFrameAt = Number.isFinite(r.lastFrameAt) ? r.lastFrameAt : null;
  if (lastFrameAt === null) {
    return { healthy: false, reason: "frame-unknown", frameStalenessMs: null, recordAgeMs };
  }
  const frameStalenessMs = now - lastFrameAt;
  if (frameStalenessMs < 0) {
    return { healthy: false, reason: "frame-ahead-of-clock", frameStalenessMs, recordAgeMs };
  }
  if (frameStalenessMs > frameStaleMs) {
    return { healthy: false, reason: "frame-silent", frameStalenessMs, recordAgeMs };
  }

  // ⚠️ Note what is deliberately NOT checked: `cursor` movement and `rows`.
  // Both are facts about whether LINEAR changed, not about whether this node is
  // still connected — see the trap in this file's header. A quiet fleet must
  // read as healthy, because it IS.
  return { healthy: true, reason: "ok", frameStalenessMs, recordAgeMs };
}
