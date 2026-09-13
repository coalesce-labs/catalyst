// config-schema.mjs — CTL-1211. Cluster-config schema versioning policy.
//
// A cluster is inherently multi-version (rolling upgrades): two nodes on
// different stack versions read the same cluster.json. An un-versioned schema
// change silently misreads, so every cluster config carries a top-level integer
// `schemaVersion`. Policy (design §5):
//   version  < min      → migrate forward (ordered, forward-only, idempotent)
//   version ∈ [min,cur] → ok (tolerate unknown additive fields)
//   version  > current  → FAIL-CLOSED (refuse to act; starvation, not corruption)
//
// Unversioned config is treated as v1 (the first schema).

export const CLUSTER_SCHEMA_CURRENT = 1;
export const CLUSTER_SCHEMA_MIN = 1; // oldest schema this stack can still read

// schemaCompat(version) → "ok" | "migrate" | "too-new"
// Never throws; a non-integer version is treated as v1 (unversioned == first schema).
export function schemaCompat(
  version,
  { current = CLUSTER_SCHEMA_CURRENT, min = CLUSTER_SCHEMA_MIN } = {},
) {
  const v = Number.isInteger(version) ? version : 1;
  if (v > current) return "too-new";
  if (v < min) return "migrate";
  return "ok";
}

// migrateClusterConfig(config) → config
// Forward-only, idempotent migrations applied in order. Current schema is 1, so
// there are no migrations yet — future breaking changes add an ordered step here
// (same pattern as catalyst.db schema_migrations). Returns the config unchanged
// when already current.
export function migrateClusterConfig(config) {
  if (!config || typeof config !== "object") return config;
  // const v = Number.isInteger(config.schemaVersion) ? config.schemaVersion : 1;
  // if (v < 2) config = migrateV1toV2(config);  // example shape for the future
  return config;
}
