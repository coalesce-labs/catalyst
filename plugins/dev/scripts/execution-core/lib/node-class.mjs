// lib/node-class.mjs — node-class resolution primitives for MJS emitters (CTL-1368).
//
// A dependency-free LEAF (node builtins only — no config.mjs, no pino, no bun:sqlite) so
// the shared resource builder (lib/catalyst-resource.mjs) and any light emitter (broker,
// catalyst-agent) can stamp `catalyst.node.class` WITHOUT dragging the heavy config.mjs
// graph. Mirrors execution-core/config.mjs's resolveNodeClass EXACTLY — the same way
// lib/host-identity.mjs mirrors getHostName's Layer-2 read rather than importing config.mjs.
// Drift is guarded by lib/__tests__/node-class-parity.test.mjs (asserts this resolver and
// config.mjs's agree across the full input matrix). config.mjs stays the canonical home for
// the dispatch/doctor logic; this leaf is the read-only mirror for telemetry.

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The three node classes (frozen). Mirrors config.mjs NODE_CLASSES.
export const NODE_CLASSES = Object.freeze(["developer", "worker", "monitor"]);
// Absent ⇒ worker ⇒ today's behavior, zero change.
const NODE_CLASS_DEFAULT = "worker";
// An EXPLICIT but unrecognized value (a typo'd "developr") degrades to the MOST
// RESTRICTIVE class so a typo can never make a node work-eligible (recognized:false
// routes catalyst doctor to FAIL).
const NODE_CLASS_MOST_RESTRICTIVE = "monitor";

// Layer-2 (machine-local) config path — mirrors config.mjs getLayer2ConfigPath()
// (CATALYST_LAYER2_CONFIG_FILE || ~/.config/catalyst/config.json), duplicated here to
// keep this a leaf (same pattern host-identity.mjs uses for layer2HostName).
function getLayer2ConfigPath() {
  return process.env.CATALYST_LAYER2_CONFIG_FILE || resolve(homedir(), ".config", "catalyst", "config.json");
}

// readLayer2NodeClass — the raw catalyst.node.class value from the Layer-2 file EXACTLY as
// written (whatever JSON type), or undefined when absent/missing/malformed. Never throws.
function readLayer2NodeClass() {
  try {
    return JSON.parse(readFileSync(getLayer2ConfigPath(), "utf8"))?.catalyst?.node?.class;
  } catch {
    return undefined;
  }
}

/**
 * resolveNodeClass — the pure, no-logging node-class resolver (verbatim mirror of
 * config.mjs resolveNodeClass). Precedence CATALYST_NODE_CLASS env → Layer-2
 * catalyst.node.class → default worker; never throws. Returns
 *   { class, source, inferred, recognized, raw }
 * Validity ladder: absent/null/empty ⇒ worker (inferred); present non-string ⇒ monitor
 * (recognized:false); non-empty string is trimmed+lowercased then membership-checked
 * (a genuine non-member ⇒ monitor, recognized:false).
 */
export function resolveNodeClass() {
  const envRaw = process.env.CATALYST_NODE_CLASS;
  const hasEnv = typeof envRaw === "string" && envRaw.trim().length > 0;
  const raw = hasEnv ? envRaw : readLayer2NodeClass();
  const source = hasEnv ? "env" : "layer2";

  if (raw === undefined || raw === null) {
    return { class: NODE_CLASS_DEFAULT, source: "default", inferred: true, recognized: true, raw: null };
  }
  if (typeof raw !== "string") {
    return { class: NODE_CLASS_MOST_RESTRICTIVE, source, inferred: false, recognized: false, raw };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return { class: NODE_CLASS_DEFAULT, source: "default", inferred: true, recognized: true, raw: null };
  }
  if (NODE_CLASSES.includes(normalized)) {
    return { class: normalized, source, inferred: false, recognized: true, raw };
  }
  return { class: NODE_CLASS_MOST_RESTRICTIVE, source, inferred: false, recognized: false, raw };
}

// nodeClass — the resolved class STRING (developer|worker|monitor). The log-free hot-path
// accessor for telemetry resources (no warn — that stays with config.mjs getNodeClass for
// the boot/doctor paths). Always returns a valid member.
export function nodeClass() {
  return resolveNodeClass().class;
}
