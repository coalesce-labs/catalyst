// beliefs/compiler/cfg-consumers.mjs — CTL-1063 Phase 5
// Extracts cfg key names referenced in a SQL string.
//
// Two forms handled:
//   Direct:  ... ON c.key = 'keyname' ...
//   CASE:    JOIN cfg win ON win.key = CASE WHEN ... THEN 'k1' ELSE 'k2' END
//
// Returns deduplicated array in first-occurrence order.

/**
 * cfgConsumers(sql) — extract cfg key names from SQL by regex scanning.
 *
 * @param {string} sql
 * @returns {string[]} deduplicated cfg key names in first-occurrence order
 */
export function cfgConsumers(sql) {
  const keys = [];
  const seen = new Set();

  function add(k) {
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }

  // 1. Direct form: .key = 'keyname'
  //    Matches: <alias>.key = 'value'  (where value contains word chars, underscores, hyphens)
  const directRe = /\.\s*key\s*=\s*'([^']+)'/g;
  let m;
  while ((m = directRe.exec(sql)) !== null) {
    add(m[1]);
  }

  // 2. CASE form: .key = CASE WHEN ... THEN 'k1' ... ELSE 'k2' END
  //    Find CASE blocks that follow a .key = CASE pattern, then extract
  //    only THEN/ELSE branch values (not the WHEN conditions which may
  //    contain phase names or other non-key strings).
  const caseRe = /\.\s*key\s*=\s*CASE([\s\S]*?)END/gi;
  while ((m = caseRe.exec(sql)) !== null) {
    const caseBody = m[1];
    // Extract only THEN 'value' and ELSE 'value' literals (not WHEN conditions)
    const thenElseRe = /\b(?:THEN|ELSE)\s+'([^']+)'/gi;
    let lit;
    while ((lit = thenElseRe.exec(caseBody)) !== null) {
      add(lit[1]);
    }
  }

  return keys;
}
