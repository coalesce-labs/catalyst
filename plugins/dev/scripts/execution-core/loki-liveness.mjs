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
  // Track the newest ts per host ACROSS ALL streams. Real Loki returns ONE
  // single-value stream PER heartbeat line (the changing catalyst_node_in_flight_count
  // label splits every beat into its own stream), so "newest per host" MUST be a
  // cross-stream reduction — a per-stream `newest` that overwrites out[host] each
  // stream would let the LAST-listed stream win (a stale beat), which is exactly the
  // bug that made a live peer read ~20 min stale and risked a false reclaim.
  const newestMs = {};
  for (const stream of results) {
    const labels = (stream && stream.stream) || {};
    const values = Array.isArray(stream.values) ? stream.values : [];
    for (const v of values) {
      const tsMs = nsToMs(v && v[0]);
      if (!Number.isFinite(tsMs)) continue;
      // CTL-1551: host resolves label-first (the deployed topology — Loki merges
      // structured metadata into the response's stream object, verified live),
      // with a per-entry structured-metadata fallback for a topology that keeps
      // host_name entry-scoped instead.
      const meta = (v && v[2]) || null;
      const host = labels.host_name ?? (meta && meta.host_name);
      if (typeof host !== "string" || host.length === 0) continue;
      if (host in newestMs && tsMs <= newestMs[host]) continue; // not strictly newer → skip
      newestMs[host] = tsMs;
      const rawTickets =
        (meta && meta.catalyst_node_in_flight_tickets) ??
        labels.catalyst_node_in_flight_tickets ??
        "";
      // CTL-1551: capacity fields — same meta-or-label defensiveness as tickets.
      // Loki serializes numeric attributes as strings; parse, reject non-finite.
      const rawMp = (meta && meta.catalyst_node_max_parallel) ?? labels.catalyst_node_max_parallel;
      const rawIfc = (meta && meta.catalyst_node_in_flight_count) ?? labels.catalyst_node_in_flight_count;
      const mp = Number(rawMp);
      const ifc = Number(rawIfc);
      // CTL-1581: the slot-OCCUPANCY subset (running/dispatched). null (not [])
      // when the attribute is absent — an old-daemon heartbeat must read as
      // "unknown", never as "zero active".
      const rawActive =
        (meta && meta.catalyst_node_active_tickets) ?? labels.catalyst_node_active_tickets;
      const rawAc = (meta && meta.catalyst_node_active_count) ?? labels.catalyst_node_active_count;
      const ac = Number(rawAc);
      // CAT-57 (Codex round 2, P1): the productivity signal — this peer's last
      // phase-boundary advance. Same meta-or-label defensiveness as the fields above.
      // null (not a synthesized timestamp) when absent or unparseable: an old-daemon
      // heartbeat must read as "unknown" so nodeProductivity skips the peer, never as
      // "advanced just now" (which would mask a genuinely stuck host).
      const rawAdv =
        (meta && meta.catalyst_node_last_advance_at) ?? labels.catalyst_node_last_advance_at;
      const lastAdvance =
        typeof rawAdv === "string" && Number.isFinite(Date.parse(rawAdv)) ? rawAdv : null;
      out[host] = {
        last_seen: new Date(tsMs).toISOString(),
        in_flight_tickets: parseInFlight(rawTickets),
        max_parallel: Number.isInteger(mp) && mp > 0 ? mp : null,
        in_flight_count: Number.isInteger(ifc) && ifc >= 0 ? ifc : null,
        active_tickets: rawActive != null ? parseInFlight(rawActive) : null,
        active_count: Number.isInteger(ac) && ac >= 0 ? ac : null,
        last_advance_at: lastAdvance,
      };
    }
  }
  return out;
}

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

// readClusterLivenessFromLoki — FIVE fail-open queries (A + B/C/D/E enrichment) → the
// peer-liveness map:
//   A (liveness): newest node.heartbeat per host → last_seen. NO dependency on the
//     in-flight structured-metadata field, so it returns EVERY host regardless of code
//     version — the load-bearing dead-host-detection read.
//   B (tickets enrichment, best-effort): Loki only surfaces the in_flight_tickets
//     structured metadata when a query REFERENCES it, so a second query filters to
//     hosts with a non-empty set and merges the ticket list onto A. A failure here
//     leaves ownership to the local-scan/board-sweep backstop — liveness (A) is already
//     set, so dead-host DETECTION is never affected.
// FAIL-OPEN → {}. `fetcher`/`nowMs` are injectable seams for unit tests.
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
    // CTL-1551 (query C, best-effort): capacity enrichment. Loki only surfaces a
    // structured-metadata field when the query REFERENCES it (same reason query B
    // exists), so a third filtered query forces catalyst_node_max_parallel into
    // the response and its newest values are merged onto A. Failure leaves
    // capacity null — the monitor renders "no data" zeros, liveness unaffected.
    try {
      // Reference BOTH capacity fields so Loki surfaces them regardless of
      // whether the topology promotes them into the response stream object —
      // every mp-bearing heartbeat line also carries the count, so the AND
      // filter matches the same lines.
      const cBody = await queryLokiStreams(
        mkUrl(`${sel} | catalyst_node_max_parallel=~\`.+\` | catalyst_node_in_flight_count=~\`.+\``),
        timeoutMs,
        fetcher,
      );
      const capEnriched = cBody ? parseLokiLivenessResponse(cBody) : {};
      for (const [host, rec] of Object.entries(capEnriched)) {
        if (!out[host]) continue;
        if (rec.max_parallel != null) out[host].max_parallel = rec.max_parallel;
        if (rec.in_flight_count != null) out[host].in_flight_count = rec.in_flight_count;
      }
    } catch (err) {
      logger?.warn?.({ err: err?.message }, "loki-liveness: capacity enrichment failed (capacity → no-data)");
    }
    // CTL-1581 (query D, best-effort): slot-occupancy enrichment. Same
    // reference-to-surface rule as B/C. active_count matches `.+` on every
    // new-daemon line (a number string, "0" included); active_tickets matches
    // `.*` because an idle host's list is legitimately EMPTY — a `.+` filter
    // would hide the "0 active" truth and leave stale occupancy on screen.
    // Old-daemon lines match neither → fields stay null (unknown, never fake 0).
    try {
      const dBody = await queryLokiStreams(
        mkUrl(`${sel} | catalyst_node_active_count=~\`.+\` | catalyst_node_active_tickets=~\`.*\``),
        timeoutMs,
        fetcher,
      );
      const activeEnriched = dBody ? parseLokiLivenessResponse(dBody) : {};
      for (const [host, rec] of Object.entries(activeEnriched)) {
        if (!out[host]) continue;
        // Only merge occupancy from a line AT LEAST as new as A's liveness line:
        // on a rollback (or a brief old+new dual-publish), A's newest can be an
        // old-daemon line while D's newest attribute-bearing line is older —
        // merging that would pin STALE occupancy onto fresher liveness. Skipped
        // → fields stay null → consumers fall back to inFlightCount honestly.
        const aMs = Date.parse(out[host].last_seen);
        const dMs = Date.parse(rec.last_seen);
        if (!(Number.isFinite(dMs) && Number.isFinite(aMs) && dMs >= aMs)) continue;
        if (rec.active_count != null) out[host].active_count = rec.active_count;
        if (Array.isArray(rec.active_tickets)) out[host].active_tickets = rec.active_tickets;
      }
    } catch (err) {
      logger?.warn?.({ err: err?.message }, "loki-liveness: active enrichment failed (occupancy → unknown)");
    }
    // CAT-57 (query E, best-effort): productivity enrichment. Same reference-to-surface
    // rule as B/C/D — parsing catalyst_node_last_advance_at is NOT enough; Loki only
    // puts a structured-metadata field in the response when a query REFERENCES it, so
    // without this query every record would keep last_advance_at:null and
    // checkNodeProductivity would skip every peer even in enforce. `.+` (not `.*`) is
    // right here: the attribute is OMITTED entirely when unknown (heartbeat-event.mjs
    // never publishes an empty string), so there is no "legitimately empty" case to
    // preserve the way active_tickets has. Old-daemon lines match neither → the field
    // stays null (unknown), never a fabricated timestamp.
    try {
      const eBody = await queryLokiStreams(
        mkUrl(`${sel} | catalyst_node_last_advance_at=~\`.+\``),
        timeoutMs,
        fetcher,
      );
      const advEnriched = eBody ? parseLokiLivenessResponse(eBody) : {};
      for (const [host, rec] of Object.entries(advEnriched)) {
        if (!out[host]) continue;
        // Same rollback guard as D: only merge from a line at least as new as A's
        // liveness line, so a dual-publish/rollback window cannot pin a STALE advance
        // onto fresher liveness and make a stuck host look productive.
        const aMs = Date.parse(out[host].last_seen);
        const eMs = Date.parse(rec.last_seen);
        if (!(Number.isFinite(eMs) && Number.isFinite(aMs) && eMs >= aMs)) continue;
        if (rec.last_advance_at != null) out[host].last_advance_at = rec.last_advance_at;
      }
    } catch (err) {
      logger?.warn?.({ err: err?.message }, "loki-liveness: advance enrichment failed (productivity → unknown)");
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
