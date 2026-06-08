#!/usr/bin/env node
// hrw.mjs — Highest-Random-Weight (rendezvous) hashing for cross-host ticket
// ownership (CTL-859, PR2 of the distributed-coordination epic).
//
// DORMANT: pure, deterministic ownership math with no caller yet. CTL-850 wires
// it into the eligible-query filter so each daemon considers ONLY its own
// tickets — which kills ~80% of cross-host races for free (only one host even
// looks at a given ticket) and dissolves the smee webhook fan-out (every host
// receives every webhook but acts only on tickets it owns).
//
// HRW property set (why rendezvous, not modulo):
//   • deterministic — same (ticket, host-set) → same owner on every host, no
//     coordination needed to agree.
//   • balanced — sha1 spreads tickets roughly uniformly across hosts.
//   • minimal churn — adding/removing ONE host re-homes only that host's ~1/N
//     of tickets; every other ticket→owner mapping is undisturbed. (Modulo would
//     reshuffle nearly everything when N changes.)

import { createHash } from "node:crypto";

// score — the rendezvous weight for one (ticketId, host) pair. A stable sha1 of
// `ticketId + '|' + host`, with a numeric slice of the digest taken as the
// score. Using the first 12 hex chars (48 bits) gives a wide, collision-resistant
// score space that fits safely in a JS double (≤2^53). Deterministic across hosts
// and runs (sha1 is content-addressed, no salt). The '|' separator prevents
// boundary ambiguity (e.g. "CTL-1" + "2" vs "CTL-12" + "" hashing alike).
function score(ticketId, host) {
  const digest = createHash("sha1").update(`${ticketId}|${host}`).digest("hex");
  // 12 hex chars = 48 bits; Number.parseInt base-16 of a 12-char slice stays
  // well under Number.MAX_SAFE_INTEGER (2^53), so comparisons are exact.
  return Number.parseInt(digest.slice(0, 12), 16);
}

// ownerForTicket — the HRW owner of a ticket: argmax_host score(ticket, host)
// over the host roster. Deterministic. Ties (astronomically unlikely with a
// 48-bit score) break on the lexicographically smaller host name so every host
// still agrees. Returns null for an empty/absent roster (no owner can exist).
export function ownerForTicket(ticketId, hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const host of hosts) {
    const s = score(ticketId, host);
    if (s > bestScore || (s === bestScore && best !== null && host < best)) {
      bestScore = s;
      best = host;
    }
  }
  return best;
}

// ownedBy — does `hostName` own `ticketId` under the current roster? The
// predicate each daemon applies to its eligible set: keep a ticket iff
// ownerForTicket(...) === my host name. False when the roster is empty (no owner).
export function ownedBy(ticketId, hosts, hostName) {
  return ownerForTicket(ticketId, hosts) === hostName;
}
