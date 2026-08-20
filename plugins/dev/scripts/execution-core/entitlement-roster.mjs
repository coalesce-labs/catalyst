// entitlement-roster.mjs — CTL-1785. The shadow/enforce roster-resolution logic
// behind config.mjs::getEntitledHosts(). Split out of config.mjs so config.mjs
// stays import-light: Phase 3 gives this file the would-shed emit seam and Phase 4
// the actual shedding + self-always-admitted + total-outage degrade. In `off`
// mode config.mjs short-circuits before ever calling this, so this file is only
// reached in shadow/enforce.
//
// It imports the zero-import entitlement leaf (VERDICT) but MUST NOT import
// config.mjs (that would be a cycle — config.mjs imports this).
//
// Phase 2 status: this is a behavior-neutral STUB — it returns `hosts` unchanged
// for every mode, so reclassifying callers is provably a no-op until Phase 3/4
// light up the shadow/enforce branches.

import { VERDICT } from "../lib/entitlement.mjs";

/**
 * resolveEntitledRoster — given the raw existence roster and an entitlement
 * provider, return the roster that dispatch/recovery should hash HRW over.
 *
 * Phase 2 (this file): returns `hosts` unchanged for all modes.
 * Phase 3: shadow branch emits `entitlement.would-shed.<host>` for unentitled
 *          rostered hosts but still returns the full roster.
 * Phase 4: enforce branch actually sheds unentitled hosts (self always admitted;
 *          total-outage degrades to the full roster) and emits `entitlement.shed.*`.
 *
 * Never throws; fail direction preserves the full roster (today's behavior).
 *
 * @param {object} args
 * @param {"off"|"shadow"|"enforce"} args.mode
 * @param {{ ttlMs:number, check:Function }} args.provider
 * @param {string[]} args.hosts   the raw existence roster
 * @param {string} args.self      this host's name
 * @returns {string[]}
 */
export function resolveEntitledRoster({ mode, provider, hosts, self } = {}) {
  // Fail-open guard: a malformed roster preserves whatever was passed.
  if (!Array.isArray(hosts)) return hosts;
  // VERDICT is referenced here so the import is load-bearing from Phase 2 (Phase 3
  // uses it in the shadow branch); reference it in a no-op guard rather than
  // leaving an unused import that knip would flag.
  void VERDICT;
  void mode;
  void provider;
  void self;
  return hosts;
}
