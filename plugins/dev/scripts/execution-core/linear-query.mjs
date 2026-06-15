// linear-query.mjs — execution-core Linear eligible query (CTL-535 Phase 2).
//
// Turns a resolved eligibleQuery into a `linearis issues list` invocation,
// parses the JSON, normalizes the ticket list, and applies the priority-floor
// post-filter that linearis cannot express server-side.

import { descriptorAgeMs } from "./gateway-read.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { withBreaker, linearBreaker, isRateLimitError } from "./linear-breaker.mjs";
import { withAuthRemint, linearReminter, isBatchAuthError } from "./linear-remint.mjs";

// linearis caps a single page; 200 comfortably covers a project's pickable
// set without pagination (the reconcile poll runs every 10 min anyway).
const DEFAULT_LIMIT = 200;

// CTL-784: batched multi-issue read. The Linear GraphQL endpoint, the named
// operation (so the proxy audit can tell a batch read apart from the per-ticket
// `GetIssueByIdentifier` storm), and the chunk ceiling (Linear caps a page at
// 250; one identifier yields ≤1 issue so 250 ids fit one page). The projection
// is a structural match for normalizeRelations / the dependency-graph consumers:
// state{name}, labels{nodes{name}}, relations{nodes{type relatedIssue{identifier}}},
// inverseRelations{nodes{type issue{identifier}}}.
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const BATCH_CHUNK_SIZE = 250;
const BATCH_QUERY = `query CtlBatchTickets($ids: [ID!]) {
  issues(filter: { id: { in: $ids } }, first: ${BATCH_CHUNK_SIZE}) {
    nodes {
      identifier
      priority
      state { name }
      parent { identifier }
      labels(first: 50) { nodes { name } }
      relations(first: 100) { nodes { type relatedIssue { identifier } } }
      inverseRelations(first: 100) { nodes { type issue { identifier } } }
    }
  }
}`;

// buildLinearisArgs — argv for `linearis issues list`. `--status` requires
// `--team` (linearis/SKILL.md), so a null team is unsatisfiable and throws.
// `--priority` is deliberately NOT passed: priority is a client-side floor
// filter (keep more-urgent-or-equal), not a server-side equality match.
export function buildLinearisArgs(query) {
  if (!query.team) {
    throw new Error("eligibleQuery.team is required (linearis --status requires --team)");
  }
  const args = [
    "issues",
    "list",
    "--team",
    query.team,
    "--status",
    query.status,
    "--limit",
    String(DEFAULT_LIMIT),
  ];
  if (query.project) args.push("--project", query.project);
  if (query.label) args.push("--label", query.label);
  return args;
}

// rawExec — thin spawnSync wrapper. Injected in tests so no test ever
// shells out to the real linearis CLI or touches the network.
function rawExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) {
    return { code: 127, stdout: "", stderr: res.error.message };
  }
  return {
    code: res.status ?? 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// defaultExec — rawExec behind the CTL-679 process-wide rate-limit breaker. The
// eligible poll and per-ticket reads short-circuit without spawning linearis
// while the breaker is open. Shared singleton with linear-write.mjs so a 429 on
// the write path also pauses reads (and vice-versa). CTL-785: withAuthRemint
// interposes under the breaker — an open breaker still short-circuits before any
// spawn (including the remint retry).
const defaultExec = withBreaker(withAuthRemint(rawExec));

// normalizeTicket — flatten linearis's nested shape into a stable record.
// `state` and `project` arrive as `{ name }` objects from the Linear API;
// a missing `priority` normalizes to 0 ("No priority", the least urgent).
//
// CTL-536: `createdAt` feeds the pull-loop scheduler's priority tie-break;
// `relations` / `inverseRelations` feed analyzeDependencyGraph
// (lib/dependency-graph.mjs). Relations default to an empty node list so the
// graph builder can read `.nodes` unconditionally. Relation capture depends on
// `linearis issues list` emitting them — if it omits relations the graph
// simply sees no edges and the scheduler degrades to `ready == eligible`.
function normalizeTicket(node) {
  return {
    identifier: node.identifier ?? null,
    title: node.title ?? null,
    state: node.state?.name ?? node.state ?? null,
    priority: typeof node.priority === "number" ? node.priority : 0,
    // CTL-957: Linear numeric estimate (story points). null when unset.
    estimate: typeof node.estimate === "number" ? node.estimate : null,
    project: node.project?.name ?? node.project ?? null,
    updatedAt: node.updatedAt ?? null,
    createdAt: node.createdAt ?? null,
    // CTL-878: the parent epic identifier (or null). buildDependencyEdges drops a
    // `blocks` edge whose source is the target's parent — a Linear parent/child
    // hierarchy link is NOT a dependency, so a never-worked tracking epic must not
    // deadlock its own children. `linearis issues list` emits `parent { identifier }`.
    parent: node.parent?.identifier ?? node.parent ?? null,
    relations: node.relations ?? { nodes: [] },
    inverseRelations: node.inverseRelations ?? { nodes: [] },
  };
}

// fetchTicketState — the current Linear workflow-state name of one ticket, or
// null on any failure (the D5 caller fails safe: a null state holds the
// dependent back). Wraps `linearis issues read <identifier>`; linearis emits
// JSON by default (its CLI header: "CLI for Linear.app with JSON output") so
// there is NO --json flag to pass. Used to hydrate out-of-set blocker states
// the bulk eligible query cannot see. CTL-565 D5.
// CTL-634: an opt-in `cache` (createTicketStateCache) deduplicates the
// per-tick re-reads the scheduler issues for the same out-of-set blocker.
// Consult before exec; populate only on a successful, non-null parse. A
// failed/unparseable read is NEVER cached so the D5 fail-safe re-reads next
// tick. The param is opt-in — callers that omit it exec on every call exactly
// as before.
// ─── gateway read-path (CTL-823, Gateway L1 child c) ────────────────────────
// The durable broker descriptor store (gateway-read.mjs) serves the hot read
// paths. Freshness windows: EXISTENCE decays only via a missed remove webhook
// (the reconcile backstop's gap), so the exists short-circuit tolerates
// 10 min; STATE changes constantly, so it gets the same 60s the in-memory
// cache uses. The store is a safe optimization, never the source of truth —
// every destructive decision still pays a live read.
const GATEWAY_EXISTS_FRESH_MS = 10 * 60_000;
const GATEWAY_STATE_FRESH_MS = 60_000;

export function fetchTicketState(
  identifier,
  { exec = defaultExec, cache, gateway, gatewayFreshMs = GATEWAY_STATE_FRESH_MS } = {}
) {
  if (cache) {
    const cached = cache.get(identifier);
    if (cached !== undefined) return cached; // hit
  }
  if (gateway) {
    const d = gateway.getDescriptor(identifier);
    if (
      d &&
      !d.removed &&
      d.state != null &&
      descriptorAgeMs(d) <= gatewayFreshMs
    ) {
      if (cache) cache.set(identifier, d.state); // warm the in-memory tier too
      return d.state;
    }
  }
  const { code, stdout } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return null; // fail-safe — not cached
  try {
    const node = JSON.parse(stdout);
    const state = node?.state?.name ?? node?.state ?? null;
    if (cache && state != null) cache.set(identifier, state); // populate on success only
    return state;
  } catch {
    return null; // unparseable — not cached
  }
}

// fetchTicketRelations — the CTL-755 admission gate's single-read hydration of
// one triaged-waiting candidate: its live workflow state, parent epic, dependency
// edges, priority, and labels, all parsed from ONE `linearis issues read <id>`. The
// returned descriptor mirrors normalizeTicket (above) so the same
// buildDependencyEdges / analyzeDependencyGraph / computeReadySet consume it:
//   { state, parent, relations, inverseRelations, priority, labels }
// - state: node.state.name (or a flat string `state`), or null when absent.
// - relations / inverseRelations: default { nodes: [] } so the graph builder
//   reads `.nodes` unconditionally. VERIFIED (ADV-1277): the single-ticket read
//   returns populated relations.nodes (blocks→ADV-1280) and inverseRelations.nodes
//   (blocks←ADV-1276, i.e. the blocked-by edge the dependency graph reads).
// - priority: node.priority when numeric, else null. An explicit 0 ("No priority")
//   is kept as 0 (fidelity to the source), NOT coerced to null. Note 0 and null
//   rank IDENTICALLY — scheduler-rank.priorityRank floors any non-1..4 value to
//   band 5 — so this distinction does not affect selection; it only differs from
//   normalizeTicket's eligible-set default (missing → 0) by recording a missing
//   priority as "unknown" (null) rather than "lowest" (0).
// - labels: node.labels.nodes[].name (or []), so STEP A can diff the held
//   indicator (blocked/waiting) without a second read.
// Returns null on a non-zero exit or unparseable stdout — the STEP-A caller
// fails SAFE (treats the candidate as held / non-terminal) just like the D5
// fetchTicketState contract.
//
// CTL-784 read-through: the opt-in `cache` is the SAME createTicketStateCache
// fetchTicketState uses, now with a relations store (getRelations/setRelations).
// fetchTicketRelations READS that store first (the gap the CTL-784 handoff
// identified: the old code WROTE the state cache but never read relations, so
// the admission pool re-read every tick regardless of TTL). A relations hit
// returns the cached descriptor (state overlaid fresh from the monitor
// write-through) with NO exec. The miss path is the live `linearis issues read`,
// which then populates BOTH the relations store and (via setRelations priming)
// the string-state store, so a subsequent fetchTicketState(id, { cache }) hits.
export function fetchTicketRelations(identifier, { exec = defaultExec, cache } = {}) {
  if (cache) {
    const hit = cache.getRelations?.(identifier);
    if (hit !== undefined) return hit; // read-through hit — no exec
  }
  const { code, stdout } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return null; // fail-safe — not cached
  try {
    const desc = normalizeRelations(JSON.parse(stdout));
    if (cache && desc.state != null) cache.setRelations?.(identifier, desc); // read-through + prime state
    return desc;
  } catch {
    return null; // unparseable — not cached
  }
}

// normalizeRelations — flatten one issue node (from `linearis issues read` OR
// the batched GraphQL query — both return the same nested shape) into the
// descriptor the admission gate consumes: { state, parent, relations,
// inverseRelations, priority, labels }. NOTE: deliberately does NOT include
// `identifier` so fetchTicketRelations and fetchTicketsBatch stay the SAME shape
// (callers and tests rely on it); fetchTicketsBatch keys its Map on
// node.identifier separately. A missing priority normalizes to null ("unknown"),
// matching fetchTicketRelations (NOT normalizeTicket's eligible-set default of 0).
function normalizeRelations(node) {
  return {
    state: node?.state?.name ?? node?.state ?? null,
    // CTL-878: parent epic identifier (or null). Carried so the admission gate's
    // buildDependencyEdges can drop a parent→child `blocks` edge AND STEP E can
    // skip persisting a child→parent blocked_by (a parent/child hierarchy link is
    // not a dependency). Both `linearis issues read` and the batch GraphQL query
    // emit `parent { identifier }`.
    parent: node?.parent?.identifier ?? node?.parent ?? null,
    relations: node?.relations ?? { nodes: [] },
    inverseRelations: node?.inverseRelations ?? { nodes: [] },
    priority: typeof node?.priority === "number" ? node.priority : null,
    labels: node?.labels?.nodes?.map((n) => n.name) ?? [],
  };
}

// authHeader — CTL-784. Linear's documented contract: an OAuth access token
// (the daemon's app-actor token, minted client_credentials, prefix `lin_oauth_`)
// is sent `Authorization: Bearer <token>` — matching lib/linear-comment-post.sh
// which posts as the SAME app-actor; a personal API key (`lin_api_`) is sent raw.
// (Empirically Linear accepts an OAuth token both ways, but Bearer is the
// contract + future-proof, and personal keys must stay raw — Bearer may be
// rejected for them.) Exported for unit coverage of the otherwise prod-only path.
export function authHeader(token = "") {
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

// isBatchRateLimited — a GraphQL errors[] signals a rate/complexity limit either
// via extensions.code === "RATELIMITED" (Linear's complexity/soft limit, served
// HTTP 400 not 429) OR a rate-limit message. Either must open the CTL-679 breaker
// so the larger batch payload backs off instead of re-firing every tick.
// Exported for unit coverage.
// CTL-785: isBatchAuthError is imported from linear-remint.mjs and re-exported
// here so callers that already depend on linear-query.mjs can access it without
// a direct dependency on linear-remint.mjs.
export { isBatchAuthError } from "./linear-remint.mjs";
export function isBatchRateLimited(errors) {
  return (errors ?? []).some(
    (e) => e?.extensions?.code === "RATELIMITED" || isRateLimitError(e?.message),
  );
}

// buildBatchCurlArgs — CTL-784. The curl argv + stdin payload for ONE batched
// GraphQL POST. Exported so the auth scheme, `--cacert` gating, and projection
// are unit-tested (the live spawn path is otherwise prod-only). `--cacert` is
// added only when NODE_EXTRA_CA_CERTS points at a real file (the mitmproxy audit:
// curl then trusts the MITM CA and the inherited HTTPS_PROXY routes the call so
// it is captured as `query CtlBatchTickets`); production (no proxy) goes direct.
export function buildBatchCurlArgs(ids, { token = "", ca } = {}) {
  const payload = JSON.stringify({ query: BATCH_QUERY, variables: { ids } });
  const caArgs = ca && existsSync(ca) ? ["--cacert", ca] : [];
  const args = [
    "-sS",
    "--max-time",
    "30",
    ...caArgs,
    "-X",
    "POST",
    LINEAR_GRAPHQL_ENDPOINT,
    "-H",
    `Authorization: ${authHeader(token)}`,
    "-H",
    "Content-Type: application/json",
    "-w",
    "\n%{http_code}",
    "--data",
    "@-", // read the payload from stdin (no argv length limit / shell escaping)
  ];
  return { args, payload };
}

// runBatchOnce — executes ONE curl GraphQL POST and classifies the result.
// Returns { nodes, auth, ratelimit, curlFailed }. Never throws. Internal to
// defaultBatchExec; extracted so the auth-retry path can call it a second time.
function runBatchOnce(ids) {
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  const { args, payload } = buildBatchCurlArgs(ids, { token, ca: process.env.NODE_EXTRA_CA_CERTS });
  const res = spawnSync("curl", args, { input: payload, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    return { nodes: null, auth: false, ratelimit: false, curlFailed: true };
  }
  const out = res.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  const httpCode = Number(out.slice(nl + 1).trim());
  const body = out.slice(0, Math.max(0, nl));
  if (httpCode === 401) {
    return { nodes: null, auth: true, ratelimit: false, curlFailed: false };
  }
  if (httpCode === 429) {
    return { nodes: null, auth: false, ratelimit: true, curlFailed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { nodes: null, auth: false, ratelimit: false, curlFailed: false };
  }
  if (parsed?.errors) {
    const auth = isBatchAuthError(parsed.errors);
    const ratelimit = !auth && isBatchRateLimited(parsed.errors);
    return { nodes: null, auth, ratelimit, curlFailed: false };
  }
  return { nodes: parsed?.data?.issues?.nodes ?? [], auth: false, ratelimit: false, curlFailed: false };
}

// defaultBatchExec — CTL-784. ONE synchronous GraphQL POST (via curl, to keep
// the scheduler tick synchronous — making the tick async would break the
// no-overlapping-tick invariant) returning the issues nodes array, or null on
// any failure (caller fails safe). Integrated with the SAME process-wide circuit
// breaker as the per-ticket reads: an open breaker short-circuits without
// spawning; a 429 (HTTP) or a RATELIMITED GraphQL error body opens it; a clean
// response closes it. Auth uses LINEAR_API_TOKEN/LINEAR_API_KEY (the daemon
// exports the orchestrator app-actor token, CTL-785).
// CTL-785: an expired app-actor token serves 401 (HTTP) or AUTHENTICATION_ERROR
// (GraphQL, HTTP 400). One remint attempt + one retry; cooldown bounds storms.
function defaultBatchExec(ids) {
  if (linearBreaker.isOpen()) return null; // circuit-open → skip, no spawn
  let r = runBatchOnce(ids);
  if (r.auth && linearReminter.attempt()) r = runBatchOnce(ids);
  if (r.ratelimit) { linearBreaker.recordRateLimited(); return null; }
  if (r.nodes == null) return null; // auth-after-retry, curlFailed, or unparseable
  linearBreaker.recordSuccess();
  return r.nodes;
}

// fetchTicketsBatch — CTL-784 THE root fix. Resolve the relation descriptors for
// a SET of identifiers in ONE request instead of N per-ticket reads. Returns a
// Map<identifier, descriptor> (descriptor = normalizeRelations shape). Cache-
// first: identifiers already in the relations read-through store are served from
// cache; only the MISSES are fetched, chunked at ≤250. An identifier that the
// query does not return (not-found / dropped) is ABSENT from the Map so the
// caller fails safe (treats it as held / unfetched), exactly like a null
// fetchTicketRelations. `exec` is the injection seam (defaults to the curl
// batch exec); tests inject a fake `(ids) => nodes[]` so no test shells out.
export function fetchTicketsBatch(identifiers, { exec = defaultBatchExec, cache } = {}) {
  const ids = [...new Set((identifiers ?? []).filter(Boolean))];
  const result = new Map();
  if (ids.length === 0) return result;

  const misses = [];
  for (const id of ids) {
    const hit = cache?.getRelations?.(id);
    if (hit !== undefined) result.set(id, hit);
    else misses.push(id);
  }

  for (let i = 0; i < misses.length; i += BATCH_CHUNK_SIZE) {
    const chunk = misses.slice(i, i + BATCH_CHUNK_SIZE);
    const nodes = exec(chunk);
    if (nodes == null) continue; // batch failed → those ids stay absent (fail-safe)
    for (const node of nodes) {
      const id = node?.identifier;
      if (!id) continue;
      const desc = normalizeRelations(node);
      result.set(id, desc);
      if (cache && desc.state != null) cache.setRelations?.(id, desc);
    }
    // ids in the chunk not returned by the query stay absent → fail-safe hold.
  }
  return result;
}

// readTicketLabels — richer label reader returning { ok, labels, code, stderr }.
// CTL-1078: allows callers (removeLabel) to classify auth vs transient failures
// from the read-step stderr rather than collapsing all failures to null.
// The shape `labels.nodes[].name` is the Linear API contract.
export function readTicketLabels(identifier, { exec = defaultExec } = {}) {
  const { code, stdout, stderr } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return { ok: false, labels: null, code, stderr: stderr ?? "" };
  try {
    const node = JSON.parse(stdout);
    const labels = node?.labels?.nodes?.map((n) => n.name) ?? [];
    return { ok: true, labels };
  } catch {
    return { ok: false, labels: null, code, stderr: stderr ?? "" };
  }
}

// fetchTicketLabels — back-compat wrapper around readTicketLabels. Returns the
// label array on success or null on any failure. Existing callers unchanged.
// CTL-587: used by linear-write.mjs::applyLabel for the verify-write-landed
// step. null is the "did not land — retry next tick" signal.
export function fetchTicketLabels(identifier, { exec = defaultExec } = {}) {
  return readTicketLabels(identifier, { exec }).labels;
}

// readTicketLabelNodes — like readTicketLabels but preserves the { id, name }
// node shape so callers (removeLabel, CTL-1085) can build a write payload from
// ticket-native label UUIDs. Using UUIDs read off the ticket itself avoids the
// cross-team name-resolution ambiguity that makes name-based overwrites fail on
// ADV tickets whose label names collide with CTL-team label names.
export function readTicketLabelNodes(identifier, { exec = defaultExec } = {}) {
  const { code, stdout, stderr } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return { ok: false, nodes: null, code, stderr: stderr ?? "" };
  try {
    const node = JSON.parse(stdout);
    const nodes =
      node?.labels?.nodes?.map((n) => ({ id: n.id, name: n.name })) ?? [];
    return { ok: true, nodes };
  } catch {
    return { ok: false, nodes: null, code, stderr: stderr ?? "" };
  }
}

// classifyTicketResolution — CTL-671 3-valued phantom probe. Distinguishes a
// DEFINITIVELY non-existent ticket (clean exit 0, empty/null node) from a
// TRANSIENT failure (nonzero exit: auth/network/rate-limit/not-found — all
// indistinguishable). Only "not-found" may trigger quarantine; "unknown" is the
// fail-safe that re-checks next tick. Sibling to fetchTicketState, which
// conflates both as null (line ~86) — existing callers are unchanged.
//
// SAFETY: the only path to "not-found" is a DEFINITIVE missing-ticket signal.
// Everything ambiguous (nonzero exit, unparseable, or a non-"not found" error
// body) returns "unknown" so a Linear outage never quarantines a real ticket.
//
// OBSERVED CONTRACT (CTL-671, verified against the real CLI 2026-05-27):
// `linearis issues read CTL-9` for a MISSING ticket exits **0** (not nonzero!)
// with body `{"error": "Issue with identifier \"CTL-9\" not found"}`. A real
// ticket exits 0 with `{"identifier": "...", "id": "...", ...}`. So the
// discriminator is the BODY, not the exit code: a "not found" error string is
// the definitive not-found; any other error body (auth/network/rate-limit) is
// transient → unknown.
export function classifyTicketResolution(
  identifier,
  { exec = defaultExec, gateway, gatewayFreshMs = GATEWAY_EXISTS_FRESH_MS } = {}
) {
  // CTL-823: serve ONLY the cheap not-quarantine verdict from the durable
  // store — a fresh, present, not-removed descriptor proves existence.
  // removed/absent/stale NEVER short-circuit: quarantine is a destructive
  // write, so those verdicts always pay a fresh live read
  // (fresh-before-quarantine).
  if (gateway) {
    const d = gateway.getDescriptor(identifier);
    if (d && !d.removed && descriptorAgeMs(d) <= gatewayFreshMs) return "exists";
  }
  const { code, stdout } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return "unknown"; // nonzero is ambiguous — NEVER not-found
  let node;
  try {
    node = JSON.parse(stdout);
  } catch {
    return "unknown"; // unparseable — fail safe, re-check next tick
  }
  if (node == null) return "not-found";
  // The real missing-ticket shape: exit 0 + { error: "...not found" }. Only a
  // "not found" error is definitive; any other error body is transient.
  if (typeof node.error === "string") {
    return /not\s*found/i.test(node.error) ? "not-found" : "unknown";
  }
  const id = node?.identifier ?? node?.id ?? null;
  return id ? "exists" : "not-found";
}

// fetchTicketAssignee — the CTL-781 respect-assignment read: the ticket's
// current assignee UUID (or null = unassigned), gateway-first so the hot
// new-work predicate is rate-free, live `linearis issues read` on a miss.
// Tri-state return so callers can distinguish "known unassigned" from
// "couldn't read": { known: true, assignee: string|null } | { known: false }.
// A not-removed descriptor is trusted regardless of age (the assignment gate
// is rate-free by design; a stale miss is corrected by the future Reconciler).
export function fetchTicketAssignee(identifier, { exec = defaultExec, gateway } = {}) {
  if (gateway) {
    const d = gateway.getDescriptor(identifier);
    if (d && !d.removed) return { known: true, assignee: d.assignee ?? null };
  }
  const { code, stdout } = exec("linearis", ["issues", "read", identifier]);
  if (code !== 0) return { known: false };
  try {
    const node = JSON.parse(stdout);
    return { known: true, assignee: node?.assignee?.id ?? null };
  } catch {
    return { known: false };
  }
}

// isAssigneeClaimable — the CTL-781 rule-set predicate: a ticket is the
// daemon's to claim iff assignee ∈ {null, bot}. Pure; shared by the scheduler
// new-work pull, the monitor triage one-shot, and (future) the CTL-780
// staleness sweep.
export function isAssigneeClaimable(assignee, botUserIds) {
  if (assignee == null) return true;
  return botUserIds instanceof Set && botUserIds.has(assignee);
}

// CTL-1173: raw GraphQL read for Issue.delegate.id — Linear routes an app-user
// UUID to delegate (not assignee), so linearis issues read never exposes it.
// Mirrors the buildBatchCurlArgs / runBatchOnce pattern: one spawnSync curl POST,
// same --cacert gating, same auth/rate classification.
// IssueFilter has no `identifier` field — filter by team key + number parsed
// from the identifier (e.g. "CTL-1160" → team "CTL", number 1160).
const DELEGATE_QUERY = `query IssueDelegate($team: String!, $num: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $num } }) { nodes { delegate { id } } }
}`;

export function buildDelegateCurlArgs(identifier, { token = "", ca } = {}) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier ?? "");
  const variables = m ? { team: m[1], num: Number(m[2]) } : { team: String(identifier ?? ""), num: 0 };
  const payload = JSON.stringify({ query: DELEGATE_QUERY, variables });
  const caArgs = ca && existsSync(ca) ? ["--cacert", ca] : [];
  const args = [
    "-sS",
    "--max-time",
    "30",
    ...caArgs,
    "-X",
    "POST",
    LINEAR_GRAPHQL_ENDPOINT,
    "-H",
    `Authorization: ${authHeader(token)}`,
    "-H",
    "Content-Type: application/json",
    "-w",
    "\n%{http_code}",
    "--data",
    "@-",
  ];
  return { args, payload };
}

function runDelegateOnce(identifier) {
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  const { args, payload } = buildDelegateCurlArgs(identifier, { token, ca: process.env.NODE_EXTRA_CA_CERTS });
  const res = spawnSync("curl", args, { input: payload, encoding: "utf8" });
  if (res.status !== 0) return { nodes: null };
  const out = res.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  const httpCode = Number(out.slice(nl + 1).trim());
  const body = out.slice(0, Math.max(0, nl));
  if (httpCode === 401 || httpCode === 429) return { nodes: null };
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { nodes: null }; }
  if (parsed?.errors) {
    if (isBatchAuthError(parsed.errors) || isBatchRateLimited(parsed.errors)) return { nodes: null };
    return { nodes: null };
  }
  return { nodes: parsed?.data?.issues?.nodes ?? null };
}

export function fetchTicketDelegate(identifier, { runQuery = runDelegateOnce } = {}) {
  const { nodes } = runQuery(identifier);
  if (nodes == null) return { known: false };
  return { known: true, delegate: nodes[0]?.delegate?.id ?? null };
}

// runEligibleQuery — run the query, parse + normalize, apply the priority
// floor. A non-zero linearis exit THROWS (never a silent []): a silent empty
// would let one failed poll flatten a project's eligible set to zero. The
// caller (Phase 4 reconcile) catches the throw and preserves the prior set.
export function runEligibleQuery(query, { exec = defaultExec } = {}) {
  const { code, stdout, stderr } = exec("linearis", buildLinearisArgs(query));
  if (code !== 0) {
    throw new Error(`linearis issues list failed (exit ${code}): ${(stderr || "").trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`linearis stdout is not JSON: ${err.message}`);
  }
  let tickets = (parsed.nodes ?? []).map(normalizeTicket);
  // Priority is a floor: keep tickets whose priority is more-urgent-or-equal
  // (1=Urgent … 4=Low). 0 ("No priority") is always below any floor.
  if (query.priority != null) {
    tickets = tickets.filter((t) => t.priority >= 1 && t.priority <= query.priority);
  }
  return tickets;
}
