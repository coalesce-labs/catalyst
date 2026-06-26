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
  const token = process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
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
const RESOLVE_ISSUE_QUERY = `query ResolveIssueId($id: String!) {
  issue(id: $id) { id }
}`;

// resolveIssueId — a ticket identifier (e.g. "CTL-842") → its issue UUID, or
// null when no issue matches. attachmentCreate needs the UUID, not the
// identifier. Exported for unit coverage + reuse.
export async function resolveIssueId(ticket, { post = defaultPost } = {}) {
  const data = await post(RESOLVE_ISSUE_QUERY, { id: ticket });
  return data?.issue?.id ?? null;
}

// ─── read ────────────────────────────────────────────────────────────────────

const READ_ATTACHMENTS_QUERY = `query ReadFence($id: String!) {
  issue(id: $id) { attachments { nodes { id url metadata } } }
}`;

// parseClaimMetadata — normalise an attachment's metadata into the flat claim
// record callers consume. `catalyst_generation` is coerced to a Number; a
// missing/unparseable generation becomes null so isFenceCurrent never reads a
// stale string as a match. Exported for unit coverage.
export function parseClaimMetadata(metadata) {
  const m = metadata ?? {};
  const genRaw = m.catalyst_generation;
  const generation = Number(genRaw);
  return {
    owner_host: m.owner_host ?? null,
    generation: Number.isFinite(generation) ? generation : null,
    phase: m.phase ?? null,
    claimed_at: m.claimed_at ?? null,
  };
}

// readClaim — the current claim/fence record for a ticket, or null when no
// catalyst://fence/ attachment exists. Reads issue.attachments and picks the
// node whose url starts with the fence prefix (defensive: the issue may carry
// unrelated attachments — PRs, designs). The `id`/`issueId` args double as the
// issue UUID when the caller already resolved it; a bare identifier is resolved
// transparently is NOT done here (Linear's `issue(id:)` accepts an identifier
// like "CTL-842" directly), so we pass `ticket` straight through.
export async function readClaim(ticket, { post = defaultPost } = {}) {
  const data = await post(READ_ATTACHMENTS_QUERY, { id: ticket });
  const nodes = data?.issue?.attachments?.nodes ?? [];
  const node = nodes.find((n) => typeof n?.url === "string" && n.url.startsWith(FENCE_URL_PREFIX));
  if (!node) return null;
  return parseClaimMetadata(node.metadata);
}

// ─── write / upsert ──────────────────────────────────────────────────────────

const WRITE_ATTACHMENT_MUTATION = `mutation UpsertFence($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id url metadata } }
}`;

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
export async function writeClaim(ticket, { owner_host, generation, phase }, { post = defaultPost } = {}) {
  const issueId = await resolveIssueId(ticket, { post });
  if (!issueId) {
    throw new Error(`cluster-claim: no issue found for identifier ${ticket}`);
  }
  const claimed_at = new Date().toISOString();
  const metadata = {
    owner_host,
    catalyst_generation: generation,
    phase,
    claimed_at,
  };
  const data = await post(WRITE_ATTACHMENT_MUTATION, {
    input: {
      issueId,
      title: FENCE_ATTACHMENT_TITLE,
      url: fenceUrl(ticket),
      metadata,
    },
  });
  if (!data?.attachmentCreate?.success) {
    throw new Error(`cluster-claim: attachmentCreate returned success=false for ${ticket}`);
  }
  return parseClaimMetadata(metadata);
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
export async function claimTicket(
  ticket,
  hostName,
  phase,
  { post = defaultPost, staleMs = CLAIM_STALE_MS_DEFAULT, now = () => Date.now() } = {},
) {
  const current = await readClaim(ticket, { post });
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
      await writeClaim(ticket, { owner_host: hostName, generation: nextGen, phase }, { post });
      return { won: true, generation: nextGen };
    }
  }

  // Normal soft-CAS (unchanged): write then read-back; a concurrent host that
  // wrote last wins the read-back and we back off.
  await writeClaim(ticket, { owner_host: hostName, generation: nextGen, phase }, { post });
  const readback = await readClaim(ticket, { post });
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
export async function isFenceCurrent(ticket, generation, { post = defaultPost } = {}) {
  const current = await readClaim(ticket, { post });
  return current?.generation === generation;
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
//   claim <ticket> <host> <phase>  → stdout JSON {won, generation}; exit 0 iff
//                                    the soft-CAS ran (read `won` from stdout —
//                                    a non-zero exit means the operation threw,
//                                    which the wrapper treats as won:false).
//   fence-check <ticket> <gen>     → stdout JSON {current}; exit 0 when current,
//                                    FENCE_STALE_EXIT (10) when stale — mirrors
//                                    claim.mjs's host-local fence-check contract.
const FENCE_STALE_EXIT = 10;

export async function runCli(argv, { post = defaultPost } = {}) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "claim": {
      const [ticket, hostName, phase] = rest;
      const res = await claimTicket(ticket, hostName, phase, { post });
      process.stdout.write(JSON.stringify(res) + "\n");
      return 0;
    }
    case "fence-check": {
      const [ticket, gen] = rest;
      const current = await isFenceCurrent(ticket, Number(gen), { post });
      process.stdout.write(JSON.stringify({ current }) + "\n");
      return current ? 0 : FENCE_STALE_EXIT;
    }
    default:
      process.stderr.write(
        `cluster-claim.mjs: unknown subcommand: ${cmd ?? "(none)"}\n` +
          "usage: cluster-claim.mjs <claim <ticket> <host> <phase> | fence-check <ticket> <gen>>\n",
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
