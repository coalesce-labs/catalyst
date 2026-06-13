// capacity-history.mjs — CTL-1092 Phase 5. Reads node.capacity.changed events
// from the unified event log and returns a per-host time-ordered change history.
//
// Pattern mirrors readClusterHeartbeats (execution-core/recovery.mjs): cheap
// string pre-filter → JSON parse → field extraction, with dependency injection
// for the log reader so tests never touch fs.
//
// Alias resolution (A4): pre-pin hostnames in the event log are mapped onto
// their current pinned names via `aliases` (catalyst.host.aliases from
// .catalyst/config.json). Steps from an aliased host merge into the pinned
// host's array. No destructive log migration needed.

import { readFileSync } from "node:fs";
import { resolveHostAlias } from "../../execution-core/host-alias.mjs";

export const CAPACITY_CHANGED_EVENT = "node.capacity.changed";

/**
 * readCapacityHistory — scan the event log for node.capacity.changed events and
 * return a per-host map of time-ordered capacity steps.
 *
 * @param {{ logPath?: string, read?: () => string, aliases?: Record<string,string> }} opts
 *   - `read`: injectable reader, called with no args, returns the raw log content.
 *     Defaults to readFileSync(logPath). Throws are caught → returns {}.
 *   - `aliases`: static alias map from catalyst.host.aliases (pre-pin → pinned name).
 *     Absent/null → no aliasing.
 * @returns {Record<string, Array<{ ts: string, old: number, new: number, reason: string }>>}
 */
export function readCapacityHistory({ read, logPath, aliases = null } = {}) {
  let raw;
  try {
    if (typeof read === "function") {
      raw = read();
    } else {
      raw = readFileSync(logPath ?? "", "utf8");
    }
  } catch {
    return {};
  }
  if (typeof raw !== "string" || raw.length === 0) return {};

  /** @type {Record<string, Array<{ ts: string, old: number, new: number, reason: string }>>} */
  const byHost = {};

  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Cheap pre-filter — avoids JSON.parse on every heartbeat/other line.
    if (!line.includes(CAPACITY_CHANGED_EVENT)) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.attributes?.["event.name"] !== CAPACITY_CHANGED_EVENT) continue;
    const rawHost =
      evt?.body?.payload?.["host.name"] ?? evt?.resource?.["host.name"];
    const ts = evt?.ts;
    const oldV = evt?.body?.payload?.old_maxParallel;
    const newV = evt?.body?.payload?.new_maxParallel;
    const reason = evt?.body?.payload?.reason;
    if (typeof rawHost !== "string" || rawHost.length === 0) continue;
    if (typeof ts !== "string" || ts.length === 0) continue;
    if (!Number.isInteger(oldV) || !Number.isInteger(newV)) continue;

    const host = resolveHostAlias(rawHost, aliases);
    if (!byHost[host]) byHost[host] = [];
    byHost[host].push({ ts, old: oldV, new: newV, reason: reason ?? "" });
  }

  // Sort each host's steps by ts ascending (ISO-8601 sorts lexicographically).
  for (const host of Object.keys(byHost)) {
    byHost[host].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  return byHost;
}
