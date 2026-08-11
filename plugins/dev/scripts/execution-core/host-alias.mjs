// host-alias.mjs — CTL-1092. Read-time host alias resolution for pre-pin OS names.
//
// Reads the catalyst.host.aliases map from Layer-1 config (.catalyst/config.json)
// so old heartbeat keys (pre-pin OS hostnames) merge onto pinned roster names.
// Pure functions — no network, no timers.

import { readFileSync } from "node:fs";

/**
 * resolveHostAlias — map a raw hostname through the alias table.
 * Returns the aliased name if found, else the original name unchanged.
 * Null/undefined aliases map is treated as empty (pass-through).
 */
export function resolveHostAlias(name, aliases) {
  if (!aliases || typeof aliases !== "object") return name;
  return aliases[name] ?? name;
}

/**
 * loadHostAliases — read catalyst.host.aliases from Layer-1 config.
 * Returns {} when the file is absent, unreadable, or the key is missing.
 */
export function loadHostAliases({ configPath } = {}) {
  if (!configPath) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    const aliases = cfg?.catalyst?.host?.aliases;
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return {};
    return aliases;
  } catch {
    return {};
  }
}

/**
 * foldMapByAlias — CAT-197. Collapse a map's raw (pre-pin) keys onto pinned roster
 * names via the alias table, same direction and semantics as resolveHostAlias.
 *
 * A cache populated straight from a raw source (e.g. Loki's `host_name` label,
 * a pre-pin OS hostname like "cddock") stays keyed by that raw name forever unless
 * folded — a caller that later asks for it by the PINNED name ("vega") will never
 * find it, since resolveHostAlias only maps forward (raw → pinned), not backward.
 * cluster-view.mjs already folds its own heartbeat map this way at write time
 * (why liveness has always correctly resolved an aliased host); this is the same
 * fold, extracted so any other raw-keyed cache (e.g. server.ts's per-host capacity
 * cache) can apply it too instead of trying to resolve the pinned name backward
 * through the alias table at read time, which is a no-op and never finds anything.
 *
 * Last-write-wins if two raw keys alias to the same pinned name (matches the
 * existing inline admission-cache fold's semantics — no separate recency field
 * to arbitrate on here).
 */
export function foldMapByAlias(map, aliases) {
  if (!map || typeof map !== "object") return {};
  const out = {};
  for (const [rawHost, value] of Object.entries(map)) {
    out[resolveHostAlias(rawHost, aliases)] = value;
  }
  return out;
}
