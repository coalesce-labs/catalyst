// lib/catalyst-resource.mjs — the SINGLE shared builder for a catalyst telemetry resource
// block (CTL-1368). Before this, ~15 MJS emitters each inlined
//   { "service.name", "service.namespace": "catalyst", "host.name", "host.id" }
// which made adding a fleet-wide dimension a 15-file edit. This is the one place that shape
// lives, so `catalyst.node.class` (and any future core dimension) is added once.
//
// A LEAF (host-identity.mjs + node-class.mjs are both leaves) — no config.mjs / pino /
// bun:sqlite — so the broker and catalyst-agent can adopt it without dragging heavy graphs.
//
// catalyst.node.class is the node's ROLE (developer|worker|monitor) — orthogonal to
// host.name/host.id (WHICH machine). Low-cardinality, so it is a safe universal metric
// label; the OTEL collector surfaces it as a fleet-wide `node_class` dashboard dimension.

import { hostName, hostId } from "./host-identity.mjs";
import { nodeClass } from "./node-class.mjs";

/**
 * buildCatalystResource — assemble the canonical resource attribute block.
 *
 * @param {object} opts
 * @param {string} opts.serviceName        the catalyst.* service name (required)
 * @param {string} [opts.serviceVersion]   service.version, included ONLY when provided
 *                                          (the broker / orch-monitor stamp it; most
 *                                          execution-core emitters omit it)
 * @param {string} [opts.host]             explicit host override forwarded to
 *                                          hostName/hostId (the heartbeat path passes the
 *                                          config-resolved name); omit for the bare resolve
 * @returns {object} resource block with keys in canonical order, node.class LAST
 */
export function buildCatalystResource({ serviceName, serviceVersion, host } = {}) {
  const hostOpts = host !== undefined ? { override: host } : {};
  const resource = {
    "service.name": serviceName,
    "service.namespace": "catalyst",
  };
  if (serviceVersion !== undefined) resource["service.version"] = serviceVersion;
  resource["host.name"] = hostName(hostOpts);
  resource["host.id"] = hostId(hostOpts);
  // node.class LAST — matches the updater reference impl + keeps existing key order stable.
  resource["catalyst.node.class"] = nodeClass();
  return resource;
}
