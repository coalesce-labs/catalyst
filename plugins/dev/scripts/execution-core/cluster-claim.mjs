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

const RESOLVE_ISSUE_QUERY = `query ResolveIssueId($id: String!) {
  issues(filter: { identifier: { eq: $id } }) { nodes { id } }
}`;

// resolveIssueId — a ticket identifier (e.g. "CTL-842") → its issue UUID, or
// null when no issue matches. Mirrors lib/linear-comment-post.sh's resolution
// (issues filter on identifier.eq). attachmentCreate needs the UUID, not the
// identifier. Exported for unit coverage + reuse.
export async function resolveIssueId(ticket, { post = defaultPost } = {}) {
  const data = await post(RESOLVE_ISSUE_QUERY, { id: ticket });
  return data?.issues?.nodes?.[0]?.id ?? null;
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
export async function claimTicket(ticket, hostName, phase, { post = defaultPost } = {}) {
  const current = await readClaim(ticket, { post });
  const nextGen = (current?.generation ?? 0) + 1;
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
