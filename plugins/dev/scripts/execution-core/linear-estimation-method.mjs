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
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
// CTL-1616 PR3: fold this file's inline LINEAR_API_TOKEN/LINEAR_API_KEY ladder
// onto the shared secret-contract engine (design §8 PR3 table).
import { resolveSecret } from "../lib/secret-contract.mjs";
// CTL-1806 (D3): the degraded-path anomaly. This module CANNOT be served from the
// replica (see the DEGRADED note below), so its Linear call is labelled rather
// than removed — and a labelled call has to actually be observable.
import { emitLinearReadEvent } from "./linear-read-event.mjs";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

/**
 * CTL-1806 (D1) — the ONE TTL for the team estimation method, and the reason the
 * Linear fetch below stays.
 *
 * DEGRADED BY NECESSITY, not by choice: the local Linear replica has no `teams`
 * table and no workflow/state table (measured 2026-08-14: `sqlite_master` LIKE
 * '%team%' and '%state%' return ZERO tables, against a positive control of
 * '%issue%' returning 3 and '%label%' returning 2), and `issueEstimation` appears
 * in 0 of 3887 `raw` blobs against a positive control of '%estimate%' matching
 * 3864. The `$.team` projection that DOES exist carries exactly {id,key,name} —
 * the container is there and the estimation config is not in it. So this read has
 * no local source and cannot be made replica-first; it is bounded instead, at 8
 * distinct team keys per host per TTL window.
 *
 * It is NOT defaulted to Fibonacci on a miss, and that is the sharpest constraint
 * in this file: the value gates a REAL LINEAR WRITE (scheduler.mjs's triage→
 * research advance reads the triage estimate and calls
 * writeStatus.applyEstimate). Today an unavailable method returns null and the
 * scheduler SKIPS the write. A default would flip that from "skip" to "derive and
 * write a Fibonacci number into a tShirt team's estimate field" — irreversible
 * without an audit. A guessed scale is worse than no estimate.
 *
 * CTL-1806 also collapses the duplicate cache: orch-monitor's
 * linear-estimate-fallback.mjs wrote THIS SAME FILE with a 24h TTL while this
 * module used 7 days, so a record written at T+30h was valid here and stale
 * there — the board re-fetched from Linear and rewrote a file the scheduler was
 * already happily serving, the exact duplicated call this ticket removes. Both
 * now share this constant, the path fn, the query, and the read/write helpers.
 */
export const TEAM_ESTIMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// GraphQL query — filter by key (the short mnemonic like "CTL") instead of
// UUID, matching the pattern in setup-execution-core-states.sh line 351.
// The scheduler knows team keys (CTL/ADV/OTL) not UUIDs.
// Exported (CTL-1806) so the orch-monitor async resolver reuses this text rather
// than carrying a byte-copy that can drift.
export const TEAM_ESTIMATION_QUERY = `query GetTeamEstimation($key: String!) {
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
// CTL-1806: `process.env.HOME ?? homedir()` rather than the old `?? "/tmp"` —
// orch-monitor's now-deleted duplicate resolved this with homedir(), so with HOME
// unset the two "same file" writers silently targeted two DIFFERENT files.
function cacheDir() {
  return join(process.env.HOME ?? homedir(), "catalyst", "execution-core");
}

/**
 * teamEstimationCachePath — the single on-disk location for a team's estimation
 * method. Exported (CTL-1806) so every writer of this file agrees on the path.
 * @param {string} teamId
 * @returns {string}
 */
export function teamEstimationCachePath(teamId) {
  return join(cacheDir(), `team-estimation-${teamId}.json`);
}

// ── Atomic cache write ────────────────────────────────────────────────────────
// Write to a .tmp sibling, then rename — avoids a corrupt half-written read on
// the next tick if the process is killed mid-write.
/**
 * writeTeamEstimationCache — persist a resolved method under the shared TTL
 * contract. Exported (CTL-1806) so the async orch-monitor resolver reuses this
 * atomic write instead of its own copy. Returns the written record, or null when
 * the disk write failed (the caller's in-memory cache remains valid).
 * @param {string} teamId
 * @param {{type: string, allowZero: boolean, extended: boolean}} method
 */
export function writeTeamEstimationCache(teamId, method) {
  const record = { teamId, method, fetchedAt: new Date().toISOString() };
  // Seed the in-process memo BEFORE attempting the disk write: an unwritable
  // disk must not force a fresh Linear fetch on every subsequent tick. (The
  // orch-monitor duplicate this replaces already behaved this way; the sync
  // scheduler path did not, and re-fetched forever on a read-only disk.)
  _memo.set(teamId, record);
  try {
    const dir = cacheDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = teamEstimationCachePath(teamId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, path);
    return record;
  } catch {
    return null; // disk write failed — the memo above is still valid
  }
}

/**
 * readTeamEstimationCache — the shared cache tiers (in-process memo, then the
 * on-disk record), under the ONE TTL. Exported (CTL-1806) so the async
 * orch-monitor resolver stops carrying a second memo, a second path fn and a
 * second (shorter) TTL over the same file.
 *
 * @param {string} teamId
 * @param {{ttlMs?: number}} [opts]
 * @returns {{type: string, allowZero: boolean, extended: boolean} | null}
 *   null means "not cached / stale / corrupt" — the caller must fetch.
 */
export function readTeamEstimationCache(teamId, { ttlMs = TEAM_ESTIMATION_TTL_MS } = {}) {
  if (!teamId || typeof teamId !== "string") return null;
  const now = Date.now();

  // 1. In-process memo (within a single daemon run).
  if (_memo.has(teamId)) {
    const cached = _memo.get(teamId);
    if (now - new Date(cached.fetchedAt).getTime() < ttlMs) return cached.method;
    _memo.delete(teamId); // stale — re-fetch
  }

  // 2. On-disk cache.
  const path = teamEstimationCachePath(teamId);
  if (existsSync(path)) {
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record?.method && typeof record.method.type === "string") {
        if (now - new Date(record.fetchedAt).getTime() < ttlMs) {
          _memo.set(teamId, record);
          return record.method;
        }
        // stale — fall through to fetch
      }
    } catch {
      // corrupt cache — fall through to fetch
    }
  }
  return null;
}

// ── Linear API fetch ─────────────────────────────────────────────────────────
// Identical curl pattern to runBatchOnce in linear-query.mjs.
function fetchFromLinear(teamId) {
  const token = resolveSecret("linear-api-token").value ?? ""; // CTL-1616 PR3
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

  // CTL-1806 (D3): emit the degraded-path anomaly IMMEDIATELY BEFORE the outbound
  // call, never after — an emission placed after is lost on exactly the failures
  // worth knowing about (curl absent, timeout, throw). source is "linearis"
  // (not "linearis_miss") because NO replica was consulted: there is no replica
  // source for team estimation config at all, so this is not a miss, it is a read
  // with no local tier. `result` records only what is knowable here — whether the
  // call could be dispatched at all.
  emitLinearReadEvent({
    source: "linearis",
    result: token ? "ok" : "failed",
    op: "team_method",
    entity: teamId,
    serviceName: "catalyst.execution-core",
  });

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
export function getEstimationMethod(teamId, { ttlMs = TEAM_ESTIMATION_TTL_MS } = {}) {
  if (!teamId || typeof teamId !== "string") return null;

  // 1+2. In-process memo, then the on-disk record — both under the ONE shared TTL
  // (CTL-1806: this is the same helper the orch-monitor async resolver now uses,
  // so the two writers of this file can no longer disagree about staleness).
  const cached = readTeamEstimationCache(teamId, { ttlMs });
  if (cached) return cached;

  // 3. Live Linear GraphQL fetch (cache miss / stale) — the labelled degraded
  // path (D1). Still returns null on ANY failure so the caller fails open; it is
  // deliberately NOT defaulted to a scale, because null makes the scheduler SKIP
  // its estimate write while a guess would make it write the wrong number.
  const method = fetchFromLinear(teamId);
  if (!method) return null;

  writeTeamEstimationCache(teamId, method); // also seeds the memo

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
