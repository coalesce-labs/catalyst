// escalation-router.mjs — CTL-2000. The one place an instrument asks the ladder
// "who do I page for this scope?". The ladder is written verbatim in
// plugins/dev/skills/concierge/references/routing.md:
//     instrument → steward of the scope → concierge → human (as an ask)
//
// The human is NOT a value in this router: it is reachable only as an ask
// (TARGET.ASK), so no instrument can produce a direct-human page. That absence
// is the whole point — "an instrument that reaches the human directly is a
// defect" is the rule this module makes structurally impossible to violate.
//
// Pure and node:*-only (this file imports nothing at all): a bare-`node` role
// runner must load it with no node_modules, the same import-free discipline
// lib/agent-liveness.mjs established. All I/O — reading role manifests — is
// injected through deps so the policy is tested deterministically rather than
// discovered during an outage.

export const TARGET = Object.freeze({ STEWARD: "steward", CONCIERGE: "concierge", ASK: "ask" });
// NOTE: there is deliberately no TARGET.HUMAN_DIRECT — its absence is the invariant.

// "two silences ≈ 90 min → page the concierge" (routing.md). After the steward
// has been paged this many times on an item without taking a turn, the ladder
// escalates INWARD to the concierge.
export const STEWARD_TURNS_BEFORE_CONCIERGE = 2;

/**
 * Resolve the steward whose scope contains `scope`. Returns {role, scope} or null.
 *
 * TODAY: roles carry a free-text `scope` string in manifest.json, so this
 * returns null unless a manifest declares an explicit `scopeKeys` array that
 * includes `scope` — which nothing does until CTL-1974 ships the scope→steward
 * registry. That is the forward-compatible seam: CTL-1974 activates the steward
 * tier by POPULATING `scopeKeys` in each manifest, with no edit to this function
 * or any call site.
 *
 * Deps (`listRoles`, `readManifest`) are injected so this stays pure and
 * testable; a missing dep resolves to null (no steward) rather than throwing —
 * the fail direction is "fall through to the concierge", never crash the caller.
 *
 * @param {string} scope
 * @param {{listRoles?: () => string[], readManifest?: (role: string) => object|null}} [deps]
 * @returns {{role: string, scope: string}|null}
 */
export function resolveSteward(scope, { listRoles, readManifest } = {}) {
  if (!scope || typeof listRoles !== "function" || typeof readManifest !== "function") return null;
  for (const role of listRoles()) {
    const m = readManifest(role);
    const keys = Array.isArray(m?.scopeKeys) ? m.scopeKeys : [];
    if (keys.includes(scope)) return { role: m?.role ?? role, scope };
  }
  return null;
}

/**
 * Next rung of `instrument → steward → concierge → human (as an ask)`.
 *
 * `priorPages` = how many times the current steward has already been paged on
 * this item without taking a turn. `resolveSteward` is injected (a thunk that
 * takes `scope`) so this function stays pure — the Phase-2/3/4 callers wire the
 * real `role-supervisor` reader in.
 *
 * Guarantees, for ANY input, that the returned `target` is one of STEWARD,
 * CONCIERGE, or ASK — never a direct-human target (there is no such enum value).
 *
 * @returns {{target: string, steward: {role: string, scope: string}|null, tag: string}}
 */
export function nextEscalationTarget({ scope, priorPages = 0, instrument = "unknown", resolveSteward: rs } = {}) {
  const steward = typeof rs === "function" ? rs(scope) : null;
  const tag = `instrument/${instrument}`;
  if (steward && priorPages < STEWARD_TURNS_BEFORE_CONCIERGE) {
    return { target: TARGET.STEWARD, steward, tag };
  }
  // No steward today, OR the steward has had its turn(s): escalate INWARD to the
  // concierge. The human is only ever reached by the concierge filing an ask.
  return { target: TARGET.CONCIERGE, steward: steward ?? null, tag };
}
