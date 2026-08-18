// cluster-attachment-transport.mjs — CTL-1889 increment 3 / CTC-692.
//
// The seam that lets `cluster-claim.mjs` (the fleet's soft-CAS mutex) and
// `cluster-heartbeat.mjs` (per-host liveness) reach Linear's attachment verb EITHER
// directly with this host's own app-actor (the pre-CTL-1889 path) OR through the Catalyst
// Cloud write proxy under the ONE cloud-held grant. These are the last two app-actor
// writers in execution-core; increments 1 and 2 moved the issue-field writes and comments.
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ⛔⛔ THE ONE INVARIANT THIS MODULE EXISTS TO ENFORCE: EVERY FAILURE THROWS.
// ══════════════════════════════════════════════════════════════════════════════════════
//
// Not "returns null". Not "returns an empty list". Not "returns {ok:false}". THROWS.
//
// This is not defensive style — it is the difference between a mutex and a corruption,
// and both callers depend on it in ways that are invisible at their call sites:
//
// ⛔ A READ THAT RETURNED `null`/`[]` ON FAILURE SILENTLY DOUBLE-CLAIMS. `claimTicket`
//    opens with `const current = await readClaim(ticket)` and then computes
//    `nextGen = (current?.generation ?? 0) + 1`. A failed read reported as "no claim
//    exists" therefore does not merely lose information — it RESETS THE FENCING TOKEN TO
//    1 on a ticket another host may hold at generation 7. The read-back then shows our
//    owner and our generation, so the CAS reports `won:true`, and `isFenceCurrent` starts
//    answering FALSE for the legitimate owner, which aborts the real worker mid-flight.
//    Two hosts, one ticket, no error anywhere. The direct GraphQL path gets this right
//    only because `defaultPost` throws on a non-2xx; the proxy's `send`/`read` NEVER
//    throw (they return tagged verdicts), so re-establishing the throw here is the whole
//    job of this file.
//
// ⛔ A WRITE THAT DID NOT THROW DECLARES A WIN IT NEVER EARNED. `claimTicket`'s stale
//    preemption branch is:
//        await writeClaim(...);  return { won: true, generation: nextGen };
//    There is NO read-back on that path — it is `writeClaim`'s throw, and nothing else,
//    that stands between a refused write and a host believing it owns a ticket it never
//    wrote to. A proxy result of `{applied:false, reason:"budget:day-exhausted"}` handed
//    back as a quiet no-op turns the host's own write budget into a fleet-wide
//    double-dispatch.
//
// So: `succeeded` yields a value; EVERYTHING else throws with a named reason. A caller
// that cannot distinguish "no claim" from "I could not find out" must be given the only
// safe answer, and for a claim that answer is an exception.
//
// ── ⭐ MEASURED, NOT ASSUMED: THE PROXY PATH NEEDS NO UUID RESOLUTION ──
// `cluster-claim.mjs`'s header states that `attachmentCreate` "needs the UUID, not the
// identifier", and `resolveIssueId` exists to satisfy that. Probed against the LIVE cloud
// route on 2026-08-18 from a per-host org key, that is NOT true of this path:
//
//   POST /api/v1/agent/attachment  {"issueId":"CTL-1889", url:"catalyst://probe/…", …}
//     → 200 {"outcome":"succeeded","attachment":{"id":"d9918a35-…", …}}
//   POST again, SAME url, metadata {n:2}
//     → 200 same id "d9918a35-…", metadata replaced      ← the upsert, re-verified
//   GET  /api/v1/agent/attachments?issueId=CTL-1889
//     → 200 exactly ONE node at that url, metadata intact ← the read-back
//
// So the proxy transport passes the IDENTIFIER through unchanged and performs no
// resolution at all. ⭐ That is not a micro-optimisation: `resolveIssueId` is a third
// Linear call, and the only credential-free way to answer it on-host would be the
// freshness-gated replica resolver — which would couple every cluster claim to the
// replica writer's heartbeat, so a dead replica writer would stop the fleet from
// claiming ANY ticket. Passing the identifier removes that coupling entirely.
//
// ⚠️ The stale header note in `cluster-claim.mjs` is corrected in place rather than left
// to be re-derived. If the identifier form ever stops working the failure is LOUD (a
// `rejected` outcome → a throw → a lost claim → the host backs off), never silent.
//
// ── ⚠️ WHAT STAYS THE SAME, AND WHY THAT MATTERS FOR REVIEW ──
// The GraphQL transport below is the pre-existing code path, moved and not rewritten: it
// calls the same `post` seam with the same three documents. Every existing test that
// injects `post` therefore exercises it unchanged, which is what makes the claim "the
// direct path is byte-equivalent" checkable rather than asserted.

import { PROXY_ROUTE_IDS, READ_ROUTE_IDS } from "./linear-write-proxy.mjs";

/** The fence/heartbeat write route id and the read-back route id, as DATA. */
export const ATTACHMENT_WRITE_ROUTE = "attachment";
export const ATTACHMENT_READ_ROUTE = "attachments";

// A boot-time assertion rather than a comment: if either id is dropped from the proxy
// module's frozen sets, this fails at import with a name — instead of every cluster claim
// failing at runtime with `unknown-route`, which reads like a cloud outage.
if (!PROXY_ROUTE_IDS.includes(ATTACHMENT_WRITE_ROUTE)) {
  throw new Error(
    `cluster-attachment-transport: "${ATTACHMENT_WRITE_ROUTE}" is not in PROXY_ROUTE_IDS`
  );
}
if (!READ_ROUTE_IDS.has(ATTACHMENT_READ_ROUTE)) {
  throw new Error(
    `cluster-attachment-transport: "${ATTACHMENT_READ_ROUTE}" is not in READ_ROUTE_IDS`
  );
}

/**
 * The error every failure in this module raises. A distinct class (rather than a bare
 * Error) so a caller CAN tell a transport refusal from a programming mistake — while the
 * default handling for both stays the same: fail the claim, back off.
 */
export class AttachmentTransportError extends Error {
  constructor(reason, { route = null, ticket = null, detail = null } = {}) {
    const where = [route && `route=${route}`, ticket && `ticket=${ticket}`, detail && `detail=${detail}`]
      .filter(Boolean)
      .join(" ");
    // ⚠️ `no-issue` KEEPS ITS ORIGINAL WORDING — "no issue found for identifier <t>". Both
    // cluster test suites assert on /no issue found/, and more importantly an operator
    // grepping host logs for that phrase has been able to find this failure since CTL-1363.
    // A tidier message would have been a silent break in the one string humans use.
    // Same rule for `write-not-succeeded`: both cluster suites (and any operator grep) look
    // for "success=false", the string this failure has printed since the modules were written.
    const preserved = {
      "no-issue": `no issue found for identifier ${ticket}`,
      "write-not-succeeded": `attachmentCreate success=false for ${ticket}`,
    };
    const text = `cluster-attachment: ${preserved[reason] ?? reason}${where ? ` (${where})` : ""}`;
    super(text);
    this.name = "AttachmentTransportError";
    this.reason = reason;
    this.route = route;
    this.ticket = ticket;
  }
}

// ─── the direct GraphQL transport (pre-CTL-1889, unchanged behaviour) ────────────────

// ⚠️ THE OPERATION NAMES ARE `ReadFence` / `UpsertFence` AND MUST STAY THAT WAY. These three
// documents are lifted VERBATIM from `cluster-claim.mjs` and `cluster-heartbeat.mjs`, which
// carried byte-identical copies of them (the modules' no-cross-import rule). Both test suites
// discriminate the mocked `post` calls by matching on the operation NAME, so renaming these to
// something more descriptive silently routes every mocked call to the "unexpected query" branch
// — which is how this was caught. The name is part of the contract, not a label.
const RESOLVE_ISSUE_QUERY = `query ResolveIssueId($id: String!) {
  issue(id: $id) { id }
}`;

const READ_ATTACHMENTS_QUERY = `query ReadFence($id: String!) {
  issue(id: $id) { attachments { nodes { id url metadata } } }
}`;

const WRITE_ATTACHMENT_MUTATION = `mutation UpsertFence($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id url metadata } }
}`;

/**
 * createGraphqlAttachmentTransport — talks to Linear directly with this host's own
 * app-actor, via the injected `post`. `post` already throws on a transport error, a
 * non-2xx, or a GraphQL `errors[]` body, so the throw-on-failure invariant holds here by
 * inheritance; the only additions are the two cases `post` cannot see (a missing issue,
 * and `success:false`).
 */
export function createGraphqlAttachmentTransport({ post }) {
  return {
    via: "app-actor",

    async resolveIssueId(ticket) {
      const data = await post(RESOLVE_ISSUE_QUERY, { id: ticket });
      return data?.issue?.id ?? null;
    },

    async readAttachments(ticket) {
      const data = await post(READ_ATTACHMENTS_QUERY, { id: ticket });
      // ⛔ `issue` absent is NOT "no attachments" — it is "we did not get an answer about
      // this issue", and the two must not collapse. See the module header.
      if (!data?.issue) {
        throw new AttachmentTransportError("no-issue", { ticket, route: "graphql" });
      }
      return data.issue.attachments?.nodes ?? [];
    },

    async upsertAttachment({ ticket, issueId, url, title, metadata }) {
      const resolved = issueId || (await this.resolveIssueId(ticket));
      if (!resolved) {
        throw new AttachmentTransportError("no-issue", { ticket, route: "graphql" });
      }
      const data = await post(WRITE_ATTACHMENT_MUTATION, {
        input: { issueId: resolved, title, url, metadata },
      });
      if (!data?.attachmentCreate?.success) {
        throw new AttachmentTransportError("write-not-succeeded", { ticket, route: "graphql" });
      }
      return data.attachmentCreate.attachment ?? null;
    },
  };
}

// ─── the cloud write-proxy transport (CTL-1889 increment 3) ──────────────────────────

/**
 * createProxyAttachmentTransport — every attachment read and write goes to the Catalyst
 * Cloud proxy under the per-host cloud key. No Linear credential is used, resolved, or
 * required on this path.
 *
 * ⛔ NO FALL-BACK TO THE APP-ACTOR ON FAILURE, for the reason increments 1 and 2 give: a
 * fall-back means the host keeps writing with its own app-actor exactly when the proxy is
 * broken, so the shadow window that gates retirement would read "zero host-originated
 * writes" while the host was still writing. A failure here is a failure.
 */
export function createProxyAttachmentTransport({ proxy, caller = "cluster-attachment" }) {
  if (!proxy || typeof proxy.send !== "function" || typeof proxy.read !== "function") {
    throw new AttachmentTransportError("no-proxy");
  }
  return {
    via: "proxy",

    /**
     * ⭐ The identity function, and deliberately so — see the module header's measurement.
     * Kept as a method rather than deleted from the interface so the two transports stay
     * substitutable and `cluster-claim.mjs`'s `resolve-issue-id` CLI verb keeps answering.
     */
    async resolveIssueId(ticket) {
      return ticket;
    },

    async readAttachments(ticket) {
      const res = proxy.read({
        routeId: ATTACHMENT_READ_ROUTE,
        ticket,
        query: { issueId: ticket },
        caller,
      });
      // ⛔ THE LOAD-BEARING LINE OF THIS FILE. `read` reports a refusal as `{ok:false}`;
      // returning `[]` here would tell `claimTicket` that no host holds this ticket.
      if (!res?.ok) {
        throw new AttachmentTransportError(res?.reason ?? "read-refused", {
          ticket,
          route: ATTACHMENT_READ_ROUTE,
          detail: res?.status ?? null,
        });
      }
      return res.attachments;
    },

    async upsertAttachment({ ticket, issueId, url, title, metadata }) {
      const res = proxy.send({
        routeId: ATTACHMENT_WRITE_ROUTE,
        ticket,
        // The identifier is accepted by the live route (header measurement); a caller that
        // already holds a UUID may still pass one and it is used verbatim.
        payload: { issueId: issueId || ticket, url, title, metadata },
        caller,
      });
      // ⛔ THE OTHER LOAD-BEARING LINE. `send` returns `{applied:false}` for a budget
      // refusal, a 5xx, a rejected body and a missing credential alike. `claimTicket`'s
      // stale-preemption branch returns `won:true` with NO read-back, so a non-throwing
      // failed write is a claim the host never made and believes it holds.
      if (!res?.handled || res.applied !== true) {
        throw new AttachmentTransportError(res?.reason ?? "write-refused", {
          ticket,
          route: ATTACHMENT_WRITE_ROUTE,
          detail: res?.detail ?? null,
        });
      }
      return null;
    },
  };
}

/**
 * resolveAttachmentTransport — pick the transport for one call.
 *
 * `enforce` → the proxy, with NO fall-back. `off` and `shadow` → the direct app-actor
 * path, unchanged.
 *
 * ⚠️ SHADOW DOES NOT DOUBLE-WRITE HERE, and that is a departure from how shadow reads
 * elsewhere in this repo. For an idempotent upsert a second write would be harmless, but
 * `claimTicket` is a CAS: writing the claim twice through two different credentials would
 * make the host race ITSELF, and the read-back would then be deciding between two of its
 * own writes. Shadow therefore observes via the proxy's own `send` accounting on the
 * routes that already support it and leaves this path alone.
 */
export function resolveAttachmentTransport({ mode = "off", post, proxy = null, caller } = {}) {
  if (mode === "enforce" && proxy) return createProxyAttachmentTransport({ proxy, caller });
  return createGraphqlAttachmentTransport({ post });
}
