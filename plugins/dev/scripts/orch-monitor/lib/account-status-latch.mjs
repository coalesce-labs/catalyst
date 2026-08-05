// account-status-latch.mjs — CTL-1653. The edge-triggered transition emitter for
// the active Claude account's ok↔rejected status. Appends exactly ONE
// `account.status.changed` v2 event on each transition, never per probe.
//
// Mirrors broker-degraded.mjs: a PURE edge state machine (nextAccountStatusLatch),
// a durable marker (~/catalyst/account-status-latch.json, atomic tmp+rename), and
// EMIT-THEN-ADVANCE — the in-memory latch is authoritative and the marker follows it.
// The append happens FIRST; the latch advances ONLY on a successful append, so a
// transient log failure re-attempts the SAME edge next tick instead of swallowing a
// real transition (never-lose). The durable marker is persisted AFTER the append, and
// if that write fails a module-level `_persistPending` flag retries it on the next
// tick — in-memory stays authoritative meanwhile, so the retry never changes what is
// emitted; it only makes the on-disk copy catch up. This is exactly the reconcile
// broker-degraded.mjs uses (Codex #2740) and it satisfies BOTH guarantees at once:
// never re-announce an already-emitted episode after a restart (exactly-once) AND
// never lose a real transition to one bad write. NOT persist-before-emit — writing the
// advanced marker ahead of the append means a crash in that window hydrates an
// episode we never emitted on restart, permanently suppressing the edge (the defect
// this file previously regressed into).
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
// Codex #2740 reconcile (ported from broker-degraded.mjs): the marker write can fail
// AFTER the event append already succeeded and `_moduleLatch.prev` advanced. Swallowing
// that would leave memory and disk disagreeing with nothing to reconcile them, so a
// later restart could hydrate an absent/stale marker and re-emit a duplicate edge for
// the same episode. When the post-emit write fails we remember it and retry on every
// subsequent module-path tick until it lands; in-memory stays authoritative meanwhile.
let _persistPending = false;

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
  _persistPending = false;
}

const defaultEmit = (env) => emitEventLog(env);

/**
 * checkAccountStatusTransition — one timer-tick evaluation. Emits exactly one
 * `account.status.changed` event on the active account's ok↔rejected edge. Uses
 * EMIT-THEN-ADVANCE (mirrors broker-degraded.mjs): the append happens first, the
 * in-memory latch advances only on a successful append (so a failed append retries
 * the same edge next tick — never-lose), and the durable marker is persisted AFTER,
 * with a `_persistPending` retry if that write fails, so a restart never re-announces
 * an already-emitted episode (exactly-once) without ever losing a real transition.
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

  // Reconcile a previously-failed marker write before evaluating this tick (ported
  // from broker-degraded.mjs). Runs AFTER hydrateLatch so it never clobbers the
  // on-disk episode with un-hydrated defaults; in-memory state is authoritative, so
  // this only makes the on-disk copy catch up. Module-path only — an injected-state
  // test drives `persist` itself and never sets `_persistPending`.
  if (usingModule && _persistPending) {
    _persistPending = !persist({ latched: latch.prev === true });
  }

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

  // EMIT-THEN-ADVANCE: append the event FIRST. The in-memory latch advances ONLY on
  // a successful append, so a transient log failure re-attempts the SAME edge next
  // tick rather than silently dropping a real transition (never-lose). The durable
  // marker is written AFTER — never before — because a marker advanced ahead of the
  // append would, on a crash in that window, hydrate an already-advanced episode on
  // restart and suppress an edge that was never emitted.
  let ok;
  try {
    ok = emit(env) !== false;
  } catch {
    ok = false;
  }
  if (!ok) return null;

  // Append landed: the in-memory episode is now authoritative. Advance it, then
  // pin hydration closed (module path) so a later successful read of a stale/absent
  // marker — e.g. after a failed persist below — can never clobber what we just
  // committed to the event log. Persist the marker AFTER; if that write fails,
  // `_persistPending` retries it next tick (broker-degraded.mjs's reconcile).
  latch.prev = latched;
  if (usingModule) _hydrated = true;
  const persisted = persist({ latched });
  if (usingModule) _persistPending = !persisted;
  return edge;
}
