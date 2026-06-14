// governance-reader.mjs — shared read-only foundation for all governance HTTP
// endpoints (CTL-1100). Exports the canonical open/wrap helpers, the event
// allowlist predicate, and the path resolver.
//
// VITE-GRAPH GUARD (same pattern as belief-reader.mjs, CTL-883):
// execution-core/beliefs/schema.mjs has a top-level
//   import { Database } from "bun:sqlite"
// This module is imported by server.ts via a COMPUTED specifier so esbuild
// cannot follow the dependency graph into bun:sqlite. See openBeliefsDbRO()
// for the lazy import pattern. DO NOT change the computed specifier to a
// string literal.
//
// Graceful degradation (audit-tap-must-not-be-load-bearing):
// Every read endpoint that uses this module returns 200 + an empty/open payload
// when the data source is absent. openBeliefsDbRO returns null (never throws)
// on any failure; withBeliefsDbRO always closes the handle and always returns
// the caller-supplied fallback when the db is unavailable or the fn throws.

import { homedir } from "node:os";
import { join } from "node:path";

// defaultBeliefsDbPath — mirrors schema.mjs:33-37 env precedence exactly.
// CATALYST_BELIEFS_DB wins; then CATALYST_DIR/beliefs.db; then ~/catalyst/beliefs.db.
export function defaultBeliefsDbPath(env = process.env) {
  if (env.CATALYST_BELIEFS_DB) return env.CATALYST_BELIEFS_DB;
  const catalystDir = env.CATALYST_DIR || join(homedir(), "catalyst");
  return join(catalystDir, "beliefs.db");
}

// openBeliefsDbRO — lazily open beliefs.db READ-ONLY.
// Returns the db handle or null if the file is absent / import fails.
// Callers must treat null as "data unavailable — degrade to empty".
// DO NOT cache the returned handle long-term (avoids pinning a WAL checkpoint).
export async function openBeliefsDbRO(dbPath) {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(dbPath, { readonly: true, create: false });
  } catch {
    return null;
  }
}

// withBeliefsDbRO — the single degradation wrapper for all db-backed endpoints.
// Opens a RO handle, runs fn(db), closes in finally, returns fallback on null/throw.
export async function withBeliefsDbRO(dbPath, fn, fallback) {
  const db = await openBeliefsDbRO(dbPath);
  if (db == null) return fallback;
  try {
    return await fn(db);
  } catch {
    return fallback;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

// GOVERNANCE_EVENT_PREFIXES — the allowlist of valid event name prefixes for
// governance feed filtering. Covers every step in the workflow pipeline
// (triage → teardown) plus the ancillary remediate step. Each prefix is
// `phase.<step>.` so a startsWith check narrows the allow-region precisely
// (e.g. `phase.terminal.reap-complete` is NOT admitted because `phase.terminal.`
// is not in this set — CTL-1100 Phase 7 regression contract).
export const GOVERNANCE_EVENT_PREFIXES = Object.freeze([
  "phase.triage.",
  "phase.research.",
  "phase.plan.",
  "phase.implement.",
  "phase.verify.",
  "phase.review.",
  "phase.pr.",
  "phase.monitor-merge.",
  "phase.monitor-deploy.",
  "phase.teardown.",
  "phase.remediate.",
]);

// isGovernanceEvent — true iff the event name is a governance-relevant phase
// lifecycle event that should appear in governance feeds.
//
// Two-step gate:
//   1. Blocklist: reject names that contain "reap" or "would." or that start
//      with the reaper-family prefixes (janitor. / worktree. / orphans.).
//      This structural guard means a future reap type is safe regardless of its
//      exact name, provided it contains "reap" or "would." or carries a
//      reaper-family prefix.
//   2. Allowlist: the name must start with one of GOVERNANCE_EVENT_PREFIXES.
//      A bare `startsWith("phase.")` would wrongly admit
//      `phase.terminal.reap-complete` and `phase.predecessor.reap-requested`
//      (Phase 7 regression contract). Only the curated per-step prefixes admit.
export function isGovernanceEvent(name) {
  // Blocklist check.
  if (
    name.includes("reap") ||
    name.includes("would.") ||
    name.startsWith("janitor.") ||
    name.startsWith("worktree.") ||
    name.startsWith("orphans.")
  ) {
    return false;
  }
  // Allowlist check.
  return GOVERNANCE_EVENT_PREFIXES.some((prefix) => name.startsWith(prefix));
}
