// read-model-client.ts — the ONE shared client contract for the cache-backed
// read-model (CTL-919 / HUD1).
//
// WHY THIS EXISTS
// ---------------
// The BFF read-model core (lib/read-model.mjs, CTL-883) assembles the cluster
// picture ONCE on the server and fans it out over SSE to every client. But each
// surface used to describe that same fleet in its own vocabulary:
//   • web/iPad: the BoardPayload shape (ui/src/board/board-client.ts), decoded
//     from `/api/board/stream` SSE `board` frames.
//   • terminal HUD: raw CanonicalEvent records from the event log
//     (cli/hooks/useEventLog.ts) PLUS a BrokerState struct it scans itself
//     (cli/lib/broker-key-health.ts) — a different shape per reader.
// So the two surfaces could silently drift whenever one side's shape changed.
//
// This module names the read-model's WIRE SHAPE in exactly one place and gives
// every reader a typed door to it. A change to the read-model payload is now a
// COMPILE-TIME break in every consumer that imports this contract, instead of a
// runtime drift. It adds NO new server behavior — it only declares the contract
// and a thin transport helper.
//
// NODE-AWARENESS (single-host identity no-op)
// -------------------------------------------
// Node attribution is part of the contract. The producing snapshot already
// stamps `hostName` (lib/state-reader.ts:170 via CTL-852/859, sourced from the
// shared `hostName()` / `hostId()` primitives in lib/canonical-event-shared.ts).
// The contract surfaces this as per-host GROUPING: `groupByHost()` lifts a flat
// read-model payload into a `ClusterReadModel` of host groups. A single-host
// fleet yields EXACTLY ONE group (an identity no-op — same rendering path as the
// eventual multi-node case, which simply has N>1 groups), per the CTL-865
// group-by-owner_host blueprint. No multi-node anchors are built here; the
// grouping is the single-host branch done correctly and the N>1 branch falls out
// of the same code with zero added latency.
//
// PROCESS-SPLIT-READY
// -------------------
// This is a standalone module (payload types + SSE envelope type + a thin
// `subscribeReadModel()` helper) so it ships with the read-model and can travel
// when the read-model is later split into a standalone `catalyst-readmodel`
// process under catalyst-stack. Consumers depend on this contract, never on the
// server internals.

import type { BoardPayload } from "./board-data.d.mts";

// Re-export the wire payload types so EVERY consumer imports the shape through
// this ONE contract door. board-data.d.mts is the server's declared payload (the
// single source of truth assembled by board-data.mjs); naming it here means a
// field added there is a compile-time break in every importer of this module.
export type {
  BoardPayload,
  BoardWorker,
  BoardTicket,
  BoardQueueItem,
  BoardConfig,
  BoardPhaseCost,
  BoardPhaseTiming,
  BoardActiveState,
} from "./board-data.d.mts";

/**
 * The wire payload the read-model pushes to every client. Today this is exactly
 * the BoardPayload (the proven superset that already carries
 * tickets/workers/queue), plus an OPTIONAL `host` attribution naming the node
 * that produced the snapshot. `host` is additive — a single-host fleet that does
 * not stamp it is handled by `groupByHost()` falling back to the local identity,
 * so existing producers stay byte-compatible (identity no-op).
 */
export type ReadModelPayload = BoardPayload & {
  /** The node that produced this snapshot (CTL-852/859). Absent ⇒ local host. */
  host?: HostRef;
};

/**
 * A node's stable identity. `name` is the configurable host name
 * (CATALYST_HOST_NAME env / os.hostname() minus ".local"); `id` is
 * sha256(name)[:16] — identical across TS / MJS / bash runtimes for the same
 * resolved host. Mirrors the `host.name` / `host.id` stamped on canonical events
 * and the snapshot's `hostName` field.
 */
export interface HostRef {
  name: string;
  id: string;
}

/**
 * One host's slice of the cluster picture. The single-host case yields exactly
 * one of these; a multi-node fleet yields N. The `payload` is the SAME wire
 * shape regardless of N, so the rendering path is identical whether there is one
 * group or many.
 */
export interface HostGroup {
  host: HostRef;
  payload: ReadModelPayload;
}

/**
 * The node-aware VIEW of the read-model: the cluster picture grouped by host.
 * Single-host ⇒ `hosts.length === 1` (identity no-op). This is the shape both
 * the web/iPad client and the terminal HUD render against, so neither surface
 * special-cases "cluster mode": one group vs N groups is the only difference.
 */
export interface ClusterReadModel {
  /** ISO timestamp of the most recent payload folded into this view. */
  generatedAt: string;
  /** One group per producing host. Length 1 for a single-host fleet. */
  hosts: HostGroup[];
}

/**
 * Lift a flat read-model payload into the node-aware `ClusterReadModel`.
 *
 * SINGLE-HOST IDENTITY NO-OP: a payload with no `host` (or a single host) yields
 * exactly ONE group attributed to `fallback`/the payload's host — behaviourally
 * identical to the non-cluster path. The multi-node case is NOT built here; when
 * a future N>1 fleet ships a payload carrying multiple hosts' data, this same
 * grouping produces N groups with zero changes to consumers.
 *
 * @param payload the wire payload from the read-model (one host's snapshot today)
 * @param fallback the local host identity to attribute an un-stamped payload to
 *        (callers pass `localHostRef()` so a producer that has not yet adopted
 *        the `host` field still groups under the real local node, not "unknown")
 */
export function groupByHost(payload: ReadModelPayload, fallback: HostRef): ClusterReadModel {
  const host = payload.host ?? fallback;
  return {
    generatedAt: payload.generatedAt,
    hosts: [{ host, payload }],
  };
}

/**
 * Merge several single-host payloads (e.g. N per-host monitors fanned into one
 * view) into a single `ClusterReadModel`. With one payload this is the identity
 * no-op above; with N it produces N groups, deduped by host id (last write wins
 * per host). The `generatedAt` is the newest payload's timestamp. This is the
 * seam the eventual multi-node board uses — single-host callers never reach the
 * N>1 branch.
 */
export function mergeHostGroups(
  payloads: ReadModelPayload[],
  fallback: HostRef,
): ClusterReadModel {
  const byId = new Map<string, HostGroup>();
  let newest = "";
  for (const payload of payloads) {
    const host = payload.host ?? fallback;
    byId.set(host.id, { host, payload });
    if (payload.generatedAt > newest) newest = payload.generatedAt;
  }
  return { generatedAt: newest, hosts: [...byId.values()] };
}

// ── SSE transport envelope ──────────────────────────────────────────────────
// The read-model is pushed over `/api/board/stream`-style SSE: each frame is an
// `event: <READ_MODEL_SSE_EVENT>` line + a `data: <json>` line carrying one
// ReadModelPayload. Both the web client and the HUD decode the SAME envelope via
// `decodeReadModelFrame()` — the envelope is shared, not re-invented per client.

/** The SSE `event:` name the read-model stream emits. Matches server.ts's
 *  existing `/api/board/stream` frame so the contract is back-compatible with
 *  today's board push (the board IS the read-model's superset payload). */
export const READ_MODEL_SSE_EVENT = "board" as const;

/**
 * Decode one SSE frame's `data` string into a typed `ReadModelPayload`.
 * Returns null on a malformed frame (so a consumer skips it rather than throwing
 * inside its event loop). This is the ONE decode path both surfaces share — the
 * web SharedWorker collapse and the HUD subscriber consume identical typed
 * events.
 */
export function decodeReadModelFrame(data: string): ReadModelPayload | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isReadModelPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Minimal structural guard: a real payload carries the load-bearing arrays the
 *  contract promises. Keeps a truncated/garbage frame from reaching renderers. */
export function isReadModelPayload(value: unknown): value is ReadModelPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.generatedAt === "string" &&
    Array.isArray(v.workers) &&
    Array.isArray(v.tickets) &&
    Array.isArray(v.queue)
  );
}

// ── Thin subscribe client ────────────────────────────────────────────────────
// A transport-agnostic SSE subscriber both surfaces import. The browser passes
// nothing (it uses the global `EventSource`); a non-browser host (the terminal
// HUD, tests) injects an EventSource factory so the SAME helper drives every
// reader. The helper owns the envelope decode so no consumer hand-rolls it.

/** Minimal EventSource surface this client depends on — lets a non-DOM host
 *  (HUD / Node / tests) supply a compatible implementation without pulling in
 *  the full DOM lib. Matches the browser `EventSource` shape we use. */
export interface ReadModelEventSource {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
}

/** The minimal `new EventSource(url)` constructor shape we depend on. Declaring
 *  it ourselves (rather than referencing the ambient `EventSource` type, whose
 *  exact signature differs between the bun/Node and DOM lib variants) keeps this
 *  module bundleable for BOTH the browser and the Node-side HUD without a cast. */
type ReadModelEventSourceCtor = new (url: string) => ReadModelEventSource;

export interface ReadModelSubscribeHandlers {
  /** A decoded snapshot landed. */
  onSnapshot: (payload: ReadModelPayload) => void;
  /** The stream errored (transport-level). Optional — the caller may reconnect. */
  onError?: (ev: unknown) => void;
}

export interface ReadModelSubscribeOptions {
  /** SSE endpoint. Defaults to the read-model stream path. */
  url?: string;
  /** EventSource factory. Defaults to the global `EventSource` (browser). A
   *  non-browser host injects one so the SAME subscribe logic runs everywhere. */
  eventSourceFactory?: (url: string) => ReadModelEventSource;
}

export interface ReadModelSubscription {
  /** Tear down this subscription. */
  close: () => void;
}

/** Default SSE path — the read-model's board-style stream (server.ts). */
export const READ_MODEL_STREAM_PATH = "/api/board/stream" as const;

/** Resolve the ambient `EventSource` constructor through `globalThis`, typed to
 *  the minimal shape we depend on. In a browser this is the DOM `EventSource`;
 *  the Node-side HUD always injects its own factory and never reaches this path
 *  (where `EventSource` may be absent). Throws a clear error if a non-browser
 *  caller forgets to inject one, instead of a cryptic `undefined is not a
 *  constructor`. */
function defaultEventSourceFactory(url: string): ReadModelEventSource {
  const ctor = (globalThis as { EventSource?: ReadModelEventSourceCtor }).EventSource;
  if (!ctor) {
    throw new Error(
      "subscribeReadModel: no global EventSource — inject eventSourceFactory (non-browser host)",
    );
  }
  return new ctor(url);
}

/**
 * Subscribe to the read-model SSE stream. Decodes each frame through the SHARED
 * `decodeReadModelFrame()` and hands the typed payload to `onSnapshot`. Both the
 * web client and the terminal HUD call this, so they consume IDENTICAL typed
 * events from one envelope.
 *
 * Transport-only: it does NOT add reconnect/backoff policy (the web client owns
 * its IndexedDB warm-paint + SharedWorker collapse + backoff; the HUD owns its
 * own loop). It just provides the one typed door onto the stream.
 */
export function subscribeReadModel(
  handlers: ReadModelSubscribeHandlers,
  options: ReadModelSubscribeOptions = {},
): ReadModelSubscription {
  const url = options.url ?? READ_MODEL_STREAM_PATH;
  const factory = options.eventSourceFactory ?? defaultEventSourceFactory;

  const es = factory(url);
  es.addEventListener(READ_MODEL_SSE_EVENT, (ev) => {
    const payload = decodeReadModelFrame(ev.data);
    if (payload) handlers.onSnapshot(payload);
  });
  if (handlers.onError) {
    es.onerror = (ev) => handlers.onError?.(ev);
  }

  return {
    close: () => {
      try {
        es.close();
      } catch {
        /* already closed */
      }
    },
  };
}
