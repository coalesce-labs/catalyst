// read-model-cluster.ts — the terminal HUD's typed door onto the shared
// read-model contract (CTL-919 / HUD1).
//
// The HUD has historically described the fleet in its OWN vocabulary (raw
// CanonicalEvent records + a BrokerState struct it scans itself). This module is
// the seam that lets the HUD read the cluster picture through the SAME contract
// the web/iPad client uses (lib/read-model-client.ts): given a read-model
// payload, it produces the node-aware `ClusterReadModel` — a single-host fleet
// yields exactly one group attributed to the local node (identity no-op), the
// eventual multi-node fleet yields N groups with no consumer change.
//
// HUD1 ships the typed door; the actual HUD consolidation onto this contract is
// HUD2's behavior. Keeping the import here (not buried in hud.tsx) means a
// read-model wire-shape change is a compile-time break in the HUD exactly as it
// is in the web client.

import {
  groupByHost,
  type ReadModelPayload,
  type ClusterReadModel,
  type HostRef,
} from "../../lib/read-model-client";
import { localHostRef } from "../../lib/read-model-host";

export type { ReadModelPayload, ClusterReadModel, HostRef };
export { localHostRef };

/**
 * Build the HUD's node-aware view of a read-model payload through the shared
 * contract. Un-stamped single-host payloads group under the LOCAL node (the
 * identity no-op); a payload that carries its own `host` is attributed to that
 * host. `localRef` is injectable so tests pin the host without touching env/os.
 */
export function clusterViewForHud(
  payload: ReadModelPayload,
  localRef: HostRef = localHostRef(),
): ClusterReadModel {
  return groupByHost(payload, localRef);
}
