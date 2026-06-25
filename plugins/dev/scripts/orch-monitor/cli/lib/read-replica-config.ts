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

// Mirrors config.mjs getLayer2ConfigPath(): CATALYST_LAYER2_CONFIG_FILE override,
// else ~/.config/catalyst/config.json.
function layer2Path(): string {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ??
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
 * This node's class for read-resolution. Mirrors config.mjs getNodeClass
 * precedence: `CATALYST_NODE_CLASS` env → `catalyst.node.class` (Layer-2) →
 * default `worker`. The read path only branches on `developer`, so a
 * present-but-unrecognized value resolves to `worker` here (it reads its own
 * replica, the same as today); `catalyst doctor` is what FAILs a typo'd class
 * (see config.mjs resolveNodeClass). Never throws.
 */
export function nodeClassForRead(): NodeClass {
  const envRaw = process.env.CATALYST_NODE_CLASS;
  const raw =
    typeof envRaw === "string" && envRaw.trim().length > 0
      ? envRaw
      : (readLayer2() as { catalyst?: { node?: { class?: unknown } } } | null)?.catalyst?.node?.class;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if ((NODE_CLASSES as readonly string[]).includes(normalized)) return normalized as NodeClass;
  }
  return "worker";
}
