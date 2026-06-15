// beliefs/shadow-store.mjs — CTL-935: shared writer for the shadow_comparison
// durable corpus. One INSERT OR IGNORE per comparison (agree and disagree) keyed
// by (tick_id, dimension, subject). Object-valued fields are JSON-encoded.
// Shadow failure contract: NEVER throws — any db error returns 0 silently.

export function recordShadowComparison(db, {
  tickId,
  dimension,
  subject,
  agree,
  procedural = null,
  belief = null,
  differingInput = null,
  legacyGuard = null,
  ruleId = null,
  rulesSha = null,
} = {}) {
  try {
    if (!db) return 0;
    const enc = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v ?? null);
    db.prepare(
      `INSERT OR IGNORE INTO shadow_comparison
         (tick_id, dimension, subject, agree, procedural, belief,
          differing_input, legacy_guard, rule_id, rules_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tickId,
      dimension,
      subject,
      agree ? 1 : 0,
      enc(procedural),
      enc(belief),
      enc(differingInput),
      legacyGuard ?? null,
      ruleId ?? null,
      rulesSha ?? null,
    );
    return 1;
  } catch {
    return 0;
  }
}
