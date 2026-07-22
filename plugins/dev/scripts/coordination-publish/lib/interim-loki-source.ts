// interim-loki-source — CTL-1488 Phase 5. The interim inbound transport used when no catalyst-cloud
// hub is configured (`hubUrl` unset).
//
// Loki is already the central place every host ships its events to, so it doubles as a
// (slower-cadence, eventually-consistent) cross-host coordination transport until the hub is wired.
// This wraps the shared `createLokiFetcher` behind the SAME `ChangeSource` interface the hub client
// implements, so mirror-tail-client.ts's merge logic never branches on transport. It queries the
// canonical coordination selector, normalizes each Loki stream value (a stored canonical envelope)
// into a hub-shaped `CoordinationDelta`, and dedups by event.id downstream (Loki carries no hub seq).
//
// FAIL-OPEN, matching loki-liveness.mjs: Loki unavailable / query error → an empty pull that the
// client treats as a no-op tick, never a crash.

import type { LokiFetcher } from "../../orch-monitor/lib/loki.ts";
import type { ChangeSource, CoordinationDelta, PullResult } from "./mirror-tail-client.ts";

/** The canonical selector for the coordination subset in Loki (the Phase 2 stream_class label). */
export const COORDINATION_LOKI_QUERY = '{service_namespace="catalyst"} | event_stream_class="coordination"';

/** Default look-back window for the interim tail — a few minutes of coordination events per pull. */
const DEFAULT_WINDOW_MS = 10 * 60_000;

export interface LokiChangeSourceOpts {
  lokiFetcher: LokiFetcher;
  windowMs?: number;
  /**
   * Injected clock. Real callers omit it (defaults to Date.now). It is a FUNCTION, not a
   * captured number, and is evaluated INSIDE pullChanges on every tick — so the look-back
   * window [now-windowMs, now] slides forward with wall-clock instead of freezing at the
   * value captured when the source was constructed at daemon startup (CTL-1488 remediate:
   * a frozen window silently stopped cross-host inbound ingestion ~windowMs after start).
   */
  nowMs?: () => number;
  limit?: number;
}

/** A stored canonical envelope, as one Loki stream value's log line deserializes. */
interface StoredEnvelope {
  id?: string;
  ts?: string;
  caused_by?: string | null;
  attributes?: unknown;
  resource?: Record<string, unknown>;
}

/** Normalize a parsed envelope into the hub's CoordinationDelta shape. seq=0 (Loki has no hub seq —
 *  the client dedups by event.id, so seq is not load-bearing on this path). */
function envelopeToDelta(env: StoredEnvelope): CoordinationDelta | null {
  if (!env || typeof env.id !== "string" || env.id === "") return null;
  const attrs = (env.attributes ?? {}) as Record<string, unknown>;
  const eventName = typeof attrs["event.name"] === "string" ? (attrs["event.name"] as string) : "";
  // The phase.*/worker.transition builders stamp `host.name` on the resource
  // (buildCatalystResource); only otel-forward's internal events carry the optional
  // `catalyst.node.name`. Prefer the coordination name when present, else host.name.
  const res = env.resource ?? {};
  const host =
    typeof res["catalyst.node.name"] === "string"
      ? (res["catalyst.node.name"] as string)
      : typeof res["host.name"] === "string"
        ? (res["host.name"] as string)
        : null;
  return {
    seq: 0,
    host,
    event_id: env.id,
    event_name: eventName,
    ts: typeof env.ts === "string" ? env.ts : null,
    caused_by: env.caused_by ?? null,
    attributes: env.attributes ?? {},
    resource: env.resource ?? {},
  };
}

/**
 * Build a ChangeSource backed by Loki. `pullChanges` ignores `since` (Loki isn't seq-paginated) and
 * re-queries the recent window each tick; the client's event.id dedup makes the re-query idempotent.
 */
export function createLokiChangeSource(opts: LokiChangeSourceOpts): ChangeSource {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.nowMs ?? Date.now;
  return {
    async pullChanges(): Promise<PullResult> {
      // Evaluate the clock per-pull so the window slides forward each tick (never frozen at ctor).
      const nowMs = now();
      const endNs = String(nowMs * 1_000_000);
      const startNs = String((nowMs - windowMs) * 1_000_000);
      let result;
      try {
        result = await opts.lokiFetcher.queryRange(COORDINATION_LOKI_QUERY, startNs, endNs, opts.limit);
      } catch {
        return { ok: false, error: true }; // fail-open: a query throw is a no-op tick
      }
      if (result == null) return { ok: false, error: true }; // Loki unavailable → no-op tick

      const deltas: CoordinationDelta[] = [];
      for (const entry of result.data.result) {
        const values = (entry as { values?: Array<[string, string]> }).values ?? [];
        for (const [, line] of values) {
          try {
            const delta = envelopeToDelta(JSON.parse(line) as StoredEnvelope);
            if (delta) deltas.push(delta);
          } catch {
            // skip a non-JSON / partial line
          }
        }
      }
      return { ok: true, deltas, headSeq: 0 };
    },
  };
}
