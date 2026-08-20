// entitlement-revoke.mjs — CTL-1785 Phase 4. The ordering-constraint TEETH.
//
// The load-bearing rule (from the ticket): losing entitlement MUST revoke the
// work leases this host holds — otherwise work sits held by an unentitled node,
// invisible to a reclaim loop that iterates roster members (an orphan by
// construction). This module is that revoke.
//
// It is the FIRST production caller of emitFenceReleased (fence-event.mjs), which
// existed but was imported only by its own test — a `fence.released` reconciler
// designed and never wired. Emitting it lets router.mjs clear the fence projection
// so a reclaiming host can enumerate the freed work.
//
// FAIL-OPEN, off the critical path, never throws. Gated on `mode === "enforce"`.
// Under the default local provider self is ALWAYS entitled (self ∈ its own
// roster), so this is a guaranteed no-op today; it becomes live when W12's
// authority provider (CTL-1786) — one that can actually lapse self — is injected.
//
// Imports the zero-import entitlement leaf (VERDICT) and the fence-event emitter;
// MUST NOT import config.mjs (the daemon call site passes self/provider/tickets in).

import { VERDICT } from "../lib/entitlement.mjs";
import { emitFenceReleased } from "./fence-event.mjs";

// safeSelfCheck — provider.check is contractually total, but an injected authority
// provider may throw. A throw must NOT trigger a revoke (fail direction ENTITLED —
// never revoke work on an unanswerable authority read).
function safeSelfCheck(provider, self, roster) {
  try {
    const v = provider?.check?.({ host: self, roster });
    if (v && typeof v.verdict === "string") return v;
  } catch {
    /* fall through */
  }
  return { verdict: VERDICT.ENTITLED, reason: "provider-threw-or-malformed" };
}

/**
 * revokeLeasesOnEntitlementLoss — if self's entitlement has lapsed under an
 * enforce-mode authority, release every work lease this host holds so a
 * reclaiming host can pick them up.
 *
 * @param {object} args
 * @param {string} args.self               this host's name
 * @param {string[]} [args.ownedTickets]   tickets this host currently holds
 * @param {{ check:Function }} args.provider
 * @param {"off"|"shadow"|"enforce"} args.mode
 * @param {string[]} [args.roster]         roster passed to the provider check
 * @param {Function} [args.emitReleased]   fence.released emitter (default: the real one)
 * @param {Function} [args.append]         optional append seam threaded to emitReleased
 * @returns {{ revoked:string[], reason:string }}
 */
export function revokeLeasesOnEntitlementLoss({
  self,
  ownedTickets = [],
  provider,
  mode,
  roster = [],
  emitReleased = emitFenceReleased,
  append,
} = {}) {
  // Gated on enforce; every early return is fail-open (never throws, never blocks).
  if (mode !== "enforce") return { revoked: [], reason: "not-enforce" };
  if (typeof self !== "string" || !self) return { revoked: [], reason: "no-self" };
  if (!Array.isArray(ownedTickets) || ownedTickets.length === 0) {
    return { revoked: [], reason: "no-owned-tickets" };
  }

  const v = safeSelfCheck(provider, self, roster);
  if (v.verdict !== VERDICT.UNENTITLED) {
    // Positive control of the revoke path: a still-entitled self revokes nothing.
    return { revoked: [], reason: "self-still-entitled" };
  }

  const revoked = [];
  for (const ticket of ownedTickets) {
    try {
      // emitFenceReleased({ ticket }, opts) — Linear-free local append, never
      // throws; it returns FALSE on an append failure. Only record a ticket as
      // revoked when the release actually landed — an optimistic `revoked[]` would
      // claim a release the reclaim loop will never see (the exact orphan this
      // path exists to prevent, laundered into a false "handled").
      const ok = emitReleased({ ticket }, append ? { append } : {});
      if (ok !== false) revoked.push(ticket);
    } catch {
      /* fail-open per ticket — a failed release never blocks the others */
    }
  }
  return { revoked, reason: "self-entitlement-lapsed" };
}
