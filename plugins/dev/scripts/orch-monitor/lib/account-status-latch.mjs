// account-status-latch.mjs — CTL-1653. The edge-triggered transition emitter for
// the active Claude account's ok↔rejected status. Appends exactly ONE
// `account.status.changed` v2 event on each transition, never per probe.
//
// Mirrors broker-degraded.mjs: a PURE edge state machine (nextAccountStatusLatch),
// a durable marker (~/catalyst/account-status-latch.json, atomic tmp+rename), and
// PERSIST-BEFORE-EMIT — the durable marker is the source of truth. The new episode
// state is written to disk BEFORE the append, so a restart can never re-announce an
// episode we already emitted (exactly-once across restarts). A failed persist emits
// nothing (nothing to duplicate) and a failed append rolls the marker back, so in
// either case the SAME edge is recomputed and retried next tick (never lose a real
// transition). The in-memory latch only advances once BOTH the marker and the append
// succeed, so it never diverges from disk in a way that re-announces an open episode.
//
// account.* is NOT a broker-protected namespace (account.ratelimit.sampled already
// lives there), so no namespace-contract change is needed.
//
// Import-light: only catalyst-agent/emit.mjs (the same buildAgentEnvelope +
// emitEventLog the existing account.ratelimit.sampled event uses) + node:*.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildAgentEnvelope, emitEventLog } from "../../catalyst-agent/emit.mjs";

export const ACCOUNT_STATUS_CHANGED_EVENT = "account.status.changed";

/**
 * nextAccountStatusLatch — PURE edge state machine (mirrors nextBrokerDegradedLatch).
 * `trip` is only consulted when NOT latched; once latched only `clear` releases it,
 * so a sustained `rejected` never re-emits.
 *
 * @param {boolean} prev  prior latch (true = an episode is open)
 * @param {{trip:boolean, clear:boolean}} verdict
 * @returns {{latched:boolean, emit:("rejected"|"recovered"|null)}}
 */
export function nextAccountStatusLatch(prev, { trip, clear } = {}) {
  if (!prev && trip) return { latched: true, emit: "rejected" };
  if (prev && clear) return { latched: false, emit: "recovered" };
  return { latched: prev === true, emit: null };
}

// ─── Durable latch (mirrors broker-degraded.mjs) ─────────────────────────────
// Module-scoped so the episode persists across ticks; PERSISTED to disk +
// hydrated on the first tick so a monitor RESTART mid-episode does not re-emit.
const _moduleLatch = { prev: false };
let _hydrated = false;

// Resolved per call (not a load-time const) so tests can redirect via CATALYST_DIR.
// Prefer process.env.HOME over homedir() for parity with getEventLogPath (macOS's
// homedir() ignores HOME).
export function getAccountStatusLatchPath() {
  const home = process.env.HOME ?? homedir();
  const catalystDir = process.env.CATALYST_DIR ?? `${home}/catalyst`;
  return resolve(catalystDir, "account-status-latch.json");
}

// hydrateLatch — lazily load the persisted episode on this process's first
// module-path tick. Never throws. Absence/corruption are CONFIRMATIONS of "no
// open episode"; any other read error is transient — leave un-hydrated so the
// next tick retries and touch nothing.
function hydrateLatch() {
  if (_hydrated) return;
  let raw;
  try {
    raw = readFileSync(getAccountStatusLatchPath(), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") {
      _hydrated = true; // CONFIRMED: no episode on disk
      _moduleLatch.prev = false;
      return;
    }
    return; // transient — retry next tick, learn nothing
  }
  _hydrated = true;
  try {
    const m = JSON.parse(raw);
    _moduleLatch.prev = m?.latched === true;
  } catch {
    _moduleLatch.prev = false; // malformed → unlatched
  }
}

// persistLatchToDisk — atomic tmp + rename write of the episode state.
// Best-effort; returns true on success, false on failure (never throws).
function persistLatchToDisk({ latched }) {
  let tmp = null;
  try {
    const path = getAccountStatusLatchPath();
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    tmp = join(dir, `.account-status-latch.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, JSON.stringify({ latched, ts: Date.now() }));
    renameSync(tmp, path);
    return true;
  } catch {
    if (tmp !== null) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* retry next tick uses a fresh name */
      }
    }
    return false;
  }
}

// __resetAccountStatusLatchForTest — clears in-memory episode + hydration flag so
// the next module-path tick re-reads the CATALYST_DIR-scoped marker (simulates a
// restart). The unit tests inject their own `state`, so this is for integration
// coverage only.
export function __resetAccountStatusLatchForTest() {
  _moduleLatch.prev = false;
  _hydrated = false;
}

const defaultEmit = (env) => emitEventLog(env);

/**
 * checkAccountStatusTransition — one timer-tick evaluation. Emits exactly one
 * `account.status.changed` event on the active account's ok↔rejected edge. The
 * durable marker is persisted BEFORE the append and the in-memory latch advances
 * only once BOTH succeed (persist-before-emit), so a restart never re-announces an
 * already-emitted episode and a failed write re-attempts the same edge next tick.
 *
 * `degraded`, `error`, and `unknown` neither trip nor clear — they HOLD the
 * current latch (only a definitive `rejected`/`ok` moves it).
 *
 * @param {object} summary  a deriveAccountsSummary() result ({node, status, active})
 * @param {object} [opts]
 * @param {Function} [opts.emit]     (env) => boolean; false = failed append. Default: emitEventLog.
 * @param {object}   [opts.state]    injectable latch { prev:boolean } (tests). Default: module latch.
 * @param {Function} [opts.persist]  ({latched}) => boolean. Default: durable marker (module path only).
 * @returns {Promise<"rejected"|"recovered"|null>} the emitted edge, or null.
 */
export async function checkAccountStatusTransition(summary, opts = {}) {
  const { emit = defaultEmit, state = null } = opts;
  const usingModule = state === null;
  if (usingModule) hydrateLatch();
  const latch = usingModule ? _moduleLatch : state;
  const persist = opts.persist ?? (usingModule ? persistLatchToDisk : () => true);

  const trip = summary?.status === "rejected";
  const clear = summary?.status === "ok";
  const { latched, emit: edge } = nextAccountStatusLatch(latch.prev === true, { trip, clear });
  if (!edge) return null;

  const status = edge === "rejected" ? "rejected" : "ok";
  const env = buildAgentEnvelope(ACCOUNT_STATUS_CHANGED_EVENT, {
    entity: "account",
    label: summary.active?.email ?? summary.active?.label ?? "unknown",
    attrs: {
      "account.handle": summary.active?.label,
      "account.email": summary.active?.email,
      "account.status": status,
      "account.binding_window": summary.active?.bindingWindow,
      "node.name": summary.node,
    },
    payload: { node: summary.node, handle: summary.active?.label, status: edge },
  });

  // PERSIST-BEFORE-EMIT: write the NEW episode state to the durable marker BEFORE
  // appending, so the marker is the source of truth. If the marker write fails we
  // emit nothing and leave the in-memory latch untouched — there is nothing to
  // duplicate and the same edge is recomputed and retried next tick.
  const prevLatched = latch.prev === true;
  if (!persist({ latched })) return null;

  let ok;
  try {
    ok = emit(env) !== false;
  } catch {
    ok = false;
  }
  if (!ok) {
    // Append failed after the marker advanced. Roll the marker back to the
    // pre-edge state and leave the in-memory latch untouched so the next tick
    // recomputes and retries this edge (a real transition is never lost to one
    // bad append). The rollback keeps disk consistent with the un-advanced latch.
    persist({ latched: prevLatched });
    return null;
  }

  // Both the durable marker and the append succeeded — advance the in-memory
  // latch to match disk. In-memory and on-disk never diverge in a way that
  // re-announces an open episode after a restart.
  latch.prev = latched;
  return edge;
}
