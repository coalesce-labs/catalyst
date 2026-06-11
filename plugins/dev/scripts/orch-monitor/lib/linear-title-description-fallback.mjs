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
// Dependencies: none beyond node built-ins + Bun's global `fetch`.

// ── In-memory TTL cache ───────────────────────────────────────────────────────
// Keyed by ticket ID (e.g. "CTL-926"). Value:
//   { title: string|null, description: string|null,
//     labels: Array<{name,color}>|null, relations: RelationMap|null, ts: number }.
// null means we fetched and Linear returned nothing; absent means uncached.
//
// RelationMap: { blockedBy: string[], blocks: string[], related: string[], duplicateOf: string[] }
const TITLE_DESC_TTL_MS = 5 * 60 * 1000; // 5 minutes (match ESTIMATE_TTL_MS)
const _titleDescCache = new Map(); // ticketId → { title, description, labels, relations, ts }

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
const TITLE_DESC_QUERY_FOR_TEAM = `query FallbackTitleDesc($teamKey: String!, $numbers: [Float!]) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }, first: ${BATCH_CHUNK_SIZE}) {
    nodes {
      number
      title
      description
      team {
        key
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
          }
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            identifier
          }
        }
      }
    }
  }
}`;

function linearAuthHeader() {
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  if (!token) return null;
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

// graphql — one async GraphQL call via Bun's native fetch. Returns the parsed
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

// ── Title+description fallback batch fetch ────────────────────────────────────

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
//   relations[{type:"blocks", relatedIssue:{identifier}}]       → this ticket blocks Y → blocks[]
//   inverseRelations[{type:"blocks", issue:{identifier}}]        → Z blocks this ticket → blockedBy[]
//   relations[{type:"duplicate", relatedIssue:{identifier}}]    → duplicateOf[]
//   relations[{type:"related"}] + inverseRelations[{type:"related"}] → related[] (deduped)
//
// Returns RelationMap on success (empty arrays are fine), null on any failure.
function parseRelations(node) {
  try {
    const fwd = node?.relations?.nodes;
    const inv = node?.inverseRelations?.nodes;
    if (!Array.isArray(fwd) && !Array.isArray(inv)) return null;

    const blocks = [];
    const blockedBy = [];
    const duplicateOf = [];
    const relatedSet = new Set();

    for (const r of Array.isArray(fwd) ? fwd : []) {
      const id = r?.relatedIssue?.identifier;
      if (typeof id !== "string") continue;
      if (r.type === "blocks") blocks.push(id);
      else if (r.type === "duplicate") duplicateOf.push(id);
      else if (r.type === "related") relatedSet.add(id);
    }

    for (const r of Array.isArray(inv) ? inv : []) {
      const id = r?.issue?.identifier;
      if (typeof id !== "string") continue;
      if (r.type === "blocks") blockedBy.push(id);
      else if (r.type === "related") relatedSet.add(id);
    }

    return {
      blockedBy,
      blocks,
      related: Array.from(relatedSet),
      duplicateOf,
    };
  } catch {
    return null;
  }
}

// NULL_ENTRY — the fail-open value stored when a fetch fails or ID not found.
const NULL_ENTRY = { title: null, description: null, labels: null, relations: null };

// fillTitleDescriptionFallback — given an array of ticket IDs (or ticket objects
// with an `id` field), enriches each with { title, description, labels, relations }.
// When called with an array of objects, mutates each object in place AND returns
// the ID-keyed map.  When called with an array of strings, returns the map only.
//
// - Hits are served from _titleDescCache (5-min TTL).
// - Remaining IDs are batched into one Linear GraphQL call per team-chunk.
// - Null values are stored for IDs Linear returned nothing for (not found),
//   so a subsequent call within the TTL does not re-fetch.
// - Always resolves; never rejects (fail-open).
export async function fillTitleDescriptionFallback(ticketIds) {
  // Support being called with an array of objects (the board-data pattern) as
  // well as an array of string IDs (the server.ts linear-ticket route pattern).
  const isObjectArray = ticketIds.length > 0 && typeof ticketIds[0] === "object" && ticketIds[0] !== null;
  const ids = isObjectArray ? ticketIds.map((t) => t.id ?? t.ticket ?? "") : ticketIds;

  const result = {};
  const toFetch = [];
  const now = Date.now();

  for (const id of ids) {
    const cached = _titleDescCache.get(id);
    if (cached !== undefined && now - cached.ts < TITLE_DESC_TTL_MS) {
      result[id] = { title: cached.title, description: cached.description, labels: cached.labels, relations: cached.relations };
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) {
    if (isObjectArray) {
      for (const t of ticketIds) {
        const id = t.id ?? t.ticket ?? "";
        const r = result[id] ?? NULL_ENTRY;
        t.title = r.title;
        t.description = r.description;
        t.labels = r.labels;
        t.relations = r.relations;
      }
    }
    return result;
  }

  // Group uncached IDs by team key. IDs that don't parse are stored as nulls
  // (can't query them).
  const teamGroups = groupByTeam(toFetch);
  const unparseable = toFetch.filter((id) => parseIdentifier(id) === null);
  for (const id of unparseable) {
    _titleDescCache.set(id, { ...NULL_ENTRY, ts: Date.now() });
    result[id] = { ...NULL_ENTRY };
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
        _titleDescCache.set(id, { title, description, labels, relations, ts: Date.now() });
        result[id] = { title, description, labels, relations };
        fetchedNumbers.add(node.number);
      }

      // Numbers Linear did not return → honest nulls (not found).
      for (const num of numbers) {
        if (!fetchedNumbers.has(num)) {
          const id = `${teamKey}-${num}`;
          _titleDescCache.set(id, { ...NULL_ENTRY, ts: Date.now() });
          result[id] = { ...NULL_ENTRY };
        }
      }
    }),
  );

  // Any ID that fail-open dropped (graphql null → no nodes loop ran for its
  // chunk) still needs an honest entry. Backfill from the cache or as null.
  for (const id of toFetch) {
    if (result[id] === undefined) {
      const cached = _titleDescCache.get(id);
      if (cached !== undefined) {
        result[id] = { title: cached.title, description: cached.description, labels: cached.labels, relations: cached.relations };
      } else {
        _titleDescCache.set(id, { ...NULL_ENTRY, ts: Date.now() });
        result[id] = { ...NULL_ENTRY };
      }
    }
  }

  // If called with objects, mutate them in place (board-data pattern).
  if (isObjectArray) {
    for (const t of ticketIds) {
      const id = t.id ?? t.ticket ?? "";
      const r = result[id] ?? NULL_ENTRY;
      t.title = r.title;
      t.description = r.description;
      t.labels = r.labels;
      t.relations = r.relations;
    }
  }

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
