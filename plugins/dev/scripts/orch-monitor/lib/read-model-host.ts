// read-model-host.ts — the Node-side host-identity bridge for the read-model
// contract (CTL-919 / HUD1).
//
// The shared contract module (read-model-client.ts) is deliberately RUNTIME-FREE
// so it can be bundled for the browser (it imports only TYPES). Host identity,
// however, is resolved from `node:os` / `node:crypto` via the shared primitives
// in canonical-event-shared.ts — which a browser bundle cannot import. This thin
// file is the Node-only door: the terminal HUD and the server import it to get
// the LOCAL host's `HostRef` to pass as the `groupByHost()` fallback, so an
// un-stamped single-host payload still groups under the real local node (the
// identity no-op) rather than an "unknown" placeholder.
//
// The web/iPad client never imports THIS file — it passes a browser-derived
// fallback (the server is the authority on host attribution; the payload's own
// `host` field wins when present).

import { hostName, hostId } from "./canonical-event-shared";
import type { HostRef } from "./read-model-client";

/**
 * The local node's identity, resolved via the SAME `hostName()` / `hostId()`
 * primitives that stamp `host.name` / `host.id` on canonical events and the
 * snapshot's `hostName` field — so a single-node fleet's grouping is an exact
 * identity no-op (the group is attributed to the real producing host).
 */
export function localHostRef(): HostRef {
  return { name: hostName(), id: hostId() };
}
