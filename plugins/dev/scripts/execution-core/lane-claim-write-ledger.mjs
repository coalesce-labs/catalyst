// lane-claim-write-ledger.mjs — CTL-2070. The fleet's own durable write-ledger: the
// TIMELY per-ticket actor source for the CTL-2068 lane-claim guard.
//
// ⛔ WHY THIS EXISTS. The lane-claim guard must decide "who established the state this ticket
// is in right now?" during the ~200 s window after a claim, before `issue_history` catches up
// (CTL-1847: issues.state lands in ~11 s, issue_history in ~201 s). The daemon knows every
// Linear state IT set, because it set it — so instead of waiting for the reconcile feed, we
// record the fleet's own writes here at the moment they are applied. This needs no history rows
// (covers the 140 history-less tickets) and is INDEPENDENT of botUserIds (it identifies the
// fleet by its own writes, not by an app-actor id set).
//
// ⭐ THE THREE-VALUED CONTRACT IS LOAD-BEARING, AND IT IS THE MODULE'S HALF OF IT. This module
// only ever returns `null` (a durable "no entry") or an entry `{toState, atMs}` — NEVER
// `undefined`. `undefined` means "could not look" and is produced solely by the guard wrapper
// (Phase 4) when a read THROWS. Conflating the two would let a transient read error read as
// "the fleet never wrote this ticket" (→ lane → a spurious refusal), so the boundary is kept
// crisp: the module answers from a loaded map, the wrapper owns the throw→undefined mapping.
//
// A light leaf: node fs/path/os only, no bun:sqlite graph. The durable file is a small JSON
// object `{ [ticket]: { toState, atMs } }`, rewritten atomically (tmp + rename) on each applied
// transition — infrequent, off any hot loop, bounded by prune.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * defaultLedgerPath — `~/catalyst/lane-claim-write-ledger.json`, overridable by
 * CATALYST_LANE_CLAIM_LEDGER_PATH (tests inject an explicit path instead). Re-resolved per call
 * so CATALYST_DIR redirection (the test/CI convention) is honored.
 */
export function defaultLedgerPath() {
  const explicit = process.env.CATALYST_LANE_CLAIM_LEDGER_PATH;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const base = process.env.CATALYST_DIR || join(homedir(), "catalyst");
  return join(base, "lane-claim-write-ledger.json");
}

// A well-formed ledger entry is { toState: string|null, atMs: number }. Anything else on disk is
// treated as absent — a corrupt/hand-edited file must never crash the guard or fabricate a write.
function isEntry(v) {
  return v !== null && typeof v === "object" && typeof v.atMs === "number" && Number.isFinite(v.atMs);
}

/**
 * createLedger — an isolated ledger instance backed by one durable file. The production singleton
 * (below) is one of these; tests build their own with an injected `path` (and optionally injected
 * fs seams for the rename-failure case).
 *
 * @param {object} o
 * @param {string} [o.path] durable file path (default defaultLedgerPath()).
 * @param {number|null} [o.maxAgeMs] prune window; entries older than this (by atMs) are dropped
 *   on load and opportunistically on record. `null` = never prune by age.
 * @param {() => number} [o.now] wall-clock source for opportunistic prune (default Date.now).
 * @param {object} [o.fs] injectable { readFileSync, writeFileSync, renameSync, existsSync } for
 *   tests (default node:fs). Never used in production.
 */
export function createLedger({ path, maxAgeMs = null, now = () => Date.now(), fs } = {}) {
  const filePath = typeof path === "string" && path.length > 0 ? path : defaultLedgerPath();
  const _read = fs?.readFileSync ?? readFileSync;
  const _write = fs?.writeFileSync ?? writeFileSync;
  const _rename = fs?.renameSync ?? renameSync;
  const _exists = fs?.existsSync ?? existsSync;
  const map = new Map();

  // pruneMap — drop entries older than maxAgeMs by their own atMs. Pure over `map`.
  const pruneMap = (nowMs) => {
    if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs)) return;
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return;
    for (const [ticket, entry] of map) {
      if (nowMs - entry.atMs > maxAgeMs) map.delete(ticket);
    }
  };

  // load — read + parse the durable file into `map`, pruning stale entries. Fail-open: a
  // missing/corrupt/unreadable file yields an EMPTY ledger, never a throw. Returns the instance.
  const load = ({ nowMs } = {}) => {
    map.clear();
    let parsed = null;
    try {
      parsed = JSON.parse(_read(filePath, "utf8"));
    } catch {
      parsed = null; // ENOENT / malformed JSON → empty ledger (the fail-open direction)
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [ticket, entry] of Object.entries(parsed)) {
        if (typeof ticket === "string" && ticket.length > 0 && isEntry(entry)) {
          map.set(ticket, { toState: entry.toState ?? null, atMs: entry.atMs });
        }
      }
    }
    pruneMap(typeof nowMs === "number" ? nowMs : now());
    return instance;
  };

  // persist — atomic tmp + rename. tmp carries the pid so concurrent writers never share a tmp
  // name. Fail-open: a throw is swallowed by the caller (recordFleetWrite), leaving the prior
  // durable file intact.
  const persist = () => {
    const obj = {};
    for (const [ticket, entry] of map) obj[ticket] = entry;
    const tmp = `${filePath}.tmp.${process.pid}`;
    _write(tmp, JSON.stringify(obj), "utf8");
    _rename(tmp, filePath);
  };

  // readFleetWrite — the module NEVER returns undefined (see the three-valued contract above).
  const readFleetWrite = (ticket) => {
    if (typeof ticket !== "string" || ticket.length === 0) return null;
    const entry = map.get(ticket);
    return entry ? { toState: entry.toState ?? null, atMs: entry.atMs } : null;
  };

  // recordFleetWrite — last-write-wins upsert, then atomic persist. A malformed record (no
  // ticket / non-numeric atMs) is ignored. A persist throw is swallowed so a write never blocks
  // the transition that produced it.
  const recordFleetWrite = (ticket, toState, atMs) => {
    if (typeof ticket !== "string" || ticket.length === 0) return;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return;
    map.set(ticket, { toState: toState ?? null, atMs });
    if (typeof maxAgeMs === "number") pruneMap(now());
    try {
      persist();
    } catch {
      /* durable write failed — keep the in-memory entry, never block the transition */
    }
  };

  const prune = (nowMs) => {
    pruneMap(nowMs);
    try {
      persist();
    } catch {
      /* best-effort */
    }
  };

  const instance = {
    path: filePath,
    load,
    readFleetWrite,
    recordFleetWrite,
    prune,
    get size() {
      return map.size;
    },
    // test-only visibility into whether a stray tmp survived a persist.
    _tmpExists: () => _exists(`${filePath}.tmp.${process.pid}`),
  };
  return instance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Process singleton — production wiring. The scheduler's write-seam and the guard's read wrapper
// (both in the SAME daemon process) share this one in-memory map, so a write is visible to the
// next read with no broker/IPC. loadLedger() (re)initializes it at daemon boot from disk.
// ─────────────────────────────────────────────────────────────────────────────

let _singleton = null;

/**
 * loadLedger — (re)create the process singleton bound to `path` and seed it from disk. Called
 * once at daemon boot; called by tests to reset the singleton to a fresh tmp path.
 * @returns {ReturnType<typeof createLedger>} the loaded singleton (so callers can read .size).
 */
export function loadLedger(path, { maxAgeMs = null, nowMs } = {}) {
  _singleton = createLedger({ path, maxAgeMs });
  _singleton.load({ nowMs });
  return _singleton;
}

// Lazily materialize the singleton on first use so a fresh host with no boot-load still works.
function singleton() {
  if (!_singleton) _singleton = createLedger({});
  return _singleton;
}

/** readFleetWrite — singleton read. null (no entry) | { toState, atMs }; never undefined. */
export function readFleetWrite(ticket) {
  return singleton().readFleetWrite(ticket);
}

/** recordFleetWrite — singleton upsert + atomic persist. defaultRecordFleetWrite for scheduler. */
export function recordFleetWrite(ticket, toState, atMs) {
  return singleton().recordFleetWrite(ticket, toState, atMs);
}

/** pruneLedger — singleton prune by age. */
export function pruneLedger(nowMs) {
  return singleton().prune(nowMs);
}
