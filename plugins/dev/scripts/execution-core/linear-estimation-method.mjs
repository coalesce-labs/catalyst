// linear-estimation-method.mjs — lazy-cached Linear team estimation method
// fetcher (CTL-954).
//
// Exports:
//   getEstimationMethod(teamId, opts?) → { type, allowZero, extended } | null
//   scaleForMethod(type) → number[]           (sorted allowed integer array)
//   mapScopeToEstimate(scope, type) → number | null
//
// The team's estimation method (fibonacci / tShirt / exponential / linear /
// notUsed) is fetched ONCE from the Linear GraphQL API and cached on disk with
// a 7-day TTL (configurable via opts.ttlMs).  On any error — curl failure,
// 401/429, bad JSON, disk full — the function returns null so callers fall back
// to the existing Fibonacci-only path unchanged.  The cache is per-team so
// different teams (CTL vs ADV) each carry their own method independently.
//
// Sync design rationale: the scheduler daemon is a tight synchronous pull loop
// (every `readFileSync`/`spawnSync` call in scheduler.mjs confirms this).
// This module follows the same pattern: cache reads are cheap synchronous fs
// reads, and the rare cache-miss GraphQL call is a synchronous `curl` spawn
// (identical to runBatchOnce in linear-query.mjs).  No async seams are needed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// GraphQL query — filter by key (the short mnemonic like "CTL") instead of
// UUID, matching the pattern in setup-execution-core-states.sh line 351.
// The scheduler knows team keys (CTL/ADV/OTL) not UUIDs.
const TEAM_ESTIMATION_QUERY = `query GetTeamEstimation($key: String!) {
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

// ── In-process memoisation ────────────────────────────────────────────────────
// Within a single daemon lifetime the cache file is cheap-but-not-free (a
// synchronous readFileSync on every tick).  A module-level Map eliminates the
// repeated disk access once we've fetched and verified the method.  The map is
// keyed by teamId; the value is the full cached record so we can check TTL.
const _memo = new Map();

// ── Cache file path ───────────────────────────────────────────────────────────
// Same durable-state directory as registry.json / eligible / state.json.
function cacheFilePath(teamId) {
  const dir = join(process.env.HOME ?? "/tmp", "catalyst", "execution-core");
  return join(dir, `team-estimation-${teamId}.json`);
}

// ── Atomic cache write ────────────────────────────────────────────────────────
// Write to a .tmp sibling, then rename — avoids a corrupt half-written read on
// the next tick if the process is killed mid-write.
function writeCacheFile(teamId, method) {
  const path = cacheFilePath(teamId);
  const dir = join(process.env.HOME ?? "/tmp", "catalyst", "execution-core");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const record = { teamId, method, fetchedAt: new Date().toISOString() };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, path);
    return record;
  } catch {
    return null;
  }
}

// ── Linear API fetch ─────────────────────────────────────────────────────────
// Identical curl pattern to runBatchOnce in linear-query.mjs.
function fetchFromLinear(teamId) {
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  // authHeader — mirrors linear-query.mjs:authHeader.
  const auth = /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
  const payload = JSON.stringify({
    query: TEAM_ESTIMATION_QUERY,
    variables: { key: teamId },
  });

  const caArgs =
    process.env.NODE_EXTRA_CA_CERTS && existsSync(process.env.NODE_EXTRA_CA_CERTS)
      ? ["--cacert", process.env.NODE_EXTRA_CA_CERTS]
      : [];

  const args = [
    "-sS",
    "--max-time",
    "15",
    ...caArgs,
    "-X",
    "POST",
    LINEAR_GRAPHQL_ENDPOINT,
    "-H",
    `Authorization: ${auth}`,
    "-H",
    "Content-Type: application/json",
    "-w",
    "\n%{http_code}",
    "--data",
    "@-",
  ];

  let res;
  try {
    res = spawnSync("curl", args, { input: payload, encoding: "utf8" });
  } catch {
    return null; // curl not available
  }
  if (res.status !== 0) return null; // curl error

  const out = res.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  const httpCode = Number(out.slice(nl + 1).trim());
  const body = out.slice(0, Math.max(0, nl));

  if (httpCode === 401 || httpCode === 403 || httpCode === 429) return null;
  if (httpCode < 200 || httpCode >= 300) return null;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (parsed?.errors) return null; // GraphQL-level errors

  const method = parsed?.data?.teams?.nodes?.[0]?.issueEstimation;
  if (!method || typeof method.type !== "string") return null;

  return { type: method.type, allowZero: !!method.allowZero, extended: !!method.extended };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * getEstimationMethod — return the team's Linear estimation method, consulting
 * the on-disk TTL cache first and the Linear GraphQL API on a miss.
 *
 * @param {string} teamId  Linear team key (e.g. "CTL") or UUID
 * @param {{ ttlMs?: number, exec?: Function }} [opts]
 *   ttlMs — override the 7-day TTL (tests only).
 *   exec  — unused (kept for interface symmetry with other helpers; the real
 *           spawnSync is always used because the function must be synchronous).
 * @returns {{ type: string, allowZero: boolean, extended: boolean } | null}
 */
export function getEstimationMethod(teamId, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!teamId || typeof teamId !== "string") return null;

  const now = Date.now();

  // 1. In-process memo (within a single daemon run).
  if (_memo.has(teamId)) {
    const cached = _memo.get(teamId);
    if (now - new Date(cached.fetchedAt).getTime() < ttlMs) {
      return cached.method;
    }
    _memo.delete(teamId); // stale — re-fetch
  }

  // 2. On-disk cache.
  const path = cacheFilePath(teamId);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const record = JSON.parse(raw);
      if (record?.method && typeof record.method.type === "string") {
        const age = now - new Date(record.fetchedAt).getTime();
        if (age < ttlMs) {
          _memo.set(teamId, record);
          return record.method;
        }
        // stale — fall through to fetch
      }
    } catch {
      // corrupt cache — fall through to fetch
    }
  }

  // 3. Live Linear GraphQL fetch (cache miss / stale).
  const method = fetchFromLinear(teamId);
  if (!method) return null; // fail-open; caller uses Fibonacci fallback

  const record = writeCacheFile(teamId, method);
  if (record) _memo.set(teamId, record);

  return method;
}

// ── scaleForMethod ────────────────────────────────────────────────────────────

/**
 * scaleForMethod — return the sorted integer point values for the given
 * estimation type.  These match Linear's internal encoding.
 *
 * fibonacci:   {0,1,2,3,5,8,13}  (0-origin per Linear's own field)
 * tShirt:      {0,1,2,3,5}       (XS=0 S=1 M=2 L=3 XL=5)
 * exponential: {0,1,2,4,8,16,32}
 * linear:      {0,1,2,3,4,5,6,7,8,9,10}
 * notUsed:     []
 *
 * @param {string} type
 * @returns {number[]}
 */
export function scaleForMethod(type) {
  switch (type) {
    case "fibonacci":
      return [0, 1, 2, 3, 5, 8, 13];
    case "tShirt":
      return [0, 1, 2, 3, 5];
    case "exponential":
      return [0, 1, 2, 4, 8, 16, 32];
    case "linear":
      return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    case "notUsed":
      return [];
    default:
      return []; // unknown → treat as notUsed
  }
}

// ── mapScopeToEstimate ────────────────────────────────────────────────────────

// Per-type explicit scope → point value map.
// Values are the actual Linear integer fields (tShirt: XS=0 S=1 M=2 L=3 XL=5).
// Triage produces: xs | small | medium | large | epic (xl is an alias for epic).
// The plan (CTL-954): xs→0, small→1(fib)/1(tShirt), medium→3(fib)/2(tShirt),
//   large→5(fib)/3(tShirt), xl/epic→8(fib)/5(tShirt).
// Using a lookup table per type avoids index-clamping surprises across scales.
const SCOPE_MAP = {
  //                 xs   small  medium  large  xl    epic
  fibonacci:   { xs: 1,  small: 1, medium: 3, large: 5,  xl: 8,  epic: 8  },
  tShirt:      { xs: 0,  small: 1, medium: 2, large: 3,  xl: 5,  epic: 5  },
  exponential: { xs: 1,  small: 1, medium: 2, large: 4,  xl: 8,  epic: 8  },
  linear:      { xs: 1,  small: 1, medium: 2, large: 3,  xl: 4,  epic: 5  },
};

/**
 * mapScopeToEstimate — map a triage estimated_scope string to the closest
 * valid integer for the given estimation type.
 *
 * Returns null for notUsed, unknown type, or unrecognized scope.
 *
 * @param {string} scope  "xs" | "small" | "medium" | "large" | "xl" | "epic"
 * @param {string} type   estimation type from getEstimationMethod
 * @returns {number | null}
 */
export function mapScopeToEstimate(scope, type) {
  if (!scope || !type) return null;
  const s = scope.toLowerCase();
  const row = SCOPE_MAP[type];
  if (!row) return null; // notUsed or unknown type
  const val = row[s];
  return val !== undefined ? val : null;
}

// ── resetMemoForTests — test-only ─────────────────────────────────────────────
// Exposed so test files can reset the module-level memo between test cases
// without reloading the module.
export function _resetMemoForTests() {
  _memo.clear();
}
