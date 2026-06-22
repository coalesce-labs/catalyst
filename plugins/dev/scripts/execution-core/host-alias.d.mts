// Type declarations for host-alias.mjs (CTL-1092). Read-time host alias
// resolution for pre-pin OS names. The .mjs remains the single source of truth;
// this file only gives TS callers (orch-monitor/server.ts) the signatures.

/**
 * Map a raw hostname through the alias table. Returns the aliased name if found,
 * else the original name unchanged. A null/undefined map is pass-through.
 */
export function resolveHostAlias(name: string, aliases?: Record<string, string> | null): string;

/**
 * Read catalyst.host.aliases from Layer-1 config. Returns {} when the file is
 * absent, unreadable, or the key is missing/non-object.
 */
export function loadHostAliases(args?: { configPath?: string }): Record<string, string>;
