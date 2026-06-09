// read-model-url.ts — resolve the local orch-monitor server's read-model SSE
// URL for the terminal HUD (CTL-920 / HUD2).
//
// The HUD has historically made ZERO `fetch`/`EventSource` calls — it scanned
// raw files itself. HUD2 makes it a CONSUMER of the shared read-model SSE the
// web/iPad already consume (`/api/board/stream`). The web client uses a
// browser-relative path (the page origin IS the server); the Node-side HUD has
// no page origin, so it must build an ABSOLUTE URL pointing at the local server.
//
// It resolves the port the SAME way the server binds it (server.ts:2189-2190 —
// `MONITOR_PORT` env, else the 7400 default) so the HUD always targets the exact
// stream the server is serving. An explicit `CATALYST_MONITOR_URL` base wins for
// the rare proxied/remote case. This is pure + env-injectable; the HUD passes
// `process.env`, tests pass a literal.

import { READ_MODEL_STREAM_PATH } from "../../lib/read-model-client";

/** The server's default port (server.ts:243 `DEFAULT_PORT = 7400`). */
export const DEFAULT_MONITOR_PORT = 7400;

/**
 * The env this resolver reads. A plain string→string|undefined record so the
 * HUD can pass `process.env` directly (Bun's `ProcessEnv`) while tests pass a
 * literal. Only `MONITOR_PORT` and `CATALYST_MONITOR_URL` are consulted.
 */
export type ReadModelUrlEnv = Record<string, string | undefined>;

/**
 * Resolve the absolute SSE URL the HUD subscribes to.
 *
 * Precedence:
 *   1. `CATALYST_MONITOR_URL` base (trailing slash trimmed) + the stream path.
 *   2. `http://127.0.0.1:<MONITOR_PORT|7400>` + the stream path.
 *
 * The path component is the shared `READ_MODEL_STREAM_PATH` from the contract,
 * so the HUD and the web client agree on the endpoint by construction.
 */
export function resolveReadModelUrl(env: ReadModelUrlEnv): string {
  const base = explicitBase(env.CATALYST_MONITOR_URL) ?? `http://127.0.0.1:${resolvePort(env)}`;
  return `${base}${READ_MODEL_STREAM_PATH}`;
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
