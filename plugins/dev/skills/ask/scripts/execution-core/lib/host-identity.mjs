// lib/host-identity.mjs — host-identity primitives for MJS emitters.
//
// Mirrors lib/host-identity.sh (bash) and orch-monitor/lib/canonical-event-shared.ts (TS).
// All three runtimes use the same algorithm so host.id is identical for a given
// machine regardless of which stack emits the event.
//
// Algorithm:
//   host.name = CATALYST_HOST_NAME  (if set and non-empty)
//               else catalyst.host.name from Layer-2 config  (if readable and non-empty)
//               else os.hostname() reduced to its first DNS label
//   host.id   = sha256(host.name)[:16]   // 16 hex chars, same shape as spanId

import { createHash } from "node:crypto";
import { hostname, homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Layer-2 (machine-local) config — mirrors config.mjs getLayer2ConfigPath()/getHostName().
function layer2HostName() {
  const path = process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json");
  try {
    const name = JSON.parse(readFileSync(path, "utf8"))?.catalyst?.host?.name;
    if (typeof name === "string" && name.length > 0) return name;
  } catch { /* missing/malformed → caller falls through */ }
  return null;
}

/**
 * Resolve the effective host name.
 * @param {{ raw?: string, override?: string }} [opts]
 *   raw      — injected hostname string (used in tests; skips Layer-2 config read)
 *   override — explicit override (wins over CATALYST_HOST_NAME env)
 */
export function hostName({ raw, override } = {}) {
  const o = override ?? process.env.CATALYST_HOST_NAME;
  if (o) return o;
  if (raw === undefined) {
    const cfg = layer2HostName();
    if (cfg) return cfg;
  }
  // Fallback only: a bare os.hostname() may be a FQDN (mini.rozich, mini.local).
  // Canonical host names are short — take the first label. Explicit override /
  // env / Layer-2 values above are returned verbatim. (CTL-1252)
  const base = raw ?? hostname();
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

/**
 * Resolve the effective host id: sha256(hostName())[:16].
 * @param {{ raw?: string, override?: string }} [opts] — forwarded to hostName()
 */
export function hostId(opts = {}) {
  return createHash("sha256").update(hostName(opts)).digest("hex").slice(0, 16);
}
