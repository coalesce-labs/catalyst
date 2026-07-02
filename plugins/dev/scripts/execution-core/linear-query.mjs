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

// CTL-1339: per-call wall-clock cap for the HOT per-signal terminal reads
// (phantom-sweep classifyTicketResolution + recovery/reclaim fetchTicketState tier-3).
// A linearis read that stalls under a Linear 429 would otherwise block the
// synchronous scheduler tick its full ~30s wall-clock. Timed-out read fails SAFE
// (-> code 127 -> classifyTicketResolution "unknown" / fetchTicketState null).
// env CATALYST_LINEARIS_TERMINAL_TIMEOUT_MS: default 8000; "0" disables (no cap).
// Opt-in ONLY: applied to exactly the two terminal reads, NOT the eligible-list
// poll (a blanket cap would trip false monitor.reconcile.failing alerts) or any
// other linearis call.
// parseTerminalTimeoutMs — pure env-parse, exported for unit coverage of the
// default/disable contract (8000 default; "0" → undefined = no cap).
export function parseTerminalTimeoutMs(raw) {
  if (raw === "0") return undefined;
  const n = Number(raw);
  return n > 0 ? n : 8000;
}
const LINEARIS_TERMINAL_READ_TIMEOUT_MS = parseTerminalTimeoutMs(
  process.env.CATALYST_LINEARIS_TERMINAL_TIMEOUT_MS,
);

// CTL-1364: DEFAULT Node `timeout` for the capped rawExec/linearis spawns — not
// just the two CTL-1339 opt-in hot terminal reads. OTEL flagged rawExec (the
// shared spawnSync behind the hot linearis reads: recovery-filter, reclaim-sweep,
// phantom-probe, assignee-read) as having NO Node timeout, so a single 429-stalled
// `linearis` call could block the synchronous scheduler tick its full ~30s
// wall-clock with no per-call cap. This default caps those at once. It is a FLOOR
// applied only when a caller did NOT pass an explicit { timeoutMs } AND did NOT
// opt OUT via { uncapped: true } — so the CTL-1339 opt-in path (which passes its
// own 8000) is untouched (no double-cap: the caller's value wins), and the
// CTL-1341 timedOut/breaker-trip semantics are identical regardless of which
// timeout supplied the value.
// CTL-1364 SCOPING (regression fix): the eligible-list poll (runEligibleQuery)
// and other non-hot readers (fetchTicketRelations) pass { uncapped: true } so
// they stay UNCAPPED — a slow-but-VALID 200-ticket page must NOT be SIGKILLed
// (it would open the shared breaker via res.timedOut + throw a false
// monitor.reconcile.failing alert, exactly what CTL-1339 designed against).
// Chosen consistent with CTL-1339's cap (~8s).
// env CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS: default 8000; "0" disables (no cap),
// which restores the pre-CTL-1364 uncapped behavior for an explicit escape hatch.
const RAWEXEC_DEFAULT_TIMEOUT_MS = parseTerminalTimeoutMs(
  process.env.CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS,
);

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
// CTL-1339: opt-in per-call wall-clock cap. `timeoutMs` is threaded through the
// exec chain (withBreaker → withAuthRemint → rawExec) and applied ONLY by the
// hot per-signal terminal reads; every other call omits it (uncapped, as today).
// On a `timeout` fire spawnSync sets res.error (ETIMEDOUT) + res.status === null,
// so the existing res.error branch returns { code: 127 } — the same fail-safe a
// missing binary produces, which callers already treat as unknown/null.
function rawExec(cmd, args, { timeoutMs, uncapped } = {}) {
  const opts = { encoding: "utf8" };
  // CTL-1364 regression fix: an explicit `{ uncapped: true }` sentinel opts the
  // call OUT of the default floor entirely — NO Node timeout is applied. This
  // preserves CTL-1339's deliberate scoping: the eligible-list poll
  // (runEligibleQuery) and other non-hot readers (fetchTicketRelations) must stay
  // UNCAPPED, because a slow-but-VALID `linearis issues list --limit 200` (a
  // 200-ticket page + delegate batch, genuinely heavier than a single
  // `issues read` and plausibly >8s under load WITHOUT a 429) would otherwise be
  // SIGKILLed at the floor → res.timedOut → withBreaker opens the PROCESS-WIDE
  // breaker (pausing ALL Linear reads AND writes) AND runEligibleQuery throws →
  // a false monitor.reconcile.failing.<TEAM> alert. The floor is for the HOT
  // per-signal terminal reads only.
  if (uncapped === true) {
    const res = spawnSync(cmd, args, opts);
    if (res.error) {
      const timedOut = res.error.code === "ETIMEDOUT" || res.signal === "SIGKILL";
      return { code: 127, stdout: "", stderr: res.error.message, timedOut };
    }
    return {
      code: res.status ?? 0,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  }
  // CTL-1364: an explicit POSITIVE per-call timeoutMs (CTL-1339 opt-in) WINS;
  // otherwise fall back to the rawExec default floor so EVERY (capped) linearis
  // spawn is capped, not just the two hot terminal reads. No double-cap: when
  // CTL-1339 passes its own 8000 that value is used verbatim (the floor never
  // stacks). A caller passing 0 / undefined (e.g. CATALYST_LINEARIS_TERMINAL_TIMEOUT_MS=0
  // resolves LINEARIS_TERMINAL_READ_TIMEOUT_MS to undefined) drops to the floor —
  // so the global default still protects the tick; to fully uncap, also set
  // CATALYST_LINEARIS_DEFAULT_TIMEOUT_MS=0.
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? timeoutMs
      : RAWEXEC_DEFAULT_TIMEOUT_MS;
  if (typeof effectiveTimeoutMs === "number" && effectiveTimeoutMs > 0) {
    opts.timeout = effectiveTimeoutMs;
    opts.killSignal = "SIGKILL";
  }
  const res = spawnSync(cmd, args, opts);
  if (res.error) {
    // CTL-1341: flag a wall-clock TIMEOUT (the CTL-1339 cap fired) distinctly from
    // other spawn errors. spawnSync on timeout sets error.code "ETIMEDOUT" +
    // signal === killSignal ("SIGKILL"); a missing binary sets error.code "ENOENT"
    // with no signal. withBreaker trips the breaker on `timedOut` (a >8s read is a
    // degraded-API signal) so the rest of a multi-read pass short-circuits — but
    // NOT on ENOENT (a config error, not rate-limiting).
    const timedOut = res.error.code === "ETIMEDOUT" || res.signal === "SIGKILL";
    return { code: 127, stdout: "", stderr: res.error.message, timedOut };
  }
  return {
    code: res.status ?? 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// CTL-1339: test-only seam. rawExec is module-private (every prod caller injects
// `exec`), but the integration test must drive the REAL spawnSync path to prove
// the `timeout` option is actually wired (all stub tests bypass rawExec). Not for
// production use — callers go through defaultExec/withBreaker.
export const __rawExecForTest = rawExec;

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
    // CTL-1174: delegate defaults null from linearis (linearis cannot read delegate).
    // The batched GraphQL enrichment in runEligibleQuery overwrites this.
    delegate: node.delegate?.id ?? node.delegate ?? null,
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

// CTL-1364: optional `onExec` seam — invoked ONLY when this call falls through to the
// ACTUAL live `linearis issues read` spawn (cache MISS + replica MISS + gateway
// stale/miss). A cache/gateway/replica HIT returns early WITHOUT calling onExec, so the
// Tier-3 scheduler.op span is recorded for exactly the reads that shelled out (the
// 15s-spike drivers) and never for the cheap hits. Signature:
//   onExec({ source, execMs, code, result, timedOut })
//     source: "live" (the live exec); execMs: wall-clock of the spawn; code: exit code;
//     result: "terminal-state-name" | null (parse failure / non-zero); timedOut: bool.
// Default undefined → zero added cost (no callback). Never throws out (best-effort).
export function fetchTicketState(
  identifier,
  { exec = defaultExec, cache, gateway, replica, gatewayFreshMs = GATEWAY_STATE_FRESH_MS, onExec } = {}
) {
  if (cache) {
    const cached = cache.get(identifier);
    if (cached !== undefined) return cached; // hit — no exec, no onExec
  }
  // CTL-1340: flag-gated read-replica tier. Sits BETWEEN the in-mem cache and the
  // gateway (Tier-2) — a HIT in the local Catalyst-Cloud SQLite replica resolves
  // the state name sub-ms with no exec. fall-through-on-MISS ONLY: an undefined
  // lookup (absent/removed row, no db, any throw) FALLS THROUGH to today's
  // gateway+live path, so a MISS can never make the terminal sweep re-flag a
  // finished ticket needs-human. When no `replica` is passed (flag off) this
  // block is fully skipped → byte-identical to the pre-CTL-1340 behavior.
  if (replica) {
    const r = replica.lookup(identifier);
    if (r !== undefined) {
      if (cache && r.state) cache.set(identifier, r.state); // warm the in-mem tier (never the "" poison)
      return r.state;
    }
    // MISS → fall through to gateway + live read (today's behavior).
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
  // CTL-1339: hot per-signal terminal read — cap the wall-clock so a 429-stalled
  // linearis can't block the synchronous tier-3 reclaim/recovery read its full ~30s.
  // CTL-1364: this is the cache+gateway+replica MISS path — the ONLY place this fn
  // shells out. Time the spawn for the optional onExec span seam.
  const execStart = onExec ? Date.now() : 0;
  const { code, stdout, timedOut } = exec("linearis", ["issues", "read", identifier], {
    timeoutMs: LINEARIS_TERMINAL_READ_TIMEOUT_MS,
  });
  if (code !== 0) {
    if (onExec) {
      try {
        onExec({ source: "live", execMs: Date.now() - execStart, code, result: null, timedOut: timedOut === true });
      } catch { /* the op-span seam never throws out of the read */ }
    }
    return null; // fail-safe — not cached
  }
  try {
    const node = JSON.parse(stdout);
    const state = node?.state?.name ?? node?.state ?? null;
    if (cache && state != null) cache.set(identifier, state); // populate on success only
    if (onExec) {
      try {
        onExec({ source: "live", execMs: Date.now() - execStart, code, result: state, timedOut: timedOut === true });
      } catch { /* the op-span seam never throws out of the read */ }
    }
    return state;
  } catch {
    if (onExec) {
      try {
        onExec({ source: "live", execMs: Date.now() - execStart, code, result: null, timedOut: timedOut === true });
      } catch { /* the op-span seam never throws out of the read */ }
    }
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
  // CTL-1364 regression fix: the admission-gate relations hydration is a non-hot
  // reader (gated behind the CTL-755 cache TTL, not run per-signal per-tick), so
  // it stays UNCAPPED like the eligible poll — out of the default floor.
  const { code, stdout } = exec("linearis", ["issues", "read", identifier], { uncapped: true });
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
  // CTL-1339: hot per-signal terminal read (phantom-sweep) — cap the wall-clock
  // so a 429-stalled linearis can't block the synchronous tick. A timed-out read
  // fails SAFE via the code-127 → "unknown" branch (never a false quarantine).
  const { code, stdout } = exec("linearis", ["issues", "read", identifier], {
    timeoutMs: LINEARIS_TERMINAL_READ_TIMEOUT_MS,
  });
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
// CTL-1174: extends the return shape to include `delegate` when a gateway is
// provided. Gateway hit: { known:true, assignee, delegate } (delegate coerced
// undefined→null for pre-Phase-1 DBs). Gateway miss: live assignee read +
// injected fetchDelegate (default fetchTicketDelegate) — a failed delegate read
// returns { known:false } (HOLD) so an unknown delegate never triggers a
// claim. Cost bound: fetchDelegate is NOT called when the assignee read fails.
// When no gateway is provided the old { known, assignee } shape is returned
// (back-compat for callers that do not wire the gateway, e.g. CLI tools).
export function fetchTicketAssignee(
  identifier,
  { exec = defaultExec, gateway, fetchDelegate = fetchTicketDelegate } = {}
) {
  if (gateway) {
    const d = gateway.getDescriptor(identifier);
    if (d && !d.removed) {
      const cachedDelegate = d.delegate === undefined ? null : d.delegate;
      // CTL-1174 LATCH FIX: a cached delegate of null is indistinguishable from
      // "never projected into the broker store" — and the store is NEVER written
      // with the orchestrator's own self-delegation (the webhook fold is dormant +
      // bot-suppressed; cache-reconcile + the eligible batch don't read delegate).
      // Returning cached-null here makes the delegate-on-Todo gate re-delegate
      // forever and never observe its own write. So on a cached NULL delegate,
      // CONFIRM LIVE before treating it as undelegated; a non-null cached delegate
      // is authoritative (only an actor sets it) and stays rate-free.
      if (cachedDelegate !== null) {
        return { known: true, assignee: d.assignee ?? null, delegate: cachedDelegate };
      }
      const drHit = fetchDelegate(identifier);
      if (!drHit.known) return { known: false }; // unreadable → HOLD (never claim on unknown)
      return { known: true, assignee: d.assignee ?? null, delegate: drHit.delegate ?? null };
    }
    // Gateway miss: live read for assignee, then delegate.
    const { code, stdout } = exec("linearis", ["issues", "read", identifier]);
    if (code !== 0) return { known: false };
    let assignee;
    try {
      const node = JSON.parse(stdout);
      assignee = node?.assignee?.id ?? null;
    } catch {
      return { known: false };
    }
    const dr = fetchDelegate(identifier);
    if (!dr.known) return { known: false };
    return { known: true, assignee, delegate: dr.delegate ?? null };
  }
  // No gateway: old behavior — live read only, no delegate (back-compat).
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

// isClaimable — CTL-1174 (delegate-ONLY claim predicate). The human ASSIGNEE is
// IRRELEVANT: a Linear bot can never BE an assignee (app-user UUIDs route to
// Issue.delegate; assigning one returns HTTP 400 "App user not valid"), so a
// human always holds the assignee and gating on it permanently starves the
// board (CTL-781's stopgap). A ticket is the daemon's to claim IFF it is
// DELEGATED to the orchestrator bot.
//   claimable iff delegate ∈ bot-ids
// An UNDELEGATED ticket (delegate == null/undefined) is NOT claimable here — it
// is first delegated by the delegate-on-Todo step at the call sites (which then
// makes this gate pass next reconcile). The `assignee` arg is retained for
// call-site/signature compatibility but is deliberately unused.
export function isClaimable(assignee, delegate, botUserIds) {
  const d = delegate === undefined ? null : delegate;
  return d != null && botUserIds instanceof Set && botUserIds.has(d);
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

// CTL-1174: batched delegate fetch for the eligible-set enrichment path.
// One GraphQL POST per ≤250-ticket chunk, team-scoped via team key + ticket
// numbers. Mirrors the CTL-784 BATCH_QUERY / defaultBatchExec pattern.
// Open Question #2: `number: { in: [...] }` is unverified — if unsupported,
// exec returns null and the fail-safe collapses to an empty Map (AC#2 not met
// but no crash, no churn). Confirm via the Phase 10 live-API check.
const DELEGATE_BATCH_QUERY = `query CtlDelegateBatch($team: String!, $nums: [Float!]) {
  issues(filter: { team: { key: { eq: $team } }, number: { in: $nums } }, first: ${BATCH_CHUNK_SIZE}) {
    nodes { identifier delegate { id } }
  }
}`;

// buildDelegateBatchCurlArgs — same curl argv skeleton as buildBatchCurlArgs;
// payload uses team + numeric ticket numbers parsed from identifiers.
export function buildDelegateBatchCurlArgs(team, identifiers, { token = "", ca } = {}) {
  const nums = (identifiers ?? [])
    .map((id) => { const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(id ?? ""); return m ? Number(m[2]) : null; })
    .filter((n) => n !== null);
  const payload = JSON.stringify({ query: DELEGATE_BATCH_QUERY, variables: { team, nums } });
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

function runDelegateBatchOnce(team, identifiers) {
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
  const { args, payload } = buildDelegateBatchCurlArgs(team, identifiers, {
    token,
    ca: process.env.NODE_EXTRA_CA_CERTS,
  });
  const res = spawnSync("curl", args, { input: payload, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    return { nodes: null, auth: false, ratelimit: false, curlFailed: true };
  }
  const out = res.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  const httpCode = Number(out.slice(nl + 1).trim());
  const body = out.slice(0, Math.max(0, nl));
  if (httpCode === 401) return { nodes: null, auth: true, ratelimit: false, curlFailed: false };
  if (httpCode === 429) return { nodes: null, auth: false, ratelimit: true, curlFailed: false };
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

// defaultDelegateBatchExec — CTL-1174. Clone of defaultBatchExec for the
// delegate-batch path: same linearBreaker short-circuit, same auth-retry via
// linearReminter, same 429 → recordRateLimited. Returns nodes[] or null.
function defaultDelegateBatchExec(team, identifiers) {
  if (linearBreaker.isOpen()) return null;
  let r = runDelegateBatchOnce(team, identifiers);
  if (r.auth && linearReminter.attempt()) r = runDelegateBatchOnce(team, identifiers);
  if (r.ratelimit) { linearBreaker.recordRateLimited(); return null; }
  if (r.nodes == null) return null;
  linearBreaker.recordSuccess();
  return r.nodes;
}

// fetchTicketsDelegateBatch — CTL-1174. Resolve `delegate.id` for a set of
// identifiers in one or more batched GraphQL POSTs. Returns
// Map<identifier, string|null>. Absent (not returned) ids are NOT in the Map
// so callers can distinguish "no delegate found" from "delegate is null".
// Fail-safe: a null chunk result keeps those ids absent; never throws.
export function fetchTicketsDelegateBatch(team, identifiers, { exec = defaultDelegateBatchExec } = {}) {
  const ids = [...new Set((identifiers ?? []).filter(Boolean))];
  const result = new Map();
  if (!team || ids.length === 0) return result;
  for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE);
    const nodes = exec(team, chunk);
    if (!nodes) continue; // fail-safe: these ids stay absent from the Map
    for (const node of nodes) {
      if (node?.identifier) {
        result.set(node.identifier, node.delegate?.id ?? null);
      }
    }
  }
  return result;
}

// CTL-1397 (3/n) — confirmed-empty trust window. A SEED-COMPLETE replica-empty is
// trusted locally ONLY within this window of a SUCCESSFUL EMPTY linearis
// confirmation, so empty Todo boards (the steady state) don't shell out to the
// rate-limited `linearis issues list` every tick and pin the CTL-679 breaker,
// while a feed-hole (CTL-139: cursor present but a team's rows dropped) is never
// trusted as empty — it keeps falling through to linearis until the replica
// catches up. Empty confirms are thereby bounded to ≤1 linearis call/team/window.
// Env-overridable; default 5 min (matches the replica staleness window).
const EMPTY_RECONFIRM_MS = Number(process.env.CATALYST_ELIGIBLE_EMPTY_RECONFIRM_MS) || 300_000;
// team → epoch-ms of the last SUCCESSFUL EMPTY linearis confirmation. Module-scoped
// (the daemon is long-lived; bounded by team count). Reset in tests via the export.
const _eligibleEmptyConfirmAt = new Map();
export function __resetEligibleEmptyConfirm() {
  _eligibleEmptyConfirmAt.clear();
}

// runEligibleQuery — run the query, parse + normalize, apply the priority
// floor. A non-zero linearis exit THROWS (never a silent []): a silent empty
// would let one failed poll flatten a project's eligible set to zero. The
// caller (Phase 4 reconcile) catches the throw and preserves the prior set.
// CTL-1174: `delegateExec` is the exec seam for the best-effort delegate
// batch enrichment. Wrapped in try/catch so a delegate hiccup never blocks
// the state/priority/relations refresh. An absent key (batch miss) leaves
// the ticket's delegate field unset; `?? null` in contentKey collapses it.
// CTL-1397: `replica` (createReplicaReader, with an eligible() method) is the
// board-list discovery accelerator. When present and it RETURNS { nodes } (a
// valid answer — even { nodes: [] }), the query is served from the local
// Catalyst-Cloud SQLite replica WITHOUT shelling out to `linearis issues list`,
// so per-tick discovery is immune to the shared Linear quota + the CTL-679
// circuit breaker that froze the fleet board. FAIL-OPEN: the tier can only
// ACCELERATE — undefined / any throw falls through to the UNCHANGED linearis
// path. `onSource("replica"|"linearis", count)` is the OTEL/Loki verification
// marker (the daemon logs eligible_source so a query can confirm WHICH source
// served). The replica already populates delegate, so a replica HIT skips the
// GraphQL delegate batch.
export function runEligibleQuery(
  query,
  {
    exec = defaultExec,
    delegateExec = defaultDelegateBatchExec,
    replica,
    onSource,
    // Injectable clock (defaults to production) so the empty-confirmation cadence
    // is deterministically testable.
    now = Date.now,
    // CTL-1420: the CTL-679 breaker state, injectable for deterministic tests.
    // When OPEN, the linearis reconfirm below can only short-circuit — so a
    // DEFINED replica-empty is trusted instead of freezing admission (see the
    // empty-path branch). Defaults to the production process-wide breaker.
    breakerIsOpen = () => linearBreaker.isOpen(),
  } = {}
) {
  // CTL-1397: replica-backed board-list tier. Fail-open: a throw out of
  // eligible() is swallowed → local undefined → fall through to linearis.
  if (replica?.eligible) {
    let local;
    try {
      local = replica.eligible(query);
    } catch {
      local = undefined; // any replica failure → fall through to linearis
    }
    if (local && Array.isArray(local.nodes)) {
      let tickets = local.nodes.map(normalizeTicket);
      // Apply the SAME priority floor the linearis path applies below.
      if (query.priority != null) {
        tickets = tickets.filter((t) => t.priority >= 1 && t.priority <= query.priority);
      }
      // A NON-EMPTY replica result is always trusted (the replica already
      // populated delegate, so no GraphQL batch is needed).
      if (tickets.length > 0) {
        onSource?.("replica", tickets.length);
        return tickets;
      }
      // CTL-1397 (3/n) — a SEED-COMPLETE replica-empty. The reader only returns a
      // defined { nodes } when the replica is fresh AND the sync_meta cursor is
      // present (seed complete; the snapshot-consistent gate rules out a mid-reseed
      // truncation), so this empty is a real "0 eligible", NOT a truncation
      // artifact. Empty Todo boards are the STEADY STATE, so confirming EVERY empty
      // via `linearis issues list` made discovery hit the rate-limited API every
      // tick — defeating the breaker-immunity this tier exists for and pinning the
      // CTL-679 breaker (the live freeze: 100% eligible_source=linearis).
      //
      // So TRUST the replica-empty — but ONLY when linearis has RECENTLY CONFIRMED
      // this team's board empty (a successful, empty confirmation cached within
      // EMPTY_RECONFIRM_MS; the marker is set at the END of the linearis path
      // below, and ONLY on a successful empty result). This keeps steady-state
      // empty boards breaker-immune (≤1 linearis confirm/team/window) while never
      // zeroing on a feed-hole:
      //   - a FAILED confirm (breaker trip, auth/network, bad stdout) throws before
      //     the marker is set → reconcileProject preserves the prior set, and the
      //     next reconcile re-confirms (not suppressed by a doomed attempt);
      //   - a NON-EMPTY confirm (the CTL-139 feed-hole: cursor present but rows
      //     dropped) serves the real board and does NOT set the marker → the next
      //     reconcile keeps confirming until the replica catches up;
      //   - a breaker-OPEN reconcile with no recent confirmation falls through so
      //     the exec short-circuits (circuit-open) → throw → preserve prior (never
      //     trusts an unconfirmed empty as authoritative during a storm).
      if (now() - (_eligibleEmptyConfirmAt.get(query.team) ?? 0) < EMPTY_RECONFIRM_MS) {
        onSource?.("replica", 0);
        return tickets; // [] — a recently linearis-confirmed empty, trusted (breaker-immune)
      }
      // CTL-1420 (freeze-avoidance): when the CTL-679 breaker is OPEN, the
      // linearis reconfirm below can only short-circuit (circuit-open) → throw →
      // reconcileProject preserves the (empty) prior set = a fleet-wide admission
      // FREEZE for the breaker's entire open window (the observed 4h+ boot freeze:
      // fresh process, empty marker map, breaker pinned → nothing ever admitted).
      // A DEFINED replica-empty has already cleared the reader's writer-liveness +
      // seed-complete cursor + snapshot-consistent gates, so it is a provably-real
      // "0 eligible" (NOT a mid-reseed truncation). During breaker-open we TRUST it
      // rather than freeze. The only residual risk is a CTL-139 feed-hole (a team's
      // rows silently dropped while the writer stays alive) — strictly less bad than
      // freezing ALL admission fleet-wide, and self-healing: the moment the breaker
      // closes, the reconfirm path below resumes and re-validates every empty. A
      // NON-EMPTY replica is always served (above), even during a storm — so this
      // only ever trusts a genuinely-empty board; real Todo work still dispatches.
      if (breakerIsOpen()) {
        onSource?.("replica-empty-breaker-open", 0);
        return tickets; // [] — trusted under quota exhaustion (freeze-avoidance)
      }
      // No recent confirmation AND breaker closed → fall through to the linearis
      // confirm/preserve-prior path below (cheap: ≤1 confirm/team/window; sets the
      // marker on a successful empty). Do NOT set the marker here.
    }
    // MISS (undefined) / unconfirmed replica-empty → fall through to the UNCHANGED
    // linearis path below.
  }
  // CTL-1364 regression fix: the eligible-list poll MUST stay UNCAPPED. The
  // CTL-1364 default floor is for the hot per-signal terminal reads only; a
  // blanket cap here would SIGKILL a slow-but-VALID 200-ticket page, open the
  // shared process-wide breaker (via res.timedOut), throw, and trip a false
  // monitor.reconcile.failing alert — exactly the failure mode CTL-1339 designed
  // against. `{ uncapped: true }` opts this spawn out of the default floor.
  const { code, stdout, stderr } = exec("linearis", buildLinearisArgs(query), { uncapped: true });
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
  // CTL-1174: best-effort delegate enrichment from a single batched GraphQL POST.
  // Never throws — a delegate hiccup must not block the state/priority refresh.
  if (tickets.length > 0) {
    try {
      const dmap = fetchTicketsDelegateBatch(
        query.team,
        tickets.map((t) => t.identifier),
        { exec: delegateExec }
      );
      for (const t of tickets) {
        const d = dmap.get(t.identifier);
        if (d !== undefined) t.delegate = d;
      }
    } catch {
      /* best-effort: a delegate hiccup never blocks the state/priority/relations refresh */
    }
  }
  // CTL-1397 (3/n): cache a SUCCESSFUL EMPTY confirmation so the replica-empty
  // branch above can trust this team's empty board for EMPTY_RECONFIRM_MS without
  // re-shelling to linearis. ONLY an empty result caches — a non-empty (feed-hole)
  // result must keep serving the real board + re-confirming, and a throw never
  // reaches here (→ reconcileProject preserves the prior set). This is what makes
  // "a failed or non-empty confirm never suppresses the next confirm" true.
  if (tickets.length === 0) {
    _eligibleEmptyConfirmAt.set(query.team, now());
  }
  // CTL-1397: mark the source (linearis) for the same verification seam as the
  // replica HIT above, so the daemon can log eligible_source for both paths.
  onSource?.("linearis", tickets.length);
  return tickets;
}
