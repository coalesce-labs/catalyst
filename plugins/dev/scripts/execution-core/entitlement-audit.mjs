// entitlement-audit.mjs — CTL-1785 Phase 3. The W13 acceptance-query surface:
// "an observable event and an absence" (plan §Desired End State).
//
// A PURE fold over the unified event log that answers two coupled questions:
//   - ABSENCE          — how many tickets have a live work-lease held by a host
//                        with NO current entitlement? (the invariant: this is 0)
//   - POSITIVE CONTROL — how many tickets have a live lease held by an ENTITLED
//                        host? (must be > 0 when work exists — proves the query
//                        can see a hit, per the "run a positive control first"
//                        house rule + [[2026-07-05-board-scan-measurement-gotchas]])
//
// A bare zero is NOT evidence: when there are no live leases at all the query
// CANNOT see a hit, so it returns `inconclusive: true` rather than a misleading
// `absence: 0`. This is the exact false-clean trap the house rule guards against.
//
// Zero-import beyond the verified event-name boundary — it must fold a raw log
// without pulling config.mjs's heavy graph. Deliberately does NOT read cluster.json
// or any live roster: entitlement is derived from the LOG (entitlement.shed /
// entitlement.restored), so the audit measures what actually happened, not what a
// roster currently claims.

import { getEventName } from "../lib/event-name.mjs";
import { ENTITLEMENT_SHED, ENTITLEMENT_RESTORED } from "./entitlement-event.mjs";

// payloadOf — the flat payload for a v2/v3 envelope: body.payload (v2 superset) or
// the flat top-level object (v3 bare-name). Never throws.
function payloadOf(ev) {
  if (ev && typeof ev === "object") {
    if (ev.body && typeof ev.body === "object" && ev.body.payload && typeof ev.body.payload === "object") {
      return ev.body.payload;
    }
    return ev;
  }
  return {};
}

// hostFromEntitlementName — the `<host>` suffix of `entitlement.shed.<host>` /
// `entitlement.restored.<host>`. Prefer the payload's explicit `host` (exact),
// fall back to the name suffix.
function hostFromEntitlementName(name, base, pl) {
  if (typeof pl.host === "string" && pl.host) return pl.host;
  if (typeof name === "string" && name.startsWith(base + ".")) return name.slice(base.length + 1);
  return null;
}

// ownerHostOf — the lease-holder host on a fence.claimed event: payload.owner_host
// (canonical) or the attribute mirror `catalyst.host.name`.
function ownerHostOf(ev, pl) {
  if (typeof pl.owner_host === "string" && pl.owner_host) return pl.owner_host;
  const attrHost = ev?.attributes?.["catalyst.host.name"];
  return typeof attrHost === "string" && attrHost ? attrHost : null;
}

/**
 * auditEntitlementLeases — fold an ordered array of parsed event objects.
 *
 * Lease holders: `fence.claimed.<ticket>` sets a ticket's owner host;
 * `fence.released.<ticket>` clears it (owner_host:null). Last write wins in log
 * order.
 *
 * Entitlement: a host is "currently unentitled" iff its most recent entitlement
 * event is `entitlement.shed.<host>` with no later `entitlement.restored.<host>`.
 * A host never named in a shed/restored event is presumed ENTITLED (the fail
 * direction — the whole point of this ticket is that being unentitled is an
 * explicit, observed fact, never an inference from silence).
 *
 * @param {object[]} events  parsed log events in log order
 * @returns {{ absence:number, positiveControl:number, inconclusive:boolean,
 *             reason:string, heldTickets:number, shedHolders:string[] }}
 */
export function auditEntitlementLeases(events) {
  if (!Array.isArray(events)) {
    return {
      absence: 0,
      positiveControl: 0,
      inconclusive: true,
      reason: "events-not-an-array",
      heldTickets: 0,
      shedHolders: [],
    };
  }

  const leaseHolder = new Map(); // ticket -> owner host (or null once released)
  const shed = new Set(); // hosts currently shed (unentitled)

  for (const ev of events) {
    const name = getEventName(ev);
    if (typeof name !== "string" || name === "") continue;
    const pl = payloadOf(ev);

    if (name.startsWith("fence.claimed.")) {
      const ticket = name.slice("fence.claimed.".length);
      const host = ownerHostOf(ev, pl);
      if (ticket) leaseHolder.set(ticket, host);
    } else if (name.startsWith("fence.released.")) {
      const ticket = name.slice("fence.released.".length);
      if (ticket) leaseHolder.set(ticket, null);
    } else if (name.startsWith(ENTITLEMENT_SHED + ".")) {
      const host = hostFromEntitlementName(name, ENTITLEMENT_SHED, pl);
      if (host) shed.add(host);
    } else if (name.startsWith(ENTITLEMENT_RESTORED + ".")) {
      const host = hostFromEntitlementName(name, ENTITLEMENT_RESTORED, pl);
      if (host) shed.delete(host);
    }
  }

  let absence = 0;
  let positiveControl = 0;
  let heldTickets = 0;
  const shedHolders = [];
  for (const [ticket, host] of leaseHolder) {
    if (!host) continue; // released — no live lease
    heldTickets++;
    if (shed.has(host)) {
      absence++;
      shedHolders.push(ticket);
    } else {
      positiveControl++;
    }
  }

  // A zero over zero live leases cannot see a hit → inconclusive, never a clean 0.
  const inconclusive = heldTickets === 0;
  return {
    absence,
    positiveControl,
    inconclusive,
    reason: inconclusive ? "no-live-leases-in-log" : "ok",
    heldTickets,
    shedHolders,
  };
}
