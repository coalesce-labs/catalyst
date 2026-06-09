// useReadModel.ts — the terminal HUD's React hook onto the shared read-model SSE
// (CTL-920 / HUD2).
//
// This is the thin React adapter over createReadModelConnection() (the tested,
// React-free controller). It subscribes to the SAME `/api/board/stream` the
// web/iPad consume, through the SAME contract (lib/read-model-client), so the
// HUD's PRIMARY state (workers/tickets/queue/config) comes from the one
// assembly the BFF fans out — not from the HUD re-deriving it by scanning raw
// files. When the server is down the connection reports `down` and the HUD's
// callers fall back to their existing raw-file readers, so the HUD never blocks
// on the read-model endpoint.
//
// The HUD's live event-log drill-down tail (useEventLog) is DELIBERATELY left
// alone — per the cluster design, per-host event logs serve only the drill-down;
// only the HUD's primary fleet state moves onto the read-model here.

import { useEffect, useState, useRef } from "react";

import {
  createReadModelConnection,
  type ReadModelConnectionState,
  type ReadModelStatus,
} from "../lib/read-model-connection";
import { createNodeEventSource } from "../lib/node-event-source";
import { resolveReadModelUrl } from "../lib/read-model-url";
import {
  groupByHost,
  type ReadModelPayload,
  type ClusterReadModel,
  type ReadModelEventSource,
} from "../../lib/read-model-client";
import { localHostRef } from "../lib/read-model-cluster";

export interface UseReadModelOptions {
  /** Override the SSE URL (defaults to resolveReadModelUrl(process.env)). */
  url?: string;
  /** Override the EventSource factory (defaults to the fetch-based Node one). */
  eventSourceFactory?: (url: string) => ReadModelEventSource;
}

export interface UseReadModelResult {
  /** Connection status. `connected` ⇒ primary state is read-model-backed;
   *  `down` ⇒ the caller should fall back to its raw-file scan. */
  status: ReadModelStatus;
  /** The latest decoded read-model snapshot, or null before the first one. */
  payload: ReadModelPayload | null;
  /** The node-aware view of the latest payload (single-host ⇒ one group — the
   *  identity no-op; N>1 ⇒ N groups via the same contract). null until a payload
   *  lands. */
  cluster: ClusterReadModel | null;
  /** True while the read-model is the live source of primary state. */
  connected: boolean;
}

/**
 * Subscribe to the shared read-model SSE for the lifetime of the HUD process.
 * Returns the latest snapshot, its node-aware cluster view, and a connection
 * status the caller uses to choose read-model vs raw-file fallback.
 */
export function useReadModel(options: UseReadModelOptions = {}): UseReadModelResult {
  // Host identity is stable for the process lifetime; resolve once.
  const localRef = useRef(localHostRef()).current;
  const url = useRef(options.url ?? resolveReadModelUrl(process.env)).current;
  const factory = useRef(
    options.eventSourceFactory ?? ((u: string) => createNodeEventSource(u)),
  ).current;

  const [state, setState] = useState<ReadModelConnectionState>({
    status: "connecting",
    payload: null,
  });

  useEffect(() => {
    const conn = createReadModelConnection({
      url,
      eventSourceFactory: factory,
      onChange: setState,
    });
    conn.start();
    // Seed initial state in case start() synchronously transitioned.
    setState(conn.snapshot());
    return () => conn.stop();
  }, [url, factory]);

  const cluster = state.payload ? groupByHost(state.payload, localRef) : null;

  return {
    status: state.status,
    payload: state.payload,
    cluster,
    connected: state.status === "connected",
  };
}
