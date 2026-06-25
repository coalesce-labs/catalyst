// read-replica-config.ts — Node-side Layer-2 reads for the read-replica resolver
// (CTL-1346). Mirrors execution-core/config.mjs (getLayer2ConfigPath / the
// getNodeClass precedence / the catalyst.readReplica.baseUrl key) in TS so the CLI
// never imports the `.mjs` config module — the same cross-runtime mirroring
// lib/canonical-event-shared.ts already uses for the host name. Keeping the Layer-2
// reads here (not in read-model-url.ts) keeps that resolver pure + bundler-safe.
// Never throws: a missing/malformed/unreadable Layer-2 file falls through to the
// safe default.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { NodeClass } from "./read-model-url";

const NODE_CLASSES: readonly NodeClass[] = ["developer", "worker", "monitor"];
// An explicit but unrecognized class degrades to the most restrictive one, exactly
// as config.mjs resolveNodeClass does, so a typo (e.g. `developr`) never reads the
// empty localhost replica this resolver exists to avoid.
const MOST_RESTRICTIVE_CLASS: NodeClass = "monitor";

// Mirrors config.mjs getLayer2ConfigPath(): CATALYST_LAYER2_CONFIG_FILE override,
// else ~/.config/catalyst/config.json. Uses `||` (not `??`) so an empty-string
// override (`CATALYST_LAYER2_CONFIG_FILE=`) falls back to the default path instead
// of resolving to "" — parity with config.mjs.
function layer2Path(): string {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json")
  );
}

function readLayer2(): unknown {
  try {
    return JSON.parse(readFileSync(layer2Path(), "utf8"));
  } catch {
    return null; // missing/malformed → caller falls through to its safe default
  }
}

/**
 * `catalyst.readReplica.baseUrl` from the Layer-2 config, trimmed, or null when
 * the key is unset / blank / non-string / the file is unreadable.
 */
export function readReplicaBaseUrlFromLayer2(): string | null {
  const value = (readLayer2() as { catalyst?: { readReplica?: { baseUrl?: unknown } } } | null)
    ?.catalyst?.readReplica?.baseUrl;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * This node's class for read-resolution. Mirrors config.mjs resolveNodeClass
 * precedence and validity ladder: `CATALYST_NODE_CLASS` env → `catalyst.node.class`
 * (Layer-2) → default `worker`.
 *   - absent / null / empty-string ⇒ `worker` (the unset, zero-config default).
 *   - a present-but-invalid value (non-string, or an unknown string like
 *     `developr`) ⇒ the most-restrictive `monitor`, so a typo can never make a
 *     developer node silently read the empty localhost replica (it errors instead;
 *     `catalyst doctor` separately FAILs the typo'd class). Never throws.
 */
export function nodeClassForRead(): NodeClass {
  const envRaw = process.env.CATALYST_NODE_CLASS;
  const hasEnv = typeof envRaw === "string" && envRaw.trim().length > 0;
  const raw = hasEnv
    ? envRaw
    : (readLayer2() as { catalyst?: { node?: { class?: unknown } } } | null)?.catalyst?.node?.class;

  // Absent / explicit null/empty "unset" sentinel ⇒ worker (reads its own replica).
  if (raw === undefined || raw === null) return "worker";
  // Present but not a string ⇒ explicit misconfiguration ⇒ most restrictive.
  if (typeof raw !== "string") return MOST_RESTRICTIVE_CLASS;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return "worker"; // empty/blank ⇒ unset (mirrors empty env)
  if ((NODE_CLASSES as readonly string[]).includes(normalized)) return normalized as NodeClass;
  return MOST_RESTRICTIVE_CLASS; // present non-empty but unknown ⇒ invalid
}
