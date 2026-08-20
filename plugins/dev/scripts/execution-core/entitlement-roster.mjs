// entitlement-roster.mjs — CTL-1785. The shadow/enforce roster-resolution logic
// behind config.mjs::getEntitledHosts(). Split out of config.mjs so config.mjs
// stays import-light. In `off` mode config.mjs short-circuits before ever calling
// this, so this file is only reached in shadow/enforce.
//
// It imports the zero-import entitlement leaf (VERDICT) and the event-name
// registry, but MUST NOT import config.mjs (that would be a cycle — config.mjs
// imports this). The event-append SEAM (`emit`) is injected by config.mjs, which
// owns getEventLogPath; this file never resolves the log path itself.
//
// Phase status:
//   Phase 3 (this): shadow branch emits `entitlement.would-shed.<host>` for every
//                   unentitled rostered host but STILL returns the full roster.
//   Phase 4: enforce branch actually sheds unentitled hosts (self always admitted;
//            total-outage degrades to the full roster) and emits `entitlement.shed.*`.

import { VERDICT } from "../lib/entitlement.mjs";
import { ENTITLEMENT_WOULD_SHED } from "./entitlement-event.mjs";

// safeCheck — provider.check is contractually total (fail direction ENTITLED), but
// an INJECTED provider (W12's authority, a test double) may throw. A throw here
// must never shed and never break roster resolution, so it degrades to ENTITLED.
function safeCheck(provider, arg) {
  try {
    const v = provider?.check?.(arg);
    if (v && typeof v.verdict === "string") return v;
  } catch {
    /* fall through to fail-open */
  }
  return { verdict: VERDICT.ENTITLED, reason: "provider-threw-or-malformed" };
}

/**
 * resolveEntitledRoster — given the raw existence roster and an entitlement
 * provider, return the roster dispatch/recovery should hash HRW over.
 *
 * Never throws; fail direction preserves the full roster (today's behavior).
 *
 * @param {object} args
 * @param {"off"|"shadow"|"enforce"} args.mode
 * @param {{ ttlMs:number, check:Function }} args.provider
 * @param {string[]} args.hosts   the raw existence roster
 * @param {string} args.self      this host's name
 * @param {(name:string, payload:object)=>void} [args.emit]  event-append seam
 * @returns {string[]}
 */
export function resolveEntitledRoster({ mode, provider, hosts, self, emit } = {}) {
  // Fail-open guard: a malformed roster preserves whatever was passed.
  if (!Array.isArray(hosts)) return hosts;

  if (mode === "shadow") {
    // Observe would-shed, change NOTHING (the safe dry-run — mirrors CTL-1609
    // delegate-first shadow). Emit one `entitlement.would-shed.<host>` per
    // unentitled rostered host, then return the FULL roster unchanged.
    for (const host of hosts) {
      const v = safeCheck(provider, { host, roster: hosts });
      if (v.verdict === VERDICT.UNENTITLED && typeof emit === "function") {
        emit(`${ENTITLEMENT_WOULD_SHED}.${host}`, {
          host,
          self,
          reason: v.reason,
          mode,
          roster_size: hosts.length,
        });
      }
    }
    return hosts;
  }

  // Phase 4 wires the enforce branch (shed + self-always-admitted + degrade); until
  // then enforce is behavior-neutral too (returns the full roster).
  return hosts;
}
