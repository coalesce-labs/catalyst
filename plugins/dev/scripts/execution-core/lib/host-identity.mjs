// lib/host-identity.mjs — host-identity primitives for MJS emitters.
//
// Mirrors lib/host-identity.sh (bash) and orch-monitor/lib/canonical-event-shared.ts (TS).
// All three runtimes use the same algorithm so host.id is identical for a given
// machine regardless of which stack emits the event.
//
// Algorithm:
//   host.name = CATALYST_HOST_NAME  (if set and non-empty)
//               else os.hostname() with trailing ".local" stripped
//   host.id   = sha256(host.name)[:16]   // 16 hex chars, same shape as spanId

import { createHash } from "node:crypto";
import { hostname } from "node:os";

// Memoize at module load — hostname does not change within a process.
let _cachedHostName = null;

/**
 * Resolve the effective host name.
 * @param {{ raw?: string, override?: string }} [opts]
 *   raw      — injected hostname string (used in tests)
 *   override — explicit override (wins over CATALYST_HOST_NAME env)
 */
export function hostName({ raw, override } = {}) {
  const o = override ?? process.env.CATALYST_HOST_NAME;
  if (o) return o;
  const base = raw ?? hostname();
  return base.replace(/\.local$/, "");
}

/**
 * Resolve the effective host id: sha256(hostName())[:16].
 * @param {{ raw?: string, override?: string }} [opts] — forwarded to hostName()
 */
export function hostId(opts = {}) {
  return createHash("sha256").update(hostName(opts)).digest("hex").slice(0, 16);
}
