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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

// ── In-memory TTL cache ───────────────────────────────────────────────────────
// Keyed by ticket ID (e.g. "CTL-774"). Value: { estimate: number|null, ts: number }.
// null means we fetched and Linear returned no estimate; absent means uncached.
const ESTIMATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _estimateCache = new Map(); // ticketId → { estimate: number|null, ts: number }

// ── Team estimation-method on-disk cache (mirrors execution-core) ─────────────
// File: ~/catalyst/execution-core/team-estimation-<TEAM>.json
// Reuses the same file the scheduler's getEstimationMethod writes, so a fresh
// scheduler run primes this cache for free.
const METHOD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const _methodCache = new Map(); // teamId → { type, fetchedAt }

function methodCachePath(teamId) {
  return join(HOME, "catalyst", "execution-core", `team-estimation-${teamId}.json`);
}

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

// The team estimation-method query (reused from linear-estimation-method.mjs).
const TEAM_METHOD_QUERY = `query GetTeamEstimation($key: String!) {
  teams(filter: { key: { eq: $key } }) {
    nodes {
      issueEstimation {
        type
        allowZero
        extended
      }
    }
  }
}`;

function linearAuthHeader() {
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  if (!token) return null;
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

// graphql — one async GraphQL call via Bun's native fetch.  Returns the parsed
// `data` object on success, or null on any failure (network, auth, 429, bad JSON).
async function graphql(query, variables) {
  const auth = linearAuthHeader();
  if (!auth) return null;
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

  const now = Date.now();

  // 1. In-process memo.
  if (_methodCache.has(teamId)) {
    const r = _methodCache.get(teamId);
    if (now - new Date(r.fetchedAt).getTime() < METHOD_TTL_MS) {
      return r.method ?? null;
    }
    _methodCache.delete(teamId);
  }

  // 2. On-disk cache (shared with execution-core/linear-estimation-method.mjs).
  const path = methodCachePath(teamId);
  if (existsSync(path)) {
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record?.method && typeof record.method.type === "string") {
        if (now - new Date(record.fetchedAt).getTime() < METHOD_TTL_MS) {
          _methodCache.set(teamId, record);
          return record.method;
        }
      }
    } catch {
      // corrupt cache — fall through
    }
  }

  // 3. Live fetch.
  const data = await graphql(TEAM_METHOD_QUERY, { key: teamId });
  const method = data?.teams?.nodes?.[0]?.issueEstimation;
  if (!method || typeof method.type !== "string") return null;

  const normalized = { type: method.type, allowZero: !!method.allowZero, extended: !!method.extended };
  const record = { teamId, method: normalized, fetchedAt: new Date().toISOString() };
  // Atomic write — same convention as linear-estimation-method.mjs.
  try {
    const dir = join(HOME, "catalyst", "execution-core");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, path);
  } catch {
    // disk write failed — in-mem cache is still valid
  }
  _methodCache.set(teamId, record);
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
export async function fillEstimateFallback(ticketIds) {
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

  // Group uncached IDs by team key (e.g. "CTL" → [774, 930, ...]).
  // IDs that don't parse are quietly stored as null (can't query them).
  const teamGroups = groupByTeam(toFetch);
  const unparseable = toFetch.filter((id) => parseIdentifier(id) === null);
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
      const data = await graphql(ESTIMATE_QUERY_FOR_TEAM, { teamKey, numbers });
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
export function _clearMethodCache() {
  _methodCache.clear();
}
export function _getEstimateCacheSize() {
  return _estimateCache.size;
}
