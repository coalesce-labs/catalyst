#!/usr/bin/env node
// cluster-heartbeat.mjs — cross-host liveness channel (CTL-1090).
//
// Each host publishes its own `catalyst://heartbeat/<HOST>` attachment to a
// well-known "anchor issue" (a Linear ticket identifier from operator config).
// Peers read back all such attachments and merge them into
// readClusterHeartbeats() so dead-host detection sees peer timestamps.
//
// DORMANT until daemon.mjs wires startLivenessPublisher (Phase 4). Like
// cluster-claim.mjs, this lib is pure + injectable (the `post` seam; no
// cross-module imports beyond Node builtins) and PR-order-independent.
//
// Single-writer-per-host: each host writes only its own attachment, so NO CAS
// is needed — just upsert + read (contrast cluster-claim.mjs's soft-CAS).
//
// Shared GraphQL constants (RESOLVE_ISSUE_QUERY, READ_ATTACHMENTS_QUERY,
// WRITE_ATTACHMENT_MUTATION, defaultPost, authHeader, resolveIssueId) are
// copied verbatim from cluster-claim.mjs per the plan's no-cross-module-import
// rule: each lib stays pure and PR-order-independent. That rule is about
// execution-core siblings never depending on each other's release order — it
// does not cover the shared zero-import lib/ leaf: CTL-1616 PR3 imports
// resolveSecret from lib/secret-contract.mjs directly, the same precedent
// cluster-sync.mjs and doctor.mjs already set, to fold this file's own
// LINEAR_API_TOKEN/LINEAR_API_KEY ladder onto the shared contract.
import { resolveSecret } from "../lib/secret-contract.mjs";
// CTL-1889 increment 3 — the shared attachment transport (see its header). Heartbeat is
// single-writer-per-host, so it has no CAS to protect; what it shares with cluster-claim is
// the VERB (attachmentCreate + read-back) and therefore the credential this ticket retires.
import {
  createGraphqlAttachmentTransport,
  resolveAttachmentTransport,
} from "./cluster-attachment-transport.mjs";
import { createLinearWriteProxy } from "./linear-write-proxy.mjs";
import { readLinearWriteProxyConfig } from "./config.mjs";

const HEARTBEAT_URL_PREFIX = "catalyst://heartbeat/";
const HEARTBEAT_ATTACHMENT_TITLE = "catalyst-liveness";
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

// heartbeatUrl — the per-host attachment url. The unique key Linear upserts on.
export function heartbeatUrl(host) {
  return `${HEARTBEAT_URL_PREFIX}${host}`;
}

// authHeader — copied verbatim from cluster-claim.mjs (keep local, PR-order-independent).
export function authHeader(token = "") {
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

// isRateClassLinearError — CTL-1420 follow-up. Recognize a RATE-class Linear
// rejection from a response body OR an error string. Linear serves its
// complexity / soft-rate limit as HTTP **400** with `errors[].extensions.code
// === "RATELIMITED"` (NOT 429), alongside the classic 429 "Only N requests are
// allowed" message. This is the discriminator between "back off the shared
// app-actor bucket" (rate-class) and a genuine bad-request 400 (a query/schema
// bug — surface it, do NOT back off). Pure + exported so the publisher can
// classify the propagated error string with the same rule.
export function isRateClassLinearError(text) {
  return /RATELIMITED|rate limit|requests are allowed|http 429\b/i.test(String(text ?? ""));
}

// defaultPost — the production GraphQL POST. Injectable via `post` option on every
// public function so tests never touch the network.
async function defaultPost(query, variables) {
  const token = resolveSecret("linear-api-token").value ?? ""; // CTL-1616 PR3
  const res = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(token),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    // CTL-1420 follow-up: READ the body before throwing. It was previously
    // discarded (throw on !res.ok fired before res.json()), so a rate-class 400
    // (RATELIMITED) looked identical to a bad-request 400 — and the publisher had
    // no signal to back off, so it re-hit the shared app-actor bucket every ~2min
    // with no cooldown (a live burn contributor + the fence-stale flap). Surface
    // the body (so a genuine query/schema 400 is diagnosable) and TAG a rate-class
    // rejection so the publisher can feed the CTL-679 breaker.
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      /* body unreadable — status alone still classifies a 429 */
    }
    const rateClass = res.status === 429 || isRateClassLinearError(bodyText);
    throw new Error(
      `linear graphql http ${res.status}${rateClass ? " [RATELIMITED]" : ""}: ${bodyText.slice(0, 300)}`,
    );
  }
  const json = await res.json();
  if (json?.errors) throw new Error(`linear graphql errors: ${JSON.stringify(json.errors)}`);
  return json?.data ?? {};
}

// ─── identifier → issue UUID ─────────────────────────────────────────────────

// CTL-1255: resolve via the `issue(id:)` query, which accepts the human
// identifier ("CTL-1217") directly and returns the UUID. The previous
// `issues(filter:{identifier:{eq}})` form was a hard 400 — IssueFilter has no
// `identifier` field ("Field identifier is not defined by type IssueFilter") —
// so resolveIssueId ALWAYS returned null and every publish aborted with "no
// issue found". This is why cross-host liveness never published (CTL-1251).
// READ_ATTACHMENTS_QUERY below already uses `issue(id:)`, which is why reads
// worked while writes silently failed.
/** See cluster-claim.mjs's transportFor — same contract, same default-is-the-old-path rule. */
function transportFor({ post = defaultPost, transport = null } = {}) {
  return transport ?? createGraphqlAttachmentTransport({ post });
}

/**
 * defaultTransport — this PROCESS's transport. Constructed from the inherited env for the
 * same reason cluster-claim.mjs does it: `cluster-heartbeat-sync.mjs` drives this module by
 * `spawnSync("node cluster-heartbeat.mjs …")`, so the daemon's process-wide install slot is
 * always empty in this child and reading it would silently keep the app-actor path alive.
 */
export function defaultTransport({ env = process.env, post = defaultPost } = {}) {
  const { mode, routes } = readLinearWriteProxyConfig(env);
  const proxy = mode === "enforce" ? createLinearWriteProxy({ mode, env, routes }) : null;
  return resolveAttachmentTransport({ mode, post, proxy, caller: "cluster-heartbeat" });
}

export async function resolveIssueId(ticket, { post = defaultPost, transport = null } = {}) {
  return transportFor({ post, transport }).resolveIssueId(ticket);
}

// ─── anchor health (CAT-46) ──────────────────────────────────────────────────

const ANCHOR_HEALTH_QUERY = `query AnchorHealth($id: String!) {
  issue(id: $id) { id identifier archivedAt state { name type } }
}`;

const CLOSED_STATE_TYPES = new Set(["completed", "canceled"]);

/**
 * Probe whether `ticket` is a live, usable liveness-attachment target.
 * Never throws; `found: null` distinguishes an unknown transport result from
 * an issue that Linear definitively reported as missing.
 */
export async function readAnchorHealth(ticket, { post = defaultPost } = {}) {
  const base = {
    ok: false,
    found: null,
    identifier: null,
    stateName: null,
    stateType: null,
    archived: false,
    closed: false,
    error: null,
  };
  if (typeof ticket !== "string" || ticket.trim() === "") {
    return { ...base, error: "no anchor issue configured" };
  }

  let data;
  try {
    data = await post(ANCHOR_HEALTH_QUERY, { id: ticket.trim() });
  } catch (err) {
    const error = String(err?.message ?? err);
    // Linear's `issue(id:)` resolver reports a missing identifier as a
    // GraphQL INPUT_ERROR rather than `{ issue: null }`. This is still a
    // definitive observation that the anchor does not resolve, not a
    // transport outage.
    if (/Entity not found:\s*Issue/i.test(error)) return { ...base, found: false };
    return { ...base, error };
  }

  const issue = data?.issue ?? null;
  if (!issue) return { ...base, found: false };

  const stateType = typeof issue.state?.type === "string" ? issue.state.type : null;
  const archived = Boolean(issue.archivedAt);
  return {
    ok: !archived,
    found: true,
    identifier: typeof issue.identifier === "string" ? issue.identifier : null,
    stateName: typeof issue.state?.name === "string" ? issue.state.name : null,
    stateType,
    archived,
    closed: stateType != null && CLOSED_STATE_TYPES.has(stateType),
    error: null,
  };
}

// ─── read ────────────────────────────────────────────────────────────────────

// ⚠️ The GraphQL document that used to live here now lives in
// cluster-attachment-transport.mjs, which is the ONE place both cluster modules and
// both transports agree on the wire format. The history above is kept because it is
// the reason the document reads the way it does, not because the text is still here.

// parseHeartbeatMetadata — normalise an attachment's metadata into the flat
// liveness record callers consume. `in_flight_tickets` is normalised to a
// string array (non-string entries filtered). CTL-1092: adds max_parallel
// (finite int or null) and in_flight_count (int ≥ 0). Exported for unit coverage.
const HEARTBEAT_CLOCK_SKEW_MS = 5 * 60_000;

function normaliseIsoTimestamp(value, { now = Date.now() } = {}) {
  if (typeof value !== "string") return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts) || ts > now + HEARTBEAT_CLOCK_SKEW_MS) return null;
  return value;
}

function normaliseLastSeen(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

export function parseHeartbeatMetadata(metadata, { now = Date.now() } = {}) {
  const m = metadata ?? {};
  const raw = m.in_flight_tickets;
  const tickets = Array.isArray(raw) ? raw.filter((t) => typeof t === "string") : [];
  const maxP = m.max_parallel;
  const maxParallel = Number.isInteger(maxP) && maxP > 0 ? maxP : null;
  const rawCount = m.in_flight_count;
  const inFlightCount = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : tickets.length;
  return {
    host: m.host ?? null,
    // A future last_seen is still positive liveness. Rejecting clock-skewed
    // peers here can split dispatch ownership and permit double dispatch.
    last_seen: normaliseLastSeen(m.last_seen),
    last_advance_at: normaliseIsoTimestamp(m.last_advance_at, { now }),
    in_flight_tickets: tickets,
    max_parallel: maxParallel,
    in_flight_count: inFlightCount,
  };
}

// readPeerHeartbeats — read all `catalyst://heartbeat/*` attachments from the
// anchor issue. Returns { [host]: { host, last_seen, in_flight_tickets,
// max_parallel, in_flight_count } } (the full parseHeartbeatMetadata record).
// Best-effort: a missing/erroring anchor yields {}. The caller filters out
// `self` to avoid treating its own attachment as a peer.
export async function readPeerHeartbeats(
  { anchorIssue },
  { post = defaultPost, transport = null } = {},
) {
  let nodes;
  try {
    nodes = await transportFor({ post, transport }).readAttachments(anchorIssue);
  } catch {
    // ⚠️ BEST-EFFORT, PRESERVED VERBATIM — and deliberately NOT changed by CTL-1889 inc 3.
    // Unlike `readClaim`, a failed read here returns `{}` (no peers) rather than throwing.
    // That asymmetry is pre-existing and is a real hazard worth its own ticket (an empty
    // peer map reads as "every peer is dead", which is the permissive direction for
    // dead-host takeover) — but this increment changes the TRANSPORT, not the failure
    // policy, so the proxy path fails exactly the way the app-actor path already did.
    return {};
  }
  const out = {};
  for (const n of nodes) {
    if (typeof n?.url !== "string" || !n.url.startsWith(HEARTBEAT_URL_PREFIX)) continue;
    const rec = parseHeartbeatMetadata(n.metadata);
    if (rec.host) out[rec.host] = rec;
  }
  return out;
}

// ─── write / upsert ──────────────────────────────────────────────────────────

// ⚠️ The GraphQL document that used to live here now lives in
// cluster-attachment-transport.mjs, which is the ONE place both cluster modules and
// both transports agree on the wire format. The history above is kept because it is
// the reason the document reads the way it does, not because the text is still here.

// publishHeartbeat — upsert THIS host's `catalyst://heartbeat/<host>` attachment
// on the anchor issue. Single-writer-per-host ⇒ no CAS. Mirrors writeClaim
// (resolve issue UUID, then attachmentCreate UPSERT). Returns the parsed
// heartbeat record written, throwing on a resolution miss or success:false.
//
// CTL-863 fleet-unfreeze (entourage, follow-up to #2552): `issueId` is an
// OPTIONAL pre-resolved UUID override. The anchor issue's UUID never changes
// once resolved, so cluster-heartbeat-sync.mjs's resolveAnchorIssueIdSyncCached
// resolves it ONCE (permanently cached, in-process) and passes it here on every
// subsequent publish — skipping the redundant `query ResolveIssueId` round-trip
// every ~2min publish tick would otherwise repeat forever. A falsy override
// (the cache-miss / cache-disabled case) falls through to the original
// resolveIssueId(anchorIssue) call, so behavior is UNCHANGED when no override
// is supplied — this is purely additive.
export async function publishHeartbeat(
  { anchorIssue, host, inFlightTickets = [], maxParallel = null, lastAdvanceAt = null },
  { post = defaultPost, transport = null, now, issueId: issueIdOverride = null } = {},
) {
  const t = transportFor({ post, transport });
  const last_seen = now ? now() : new Date().toISOString();
  const metadata = {
    host,
    last_seen,
    in_flight_tickets: inFlightTickets,
    max_parallel: maxParallel ?? null,
    in_flight_count: inFlightTickets.length,
  };
  if (lastAdvanceAt != null) metadata.last_advance_at = lastAdvanceAt;
  // Throws on a resolution miss or any non-success, exactly as before — the transport owns
  // both cases now, so the two callers cannot drift on what "the publish failed" means.
  await t.upsertAttachment({
    ticket: anchorIssue,
    issueId: issueIdOverride,
    title: HEARTBEAT_ATTACHMENT_TITLE,
    url: heartbeatUrl(host),
    metadata,
  });
  return parseHeartbeatMetadata(metadata);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// A thin argv shim so the SYNCHRONOUS daemon can drive these async functions
// through spawnSync — the same sync-subprocess convention as cluster-claim.mjs.
// cluster-heartbeat-sync.mjs is the in-process wrapper that spawnSync's
// `node cluster-heartbeat.mjs <cmd> …`.
//
//   publish <anchor> <host> <ticketsCSV> [maxParallel] [issueId]  → stdout JSON record; exit 0
//   read <anchor>                                                  → stdout JSON map; exit 0
//   resolve-anchor <anchor>                                        → stdout JSON {issueId}; exit 0
//
// CTL-863 fleet-unfreeze (entourage): `resolve-anchor` is a standalone identifier→UUID
// resolution, added so cluster-heartbeat-sync.mjs's permanent cache can populate itself
// with ONE small subprocess call (instead of the resolution being buried inside every
// `publish`), then pass the resolved UUID back into `publish`'s optional 5th arg on every
// subsequent call — skipping that call's own ResolveIssueId round-trip.
export async function runCli(argv, { post = defaultPost, transport = null, now } = {}) {
  const t = transport ?? defaultTransport({ post });
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "publish": {
      const flags = rest.filter((arg) => typeof arg === "string" && arg.startsWith("--"));
      const positional = rest.filter((arg) => typeof arg !== "string" || !arg.startsWith("--"));
      const [anchor, host, ticketsCsv, maxParallelRaw, issueIdRaw] = positional;
      const lastAdvanceAt = flags.find((arg) => arg.startsWith("--last-advance-at="))
        ?.slice("--last-advance-at=".length) || null;
      const inFlightTickets =
        ticketsCsv
          ? ticketsCsv
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
      // CTL-1092: optional 4th arg — this host's live max_parallel (slot count).
      // Absent/blank/non-positive-int → null (back-compat: pre-CTL-1092 callers
      // pass only 3 args, so the heartbeat still carries max_parallel: null).
      const mp = maxParallelRaw != null && maxParallelRaw !== "" ? Number(maxParallelRaw) : null;
      const maxParallel = Number.isInteger(mp) && mp > 0 ? mp : null;
      // CTL-863 follow-up: optional 5th arg — a pre-resolved anchor UUID from the
      // daemon-side permanent cache. Absent/blank → null (publishHeartbeat falls back
      // to resolving it itself, byte-identical to pre-follow-up behavior).
      const issueId = issueIdRaw != null && issueIdRaw !== "" ? issueIdRaw : null;
      const rec = await publishHeartbeat(
        { anchorIssue: anchor, host, inFlightTickets, maxParallel, lastAdvanceAt },
        { post, transport: t, now, issueId },
      );
      process.stdout.write(JSON.stringify(rec) + "\n");
      return 0;
    }
    case "read": {
      const [anchor] = rest;
      const map = await readPeerHeartbeats({ anchorIssue: anchor }, { post, transport: t });
      process.stdout.write(JSON.stringify(map) + "\n");
      return 0;
    }
    case "resolve-anchor": {
      const [anchor] = rest;
      const issueId = await resolveIssueId(anchor, { post, transport: t });
      process.stdout.write(JSON.stringify({ issueId }) + "\n");
      return 0;
    }
    default:
      process.stderr.write(
        `cluster-heartbeat.mjs: unknown subcommand: ${cmd ?? "(none)"}\n` +
          "usage: cluster-heartbeat.mjs <publish <anchor> <host> <ticketsCSV> [maxParallel] [issueId] [--last-advance-at=<iso>] | read <anchor> | resolve-anchor <anchor>>\n",
      );
      return 1;
  }
}

function isMain() {
  return (
    process.argv[1] &&
    (process.argv[1].endsWith("/cluster-heartbeat.mjs") ||
      process.argv[1].endsWith("cluster-heartbeat.mjs"))
  );
}

if (isMain()) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`cluster-heartbeat.mjs: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
