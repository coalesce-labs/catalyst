#!/usr/bin/env node
// cluster-claim.mjs — cross-host CLAIM + FENCE record, stored as a single Linear
// ATTACHMENT per ticket (CTL-859, PR2 of the distributed-coordination epic).
//
// DORMANT: this module is the verified mechanism + the read-back CAS + the
// fencing predicate as a tested library. No caller is wired in yet — CTL-850
// (HRW ownership + Linear-CAS claim wiring) consumes it next. Keeping it pure
// and self-contained makes it PR-order-independent: the only externalities are
// the GraphQL `post` seam (injectable) and the Linear API token in the env.
//
// CTL-1616 PR3: resolveSecret from the shared zero-import lib/ leaf is NOT a
// cross-module import of an execution-core sibling (the PR-order-independence
// rule above is about staying independent of linear-query.mjs/
// cluster-heartbeat.mjs's release order, not about the shared secret-contract
// leaf; cluster-sync.mjs and doctor.mjs already set this precedent). Folds
// defaultPost's own LINEAR_API_TOKEN/LINEAR_API_KEY ladder below.
import { resolveSecret } from "../lib/secret-contract.mjs";
// CTL-1889 increment 3 — the transport seam. Read its header before changing anything
// here: it is the file that re-establishes "every failure throws" on the proxy path, and
// both the soft-CAS below and the stale-preemption branch depend on that and on nothing else.
import {
  createGraphqlAttachmentTransport,
  resolveAttachmentTransport,
} from "./cluster-attachment-transport.mjs";
import { createLinearWriteProxy } from "./linear-write-proxy.mjs";
import { readLinearWriteProxyConfig } from "./config.mjs";
// CTL-1786 — the lease-authority client half of CTC-410. The refusable claim path lives beside
// the attachment soft-CAS here so `runCli`/`defaultTransport` can select it on the env gate with
// ZERO change to any caller: it returns the same {won, generation} contract.
import {
  DEFAULT_WORK_TTL_MS,
  LeaseAuthorityError,
  createLeaseAuthorityClient,
  ensureEntitled as defaultEnsureEntitled,
} from "./lease-authority.mjs";
//
// ─── The storage mechanism (VERIFIED via live Linear API probe, 2026-06-08) ──
// Linear has no custom fields and labels can't model a counter, so the claim +
// fence + owner-name record is ONE Linear attachment per ticket:
//
//   attachmentCreate(input:{
//     issueId, title:"catalyst-meta", url:"catalyst://fence/<TICKET>",
//     metadata:{ owner_host, catalyst_generation, phase, claimed_at }
//   })
//
//   • attachmentCreate with the SAME url is an UPSERT — it returns the same
//     attachment id with new metadata. (attachmentUpdate requires `title` and
//     does NOT accept `metadata`, so create is the only upsert path.)
//     ⭐ RE-VERIFIED 2026-08-18 through the CTC-692 cloud route: a second POST to
//     the same url returned the SAME attachment id with the metadata replaced,
//     and the read-back showed exactly ONE node. This is the measurement the
//     whole soft-CAS rests on, so it is re-checked whenever the path changes.
//   • The write produces ZERO issue.history entries → invisible to the human
//     activity feed (no notification spam).
//   • READ via issue.attachments and pick the node whose url starts with
//     `catalyst://fence/`.
//
// Linear has no native compare-and-swap, so claimTicket is a SOFT-CAS: write the
// claim, then read it back and confirm the owner+generation we just wrote are
// what's on the ticket. A concurrent host that wrote last wins the read-back; we
// lose and back off. Single-writer discipline (the owning host) + the read-back
// staleness signal is what makes a small trusted fleet safe without consensus.

// FENCE_URL_PREFIX — the synthetic attachment url that namespaces our record.
// One attachment per ticket; the full url is `${FENCE_URL_PREFIX}<TICKET>`.
const FENCE_URL_PREFIX = "catalyst://fence/";

// CLAIM_STALE_MS_DEFAULT — a claim held by a DIFFERENT host older than this is
// definitively stale: triage/dispatch agents complete or fail well within it, so
// a non-matching owner past this age is an abandoned claim the HRW owner may
// preempt without the read-back race (CTL-1297). Mirrors the
// EXECUTION_CORE_CLAIM_TIMEOUT_MS env convention. 5 min default.
// Validate the env override: only a FINITE, STRICTLY POSITIVE value is honored.
// A zero/negative/NaN value would make `now - claimedAt > staleMs` true for
// essentially every cross-host claim, collapsing the soft-CAS mutex into
// last-writer-wins fleet-wide — so any non-positive override falls back to the
// safe 5 min default rather than silently disabling the serializer (CTL-1297).
const CLAIM_STALE_MS_DEFAULT = (() => {
  const raw = Number(process.env.EXECUTION_CORE_CLAIM_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
})();

// FENCE_ATTACHMENT_TITLE — the human-facing title on the attachment. Constant so
// the record is always recognisable in the (rare) case a human inspects it.
const FENCE_ATTACHMENT_TITLE = "catalyst-meta";

// LINEAR_GRAPHQL_ENDPOINT — same endpoint linear-query.mjs posts to.
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

// fenceUrl — the per-ticket attachment url. The unique key Linear upserts on.
export function fenceUrl(ticket) {
  return `${FENCE_URL_PREFIX}${ticket}`;
}

// authHeader — Linear's documented auth contract, mirrored from
// linear-query.mjs::authHeader (kept local so this lib has no cross-module
// import and stays PR-order-independent). An OAuth access token (`lin_oauth_…`,
// the daemon's app-actor token) is sent `Bearer <token>`; a personal API key
// (`lin_api_…`) is sent raw.
export function authHeader(token = "") {
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

// defaultPost — the production GraphQL POST. One fetch to the Linear endpoint
// with the env token (LINEAR_API_TOKEN / LINEAR_API_KEY — the same vars the
// daemon exports for linear-query.mjs). Returns the parsed `data` object, or
// throws on a transport error, non-2xx status, or a GraphQL errors[] body so
// the caller's try/catch fails safe. Injectable via the `post` option on every
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
    throw new Error(`linear graphql http ${res.status}`);
  }
  const json = await res.json();
  if (json?.errors) {
    throw new Error(`linear graphql errors: ${JSON.stringify(json.errors)}`);
  }
  return json?.data ?? {};
}

/**
 * transportFor — the attachment transport for one call. CTL-1889 increment 3.
 *
 * ⚠️ THE DEFAULT IS THE PRE-EXISTING PATH, BY CONSTRUCTION. When no `transport` is
 * injected this wraps whatever `post` the caller supplied — so every existing test that
 * injects `post` keeps exercising the direct GraphQL path with the same documents and the
 * same assertions, and "the app-actor path is unchanged" is checkable rather than claimed.
 */
function transportFor({ post = defaultPost, transport = null } = {}) {
  return transport ?? createGraphqlAttachmentTransport({ post });
}

// ─── identifier → issue UUID ─────────────────────────────────────────────────

// CTL-1363: resolve via the `issue(id:)` query, which accepts the human
// identifier ("CTL-842") directly and returns the UUID. The previous
// `issues(filter:{identifier:{eq}})` form was a hard 400 — IssueFilter has no
// `identifier` field ("Field 'identifier' is not defined by type 'IssueFilter'")
// — so resolveIssueId ALWAYS 400'd and every cross-host claim write aborted.
// When multiHost=true that silently wedged fleet dispatch: the monitor's triage
// dispatch failed the claim and never wrote triage.json, so the scheduler held
// every new-work candidate at the CTL-1150 triage gate (all at log.debug, so
// invisible at INFO). Same bug + fix as cluster-heartbeat.mjs (CTL-1255).
// READ_ATTACHMENTS_QUERY below already uses `issue(id:)` — which is why reads
// worked while writes silently 400'd.
// ⚠️ The GraphQL document that used to live here now lives in
// cluster-attachment-transport.mjs, which is the ONE place both cluster modules and
// both transports agree on the wire format. The history above is kept because it is
// the reason the document reads the way it does, not because the text is still here.

// resolveIssueId — a ticket identifier (e.g. "CTL-842") → its issue UUID, or null when no
// issue matches. Exported for unit coverage + reuse.
//
// ⚠️ THE CLAIM THIS FUNCTION WAS WRITTEN FOR — "attachmentCreate needs the UUID, not the
// identifier" — IS NOT TRUE OF THE PROXY PATH, measured 2026-08-18 against the live CTC-692
// route: a POST carrying `issueId: "CTL-1889"` returned `succeeded`, and the cloud passes
// that value STRAIGHT to `attachmentCreate` without resolving it. So on the proxy transport
// this is the identity function and no resolution happens at all.
//
// ⚠️ It is left in place, and still resolves, for the DIRECT app-actor path — where the
// original claim has not been re-measured and where `cluster-claim-sync.mjs`'s permanent
// UUID cache (CTL-863) calls the `resolve-issue-id` CLI verb expecting a real answer. Do
// not "simplify" it away on the strength of the proxy measurement: those are two different
// call paths and only one of them has been checked.
export async function resolveIssueId(ticket, { post = defaultPost, transport = null } = {}) {
  return transportFor({ post, transport }).resolveIssueId(ticket);
}

// ─── read ────────────────────────────────────────────────────────────────────

// ⚠️ The GraphQL document that used to live here now lives in
// cluster-attachment-transport.mjs, which is the ONE place both cluster modules and
// both transports agree on the wire format. The history above is kept because it is
// the reason the document reads the way it does, not because the text is still here.

// parseClaimMetadata — normalise an attachment's metadata into the flat claim
// record callers consume. `catalyst_generation` is coerced to a Number; a
// missing/unparseable generation becomes null so isFenceCurrent never reads a
// stale string as a match. `triage_attempt_count` is coerced similarly but
// defaults to 0 (not null) — a count fails open to 0 so the cap gate
// under-counts rather than falsely parks. Exported for unit coverage.
export function parseClaimMetadata(metadata) {
  const m = metadata ?? {};
  const genRaw = m.catalyst_generation;
  const generation = Number(genRaw);
  const attemptCount = Number(m.triage_attempt_count);
  return {
    owner_host: m.owner_host ?? null,
    generation: Number.isFinite(generation) ? generation : null,
    phase: m.phase ?? null,
    claimed_at: m.claimed_at ?? null,
    triage_attempt_count: Number.isFinite(attemptCount) && attemptCount >= 0 ? attemptCount : 0,
  };
}

// readClaim — the current claim/fence record for a ticket, or null when no
// catalyst://fence/ attachment exists. Reads issue.attachments and picks the
// node whose url starts with the fence prefix (defensive: the issue may carry
// unrelated attachments — PRs, designs). The `id`/`issueId` args double as the
// issue UUID when the caller already resolved it; a bare identifier is resolved
// transparently is NOT done here (Linear's `issue(id:)` accepts an identifier
// like "CTL-842" directly), so we pass `ticket` straight through.
export async function readClaim(ticket, { post = defaultPost, transport = null } = {}) {
  // ⛔ A THROWN read must stay thrown. `null` here means "there is no fence on this
  // ticket", which `claimTicket` reads as "nobody holds it, claim at generation 1" — so
  // swallowing a transport failure into `null` would reset the fencing token on a ticket
  // another host owns. The transport's contract is that only a SUCCESSFUL read returns;
  // this function must not add a catch. See cluster-attachment-transport.mjs's header.
  const nodes = await transportFor({ post, transport }).readAttachments(ticket);
  const node = nodes.find((n) => typeof n?.url === "string" && n.url.startsWith(FENCE_URL_PREFIX));
  if (!node) return null;
  return parseClaimMetadata(node.metadata);
}

// ─── write / upsert ──────────────────────────────────────────────────────────

// ⚠️ The GraphQL document that used to live here now lives in
// cluster-attachment-transport.mjs, which is the ONE place both cluster modules and
// both transports agree on the wire format. The history above is kept because it is
// the reason the document reads the way it does, not because the text is still here.

// writeClaim — upsert the claim/fence attachment for a ticket. Always uses
// attachmentCreate (the VERIFIED upsert path — the same url returns the same
// attachment id with new metadata; attachmentUpdate cannot take metadata).
// Sets claimed_at to now. Resolves the issue UUID first (attachmentCreate needs
// issueId). Returns the parsed claim record written (the metadata we sent),
// throwing on a resolution miss or a success:false response so callers fail safe.
//
// metadata is written with the VERIFIED key names: owner_host,
// catalyst_generation, phase, claimed_at. catalyst_generation is a Number on the
// wire; Linear's metadata JSON round-trips it.
//
// CTL-863 fleet-unfreeze (entourage, follow-up to #2552): `issueId` is an OPTIONAL
// pre-resolved UUID override. A ticket's issue UUID never changes once assigned, so
// cluster-claim-sync.mjs's permanent resolveIssueIdSyncCached resolves it ONCE and
// passes it here on every subsequent claim — skipping this call's own `query
// ResolveIssueId` round-trip. A falsy override (cache miss/disabled) falls through to
// the original resolveIssueId(ticket) call, so behavior is unchanged when omitted.
export async function writeClaim(
  ticket,
  { owner_host, generation, phase, triage_attempt_count = 0 },
  { post = defaultPost, transport = null, issueId: issueIdOverride = null, preserveClaimedAt = null } = {},
) {
  // preserveClaimedAt allows a count-only bump to avoid resetting the CTL-1297
  // staleness clock — a mere triage_attempt_count increment is not a takeover.
  const claimed_at = preserveClaimedAt ?? new Date().toISOString();
  const metadata = {
    owner_host,
    catalyst_generation: generation,
    phase,
    claimed_at,
    triage_attempt_count,
  };
  // ⛔ MUST THROW ON ANY NON-SUCCESS, and this is the single most important line in the
  // file. `claimTicket`'s stale-preemption branch returns `{won:true}` with NO read-back
  // — the throw from here is the ONLY thing between a refused write and a host that
  // believes it owns a ticket it never wrote to. The transport guarantees the throw for
  // both paths (`success:false` on GraphQL, `applied:false` on the proxy); do not wrap
  // this call in a try/catch that returns a value.
  await transportFor({ post, transport }).upsertAttachment({
    ticket,
    issueId: issueIdOverride,
    title: FENCE_ATTACHMENT_TITLE,
    url: fenceUrl(ticket),
    metadata,
  });
  return parseClaimMetadata(metadata);
}

// ─── triage attempt count ────────────────────────────────────────────────────

// readTriageAttemptCount — the fleet-wide triage attempt count from the fence
// attachment. Returns the count (≥0) when a fence exists, or null when no
// catalyst://fence/ attachment is found (fence-absent → caller fails open to
// host-local counting). A zero count is a valid result (fence exists but no
// attempts have been bumped yet, e.g. immediately after a fresh claim).
export async function readTriageAttemptCount(ticket, { post = defaultPost, transport = null } = {}) {
  const c = await readClaim(ticket, { post, transport });
  return c ? (c.triage_attempt_count ?? 0) : null;
}

// bumpTriageAttemptCount — increment the fleet-wide triage attempt count on the
// fence attachment. Preserves owner_host, catalyst_generation, phase, and
// claimed_at (does NOT bump the generation — this is not a takeover). Returns
// the new count on success, or null when no fence exists (best-effort no-op).
export async function bumpTriageAttemptCount(
  ticket,
  { post = defaultPost, transport = null, issueId = null } = {},
) {
  const current = await readClaim(ticket, { post, transport });
  if (!current) return null; // no fence — no-op, fail-open
  const newCount = (current.triage_attempt_count ?? 0) + 1;
  await writeClaim(
    ticket,
    {
      owner_host: current.owner_host,
      generation: current.generation,
      phase: current.phase,
      triage_attempt_count: newCount,
    },
    { post, transport, issueId, preserveClaimedAt: current.claimed_at },
  );
  return newCount;
}

// ─── soft-CAS claim ──────────────────────────────────────────────────────────

// claimTicket — the soft compare-and-set that is the actual cross-host mutex.
//   1. read the current claim → currentGen = current?.generation ?? 0
//   2. nextGen = currentGen + 1 (1 when nothing is held; a takeover bumps past
//      the dead owner's generation — the monotonic FENCING TOKEN)
//   3. writeClaim with owner_host = hostName, generation = nextGen
//   4. read it BACK and declare won iff the readback shows OUR owner AND OUR
//      generation. A concurrent host that wrote last shows a different owner (or
//      a higher generation) → won:false → back off.
//
// hostName is a PARAMETER (this lib never imports config — that keeps it pure
// and PR-order-independent; the caller threads in catalyst.host.name).
// Returns { won, generation } where generation is the gen we attempted to claim.
// staleMs and now are injectable seams for unit testing (no Date.now() in tests).
// CTL-863 fleet-unfreeze (entourage): `issueId` is an OPTIONAL pre-resolved UUID
// override, threaded straight through to both writeClaim call sites below (see
// writeClaim's own doc comment) — NOT applied to the readClaim CAS reads above/below,
// which must stay live: they are the actual fencing correctness check, not an
// immutable identifier→UUID mapping, so caching them would risk a false win/lose.
export async function claimTicket(
  ticket,
  hostName,
  phase,
  {
    post = defaultPost,
    transport = null,
    staleMs = CLAIM_STALE_MS_DEFAULT,
    now = () => Date.now(),
    issueId = null,
  } = {},
) {
  const current = await readClaim(ticket, { post, transport });
  const nextGen = (current?.generation ?? 0) + 1;

  // CTL-1297: stale cross-host preemption. If a claim is held by a DIFFERENT host
  // and is older than staleMs, it is an abandoned claim left by a host that used to
  // own this ticket under a prior roster. The HRW pre-filter guarantees only the
  // legitimate owner reaches here, so write unconditionally and skip the
  // write→read-back race the orphan depends on. A missing/unparseable claimed_at
  // is treated as NOT stale (conservative) → fall through to the soft-CAS.
  if (current && current.owner_host && current.owner_host !== hostName) {
    const claimedAtMs = current.claimed_at ? Date.parse(current.claimed_at) : NaN;
    if (Number.isFinite(claimedAtMs) && now() - claimedAtMs > staleMs) {
      await writeClaim(
        ticket,
        { owner_host: hostName, generation: nextGen, phase },
        { post, transport, issueId },
      );
      return { won: true, generation: nextGen };
    }
  }

  // Normal soft-CAS (unchanged): write then read-back; a concurrent host that
  // wrote last wins the read-back and we back off.
  await writeClaim(
    ticket,
    { owner_host: hostName, generation: nextGen, phase },
    { post, transport, issueId },
  );
  const readback = await readClaim(ticket, { post, transport });
  const won = readback?.owner_host === hostName && readback?.generation === nextGen;
  return { won, generation: nextGen };
}

// ─── fencing predicate ───────────────────────────────────────────────────────

// isFenceCurrent — the cross-host fencing check a worker calls BEFORE any
// side-effect (PR push, comment, Linear transition). true ⇒ the ticket's current
// claim generation still equals the generation this worker holds → proceed.
// false ⇒ a takeover bumped the generation past us (we're a stale zombie) →
// abort the side-effect. A missing claim (null) yields false — there is nothing
// authorising our generation, so the conservative answer is "not current".
export async function isFenceCurrent(ticket, generation, { post = defaultPost, transport = null } = {}) {
  const current = await readClaim(ticket, { post, transport });
  return current?.generation === generation;
}

// ─── lease-authority refusable claim (CTL-1786) ──────────────────────────────
//
// The parallel claim path to `claimTicket`, backed by the cloud lease authority instead of the
// Linear-attachment soft-CAS. It returns the EXACT same public contract — `{won, generation}`,
// throw-on-terminal-failure — so `runCli` slots it in behind the env gate with no caller change.
//
// The whole point is that the store can REFUSE: a `lease_held` refusal is a definitive "a peer
// won", returned as `{won:false}` with NO retry (silent backoff, AC-1). A `not_entitled` refusal
// self-heals ONCE — (re-)entitle the node then re-claim — because entitlement lapses on a DO reset
// and must not fail the phase. A transient transport error is bounded-retried; anything terminal
// (auth, malformed grant, exhausted retries) THROWS, so `runCli` yields exit 11 (a stall, not a
// lost race) exactly like the attachment path.

/** Bounded transient-retry cap. The real backoff is the next dispatch sweep; this only rides out a blip. */
export const LEASE_CLAIM_MAX_RETRIES = 2;

/**
 * claimViaLease — refusable claim through an injected lease `client`.
 *
 * `client` is the `createLeaseAuthorityClient` shape (`{claim, entitle, ...}`), injectable so the
 * two Gherkin ACs run against a fake single-winner authority with no network. `hostName` is the
 * node identity the store attributes the lease to (its `node`). Returns `{won, generation}`;
 * `generation` is the grant nonce on a win (the drop-in fence-guard equality token) and null on a
 * loss.
 */
export async function claimViaLease({
  ticket,
  phase,
  hostName,
  client,
  ttlMs = DEFAULT_WORK_TTL_MS,
  workTtlMs = DEFAULT_WORK_TTL_MS,
  budgetUsd = null,
  maxRetries = LEASE_CLAIM_MAX_RETRIES,
  ensureEntitled = defaultEnsureEntitled,
}) {
  if (!client) throw new LeaseAuthorityError("no-lease-client", { retryable: false });
  let entitleAttempted = false;
  let transientRetries = 0;
  for (;;) {
    let res;
    try {
      res = await client.claim({ ticket, phase, node: hostName, ttlMs });
    } catch (err) {
      // Only a retryable transport blip is retried, and only up to the cap; a terminal error
      // (auth, 4xx, malformed grant) is surfaced immediately so the CLI stalls loudly (exit 11).
      if (err?.retryable && transientRetries < maxRetries) {
        transientRetries += 1;
        continue;
      }
      throw err;
    }
    if (res.won) return { won: true, generation: res.generation };
    // A `not_entitled` refusal self-heals exactly once: (re-)entitle then re-claim. A second
    // one (entitlement did not take) falls through to the silent-backoff return below rather
    // than looping forever.
    if (res.refusal === "not_entitled" && !entitleAttempted) {
      entitleAttempted = true;
      try {
        ensureEntitled({ client, node: hostName, workTtlMs, budgetUsd });
      } catch (err) {
        if (err?.retryable && transientRetries < maxRetries) {
          transientRetries += 1;
        } else {
          throw err;
        }
      }
      continue;
    }
    // lease_held, a repeat not_entitled, or any other refusal → a peer won. Silent backoff.
    return { won: false, generation: null };
  }
}

/**
 * defaultLeaseClient — construct the production lease client from this process's env. Built here
 * (not read from an install slot) for the same reason `defaultTransport` builds the write proxy
 * locally: this module runs as a spawnSync child, so any process-wide slot is empty in it.
 */
export function defaultLeaseClient(env = process.env) {
  return createLeaseAuthorityClient({ env });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// A thin argv shim so the SYNCHRONOUS daemon (scheduler.mjs / monitor.mjs) can
// drive these async claim/fence functions through spawnSync — the same
// sync-subprocess convention the daemon already uses for its Linear writes
// (linear-write.mjs shells linear-transition.sh). cluster-claim-sync.mjs is the
// in-process wrapper that spawnSync's `node cluster-claim.mjs <cmd> …`.
//
// runCli is exported (with an injectable `post`) so the CLI surface is unit
// tested without the network; the main-guard below calls it with the real post.
//
//   claim <ticket> <host> <phase> [issueId]  → stdout JSON; the optional 4th arg is a
//                                    pre-resolved ticket UUID (CTL-863 follow-up —
//                                    see claimTicket/writeClaim). THREE outcomes,
//                                    each separable by the caller (CTL-2033):
//                                      exit 0  + {won:true,  generation}  → we hold the fence
//                                      exit 0  + {won:false, generation}  → the soft-CAS RAN
//                                                    and a peer won the read-back (normal)
//                                      exit 11 + {won:false, error:{reason,message}}
//                                                  → the soft-CAS NEVER RAN (refused write,
//                                                    auth failure, GraphQL error) — a stall,
//                                                    not a race.
//   fence-check <ticket> <gen>     → stdout JSON {current}; exit 0 when current,
//                                    FENCE_STALE_EXIT (10) when stale — mirrors
//                                    claim.mjs's host-local fence-check contract.
//   resolve-issue-id <ticket>      → stdout JSON {issueId}; exit 0. Standalone
//                                    identifier→UUID resolution (CTL-863 follow-up)
//                                    so cluster-claim-sync.mjs's permanent cache can
//                                    populate itself with one small subprocess call
//                                    instead of the resolution being buried inside
//                                    every `claim`.
const FENCE_STALE_EXIT = 10;

// CLAIM_FAILED_EXIT — CTL-2033. The `claim` subcommand's THIRD outcome, and the
// one that had no representation at all: the soft-CAS never ran. Before this,
// `claimTicket` throwing (a refused proxy write, a 401, a GraphQL error) fell to
// the module's top-level catch, which printed the message to stderr and exited 1
// — while a peer legitimately winning the fence exited 0 with `{won:false}`. The
// synchronous wrapper collapsed BOTH into `{won:false, generation:null}`, so
// "another host owns this" and "our claim write never landed" were the same
// value. Measured 2026-08-18: 36 held tickets across both minis reported a lost
// claim on tickets they OWN under HRW — impossible as a race, and invisible as a
// failure.
//
// A distinct exit code (mirroring FENCE_STALE_EXIT's convention) plus a
// machine-readable `error.reason` on STDOUT is what makes the two separable
// WITHOUT scraping stderr prose. The reason string is the transport's own
// (`budget:day-exhausted`, `no-cloud-token`, `write-not-succeeded`, …), passed
// through unchanged so the operator reads the same word the proxy logged.
const CLAIM_FAILED_EXIT = 11;

/**
 * defaultTransport — build the transport this PROCESS should use. CTL-1889 increment 3.
 *
 * ⛔ WHY THE PROXY IS CONSTRUCTED HERE AND NOT READ FROM THE INSTALL SLOT.
 * `linear-write-proxy-install.mjs` holds a PROCESS-WIDE slot the daemon fills at startup.
 * This module is not run in the daemon's process — `cluster-claim-sync.mjs` drives it by
 * `spawnSync("node cluster-claim.mjs …")`, so the slot in this child is always empty.
 * Reaching for `getLinearWriteProxy()` here would therefore find `null` on every real
 * invocation and silently fall through to the app-actor path, which would look exactly
 * like a working migration while retiring nothing. The child re-reads the mode from its
 * inherited env instead.
 *
 * ⚠️ A mode of `enforce` with no constructible proxy yields the app-actor transport, and
 * that is NOT a silent fall-back of the kind increments 1-2 forbid: `createLinearWriteProxy`
 * returns null only for a mode that is not shadow/enforce, so this branch is unreachable
 * under enforce. It is here so a future mode cannot produce an undefined transport.
 */
export function defaultTransport({ env = process.env, post = defaultPost } = {}) {
  const { mode, routes } = readLinearWriteProxyConfig(env);
  const proxy = mode === "enforce" ? createLinearWriteProxy({ mode, env, routes }) : null;
  return resolveAttachmentTransport({ mode, post, proxy, caller: "cluster-claim" });
}

export async function runCli(argv, { post = defaultPost, transport = null } = {}) {
  const t = transport ?? defaultTransport({ post });
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "claim": {
      const [ticket, hostName, phase, issueIdRaw] = rest;
      const issueId = issueIdRaw != null && issueIdRaw !== "" ? issueIdRaw : null;
      // CTL-2033: REPORT the failure instead of only throwing it. The catch is
      // scoped to `claim` alone — every other subcommand keeps the module's
      // top-level catch (stderr + exit 1) byte-for-byte. stdout stays exactly one
      // JSON line either way, so the wrapper's "take the last non-empty line"
      // parse is unchanged; stderr keeps a human line for an operator grep.
      try {
        const res = await claimTicket(ticket, hostName, phase, { post, transport: t, issueId });
        process.stdout.write(JSON.stringify(res) + "\n");
        return 0;
      } catch (err) {
        // `err.reason` is AttachmentTransportError's structured field (the proxy's
        // own refusal word). Anything else — a bare Error from `post`, a
        // programming mistake — has no reason, and is named `claim-threw` rather
        // than guessed at from its message.
        const reason = typeof err?.reason === "string" && err.reason ? err.reason : "claim-threw";
        process.stdout.write(
          JSON.stringify({ won: false, generation: null, error: { reason, message: String(err?.message ?? err) } }) + "\n",
        );
        process.stderr.write(`cluster-claim.mjs: claim failed for ${ticket}: reason=${reason}: ${err?.message ?? err}\n`);
        return CLAIM_FAILED_EXIT;
      }
    }
    case "fence-check": {
      const [ticket, gen] = rest;
      const current = await isFenceCurrent(ticket, Number(gen), { post, transport: t });
      process.stdout.write(JSON.stringify({ current }) + "\n");
      return current ? 0 : FENCE_STALE_EXIT;
    }
    case "resolve-issue-id": {
      const [ticket] = rest;
      const issueId = await resolveIssueId(ticket, { post, transport: t });
      process.stdout.write(JSON.stringify({ issueId }) + "\n");
      return 0;
    }
    case "read-triage-attempt": {
      const [ticket] = rest;
      const count = await readTriageAttemptCount(ticket, { post, transport: t });
      process.stdout.write(JSON.stringify({ count }) + "\n");
      return 0;
    }
    case "bump-triage-attempt": {
      const [ticket] = rest;
      const count = await bumpTriageAttemptCount(ticket, { post, transport: t });
      process.stdout.write(JSON.stringify({ count }) + "\n");
      return 0;
    }
    default:
      process.stderr.write(
        `cluster-claim.mjs: unknown subcommand: ${cmd ?? "(none)"}\n` +
          "usage: cluster-claim.mjs <claim <ticket> <host> <phase> [issueId] | fence-check <ticket> <gen> | resolve-issue-id <ticket> | read-triage-attempt <ticket> | bump-triage-attempt <ticket>>\n",
      );
      return 1;
  }
}

// isMain — true when run as `node cluster-claim.mjs …`, false when imported.
// Uses the suffix check (not bun-only import.meta.main) so the CLI fires under
// the daemon's node runtime, mirroring claim.mjs::isMain.
function isMain() {
  return (
    process.argv[1] &&
    (process.argv[1].endsWith("/cluster-claim.mjs") ||
      process.argv[1].endsWith("cluster-claim.mjs"))
  );
}

if (isMain()) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`cluster-claim.mjs: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
