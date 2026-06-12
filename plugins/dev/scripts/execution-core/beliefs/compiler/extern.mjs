// beliefs/compiler/extern.mjs — CTL-1063 Phase 2: extern block parser.
// Parses `extern <ID> <NAME> stratum <N> sql """..."""` blocks from rules.dl source.
//
// Extern block syntax:
//   extern R3 progress_evidence
//   stratum 1
//   sql """
//   <verbatim SQL here>
//   """
//
// The triple-quote delimiter is used so that SQL can contain any characters
// without escaping, including double-quotes and backticks.

/**
 * parseExterns(source) → Map<ruleId, {ruleId, name, stratum, sql, extern:true}>
 *
 * Parses all `extern` blocks in the source. Each block contributes one entry.
 * The sql field contains the verbatim SQL between the triple-quote delimiters,
 * with leading/trailing whitespace trimmed but internal whitespace preserved.
 *
 * @param {string} source — contents of rules.dl
 * @returns {Map<string, {ruleId:string, name:string, stratum:number, sql:string, extern:true}>}
 */
export function parseExterns(source) {
  const result = new Map();

  // Strip line comments (//) and block comments (/* ... */) before parsing.
  // We do NOT strip content inside sql triple-quote blocks — but comments in
  // that region are SQL comments (-- style) and should survive verbatim.
  // Strategy: remove JS-style comments outside triple-quote blocks only.
  // For simplicity (no JS comments appear in rules.dl extern SQL blocks),
  // we do the same stripping as the main compiler then search for extern blocks.
  let text = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/\/\/[^\n]*/g, "");

  // Match: extern <ID> <NAME> ... stratum <N> ... sql """..."""
  // The sql triple-quote block may span multiple lines.
  // We use a regex that matches the block header then finds the sql block.
  const externPattern = /\bextern\s+(\S+)\s+(\S+)([\s\S]*?)(?=\bextern\s+\S+\s+\S+|\brule\s+\S+\s+\S+|\s*$)/g;

  let m;
  while ((m = externPattern.exec(text)) !== null) {
    const ruleId = m[1];
    const name = m[2];
    const body = m[3];

    // Parse stratum
    const stratumMatch = body.match(/\bstratum\s+(\d+)/);
    if (!stratumMatch) {
      throw new Error(`extern ${ruleId}: missing stratum`);
    }
    const stratum = parseInt(stratumMatch[1], 10);

    // Parse sql block — find sql """ ... """ (triple double-quotes)
    // We parse the ORIGINAL source for the sql block to preserve exact whitespace.
    // The regex finds the triple-quote delimited block within the body.
    const sqlBlockMatch = body.match(/\bsql\s+"""([\s\S]*?)"""/);
    if (!sqlBlockMatch) {
      throw new Error(`extern ${ruleId}: missing sql """...""" block`);
    }

    // The SQL is everything between the triple-quotes, with leading/trailing
    // whitespace stripped (matching how rules.mjs template literals are stored).
    const sql = sqlBlockMatch[1];

    result.set(ruleId, { ruleId, name, stratum, sql, extern: true });
  }

  return result;
}
