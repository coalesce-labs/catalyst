// state.mjs — CTL-1994. Reading and writing a role's on-disk state.
//
// Every write is atomic (tmp + rename), because the reader is a doctor line and
// a half-written heartbeat that parses as garbage reads as "no heartbeat",
// which reads as "dead". A liveness signal must not be able to lie about
// liveness through its own write.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { roleFiles } from "./paths.mjs";

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A missing OR malformed file is `fallback`. Callers must treat a null
    // heartbeat as MISSING, never as healthy (see agent-liveness.classifyHeartbeat).
    return fallback;
  }
}

function writeJsonAtomic(path, obj) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readManifest(role, env = process.env) {
  return readJson(roleFiles(role, env).manifest);
}

export function writeManifest(role, manifest, env = process.env) {
  writeJsonAtomic(roleFiles(role, env).manifest, manifest);
}

/**
 * CTL-2129. Merge `keys` into manifest.scopeKeys (create the field if absent),
 * atomic, deduped, order-stable. This is the one write that makes
 * escalation-router.resolveSteward return non-null: a steward's manifest declares
 * which scope keys (Linear project ids) it owns, and the router keys off that
 * array. Written here (beside writeManifest) to preserve the single-writer
 * manifest discipline; the concierge scaffold calls it at steward launch via
 * install.sh --scope-keys → cli.mjs set-scope-keys.
 *
 * Merge-into-existing (not create-only) so an already-installed role can be
 * back-filled. A fresh role gets a minimal `{ role, scopeKeys }` manifest.
 * Non-string / empty keys are filtered — a scope key must be a real path key.
 */
export function setScopeKeys(role, keys, env = process.env) {
  const m = readManifest(role, env) ?? { role };
  const prior = Array.isArray(m.scopeKeys) ? m.scopeKeys : [];
  const next = Array.from(new Set([...prior, ...(Array.isArray(keys) ? keys : [])])).filter(
    (k) => typeof k === "string" && k.length > 0,
  );
  writeManifest(role, { ...m, scopeKeys: next }, env);
  return next;
}

export function readHeartbeat(role, env = process.env) {
  return readJson(roleFiles(role, env).heartbeat);
}

/**
 * Beat. `now` is injectable so tests never race the clock.
 * `lastArtifact` is the point: a heartbeat that only says "the process exists"
 * cannot distinguish a working role from a wedged one. Recording what it last
 * WROTE makes "quiet" checkable against "produced nothing".
 */
export function beat(role, { now = Date.now(), sessionId = null, lastTurnTs = null, lastArtifact = null, scope = null, state = "running" } = {}, env = process.env) {
  const hb = { role, scope, ts: now, state, session: sessionId, last_turn_ts: lastTurnTs, last_artifact: lastArtifact, host: hostname(), pid: process.pid };
  writeJsonAtomic(roleFiles(role, env).heartbeat, hb);
  return hb;
}

export function readCounters(role, env = process.env) {
  return readJson(roleFiles(role, env).counters, { restarts: [], reentries: [] });
}

export function recordEvent(role, kind, { now = Date.now() } = {}, env = process.env) {
  const c = readCounters(role, env);
  const key = kind === "reentry" ? "reentries" : "restarts";
  c[key] = [...(c[key] ?? []), now];
  writeJsonAtomic(roleFiles(role, env).counters, c);
  return c;
}

/** How many of `kind` happened in the last hour — the input to the storm caps. */
export function countLastHour(counters, kind, { now = Date.now() } = {}) {
  const key = kind === "reentry" ? "reentries" : "restarts";
  const cutoff = now - 60 * 60 * 1000;
  return (counters?.[key] ?? []).filter((t) => t >= cutoff).length;
}

export function readSession(role, env = process.env) {
  return readJson(roleFiles(role, env).session)?.session_id ?? null;
}

export function writeSession(role, sessionId, env = process.env) {
  writeJsonAtomic(roleFiles(role, env).session, { session_id: sessionId, ts: Date.now() });
}

// ── Lease: exactly one live process per role ────────────────────────────────
// Two stewards on one scope means double dispatch: both move the same tickets
// to Todo and both answer the same thread. The lease is what makes a
// restart-on-a-hunch safe.

export function readLease(role, env = process.env) {
  return readJson(roleFiles(role, env).lease);
}

/** Is a pid actually alive? `kill(pid, 0)` throws ESRCH when it is not. */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user — alive.
    return e?.code === "EPERM";
  }
}

/**
 * Take the lease, or refuse. Returns {ok, holder, reason}.
 * A stale lease (holder pid is gone) is takeable — otherwise a `kill -9`
 * would lock the role out permanently, which is the opposite of the goal.
 */
export function acquireLease(role, { now = Date.now(), pid = process.pid, isAlive = pidAlive } = {}, env = process.env) {
  const existing = readLease(role, env);
  if (existing && existing.pid !== pid && isAlive(existing.pid)) {
    return { ok: false, holder: existing, reason: `role '${role}' is already held by live pid ${existing.pid} on ${existing.host} — refusing to start a second process (double dispatch)` };
  }
  const lease = { role, pid, host: hostname(), ts: now };
  writeJsonAtomic(roleFiles(role, env).lease, lease);
  return { ok: true, holder: lease, reason: null };
}

export function releaseLease(role, { pid = process.pid } = {}, env = process.env) {
  const f = roleFiles(role, env).lease;
  const existing = readLease(role, env);
  if (existing && existing.pid !== pid) return false; // never release someone else's lease
  if (existsSync(f)) rmSync(f);
  return true;
}
