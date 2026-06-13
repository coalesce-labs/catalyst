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
