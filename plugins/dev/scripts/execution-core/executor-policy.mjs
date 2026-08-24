// executor-policy.mjs — CTL-2116. The FLEET routing policy: which executor runs
// which phase, stored once in the cluster repo's cluster.json and read live by
// every host (readClusterConfig is uncached, config.mjs:584-592) so a policy
// change needs no restart and no per-host edit.
//
// This module is PURE + one readFileSync. It deliberately does NOT canonicalize
// aliases or validate against EXECUTORS: that stays in resolveExecutorForPhase
// (config.mjs:1017-1035), which THROWS loudly on an invalid value. Duplicating
// the check here would create a second, silently-diverging validity ladder.
//
// Not a cli/*.mjs entry point (it lives outside cli/, imported by other .mjs
// modules), so it does not carry the CTL-1937 shell guard — that lint scans
// only `cli/*.mjs` paths.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { KNOWN_PHASES } from "../broker/namespace-contract.mjs";

export const EXECUTOR_POLICY_VERSION = 1;
export const HISTORY_MAX = 20;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// normalizePolicyRoutes — keep only non-empty string route values. Deliberately
// does NOT canonicalize aliases (claude-sdk→sdk) or validate against EXECUTORS —
// resolveExecutorForPhase owns that, so a value stored here survives verbatim and
// is judged once, at read time, by the single existing validity ladder.
export function normalizePolicyRoutes(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

// readExecutorPolicy — the policy out of <clusterDir>/cluster.json, or null.
// null means "no fleet policy" (the default) → the caller falls through to the
// pre-CTL-2116 ladder byte-for-byte. A malformed policy is ALSO null, and the
// caller warns: a partial map would silently hide a valid env/Layer-1 route,
// which is the same failure mode readExecutorByPhaseLayer1's env branch already
// guards against (config.mjs:963-985). "Malformed" is judged strictly — a route
// value that is not a string fails the WHOLE read, rather than being silently
// dropped by normalizePolicyRoutes, precisely so a single bad entry cannot
// smuggle out a partial (and therefore wrong) fleet policy.
export function readExecutorPolicy(clusterDir) {
  if (!clusterDir) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(clusterDir, "cluster.json"), "utf8"));
  } catch {
    return null; // absent/unreadable/garbage cluster.json
  }
  if (!isPlainObject(parsed)) return null;
  const policy = parsed.executorPolicy;
  if (policy === undefined) return null; // no key → zero behavior change
  if (!isPlainObject(policy)) return null; // e.g. "nope" or []

  const rawRoutes = policy.routes;
  if (!isPlainObject(rawRoutes)) return null; // e.g. routes: []
  for (const v of Object.values(rawRoutes)) {
    if (typeof v !== "string") return null; // e.g. {triage: false} — never a partial map
  }

  return {
    routes: normalizePolicyRoutes(rawRoutes),
    updatedAt: typeof policy.updatedAt === "string" ? policy.updatedAt : null,
    updatedBy: typeof policy.updatedBy === "string" ? policy.updatedBy : null,
    history: Array.isArray(policy.history) ? policy.history : [],
  };
}

function newEntryId() {
  return randomBytes(6).toString("hex");
}

function boundedHistory(entry, priorHistory) {
  const prior = Array.isArray(priorHistory) ? priorHistory : [];
  return [entry, ...prior].slice(0, HISTORY_MAX);
}

// applyRouteChange — pure. Returns { changed, next, entry }. `entry` carries the
// PRIOR route map in full (not just the single changed key) so rollback is an
// exact restore rather than an inverse-op replay — an inverse-op replay would
// silently diverge from the real prior state once two changes interleave across
// hosts. `all` maps every member of KNOWN_PHASES (the canonical 10), so
// Scenario 2's "no subsequent dispatch on any host uses Codex" is an explicit
// map, not an absence of routes. History is bounded at HISTORY_MAX newest-first
// because cluster.json is pulled by every host every 5 minutes.
export function applyRouteChange(policy, { phase, all, executor, by, host, at } = {}) {
  const base = isPlainObject(policy) ? policy : { routes: {}, history: [] };
  const priorRoutes = { ...(isPlainObject(base.routes) ? base.routes : {}) };

  let nextRoutesRaw;
  let changeEntry;
  if (all) {
    nextRoutesRaw = {};
    for (const p of KNOWN_PHASES) nextRoutesRaw[p] = executor;
    changeEntry = { phase: "*", from: null, to: executor ?? null };
  } else {
    nextRoutesRaw = { ...priorRoutes };
    if (executor === null || executor === undefined) {
      delete nextRoutesRaw[phase];
    } else {
      nextRoutesRaw[phase] = executor;
    }
    changeEntry = { phase, from: priorRoutes[phase] ?? null, to: executor ?? null };
  }

  const nextRoutes = normalizePolicyRoutes(nextRoutesRaw);

  const unchanged =
    Object.keys(nextRoutes).length === Object.keys(priorRoutes).length &&
    Object.entries(nextRoutes).every(([k, v]) => priorRoutes[k] === v);
  if (unchanged) {
    return { changed: false, next: base, entry: null };
  }

  const entry = {
    id: newEntryId(),
    at: at ?? new Date().toISOString(),
    by: by ?? null,
    host: host ?? null,
    change: changeEntry,
    priorRoutes,
  };
  const next = {
    ...base,
    routes: nextRoutes,
    updatedAt: entry.at,
    updatedBy: entry.by,
    history: boundedHistory(entry, base.history),
  };
  return { changed: true, next, entry };
}

// rollbackPolicy — pure. Restores history[0].priorRoutes and pushes the rollback
// itself as a new entry (so it is auditable, and so rollback-of-rollback works).
export function rollbackPolicy(policy, { by, host, at } = {}) {
  const base = isPlainObject(policy) ? policy : { routes: {}, history: [] };
  const history = Array.isArray(base.history) ? base.history : [];
  if (history.length === 0) {
    return { changed: false, next: base, entry: null, reason: "no-history" };
  }

  const last = history[0];
  const priorRoutes = { ...(isPlainObject(base.routes) ? base.routes : {}) };
  const restoredRoutes = normalizePolicyRoutes(
    isPlainObject(last?.priorRoutes) ? last.priorRoutes : {},
  );

  const entry = {
    id: newEntryId(),
    at: at ?? new Date().toISOString(),
    by: by ?? null,
    host: host ?? null,
    change: { phase: "*", from: null, to: null },
    priorRoutes,
    rollbackOf: last?.id ?? null,
  };
  const next = {
    ...base,
    routes: restoredRoutes,
    updatedAt: entry.at,
    updatedBy: entry.by,
    history: boundedHistory(entry, history),
  };
  return { changed: true, next, entry };
}
