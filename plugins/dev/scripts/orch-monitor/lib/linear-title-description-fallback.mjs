// linear-title-description-fallback.mjs — supplemental {title, description}
// resolver for the ticket-detail page (CTL-974 pattern).
//
// Context (verified in source):
//   The board ticket (/api/board .tickets[]) carries a `title` but NO
//   description, and that `title` is sourced from the triage/eligible
//   projection (board-data.mjs ticketTitle: triage.title || triage.summary ||
//   eligibleIndex[t].title || cache title) — the triage SUMMARY (a
//   description-y sentence) can win over the real Linear title, which is why
//   CTL-926 rendered a stale/description-y title.  The durable cache
//   (filter-state.db ticket_state) has NO title column and NO description
//   column (linear-cache-reader.mjs), and ticket-detail-reader.mjs hard-codes
//   `description: null`.  So BOTH the real current title AND the description
//   must be FETCHED from Linear.
//
// This is exactly the shape linear-estimate-fallback.mjs (CTL-974) solves for
// the estimate field: a supplemental, cached, TTL'd, batched, fail-open Linear
// GraphQL fetch that NEVER spawns `linearis` per render.  Given the set of
// ticket IDs needing a title/description, it:
//
//   1. Skips any ID already in the in-memory TTL cache (5 min default).
//   2. Batches the remaining IDs into one Linear GraphQL call per team-chunk
//      (fields: `title`, `description` on each issue node — `description`
//      returns the same markdown `linearis issues read .description` yields).
//   3. Merges results back into the cache and returns the full per-ID map.
//
// Design constraints (from the SPEC + CTL-883 + CTL-974, carried verbatim):
//   - READ-ONLY vs Linear.  Never writes.
//   - NEVER touches the broker DB.
//   - Fail-open: any error (missing token, network, 429, GraphQL error)
//     leaves the affected tickets with { title:null, description:null }
//     (honest null).  The UI shows the stale board title + an honest-empty
//     description; it never fabricates.
//   - BATCH, not N+1.  All needed IDs in one GraphQL call per team
//     (≤250 at a time; chunking is safe for cross-team boards CTL + ADV).
//   - Short TTL (5 min) so an in-Linear edit reflects within one board-refresh
//     cycle while keeping the API quiet (2500/hr cap; CTL-883 "no synchronous
//     Linear call on a request path").
//   - NEVER throws.
//
// Dependencies: node built-ins + Bun's global `fetch`, plus (CTL-1616 PR3) the
// shared secret-contract engine for the LINEAR_API_TOKEN/LINEAR_API_KEY
// resolution below (design §8 PR3 table).
import { resolveSecret } from "../../lib/secret-contract.mjs";
// CTL-1806: the replica tier + the degraded-path anomaly (D3). This is the read
// that closes the REAL AC2 gap — the board's title backfill was already
// replica-aware one layer up (CTL-1372's readReplicaTitles in board-data), but
// the ticket-DETAIL route (server.ts's /api/linear-ticket) calls this resolver
// with no replica tier at all, and every RELATION TARGET it renders came from
// Linear too. Putting the tier INSIDE the resolver serves both callers at once.
import { readReplicaTicketDetails } from "./linear-cache-reader.mjs";
import { noteDegradedLinearRead } from "./linear-degraded-read.mjs";

// ── In-memory TTL cache ───────────────────────────────────────────────────────
// Keyed by ticket ID (e.g. "CTL-926"). Value:
//   { title: string|null, description: string|null,
//     labels: Array<{name,color}>|null, relations: RelationMap|null,
//     state: {name,type}|null, priority: number|null, project: string|null,
//     estimate: number|null, ts: number, ttlMs: number }.
// null means we fetched and Linear returned nothing; absent means uncached.
//
// RelationMap: { blockedBy: RelationTarget[], blocks: RelationTarget[], related: RelationTarget[], duplicateOf: RelationTarget[] }
// RelationTarget: { identifier, title: string|null, state: {name,type}|null, priority: number|null, project: string|null }
const TITLE_DESC_TTL_MS = 5 * 60 * 1000; // 5 minutes (match ESTIMATE_TTL_MS)
const DONE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for completed/canceled tickets (D4)
// CTL-1215: hard size cap so the long-lived monitor process can't grow this map
// without bound. A board holds low-hundreds of distinct tickets; 2000 covers
// cross-team boards + relation targets with headroom while bounding worst-case
// to a few MB. The lazy TTL (checked on read) only fires when a key is
// re-requested; the cap + the periodic _sweepTitleDescCache (wired in server.ts)
// evict abandoned keys that are never read again.
export const TITLE_DESC_CAP = 2000;
const _titleDescCache = new Map(); // ticketId → { title, description, labels, relations, state, priority, project, estimate, ts, ttlMs }

// _capTitleDescCache — insertion-order LRU evict, mirroring the proven beliefRates
// pattern (belief-store-queries.mjs). Map preserves insertion order so the first
// key is the oldest. Call after each _titleDescCache.set(...).
function _capTitleDescCache() {
  while (_titleDescCache.size > TITLE_DESC_CAP) {
    _titleDescCache.delete(_titleDescCache.keys().next().value);
  }
}

// ── Linear GraphQL helpers ────────────────────────────────────────────────────
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const BATCH_CHUNK_SIZE = 250;

// parseIdentifier — splits "CTL-926" into { teamKey: "CTL", number: 926 }.
// Returns null if the identifier does not match the expected format.
function parseIdentifier(id) {
  if (typeof id !== "string") return null;
  const match = id.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  if (!match) return null;
  return { teamKey: match[1].toUpperCase(), number: parseInt(match[2], 10) };
}

// groupByTeam — partitions identifier strings by team key.
// Identifiers that don't parse are silently skipped. Returns Map<teamKey, number[]>.
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

// The title+description query: filter by team key + issue numbers (valid Linear
// IssueFilter fields — the CTL-976 pattern; `identifier: { in }` is NOT valid
// and 400s every call). One query per team key so cross-team boards resolve.
// B3: expanded to include estimate, priority, project, state on the issue node,
// and full relation-target details (title, state, priority, project) — one
// batched call, no N+1.
const TITLE_DESC_QUERY_FOR_TEAM = `query FallbackTitleDesc($teamKey: String!, $numbers: [Float!]) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }, first: ${BATCH_CHUNK_SIZE}) {
    nodes {
      number
      title
      description
      estimate
      priority
      team {
        key
      }
      state {
        name
        type
      }
      project {
        name
      }
      labels {
        nodes {
          name
          color
        }
      }
      relations {
        nodes {
          type
          relatedIssue {
            identifier
            title
            priority
            state {
              name
              type
            }
            project {
              name
            }
          }
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            identifier
            title
            priority
            state {
              name
              type
            }
            project {
              name
            }
          }
        }
      }
    }
  }
}`;

function linearAuthHeader() {
  const token = resolveSecret("linear-api-token").value ?? ""; // CTL-1616 PR3
  if (!token) return null;
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

// graphql — one async GraphQL call via Bun's native fetch. Returns the parsed
// `data` object on success, or null on any failure (network, auth, 429, bad JSON).
//
// CTL-1806 (D3): emit `catalyst.linear.read` IMMEDIATELY BEFORE the outbound
// call — never after, since an after-the-fact emission is lost on exactly the
// failures (timeout, throw) worth knowing about. Every id reaching here has
// already missed the replica, hence source "linearis_miss".
async function graphql(query, variables, { source = "linearis_miss", op = "title_desc" } = {}) {
  const auth = linearAuthHeader();
  if (!auth) {
    // Degraded path reached but undispatchable — a node with no Linear
    // credential otherwise returns nulls in total silence. WARN via result:failed.
    noteDegradedLinearRead({ source, result: "failed", op });
    return null;
  }
  noteDegradedLinearRead({ source, result: "ok", op });
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

// ── Title+description fallback batch fetch ────────────────────────────────────

// parseRelationIssue — maps a Linear relation-issue node to our RelationTarget shape.
// Returns { identifier, title, state, priority, project } (all nullable except identifier).
function parseRelationIssue(node) {
  if (!node || typeof node.identifier !== "string") return null;
  const title = typeof node.title === "string" && node.title.length > 0 ? node.title : null;
  const state =
    node.state && typeof node.state.name === "string" && typeof node.state.type === "string"
      ? { name: node.state.name, type: node.state.type }
      : null;
  const priority = typeof node.priority === "number" ? node.priority : null;
  const project = node.project && typeof node.project.name === "string" ? node.project.name : null;
  return { identifier: node.identifier, title, state, priority, project };
}

// parseTicketMeta — extracts own-ticket state/priority/project/estimate from a node.
// Returns { state, priority, project, estimate } (all nullable).
function parseTicketMeta(node) {
  const state =
    node?.state && typeof node.state.name === "string" && typeof node.state.type === "string"
      ? { name: node.state.name, type: node.state.type }
      : null;
  const priority = typeof node?.priority === "number" ? node.priority : null;
  const project =
    node?.project && typeof node.project.name === "string" ? node.project.name : null;
  const estimate = typeof node?.estimate === "number" ? node.estimate : null;
  return { state, priority, project, estimate };
}

// parseLabels — extracts labels array from a Linear issue node.
// Returns Array<{name, color}> on success, null on any failure.
function parseLabels(node) {
  try {
    const nodes = node?.labels?.nodes;
    if (!Array.isArray(nodes)) return null;
    const labels = [];
    for (const l of nodes) {
      if (typeof l?.name === "string") {
        labels.push({ name: l.name, color: typeof l.color === "string" ? l.color : "#8d8d8d" });
      }
    }
    return labels;
  } catch {
    return null;
  }
}

// parseRelations — maps Linear relations + inverseRelations onto our RelationMap.
// Linear relation type values: "blocks", "duplicate", "related".
//
//   relations[{type:"blocks", relatedIssue:{...}}]        → this ticket blocks Y → blocks[]
//   inverseRelations[{type:"blocks", issue:{...}}]         → Z blocks this ticket → blockedBy[]
//   relations[{type:"duplicate", relatedIssue:{...}}]     → duplicateOf[]
//   relations[{type:"related"}] + inverseRelations[{type:"related"}] → related[] (deduped by identifier)
//
// B3: arrays are now RelationTarget[] (with identifier, title, state, priority, project)
// rather than plain string[]. Returns RelationMap on success (empty arrays are fine),
// null on any failure.
function parseRelations(node) {
  try {
    const fwd = node?.relations?.nodes;
    const inv = node?.inverseRelations?.nodes;
    if (!Array.isArray(fwd) && !Array.isArray(inv)) return null;

    const blocks = [];
    const blockedBy = [];
    const duplicateOf = [];
    // Dedup related by identifier (Set of identifiers, keep first-seen target).
    const relatedByIdentifier = new Map();

    for (const r of Array.isArray(fwd) ? fwd : []) {
      const target = parseRelationIssue(r?.relatedIssue);
      if (!target) continue;
      if (r.type === "blocks") blocks.push(target);
      else if (r.type === "duplicate") duplicateOf.push(target);
      else if (r.type === "related") {
        if (!relatedByIdentifier.has(target.identifier)) {
          relatedByIdentifier.set(target.identifier, target);
        }
      }
    }

    for (const r of Array.isArray(inv) ? inv : []) {
      const target = parseRelationIssue(r?.issue);
      if (!target) continue;
      if (r.type === "blocks") blockedBy.push(target);
      else if (r.type === "related") {
        if (!relatedByIdentifier.has(target.identifier)) {
          relatedByIdentifier.set(target.identifier, target);
        }
      }
    }

    return {
      blockedBy,
      blocks,
      related: Array.from(relatedByIdentifier.values()),
      duplicateOf,
    };
  } catch {
    return null;
  }
}

// NULL_ENTRY — the fail-open value stored when a fetch fails or ID not found.
// B3: gains state/priority/project/estimate fields; ttlMs defaults to 5m.
const NULL_ENTRY = {
  title: null,
  description: null,
  labels: null,
  relations: null,
  state: null,
  priority: null,
  project: null,
  estimate: null,
  // CTL-1806: provenance for the detail route's `source` field. "replica" = served
  // from the local replica, "linear" = served by the degraded Linear fetch, null =
  // nothing served it. A user-facing field must not report "linear-live" for a read
  // that never touched Linear.
  source: null,
};

// ttlForState — D4's cache-lifetime decision, hoisted so the replica tier and the
// Linear tier can never disagree about it. Terminal tickets (completed/canceled)
// hold for 24h; everything else 5 min. This is exactly why the replica tier must
// carry a `state.type` rather than omitting it: dropping the type would move
// every terminal ticket (measured: 2725 of 3887) from a 24h to a 5-min cache — a
// quota REGRESSION inside a quota-reduction change.
function ttlForState(state) {
  return state?.type === "completed" || state?.type === "canceled"
    ? DONE_TTL_MS
    : TITLE_DESC_TTL_MS;
}

// fillTitleDescriptionFallback — given an array of ticket IDs, enrich each with
// { title, description, labels, relations, state, priority, project, estimate }.
//
// - Hits are served from _titleDescCache (5-min TTL; 24h for terminal tickets).
// - Remaining IDs are served from the LOCAL REPLICA (CTL-1806).
// - Only genuine replica misses are batched into a Linear GraphQL call per
//   team-chunk, and each such call emits a `catalyst.linear.read` anomaly.
// - Null values are stored for IDs nothing returned (not found), so a subsequent
//   call within the TTL does not re-fetch.
// - Always resolves; never rejects (fail-open).
//
// CTL-1806 subtraction: the old "array of objects, mutate in place" mode
// (`isObjectArray`) is gone. It had ZERO production callers — board-data passes
// `nullTitleIds` (strings from collectNullTitleIds) and server.ts passes
// `[ticket]` (a string) — and the .d.mts already typed the parameter `string[]`.
export async function fillTitleDescriptionFallback(ticketIds, { replicaOptions = {} } = {}) {
  const ids = Array.isArray(ticketIds) ? ticketIds : [];

  const result = {};
  const toFetch = [];
  const now = Date.now();

  for (const id of ids) {
    const cached = _titleDescCache.get(id);
    if (cached !== undefined && now - cached.ts < (cached.ttlMs ?? TITLE_DESC_TTL_MS)) {
      result[id] = {
        title: cached.title,
        description: cached.description,
        labels: cached.labels,
        relations: cached.relations,
        state: cached.state ?? null,
        priority: cached.priority ?? null,
        project: cached.project ?? null,
        estimate: cached.estimate ?? null,
        source: cached.source ?? null,
      };
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) return result;

  // ── Tier 1: the LOCAL replica (CTL-1806) ───────────────────────────────────
  // Serves title, description, labels (with colour), relations (with enriched
  // targets), state, priority, project and estimate — the entire payload both
  // callers consume. FILE-PRESENCE gate only, fail-open: an absent/unreadable
  // replica yields {} and every id proceeds to the degraded path as before.
  //
  // A hit requires a NON-EMPTY title (the primitive omits anything less), so a
  // replica row that could not actually populate the detail page still falls
  // through to Linear rather than being cached as a hollow "available" entry.
  //
  // Note on the BOARD caller specifically: board-data already filters its ids
  // through readReplicaTitles, so the set it passes here is precisely the ids the
  // replica could NOT title — which means this read will miss for all of them.
  // That is one extra local SQLite query over a usually-empty set (the resolver
  // is not called at all when nothing is null-titled), and it is the price of
  // putting the tier INSIDE the resolver, which is what gives the ticket-detail
  // route and its relation targets a replica tier at all.
  const replicaHits = await readReplicaTicketDetails({ ids: toFetch, ...replicaOptions });
  const stillMissing = [];
  for (const id of toFetch) {
    const hit = replicaHits[id];
    if (hit && typeof hit.title === "string" && hit.title.length > 0) {
      const entry = {
        title: hit.title,
        description: hit.description ?? null,
        labels: hit.labels ?? null,
        relations: hit.relations ?? null,
        state: hit.state ?? null,
        priority: hit.priority ?? null,
        project: hit.project ?? null,
        estimate: hit.estimate ?? null,
        source: "replica",
      };
      _titleDescCache.set(id, { ...entry, ts: Date.now(), ttlMs: ttlForState(entry.state) });
      result[id] = entry;
    } else {
      stillMissing.push(id);
    }
  }
  _capTitleDescCache();
  if (stillMissing.length === 0) return result;
  // From here on, every id is a genuine REPLICA MISS — which is exactly what the
  // `linearis_miss` source on the emissions records.
  const toQuery = stillMissing;

  // Group uncached IDs by team key. IDs that don't parse are stored as nulls
  // (can't query them).
  const teamGroups = groupByTeam(toQuery);
  const unparseable = toQuery.filter((id) => parseIdentifier(id) === null);
  for (const id of unparseable) {
    _titleDescCache.set(id, { ...NULL_ENTRY, ts: Date.now(), ttlMs: TITLE_DESC_TTL_MS });
    result[id] = { ...NULL_ENTRY };
  }
  _capTitleDescCache();

  // For each team key, chunk its numbers and fire one query per chunk.
  const perTeamChunks = [];
  for (const [teamKey, numbers] of teamGroups) {
    for (let i = 0; i < numbers.length; i += BATCH_CHUNK_SIZE) {
      perTeamChunks.push({ teamKey, numbers: numbers.slice(i, i + BATCH_CHUNK_SIZE) });
    }
  }

  await Promise.allSettled(
    perTeamChunks.map(async ({ teamKey, numbers }) => {
      const data = await graphql(TITLE_DESC_QUERY_FOR_TEAM, { teamKey, numbers });
      const nodes = data?.issues?.nodes ?? [];

      // Build a set of numbers returned for this team.
      const fetchedNumbers = new Set();
      for (const node of nodes) {
        if (typeof node.number !== "number") continue;
        const returnedKey = node.team?.key?.toUpperCase() ?? teamKey;
        const id = `${returnedKey}-${node.number}`;
        const title = typeof node.title === "string" ? node.title : null;
        const description =
          typeof node.description === "string" && node.description.length > 0
            ? node.description
            : null;
        const labels = parseLabels(node);
        const relations = parseRelations(node);
        // B3: parse own-ticket meta fields.
        const { state, priority, project, estimate } = parseTicketMeta(node);
        // D4: completed/canceled tickets cached for 24h; all others 5m.
        const ttlMs = ttlForState(state);
        _titleDescCache.set(id, { title, description, labels, relations, state, priority, project, estimate, source: "linear", ts: Date.now(), ttlMs });
        result[id] = { title, description, labels, relations, state, priority, project, estimate, source: "linear" };
        fetchedNumbers.add(node.number);
      }

      // Numbers Linear did not return → honest nulls (not found).
      for (const num of numbers) {
        if (!fetchedNumbers.has(num)) {
          const id = `${teamKey}-${num}`;
          _titleDescCache.set(id, { ...NULL_ENTRY, ts: Date.now(), ttlMs: TITLE_DESC_TTL_MS });
          result[id] = { ...NULL_ENTRY };
        }
      }
      _capTitleDescCache();
    }),
  );

  // Any ID that fail-open dropped (graphql null → no nodes loop ran for its
  // chunk) still needs an honest entry. Backfill from the cache or as null.
  for (const id of toQuery) {
    if (result[id] === undefined) {
      const cached = _titleDescCache.get(id);
      if (cached !== undefined) {
        result[id] = {
          title: cached.title,
          description: cached.description,
          labels: cached.labels,
          relations: cached.relations,
          state: cached.state ?? null,
          priority: cached.priority ?? null,
          project: cached.project ?? null,
          estimate: cached.estimate ?? null,
          source: cached.source ?? null,
        };
      } else {
        _titleDescCache.set(id, { ...NULL_ENTRY, ts: Date.now(), ttlMs: TITLE_DESC_TTL_MS });
        result[id] = { ...NULL_ENTRY };
      }
    }
  }
  _capTitleDescCache();

  return result;
}

// ── Exposed for tests / webhook invalidation ──────────────────────────────────
// Allow tests to clear the cache without module reload, and the Linear webhook
// branch to drop a single ticket's entry so an edit reflects in seconds.
export function _clearTitleDescCache(id) {
  if (typeof id === "string") {
    _titleDescCache.delete(id);
  } else {
    _titleDescCache.clear();
  }
}
export function _getTitleDescCacheSize() {
  return _titleDescCache.size;
}

// _sweepTitleDescCache — CTL-1215: evict entries whose per-entry TTL has elapsed.
// The lazy TTL (in fillTitleDescriptionFallback's hit check) only fires when a
// key is re-requested; a key never read again would otherwise sit forever. A
// low-frequency setInterval in server.ts calls this so abandoned keys leave
// memory. Returns the count removed. `now` is injectable for tests.
export function _sweepTitleDescCache(now = Date.now()) {
  let removed = 0;
  for (const [id, v] of _titleDescCache) {
    if (now - v.ts >= (v.ttlMs ?? TITLE_DESC_TTL_MS)) {
      _titleDescCache.delete(id);
      removed++;
    }
  }
  return removed;
}
