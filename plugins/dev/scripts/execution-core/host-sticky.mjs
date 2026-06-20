// host-sticky.mjs — machine-local sticky host identity record (CTL-1093 Phase 1).
// Reads/writes <dir>/.host-identity.json. Never throws on read.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = ".host-identity.json";

/**
 * Returns the recorded sticky host name, or null if absent/malformed.
 * Never throws.
 */
export function readStickyIdentity({ dir }) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, FILE), "utf8"));
    const name = parsed?.name;
    return (typeof name === "string" && name.length > 0) ? name : null;
  } catch { return null; }
}

/**
 * Persists the given name as the sticky identity. Best-effort — never blocks boot.
 */
export function writeStickyIdentity({ dir, name }) {
  try {
    writeFileSync(resolve(dir, FILE),
      JSON.stringify({ name, recordedAt: new Date().toISOString() }, null, 2));
  } catch { /* best-effort; never block boot */ }
}
