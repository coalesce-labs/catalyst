// session-liveness.mjs — CTL-672. Bridge the broker's session-id space
// (`sess_…` catalyst ids + orchestrator ids) to `claude agents` liveness.
//
// The broker watchdog tracks sessions by catalyst session id, but `claude
// agents --json` (the reliable, externally-observed liveness signal CTL-662
// adopted for the daemon reclaim path) keys on the claude session UUID. The
// catalyst.db `sessions` table already records both — `claude_session_id` is
// written at dispatch (catalyst-session.sh) and is populated for every bg phase
// worker. This module resolves `sess_…` → claude UUID via that table (cached,
// since the mapping is immutable once set) and answers a three-valued liveness:
//
//   "alive"   — resolves to a claude UUID present in `claude agents`.
//   "dead"    — resolves to a claude UUID that is ABSENT from `claude agents`.
//   "unknown" — does not resolve (no row, or claude_session_id not yet set, e.g.
//               interactive sessions / test fixtures). The caller falls back to
//               its prior signal (the watchdog: heartbeat-ts staleness).
//
// SINGLE-HOST: both inputs (catalyst.db and `claude agents`) are host-local, so
// every decision here is correct only while the broker is co-located with its
// workers. A distributed deployment must reinstate an over-the-wire liveness
// signal — see CTL-672's single-host caveat.

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { cachedListClaudeAgents, agentForShortId } from "../execution-core/claude-agents.mjs";
import { shortIdFromSessionId } from "../execution-core/claude-ids.mjs";

function catalystDbPath() {
  const dir = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
  return resolve(dir, "catalyst.db");
}

// A read-only handle to catalyst.db, opened lazily and reused. Best-effort: any
// open failure (missing db, locked, etc.) leaves it null so lookups return null
// → "unknown" → caller falls back. Never throws.
let _db = null;
let _dbTried = false;
function catalystDb() {
  if (_dbTried) return _db;
  _dbTried = true;
  try {
    _db = new Database(catalystDbPath(), { readonly: true });
  } catch {
    _db = null;
  }
  return _db;
}

// Hit-cache: a session's claude_session_id is immutable once written, so a hit
// can be memoized permanently. Misses are NOT cached — a session may not have
// its claude_session_id populated yet (it's written at dispatch), so we re-query
// until it appears.
const _idCache = new Map();

export function resolveClaudeSessionId(sessionId, { db = catalystDb() } = {}) {
  if (!sessionId) return null;
  if (_idCache.has(sessionId)) return _idCache.get(sessionId);
  if (!db) return null;
  try {
    const row = db
      .prepare("SELECT claude_session_id FROM sessions WHERE session_id = ?")
      .get(sessionId);
    const claudeId = row?.claude_session_id || null;
    if (claudeId) _idCache.set(sessionId, claudeId);
    return claudeId;
  } catch {
    return null;
  }
}

// sessionLiveness — three-valued liveness for a broker-tracked session id.
// `agents` and `lookupClaudeSessionId` are injectable seams (tests pass fixtures;
// the watchdog passes one shared cached snapshot per tick to avoid N reads).
export function sessionLiveness(
  sessionId,
  { agents, lookupClaudeSessionId = resolveClaudeSessionId } = {},
) {
  const claudeId = lookupClaudeSessionId(sessionId);
  if (!claudeId) return "unknown";
  let shortId;
  try {
    shortId = shortIdFromSessionId(claudeId);
  } catch {
    return "unknown";
  }
  const list = agents ?? cachedListClaudeAgents();
  return agentForShortId(shortId, list) ? "alive" : "dead";
}

// resetSessionLivenessCaches — test seam / explicit invalidation (drops the
// id-cache and forces the next call to reopen catalyst.db).
export function resetSessionLivenessCaches() {
  _idCache.clear();
  _db = null;
  _dbTried = false;
}
