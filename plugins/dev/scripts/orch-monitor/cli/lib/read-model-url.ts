// read-model-url.ts — resolve the orch-monitor read-model SSE URL for the
// terminal HUD (CTL-920 / HUD2), node-class + Layer-2 aware (CTL-1346).
//
// The HUD has historically made ZERO `fetch`/`EventSource` calls — it scanned
// raw files itself. HUD2 makes it a CONSUMER of the shared read-model SSE the
// web/iPad already consume (`/api/board/stream`). The web client uses a
// browser-relative path (the page origin IS the server); the Node-side HUD has
// no page origin, so it must build an ABSOLUTE URL pointing at a monitor.
//
// CTL-1346 — read-architecture per node class. A `developer` (daemonless) node
// runs no broker, so its LOCAL `filter-state.db` replica is empty; it must read a
// WORKER's monitor. The base now resolves through:
//   1. `CATALYST_MONITOR_URL` env (explicit override — unchanged, still wins)
//   2. `catalyst.readReplica.baseUrl` (Layer-2 machine-local config)
//   3. class-aware default:
//        - developer / monitor ⇒ NO base — refuse the localhost fallback (which
//          would serve an empty replica); the caller surfaces an explicit
//          unset/error. Both read a REMOTE replica (design §3 read-source table).
//        - worker / unknown ⇒ `http://127.0.0.1:<MONITOR_PORT|7400>` (its own
//          broker fills + serves the local replica).
//
// This module stays PURE: the Layer-2 baseUrl + node class are INJECTED (read by
// read-replica-config.ts on the Node side), so it imports no fs/config and never
// pulls a runtime config module into a bundler graph.

import { READ_MODEL_STREAM_PATH } from "../../lib/read-model-client";

/** The server's default port (server.ts:243 `DEFAULT_PORT = 7400`). */
export const DEFAULT_MONITOR_PORT = 7400;

/**
 * The env this resolver reads. A plain string→string|undefined record so the
 * HUD can pass `process.env` directly (Bun's `ProcessEnv`) while tests pass a
 * literal. Only `MONITOR_PORT` and `CATALYST_MONITOR_URL` are consulted.
 */
export type ReadModelUrlEnv = Record<string, string | undefined>;

/** The node classes whose read behavior differs (CTL-1344 enum). */
export type NodeClass = "developer" | "worker" | "monitor";

/** Inputs to the node-aware base resolver. All injected → the module stays pure. */
export interface ReadModelBaseInputs {
  /** process.env (or a test literal). `CATALYST_MONITOR_URL` + `MONITOR_PORT`. */
  env: ReadModelUrlEnv;
  /** `catalyst.readReplica.baseUrl` from Layer-2 (null/undefined when unset). */
  layer2BaseUrl?: string | null;
  /** This node's class. Only `developer` changes the no-endpoint behavior. */
  nodeClass?: NodeClass;
}

export type ReadModelBaseResult =
  | { ok: true; base: string }
  | { ok: false; reason: string };

export type ReadModelStreamUrlResult =
  | { ok: true; base: string; url: string }
  | { ok: false; reason: string };

/**
 * Resolve the read-replica base URL (no path). Precedence:
 *   1. `CATALYST_MONITOR_URL` env (explicit override)
 *   2. `catalyst.readReplica.baseUrl` (Layer-2)
 *   3. class-aware default — developer / monitor ⇒ `{ ok:false }` (no silent
 *      localhost; both read a remote replica); worker / unknown ⇒
 *      `http://127.0.0.1:<MONITOR_PORT|7400>`.
 */
export function resolveReadModelBase(inputs: ReadModelBaseInputs): ReadModelBaseResult {
  const envBase = explicitBase(inputs.env.CATALYST_MONITOR_URL);
  if (envBase) return { ok: true, base: envBase };

  const layer2Base = explicitBase(inputs.layer2BaseUrl ?? undefined);
  if (layer2Base) return { ok: true, base: layer2Base };

  // developer and monitor both read a REMOTE replica (design §3 read-source
  // table — only worker reads its own local replica). An invalid explicit class
  // resolves to the most-restrictive `monitor` (read-replica-config.ts), so this
  // also closes the typo footgun: a misconfigured node never silently reads the
  // empty localhost replica.
  if (inputs.nodeClass === "developer" || inputs.nodeClass === "monitor") {
    return {
      ok: false,
      reason:
        `${inputs.nodeClass} node has no read-replica endpoint — set CATALYST_MONITOR_URL ` +
        "or catalyst.readReplica.baseUrl to a worker's monitor (e.g. http://mini:7400); " +
        "refusing to fall back to localhost, which would serve an empty replica",
    };
  }

  return { ok: true, base: `http://127.0.0.1:${resolvePort(inputs.env)}` };
}

/**
 * Resolve the absolute SSE stream URL (resolved base + the shared
 * `READ_MODEL_STREAM_PATH`, so the HUD and the web client agree by construction).
 * Propagates the `{ ok:false }` developer-no-endpoint case unchanged.
 */
export function resolveReadModelStreamUrl(inputs: ReadModelBaseInputs): ReadModelStreamUrlResult {
  const resolved = resolveReadModelBase(inputs);
  if (!resolved.ok) return resolved;
  return { ok: true, base: resolved.base, url: `${resolved.base}${READ_MODEL_STREAM_PATH}` };
}

function explicitBase(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function resolvePort(env: ReadModelUrlEnv): number {
  const parsed = parseInt(env.MONITOR_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MONITOR_PORT;
}
