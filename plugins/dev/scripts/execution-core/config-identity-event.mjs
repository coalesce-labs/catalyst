// config-identity-event.mjs — CTL-2076. Surface a registry team-identity
// mismatch (CAT-52) on the unified event log, not only in doctor's advisory WARN.
//
// Zero-import leaf (no node:*, no sibling imports) so the pure builder stays
// cheap and unit-testable without booting the daemon — the same pure-core /
// thin-wiring split lane-claim.mjs itself uses.
export const CONFIG_TEAM_IDENTITY_MISMATCH = "config.registry-team-identity.mismatch";

// Pure: registry projects (from listProjects()) → operator-event objects,
// one per PROVEN mismatch (identity.matches === false). Unknown (matches ===
// null) is NOT a mismatch and is skipped — the same three-valued discipline
// teamIdentityOf and the CAT-52 doctor check use. A null / malformed entry is
// skipped without throwing.
export function buildTeamIdentityMismatchEvents(projects) {
  const out = [];
  for (const p of projects ?? []) {
    if (p?.identity?.matches !== false) continue;
    out.push({
      "event.name": CONFIG_TEAM_IDENTITY_MISMATCH,
      payload: {
        team: p.team ?? null,
        repoRoot: p.repoRoot ?? null,
        declared: p.identity?.declared ?? null,
      },
    });
  }
  return out;
}
