// loki-liveness.mjs — CTL-1420 (#17). Cross-host peer LIVENESS read via Loki,
// the replacement for the Linear heartbeat-attachment read (readPeerHeartbeatsSync).
//
// Loki is already the central place every host pushes node.heartbeat to, so it IS
// the cross-host transport we need — no mesh, no direct host-to-host connectivity,
// no new shared store (Ryan, 2026-07-07). LIVENESS ONLY: this is a broadcast,
// read-mostly, FAIL-OPEN signal (a wrong "alive" is caught by fencing; a wrong
// "dead" merely declines to reclaim). It is NEVER used for claim/fence CAS — that
// needs a fail-closed arbiter, and Loki is append-only / eventually-consistent.
//
// Returns { [host]: { last_seen, in_flight_tickets } } — the SAME shape as the
// legacy readPeerHeartbeatsSync peer map, so readClusterHeartbeats /
// defaultOwnedTicketsForHost are drop-in (recovery.mjs).
//
// FAIL-OPEN everywhere: no lokiUrl, probe/timeout/non-200/parse error → {}. An
// empty map makes deadHosts treat every peer as "never seen ⇒ alive"
// (recovery.mjs:deadHosts), so a Loki outage can NEVER cause a false reclaim.

const HEARTBEAT_EVENT = "node.heartbeat";
const DEFAULT_TIMEOUT_MS = 2000;
// Window must comfortably exceed the dead-host grace (HEARTBEAT_GRACE_MS = 10 min):
// detection fires at grace-expiry when the last beat is ~grace old, so a window a
// few× grace guarantees that last beat is still in range. 60 min = 6× grace.
const DEFAULT_WINDOW_MS = 60 * 60_000;

// nsToMs — Loki entry timestamps are NANOSECOND strings (e.g. "1783451090000000000").
// Number() of a ns value overflows Number.MAX_SAFE_INTEGER (~9.0e15) and loses
// precision, so convert ns→ms by dropping the last 6 digits on the STRING first,
// then Number() (ms fits safely). Non-numeric input → NaN (caller skips it).
export function nsToMs(ns) {
  const s = String(ns ?? "");
  if (!/^\d+$/.test(s)) return NaN;
  const ms = s.length > 6 ? s.slice(0, -6) : "0";
  const n = Number(ms);
  return Number.isFinite(n) ? n : NaN;
}

// parseInFlight — normalize an in-flight-tickets value (comma-joined string, from
// heartbeat-event.mjs's catalyst.node.in_flight_tickets attribute) into a string[].
function parseInFlight(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// parseLokiLivenessResponse — PURE. Fold a Loki query_range `streams` response into
// { host: { last_seen, in_flight_tickets } }. Defensive across the two shapes the
// in_flight attribute could take: per-entry STRUCTURED METADATA (the 3rd element of
// a values tuple [tsNs, line, {meta}]) OR a promoted STREAM LABEL
// (result[].stream.catalyst_node_in_flight_tickets). Exported for unit coverage.
export function parseLokiLivenessResponse(body) {
  const out = {};
  const results = body?.data?.result;
  if (!Array.isArray(results)) return out;
  for (const stream of results) {
    const labels = (stream && stream.stream) || {};
    const host = labels.host_name;
    if (typeof host !== "string" || host.length === 0) continue;
    const values = Array.isArray(stream.values) ? stream.values : [];
    // Pick the NEWEST entry by ts (don't assume Loki's ordering) so last_seen and
    // in_flight reflect the most recent heartbeat.
    let newest = null;
    for (const v of values) {
      const tsMs = nsToMs(v && v[0]);
      if (!Number.isFinite(tsMs)) continue;
      if (!newest || tsMs > newest.tsMs) newest = { tsMs, meta: (v && v[2]) || null };
    }
    if (!newest) continue;
    const rawTickets =
      (newest.meta && newest.meta.catalyst_node_in_flight_tickets) ??
      labels.catalyst_node_in_flight_tickets ??
      "";
    out[host] = {
      last_seen: new Date(newest.tsMs).toISOString(),
      in_flight_tickets: parseInFlight(rawTickets),
    };
  }
  return out;
}

// readClusterLivenessFromLoki — query Loki for every host's most-recent
// node.heartbeat over `windowMs`, returning the peer-liveness map. FAIL-OPEN → {}.
// `fetcher`/`nowMs` are injectable seams for unit tests (no network, no clock).
// queryLokiStreams — one fail-open query_range → the parsed success body, or null on
// ANY failure (unreachable / timeout / non-200 / non-success). Injectable fetcher.
async function queryLokiStreams(url, timeoutMs, fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetcher(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) return null;
  const body = await res.json();
  if (!body || body.status !== "success") return null;
  return body;
}

// readClusterLivenessFromLoki — TWO fail-open queries:
//   A (liveness): the newest node.heartbeat per host → last_seen. This has NO dependency
//     on the in-flight structured-metadata field, so it returns every host regardless of
//     code version — it is the load-bearing dead-host-detection read.
//   B (tickets enrichment, best-effort): Loki only surfaces the in_flight_tickets
//     structured metadata when a query REFERENCES it, so a second query filters to hosts
//     with a non-empty set and merges the ticket list onto A. A failure here leaves
//     ownership to the local-scan/board-sweep backstop — liveness is already set, so
//     dead-host DETECTION is never affected.
// FAIL-OPEN → {}. `fetcher`/`nowMs` injectable for unit tests.
export async function readClusterLivenessFromLoki({
  lokiUrl,
  nowMs = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetcher = globalThis.fetch,
  logger,
} = {}) {
  if (typeof lokiUrl !== "string" || lokiUrl.length === 0) return {};
  const base = lokiUrl.replace(/\/+$/, "");
  const startNs = String((nowMs - windowMs) * 1_000_000);
  const endNs = String(nowMs * 1_000_000);
  const sel = `{service_name="catalyst.execution-core"} | event_name=\`${HEARTBEAT_EVENT}\``;
  const mkUrl = (q) =>
    `${base}/loki/api/v1/query_range?` +
    new URLSearchParams({ query: q, start: startNs, end: endNs, limit: "1000", direction: "backward" }).toString();
  try {
    const aBody = await queryLokiStreams(mkUrl(sel), timeoutMs, fetcher);
    if (!aBody) return {};
    const out = parseLokiLivenessResponse(aBody);
    if (Object.keys(out).length === 0) return {};
    try {
      const bBody = await queryLokiStreams(
        mkUrl(`${sel} | catalyst_node_in_flight_tickets=~\`.+\``),
        timeoutMs,
        fetcher,
      );
      const enriched = bBody ? parseLokiLivenessResponse(bBody) : {};
      for (const [host, rec] of Object.entries(enriched)) {
        if (out[host] && Array.isArray(rec.in_flight_tickets) && rec.in_flight_tickets.length > 0) {
          out[host].in_flight_tickets = rec.in_flight_tickets;
        }
      }
    } catch (err) {
      logger?.warn?.({ err: err?.message }, "loki-liveness: tickets enrichment failed (ownership → local fallback)");
    }
    return out;
  } catch (err) {
    // Fail-open: never let a Loki hiccup break liveness. An empty map = "no peers
    // seen" = deadHosts treats all as alive = no false reclaim.
    logger?.warn?.({ err: err?.message }, "loki-liveness: read failed (fail-open → {})");
    return {};
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// Thin argv shim so the SYNCHRONOUS daemon (recovery.mjs dead-host detection) can
// drive this async reader through spawnSync — the same sync-subprocess convention
// cluster-heartbeat.mjs uses. loki-liveness-sync.mjs is the in-process wrapper that
// spawnSync's `node loki-liveness.mjs read <lokiUrl> [windowMs]`.
//
//   read <lokiUrl> [windowMs]  → stdout JSON { [host]: {last_seen, in_flight_tickets} }; exit 0
export async function runCli(argv, { fetcher } = {}) {
  const [cmd, lokiUrl, windowMsRaw] = argv;
  switch (cmd) {
    case "read": {
      const windowMs = windowMsRaw ? Number(windowMsRaw) : undefined;
      const map = await readClusterLivenessFromLoki({
        lokiUrl,
        windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined,
        fetcher,
      });
      process.stdout.write(JSON.stringify(map) + "\n");
      return 0;
    }
    default:
      process.stderr.write(
        `loki-liveness.mjs: unknown subcommand: ${cmd ?? "(none)"}\n` +
          "usage: loki-liveness.mjs read <lokiUrl> [windowMs]\n",
      );
      return 1;
  }
}

function isMain() {
  return (
    process.argv[1] &&
    (process.argv[1].endsWith("/loki-liveness.mjs") || process.argv[1].endsWith("loki-liveness.mjs"))
  );
}

if (isMain()) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`loki-liveness.mjs: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
