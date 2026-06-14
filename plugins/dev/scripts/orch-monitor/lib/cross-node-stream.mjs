// cross-node-stream.mjs — CTL-885 (BFF3): the cross-node live-tail SSE FAN-IN.
//
// Clicking a ticket must stream its live activity tail REGARDLESS of which node
// owns it. The owning worker may run on a different node than the one serving the
// UI, and per-host event logs MUST stay per-host (a merged/shared log is a SPOF —
// NFS append isn't atomic, design §"What we explicitly will NOT do"). So the
// read-model MULTIPLEXES the per-host live streams keyed by host.name: the UI
// subscribes ONCE to its local read-model, and the read-model fans IN the owning
// node's `/api/ec-worker-stream/<sessionId>` behind the scenes.
//
// SINGLE-HOST IDENTITY NO-OP (the load-bearing operator constraint):
//   When the roster is absent or length 1 (hosts.json absent → getClusterHosts
//   returns [getHostName()]), this is an EXACT identity no-op — `resolveTailRoute`
//   returns { mode: "local" } with ZERO added latency, no owner-host resolution,
//   no remote hop, no fetch. The server then tails the local transcript exactly as
//   the non-cluster BFF5 path does. The N>1 fan-in branch is exercised ONLY once a
//   real multi-host roster exists.
//
// NEVER a shared/merged log: this module multiplexes N per-host SSE STREAMS keyed
// by host.name. It never reads a shared or merged event log — the only thing it
// fans in is the live drill-down transcript tail (the board's primary source is
// the tracker, not the logs — design §"Recommended board source").
//
// Everything is injectable (env, file read, owner-host lookup, base-URL resolver,
// fetch) so both branches are unit-testable without a real hosts.json, a real
// peer, or a real network.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * readClusterRoster — the committed cluster roster from
 * <repoRoot>/.catalyst/hosts.json (a JSON array of host names). Mirrors
 * execution-core/config.mjs::getClusterHosts AND lib/stop-worker.mjs's tolerance:
 * an absent / unreadable / malformed / non-array / empty-array roster collapses to
 * the SINGLE-HOST default of []. Kept LOCAL (not imported from config.mjs) so the
 * orch-monitor package stays self-contained and PR-order-independent — the
 * externalities (the env var + the file read) are injectable. Never throws.
 *
 * @param {{ env?: NodeJS.ProcessEnv, read?: typeof readFileSync }} [deps]
 * @returns {string[]} the roster host names, or [] when single-host/absent
 */
export function readClusterRoster({ env = process.env, read = readFileSync } = {}) {
  const cfgFile = env.CATALYST_CONFIG_FILE;
  // <repoRoot>/.catalyst/config.json → <repoRoot>/.catalyst (else cwd/.catalyst)
  const catalystDir = cfgFile ? resolve(cfgFile, "..") : resolve(process.cwd(), ".catalyst");
  try {
    const raw = read(resolve(catalystDir, "hosts.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const hosts = parsed.filter((h) => typeof h === "string" && h.length > 0);
      if (hosts.length > 0) return hosts;
    }
  } catch {
    /* absent/malformed roster → single-host default */
  }
  return [];
}

/**
 * isSingleHost — is the fleet a SINGLE host (the identity-no-op gate)? True when
 * the roster is absent or length ≤ 1 — the exact condition under which the fan-in
 * collapses to a local pass-through with zero added latency.
 *
 * @param {string[]} roster
 * @returns {boolean}
 */
export function isSingleHost(roster) {
  return !Array.isArray(roster) || roster.length <= 1;
}

/**
 * resolveTailRoute — decide HOW to serve the live tail for `sessionId`, keyed by
 * the owning node's host.name. The discriminated outcome the SSE route maps to a
 * local tail or a remote proxy:
 *
 *   { mode: "local" }
 *     SINGLE-HOST identity no-op (roster absent/len ≤ 1) OR the owner resolves to
 *     THIS host OR the owner is unknown (no fence owner yet → tail locally, the
 *     conservative fallback that preserves the non-cluster behavior). NO remote hop.
 *
 *   { mode: "remote", host, url }
 *     MULTI-HOST: the ticket is owned by a DIFFERENT node `host`; `url` is that
 *     peer's `/api/ec-worker-stream/<sessionId>` to fan in. Keyed by host.name.
 *
 *   { mode: "unroutable", host }
 *     MULTI-HOST: the owner is a different node but its base URL can't be resolved
 *     (no transport address for `host`). The route maps this to 404 rather than a
 *     blind local tail (a local tail would show the WRONG node's transcript).
 *
 * The owner host is resolved via the injected `ownerHostForSession` — BFF2's
 * fence-attachment projection (owner_host, read from the durable cache, NEVER a
 * live attachment fetch). `hostBaseUrl(host)` maps a roster host NAME to its
 * monitor base URL (the cross-node transport seam; no production roster source
 * exists yet, so it's a config injection — single-node MVP never calls it).
 *
 * @param {object} args
 * @param {string} args.sessionId the CC session UUID to tail
 * @param {string[]} args.roster the cluster roster (readClusterRoster)
 * @param {string} args.selfHost this node's name (getHostName)
 * @param {(sessionId: string) => (string | null | undefined)} [args.ownerHostForSession]
 *   owner_host for the session's ticket (BFF2 durable fence projection)
 * @param {(host: string) => (string | null | undefined)} [args.hostBaseUrl]
 *   roster host name → monitor base URL (the cross-node transport seam)
 * @returns {import("./cross-node-stream.d.mts").TailRoute}
 */
export function resolveTailRoute({
  sessionId,
  roster,
  selfHost,
  ownerHostForSession,
  hostBaseUrl,
}) {
  // SINGLE-HOST identity no-op: no other node exists → tail the LOCAL transcript
  // with zero added latency. We never resolve the owner host or touch hostBaseUrl.
  if (isSingleHost(roster)) {
    return { mode: "local" };
  }

  // MULTI-HOST: resolve which node owns this session's ticket (durable fence
  // projection — never a live attachment fetch). An unknown owner (no fence yet)
  // falls back to a LOCAL tail — the conservative answer that preserves the
  // non-cluster behavior rather than guessing a peer.
  const owner =
    typeof ownerHostForSession === "function" ? ownerHostForSession(sessionId) : null;
  if (typeof owner !== "string" || owner.length === 0) {
    return { mode: "local" };
  }
  // Owner is THIS host → tail locally (no self-fan-in hop).
  if (owner === selfHost) {
    return { mode: "local" };
  }

  // Owner is a DIFFERENT node → fan in that node's per-host stream keyed by
  // host.name. Resolve its monitor base URL; if unresolvable, mark unroutable so
  // the route 404s rather than silently tailing the wrong node's local transcript.
  const base = typeof hostBaseUrl === "function" ? hostBaseUrl(owner) : null;
  if (typeof base !== "string" || base.length === 0) {
    return { mode: "unroutable", host: owner };
  }
  return {
    mode: "remote",
    host: owner,
    url: `${base.replace(/\/+$/, "")}/api/ec-worker-stream/${encodeURIComponent(sessionId)}`,
  };
}

/**
 * resolvePeerBaseUrl — the cross-node TRANSPORT SEAM: map a roster host NAME to
 * its orch-monitor base URL so the fan-in knows where to subscribe.
 *
 * SINGLE-NODE MVP DESCOPE: there is no production roster→URL source yet (the
 * multi-host membership/address registry is a later epic anchor), so this reads
 * an OPTIONAL operator-provided map from the env var `CATALYST_PEER_MONITORS`
 * (JSON: `{ "<host.name>": "http://<host>:7400", … }`). When the var is absent /
 * malformed / has no entry for `host`, it returns null — and resolveTailRoute maps
 * a remote owner with no base URL to `unroutable` (a 404), never a wrong-node tail.
 * On a single-host fleet this is NEVER called (the no-op short-circuits first).
 *
 * @param {string} host the owning node's host.name
 * @param {{ env?: NodeJS.ProcessEnv }} [deps]
 * @returns {string | null} the peer monitor base URL, or null when unresolvable
 */
export function resolvePeerBaseUrl(host, { env = process.env } = {}) {
  if (typeof host !== "string" || host.length === 0) return null;
  const raw = env.CATALYST_PEER_MONITORS;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const map = JSON.parse(raw);
    if (map && typeof map === "object" && !Array.isArray(map)) {
      const url = map[host];
      if (typeof url === "string" && url.length > 0) return url;
    }
  } catch {
    /* malformed map → unresolvable → unroutable (404), never a wrong tail */
  }
  return null;
}

/**
 * proxyRemoteTail — fan in a REMOTE node's live tail by streaming its SSE response
 * body straight through to the caller. The owning node already serves the typed
 * StreamEvent SSE (BFF5); the read-model is a transparent multiplexer — it neither
 * re-parses nor re-frames, so the client's StreamEventRow renderer consumes the
 * peer's frames unchanged. Multi-host ONLY (single-node never reaches here).
 *
 * Returns the upstream Response's body (a ReadableStream) on a 2xx, or null on any
 * non-2xx / network failure so the route maps it to 502 (a peer that's down must
 * not wedge the client). The AbortSignal is forwarded so a client disconnect tears
 * down the upstream subscription — no leaked per-host connection.
 *
 * @param {object} args
 * @param {string} args.url the peer's /api/ec-worker-stream/<sessionId>
 * @param {AbortSignal} [args.signal] forwarded so client-disconnect aborts upstream
 * @param {typeof fetch} [args.fetchImpl] injectable for tests
 * @returns {Promise<ReadableStream<Uint8Array> | null>}
 */
export async function proxyRemoteTail({ url, signal, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!res || !res.ok || !res.body) return null;
    return res.body;
  } catch {
    // peer down / aborted / DNS — the route degrades to 502, never a wrong tail.
    return null;
  }
}
