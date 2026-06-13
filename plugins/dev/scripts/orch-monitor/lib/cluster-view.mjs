// cluster-view.mjs — the node-aware CLUSTER VIEW assembler (CTL-884, BFF2).
//
// "What is the WHOLE CLUSTER working on" is, per the design doc, a SINGLE
// tracker query GROUPED BY owner_host, enriched by heartbeats (liveness) and
// GitHub (PR state) — never N merged event logs. This module is the read-model
// consumer/superset of CTL-865's cluster-board aggregation (it ABSORBS that
// work). It composes three durable, breaker-safe sources the read-model already
// assembles — it spawns nothing and never hits Linear/GitHub per request:
//
//   1. GROUPING KEY (owner_host): read from the durable cache (filter-state.db
//      ticket_state, projected by BFF11 from each ticket's catalyst://fence/<T>
//      attachment), surfaced through linear-cache-reader.mjs → `ownerHostById`.
//      NEVER a live per-request attachment fetch.
//   2. PR-STATE JOIN: each board ticket already carries its `pr` number (board-
//      data.mjs::prFor, from the durable phase signals); the cluster view layers
//      it through per ticket so the UI can show PR state node-attributed.
//   3. LIVENESS OVERLAY: recovery.readClusterHeartbeats({logPath}) → { host:
//      lastSeenISO }, classified live/degraded/offline by node-liveness.mjs.
//
// SINGLE-HOST IDENTITY NO-OP (the load-bearing operator constraint):
//   When the roster is absent or length 1 (config.mjs::getClusterHosts returns
//   [getHostName()] when .catalyst/hosts.json is absent), the cluster view is an
//   EXACT identity no-op: ONE node carrying ALL board tickets in board order
//   (un-fenced tickets included — on a 1-node fleet there is no "other" owner),
//   the local daemon's own heartbeat as its liveness, and ZERO added latency
//   (one local-log read, no per-peer fan-out, no cross-node transport — that is
//   BFF3's concern). The N>1 grouping/unassigned-bucket branch below is exercised
//   ONLY once a real multi-host roster exists.

import { overlayClusterLiveness } from "./node-liveness.mjs";
import { resolveHostAlias } from "../../execution-core/host-alias.mjs";

// readClusterHeartbeats lives in execution-core/recovery.mjs — a heavy Node-only
// module chain (config.mjs/pino, monitor.mjs, registry.mjs). We DO NOT statically
// import it here: board-data.mjs is statically imported by ui/vite.config.ts, and
// the BFF1/CTL-883 note proves anything in board-data's eventual static graph is
// esbuild-bundled into the Node-evaluated vite config — a transitive `bun:`/pino
// dep there breaks `vite build`. So the liveness reader is INJECTED: the server
// (which runs under Bun with the full dep graph) wires the real
// recovery.readClusterHeartbeats in; tests pass `heartbeats` or a stub reader.
// `noLivenessReader` is the safe default — no caller, no read — so a bare
// assembleClusterView call (no heartbeats, no reader) degrades to all-offline
// rather than throwing.
const noLivenessReader = () => ({});

/**
 * assembleClusterView — group the board's tickets by owning node, layer the
 * per-ticket PR-state join, and overlay per-host liveness. Pure + fully
 * injectable so the unit tests drive every scenario without a DB/log/subprocess.
 *
 * @param {object} args
 * @param {import("./board-data.mjs").BoardPayload} args.board the assembled board payload
 * @param {Record<string, string | null>} [args.ownerHostById] owner_host per ticket id (durable cache)
 * @param {string[]} args.hosts the cluster roster (config.mjs::getClusterHosts)
 * @param {Record<string, string>} [args.heartbeats] pre-read readClusterHeartbeats output
 * @param {(opts: { logPath?: string }) => Record<string, string>} [args.heartbeatReader]
 *   recovery.readClusterHeartbeats; called once with { logPath } when `heartbeats` is absent
 * @param {string} [args.logPath] local event-log path forwarded to the reader
 * @param {number} [args.now] epoch ms (injected for tests)
 * @param {number} [args.intervalMs] liveness interval threshold
 * @param {number} [args.graceMs] liveness grace window
 * @returns {import("./cluster-view.d.mts").ClusterView}
 */
export function assembleClusterView({
  board,
  ownerHostById = {},
  hosts,
  heartbeats,
  heartbeatReader = noLivenessReader,
  logPath,
  now = Date.now(),
  intervalMs,
  graceMs,
  // CTL-1095: injectable drain reader. Default → no drain info (fail-open:
  // draining:false). Production wires it from the local isDraining + inFlightCount.
  drainReader = null,
  // CTL-1092: injectable capacity reader. (host) → { maxParallel, inFlightCount, freeSlots } | null.
  // Default → no capacity info (offline nodes get zeros). Offline nodes always return zeros regardless.
  capacityReader = null,
  // CTL-1092: host alias map { oldName → pinnedName } for collapsing pre-pin heartbeat keys.
  aliases = null,
}) {
  const roster = Array.isArray(hosts) && hosts.length > 0 ? hosts : [];
  // SINGLE-HOST: roster absent or length 1 → identity no-op. Everything belongs
  // to the one host; there is no "other" owner to group away.
  const singleHost = roster.length <= 1;
  const tickets = Array.isArray(board?.tickets) ? board.tickets : [];

  // Resolve liveness ONCE — read the local event log a single time (the reader is
  // injected so tests don't touch fs; the read-model passes the real one). On a
  // single node this is the ONE local log; there is no per-peer fan-out.
  const rawLastSeen =
    heartbeats && typeof heartbeats === "object"
      ? heartbeats
      : heartbeatReader({ logPath });

  // CTL-1092: apply alias map to collapse pre-pin hostnames onto pinned roster names.
  // Newest-wins: if both the old name and the pinned name have entries, keep the latest.
  let lastSeen = rawLastSeen;
  if (aliases && typeof aliases === "object") {
    lastSeen = {};
    for (const [rawHost, ts] of Object.entries(rawLastSeen)) {
      const resolved = resolveHostAlias(rawHost, aliases);
      if (!(resolved in lastSeen) || ts > lastSeen[resolved]) {
        lastSeen[resolved] = ts;
      }
    }
  }

  const liveness = overlayClusterLiveness(roster, lastSeen, { now, intervalMs, graceMs });
  const livenessByHost = new Map(liveness.map((n) => [n.host, n]));

  // CTL-1095: resolve drain state per host — fail-open on error or absent reader.
  const resolveDrain = (host) => {
    if (!drainReader || host === null) return { draining: false, inFlightCount: 0 };
    try {
      const d = drainReader(host);
      return { draining: Boolean(d?.draining), inFlightCount: d?.inFlightCount ?? 0 };
    } catch {
      return { draining: false, inFlightCount: 0 };
    }
  };

  // CTL-1092: resolve capacity per host — offline nodes always get zeros; fail-open.
  const resolveCapacity = (host, status) => {
    if (status === "offline" || !capacityReader || host === null) {
      return { maxParallel: 0, inFlightCount: 0, freeSlots: 0 };
    }
    try {
      const c = capacityReader(host);
      if (!c) return { maxParallel: 0, inFlightCount: 0, freeSlots: 0 };
      const mp = c.maxParallel ?? 0;
      const ifc = c.inFlightCount ?? 0;
      return { maxParallel: mp, inFlightCount: ifc, freeSlots: Math.max(0, mp - ifc) };
    } catch {
      return { maxParallel: 0, inFlightCount: 0, freeSlots: 0 };
    }
  };

  // ── grouping ──────────────────────────────────────────────────────────────
  // A node entry is { host, status, lastSeen, tickets[] }. The `null` host is the
  // synthetic "unassigned" bucket for tickets with no fence owner — used ONLY in
  // the multi-host branch (a single-node fleet attributes everything to its host).
  const makeTicket = (t, host) => ({ ...t, ownerHost: host });

  if (singleHost) {
    const host = roster[0] ?? null;
    const node = livenessByHost.get(host) ?? { host, status: host ? "offline" : null, lastSeen: null };
    return {
      generatedAt: board?.generatedAt ?? new Date(now).toISOString(),
      singleHost: true,
      // Identity no-op: ALL board tickets, in board order, attributed to the one
      // host (preserves the flat board's ticket identity + ordering exactly).
      nodes: [
        {
          host,
          status: node.status,
          lastSeen: node.lastSeen,
          ...resolveDrain(host),
          ...resolveCapacity(host, node.status),
          tickets: tickets.map((t) => makeTicket(t, host)),
        },
      ],
    };
  }

  // ── multi-host (N>1): group by the durable owner_host key ───────────────────
  const byHost = new Map(); // host (string | null) → ticket[]
  for (const host of roster) byHost.set(host, []); // stable roster order, even if empty
  for (const t of tickets) {
    const raw = ownerHostById[t.id];
    const host = typeof raw === "string" && raw.length > 0 ? raw : null;
    // A fenced owner not in the roster is still a real node — surface it as its
    // own group rather than mislabel it unassigned (a roster lag, not orphaning).
    if (host !== null && !byHost.has(host)) byHost.set(host, []);
    if (host === null && !byHost.has(null)) byHost.set(null, []);
    byHost.get(host).push(makeTicket(t, host));
  }

  const nodes = [];
  for (const [host, groupTickets] of byHost) {
    if (host === null) {
      // the unassigned bucket — not a real host, so no liveness; skip if empty
      if (groupTickets.length === 0) continue;
      nodes.push({ host: null, status: null, lastSeen: null, tickets: groupTickets });
      continue;
    }
    const node = livenessByHost.get(host) ?? { status: "offline", lastSeen: null };
    nodes.push({ host, status: node.status, lastSeen: node.lastSeen, ...resolveDrain(host), ...resolveCapacity(host, node.status), tickets: groupTickets });
  }

  return {
    generatedAt: board?.generatedAt ?? new Date(now).toISOString(),
    singleHost: false,
    nodes,
  };
}

// Computed specifiers (not string literals) so esbuild can't follow these into
// the Node-evaluated vite config bundle — the exact CTL-883/BFF1 guard that
// keeps bun:sqlite / pino out of `vite build` (see linear-cache-reader.mjs). The
// server resolves them once at runtime under Bun, where the full graph exists.
const RECOVERY_MODULE = ["..", "..", "execution-core", "recovery.mjs"].join("/");
const CONFIG_MODULE = ["..", "..", "execution-core", "config.mjs"].join("/");

// resolveClusterDeps — lazily import the heavy execution-core sources (the roster
// reader + the heartbeat reader) ONCE, returning them as injectable deps. Each is
// best-effort: an import or read failure degrades to the single-host identity
// no-op (roster = [], heartbeats = {}) rather than throwing out of the assemble.
async function resolveClusterDeps() {
  let getClusterHosts = () => [];
  let readClusterHeartbeats = () => ({});
  try {
    ({ getClusterHosts } = await import(CONFIG_MODULE));
  } catch {
    /* config unavailable → empty roster → single-host no-op */
  }
  try {
    ({ readClusterHeartbeats } = await import(RECOVERY_MODULE));
  } catch {
    /* recovery unavailable → no heartbeats → all hosts offline */
  }
  return { getClusterHosts, readClusterHeartbeats };
}

// createClusterEntity — a read-model entity (CTL-883 registration seam) that
// assembles the cluster view off the SAME board snapshot the read-model already
// computed, layering the durable owner_host grouping + the heartbeat liveness
// overlay. Registered by the server via createReadModel({ entities }) so the
// default entity set (board/tickets/workers/queue) — and its drift guard — stay
// untouched. All sources are injectable so this is unit-testable without the
// execution-core import or a real DB/log.
//
// `ownerHostProvider()` → Promise<{ [ticketId]: ownerHost|null }> (defaults to
// reading owner_host out of linear-cache-reader's durable enrichment map);
// `rosterProvider()` → string[] (defaults to config.getClusterHosts);
// `heartbeatReader({logPath})` → { host: lastSeenISO } (defaults to
// recovery.readClusterHeartbeats). The board snapshot is passed by the read-model.
export function createClusterEntity({
  ownerHostProvider,
  rosterProvider,
  heartbeatReader,
  logPath,
  now = () => Date.now(),
} = {}) {
  // Memoize the lazy execution-core import so repeated assembles don't re-import.
  // Only resolved when an injected provider is missing — fully-injected callers
  // (tests, a future standalone read-model process) never touch execution-core.
  let depsPromise = null;
  const loadExecCoreDeps = () => {
    if (!depsPromise) depsPromise = resolveClusterDeps();
    return depsPromise;
  };

  // Resolve the roster + heartbeat reader: prefer the injected providers; lazily
  // import the execution-core defaults only for whichever one is absent.
  const resolveRosterAndHeartbeats = async () => {
    if (rosterProvider && heartbeatReader) {
      return { getClusterHosts: rosterProvider, readClusterHeartbeats: heartbeatReader };
    }
    const d = await loadExecCoreDeps();
    return {
      getClusterHosts: rosterProvider ?? d.getClusterHosts,
      readClusterHeartbeats: heartbeatReader ?? d.readClusterHeartbeats,
    };
  };

  return {
    // project off the board snapshot the read-model already assembled — the
    // read-model passes it in, so we never re-run assembleBoard here.
    project: async (snapshot) => {
      const [{ getClusterHosts, readClusterHeartbeats }, ownerHostById] = await Promise.all([
        resolveRosterAndHeartbeats(),
        // owner_host map: the injected provider, else derive it from the board
        // snapshot's per-ticket ownerHost when board-data carries it (BFF10), else
        // an empty map (every ticket unassigned → single-host no-op still holds).
        ownerHostProvider
          ? Promise.resolve(ownerHostProvider())
          : Promise.resolve(deriveOwnerHostFromBoard(snapshot)),
      ]);
      // getClusterHosts may throw (a malformed roster read); degrade to [] so the
      // cluster view falls to the single-host identity no-op rather than crashing.
      let hosts;
      try {
        hosts = getClusterHosts() || [];
      } catch {
        hosts = [];
      }
      return assembleClusterView({
        board: snapshot,
        ownerHostById,
        hosts,
        heartbeatReader: readClusterHeartbeats,
        logPath,
        now: now(),
      });
    },
  };
}

// deriveOwnerHostFromBoard — pull a per-ticket ownerHost map off the board
// snapshot when board-data already stamps it (BFF10's per-entity host field).
// Until BFF10 lands, board tickets carry no ownerHost, so this yields {} and the
// cluster view groups everything as unassigned — which, under a single-host
// roster, still collapses to the exact identity no-op.
function deriveOwnerHostFromBoard(snapshot) {
  const out = {};
  const tickets = Array.isArray(snapshot?.tickets) ? snapshot.tickets : [];
  for (const t of tickets) {
    if (t && typeof t.ownerHost === "string" && t.ownerHost.length > 0) {
      out[t.id] = t.ownerHost;
    }
  }
  return out;
}
