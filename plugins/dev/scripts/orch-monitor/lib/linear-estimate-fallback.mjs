// linear-estimate-fallback.mjs — supplemental estimate resolver for tickets
// whose durable-cache estimate is null (CTL-974).
//
// Context:
//   linear-cache-reader.mjs reads estimates ONLY from the broker's durable
//   caches (filter-state.db ticket_state + eligible projections).  A ticket
//   whose estimate was set in Linear BEFORE the broker's webhook write-through
//   was deployed (CTL-957) — or that has never been touched by a relevant
//   webhook — will have estimate===null forever unless we supplement.
//
// This module adds that supplemental pass: given the set of ticket IDs on the
// board that still have a null estimate, it:
//
//   1. Skips any ID already in the in-memory TTL cache (5 min default).
//   2. Batches the remaining IDs into a SINGLE Linear GraphQL call
//      (field: `estimate` on each issue node — cheap, no relation traversal).
//   3. Merges results back into the cache and returns the full per-ID map.
//   4. Also resolves each team's estimation METHOD so deriveEstimateDisplay
//      can pick the right label scale (fibonacci → number, tShirt → XS/S/M/L/XL).
//      The method is cached with a 24h TTL on disk (reused from the scheduler's
//      ~/catalyst/execution-core/team-estimation-<TEAM>.json).
//
// Design constraints (from the ticket + CTL-883):
//   - READ-ONLY vs Linear.  Never writes.
//   - NEVER touches the broker DB.
//   - Fail-open: any error (missing token, network, quota) leaves the affected
//     tickets with estimate===null (honest null).  The board renders fine without
//     an estimate; the chip is simply absent.
//   - BATCH, not N+1.  All null-estimate board tickets in one GraphQL call
//     (≤250 at a time; the board never has that many but chunking is safe).
//   - Short TTL (5 min) so a ticket whose estimate is set in Linear shows up
//     within one board refresh cycle.
//
// Dependencies: none beyond node built-ins + Bun's global `fetch`.

// CTL-1616 PR3 folded this file's inline LINEAR_API_TOKEN/LINEAR_API_KEY ladder
// onto the shared secret-contract engine (design §8 PR3 table). CTL-2187 moves
// that resolution one step further out, into the shared degraded-read credential
// resolver — which adds the SCOPED app-actor tier the monitor process actually
// has. Read the CTL-1612 note in that module before changing the tier order.
import { resolveDegradedLinearAuth } from "./linear-degraded-auth.mjs";
// CTL-1806: the replica tier (read #1) + the degraded-path anomaly (D3).
import { readReplicaEstimates } from "./linear-cache-reader.mjs";
import { noteDegradedLinearRead } from "./linear-degraded-read.mjs";
// CTL-1806 (D1): the team estimation method's cache lives in execution-core and
// is now shared rather than duplicated here. This module previously carried its
// own 24h TTL, its own path fn, its own memo, a byte-copy of the GraphQL query
// and its own atomic write — all over THE SAME FILE the scheduler writes with a
// 7-day TTL. A record written at T+30h was therefore valid to the scheduler and
// stale here, so the board re-fetched from Linear and rewrote a file the
// scheduler was already serving: a duplicated Linear call caused purely by the
// two caches disagreeing. One TTL now, one path, one query, one writer.
import {
  TEAM_ESTIMATION_QUERY,
  readTeamEstimationCache,
  writeTeamEstimationCache,
  _resetMemoForTests,
} from "../../execution-core/linear-estimation-method.mjs";

// ── In-memory TTL cache ───────────────────────────────────────────────────────
// Keyed by ticket ID (e.g. "CTL-774"). Value: { estimate: number|null, ts: number }.
// null means we fetched and Linear returned no estimate; absent means uncached.
const ESTIMATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _estimateCache = new Map(); // ticketId → { estimate: number|null, ts: number }

// ── Team-method failure backoff (CTL-2187) ───────────────────────────────────
// Keyed by team key ("CTL"). Value: epoch ms of the last FAILED resolution.
// Deliberately short — a credential arriving mid-run (the reminter re-populating
// CATALYST_MONITOR_APP_ACTOR_TOKEN, an operator exporting a personal key) must
// take effect within a couple of board refreshes, not after the 7-day positive
// TTL. See the note at the read site in getEstimationMethodAsync for why the
// negative half exists at all.
const METHOD_FAILURE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _methodFailureCache = new Map(); // teamId → epoch ms of last failure

// ── Linear GraphQL helpers ────────────────────────────────────────────────────
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const BATCH_CHUNK_SIZE = 250;

// parseIdentifier — splits "CTL-774" into { teamKey: "CTL", number: 774 }.
// Returns null if the identifier does not match the expected format.
function parseIdentifier(id) {
  if (typeof id !== "string") return null;
  const match = id.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  if (!match) return null;
  return { teamKey: match[1].toUpperCase(), number: parseInt(match[2], 10) };
}

// groupByTeam — partitions an array of identifier strings by their team key.
// Identifiers that don't parse (no dash, non-numeric suffix) are silently skipped.
// Returns a Map<teamKey, number[]>.
function groupByTeam(ids) {
  const groups = new Map();
  for (const id of ids) {
    const parsed = parseIdentifier(id);
    if (!parsed) continue;
    const { teamKey, number } = parsed;
    if (!groups.has(teamKey)) groups.set(teamKey, []);
    groups.get(teamKey).push(number);
  }
  return groups;
}

// The estimate query: filter by team key + issue numbers (valid Linear IssueFilter
// fields).  The old `identifier: { in: $ids }` filter is NOT a valid IssueFilter
// field and causes a 400 on every call (CTL-976).
// We run one query per team key so cross-team boards (CTL + ADV, etc.) all resolve.
const ESTIMATE_QUERY_FOR_TEAM = `query FallbackEstimates($teamKey: String!, $numbers: [Float!]) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }, first: ${BATCH_CHUNK_SIZE}) {
    nodes {
      number
      estimate
      team {
        key
      }
    }
  }
}`;

// CTL-2187: the credential ladder now lives in linear-degraded-auth.mjs so both
// degraded resolvers agree on it and the CTL-1612 reasoning is stated once.
function linearAuthHeader() {
  return resolveDegradedLinearAuth()?.header ?? null;
}

// graphql — one async GraphQL call via Bun's native fetch.  Returns the parsed
// `data` object on success, or null on any failure (network, auth, 429, bad JSON).
//
// CTL-1806 (D3): every reachable exit from this function is a Linear read on the
// DEGRADED path, so each one emits `catalyst.linear.read` BEFORE the outbound
// call. `source`/`op` are threaded from the call site because both queries below
// route through this one helper — without that, the estimate read and the
// team-method read would be indistinguishable in Loki, and one of them consults a
// replica while the other has no local source at all.
async function graphql(query, variables, { source, op, entity = null } = {}) {
  const auth = linearAuthHeader();
  if (!auth) {
    // Reached the degraded path but cannot even dispatch — a node with no Linear
    // credential otherwise returns nulls in total silence. WARN via result:failed.
    noteDegradedLinearRead({ source, result: "failed", op, entity });
    return null;
  }
  noteDegradedLinearRead({ source, result: "ok", op, entity });
  try {
    const res = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null; // 401/403/429/5xx → fail-open
    const json = await res.json();
    if (json?.errors) return null; // GraphQL-level error
    return json?.data ?? null;
  } catch {
    return null; // network / timeout / JSON parse failure → fail-open
  }
}

// ── Estimation method ─────────────────────────────────────────────────────────

// getEstimationMethodAsync — async version of the scheduler's getEstimationMethod.
// Reads the same on-disk cache first (populated by the scheduler daemon), so this
// normally returns immediately from disk.  Falls back to a live Linear fetch when
// the cache is absent or stale (24h TTL).
export async function getEstimationMethodAsync(teamId) {
  if (!teamId || typeof teamId !== "string") return null;

  // 1+2. The SHARED memo + on-disk record, under the ONE 7-day TTL (D1). This is
  // the same helper the scheduler's synchronous getEstimationMethod uses, so a
  // record either module writes is honoured by both.
  const cached = readTeamEstimationCache(teamId);
  if (cached) return cached;

  // 2b. CTL-2187 — the NEGATIVE half of the cache. A SUCCESSFUL fetch is cached
  // for 7 days by the positive tiers above; a FAILED one was cached nowhere, so
  // a team whose method cannot be resolved was re-attempted on every board
  // render. That is the shape of the runaway: ~2 attempts/second, constant
  // rather than decaying, because the thing that would have stopped it is the
  // very write that never happened. This is NOT the fix for the credential gap
  // (that is the scoped tier in linear-degraded-auth.mjs, and with a credential
  // present the POSITIVE cache is what suppresses the repeat) — it is the bound
  // for a host that genuinely has no credential of any tier, so such a host
  // still says so, at one attempt per team per window instead of per render.
  const failedAt = _methodFailureCache.get(teamId);
  if (failedAt !== undefined && Date.now() - failedAt < METHOD_FAILURE_TTL_MS) return null;

  // 3. Live fetch — the labelled DEGRADED path (D1). The replica has no teams
  // table and carries no issueEstimation, so unlike the estimate read below there
  // is no local tier to consult first; source is "linearis", not "linearis_miss".
  //
  // The async fetch stays here rather than delegating to the sync
  // getEstimationMethod: that one spawns curl SYNCHRONOUSLY, which is right for
  // the scheduler's synchronous pull loop and wrong for a board request path.
  const data = await graphql(
    TEAM_ESTIMATION_QUERY,
    { key: teamId },
    { source: "linearis", op: "team_method", entity: teamId }
  );
  const method = data?.teams?.nodes?.[0]?.issueEstimation;
  if (!method || typeof method.type !== "string") {
    // CTL-2187: remember the failure so the next render does not re-attempt.
    // Covers both reachable failure modes — no credential resolved (graphql
    // returned null before fetch) and a dispatched call that came back empty.
    _methodFailureCache.set(teamId, Date.now());
    return null;
  }

  const normalized = { type: method.type, allowZero: !!method.allowZero, extended: !!method.extended };
  _methodFailureCache.delete(teamId); // a success clears any prior backoff
  writeTeamEstimationCache(teamId, normalized); // shared atomic write + memo seed
  return normalized;
}

// ── Estimate fallback batch fetch ─────────────────────────────────────────────

// fillEstimateFallback — given an array of ticket IDs whose durable-cache
// estimate is null, return a map { [id]: number|null } for those tickets.
//
// - Hits are served from _estimateCache (5-min TTL).
// - Remaining IDs are batched into one Linear GraphQL call (chunked at 250).
// - null is stored for IDs that Linear returned no estimate for (unset in
//   Linear) so a subsequent call within the TTL does not re-fetch.
// - Always resolves; never rejects.
export async function fillEstimateFallback(ticketIds, { replicaOptions = {} } = {}) {
  const result = {};
  const toFetch = [];
  const now = Date.now();

  for (const id of ticketIds) {
    const cached = _estimateCache.get(id);
    if (cached !== undefined && now - cached.ts < ESTIMATE_TTL_MS) {
      result[id] = cached.estimate;
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) return result;

  // ── Tier 1: the LOCAL replica (CTL-1806) ───────────────────────────────────
  // The whole point of this ticket. This resolver used to go straight from a
  // durable-cache miss to the rate-limited Linear API, for a value that is
  // already on this node in SQLite. Gated on FILE PRESENCE only and fail-open:
  // an absent/unreadable replica yields {} and every id simply proceeds to the
  // degraded path exactly as before.
  //
  // A replica row whose estimate is NULL is OMITTED by the primitive — i.e. it
  // is a MISS and falls through, never an authoritative null. "Linear has none"
  // and "this row predates the estimate projection" are indistinguishable
  // locally, and serving the null would silently drop the chip for a refresh.
  const replicaHits = await readReplicaEstimates({ ids: toFetch, ...replicaOptions });
  const stillMissing = [];
  for (const id of toFetch) {
    const hit = replicaHits[id];
    if (typeof hit === "number" && Number.isFinite(hit)) {
      _estimateCache.set(id, { estimate: hit, ts: Date.now() });
      result[id] = hit;
    } else {
      stillMissing.push(id);
    }
  }
  if (stillMissing.length === 0) return result;
  // From here on, every id is a genuine REPLICA MISS — which is exactly what the
  // `linearis_miss` source on the emission below records.
  const toQuery = stillMissing;

  // Group uncached IDs by team key (e.g. "CTL" → [774, 930, ...]).
  // IDs that don't parse are quietly stored as null (can't query them).
  const teamGroups = groupByTeam(toQuery);
  const unparseable = toQuery.filter((id) => parseIdentifier(id) === null);
  for (const id of unparseable) {
    _estimateCache.set(id, { estimate: null, ts: Date.now() });
    result[id] = null;
  }

  // For each team key, chunk its numbers and fire one query per chunk.
  const perTeamChunks = [];
  for (const [teamKey, numbers] of teamGroups) {
    for (let i = 0; i < numbers.length; i += BATCH_CHUNK_SIZE) {
      perTeamChunks.push({ teamKey, numbers: numbers.slice(i, i + BATCH_CHUNK_SIZE) });
    }
  }

  await Promise.allSettled(
    perTeamChunks.map(async ({ teamKey, numbers }) => {
      // CTL-1806 (D3): a replica WAS consulted above and missed → linearis_miss.
      const data = await graphql(
        ESTIMATE_QUERY_FOR_TEAM,
        { teamKey, numbers },
        { source: "linearis_miss", op: "estimate" }
      );
      const nodes = data?.issues?.nodes ?? [];

      // Build a set of numbers returned for this team.
      const fetchedNumbers = new Set();
      for (const node of nodes) {
        if (typeof node.number !== "number") continue;
        const returnedKey = node.team?.key?.toUpperCase() ?? teamKey;
        const id = `${returnedKey}-${node.number}`;
        const estimate = typeof node.estimate === "number" ? node.estimate : null;
        _estimateCache.set(id, { estimate, ts: Date.now() });
        result[id] = estimate;
        fetchedNumbers.add(node.number);
      }

      // Numbers that Linear did not return → honest null (not found or unset).
      for (const num of numbers) {
        if (!fetchedNumbers.has(num)) {
          const id = `${teamKey}-${num}`;
          _estimateCache.set(id, { estimate: null, ts: Date.now() });
          result[id] = null;
        }
      }
    }),
  );

  return result;
}

// ── Exposed for tests ─────────────────────────────────────────────────────────
// Allow tests to inject a clock / clear the cache without module reload.
export function _clearEstimateCache() {
  _estimateCache.clear();
}
// CTL-1806: the method memo now lives in execution-core (one cache, one TTL), so
// this delegates rather than clearing a second map that no longer exists.
export function _clearMethodCache() {
  _resetMemoForTests();
  _methodFailureCache.clear(); // CTL-2187: the negative half lives here
}
export function _getEstimateCacheSize() {
  return _estimateCache.size;
}
