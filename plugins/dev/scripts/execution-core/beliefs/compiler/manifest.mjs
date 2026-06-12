// beliefs/compiler/manifest.mjs — CTL-1063 Phase 5
// Builds the RULE_MANIFEST data structure from compiled IR + annotations + SQL.
//
// RULE_MANIFEST shape:
// {
//   strata: [{id:1, label:'S1 ground correlations', prose:'...'},...],  // 6 entries
//   rules: [{
//     rule_id: string,       // 'R1', 'R10' (merged R10a+R10b)
//     name: string,
//     stratum: number,
//     extern: boolean,       // true for R3/R8/R13/R14/R15/R16/R17
//     feeds: string[],       // @feeds annotation
//     reads: string[],       // derived from SQL: belief table names
//     negates: string[],     // derived: belief names under NOT EXISTS
//     cfg_keys: string[],    // derived by cfgConsumers
//     severity: string,
//     since: string,
//     ticket: string,
//     src: {file: 'beliefs/rules.dl', line: number},
//     arms: [{               // usually 1 arm; R10 has 2
//       arm_id: string,      // 'R1', 'R10a', 'R10b'
//       datalog: string|null, // .dl clause text (null for extern)
//       sql: string,         // executed SQL (trim'd)
//     }],
//     examples: [],          // from @example blocks
//   }],
// }

import { cfgConsumers } from "./cfg-consumers.mjs";
import { parseAnnotations } from "./annotations.mjs";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STRATA_META = [
  { id: 1, label: "S1 ground correlations",           prose: "Read obs_* EDB only; establish per-phase session, turn, heartbeat, and job-state correlations." },
  { id: 2, label: "S2 liveness verdicts",             prose: "Stratified negation over S1 beliefs; derive lease validity, expiry, wedge detection, and board-drift." },
  { id: 3, label: "S3 capacity aggregation",          prose: "Aggregate over S2 lease_valid beliefs and obs_agent to compute free_slots per host." },
  { id: 4, label: "S4 escalation ladder",             prose: "Negation over intent table; fire diagnostician wake-up, detect action_ineffective, escalate to human." },
  { id: 5, label: "S5 recursive dependency beliefs",  prose: "Transitive blocker closure (WITH RECURSIVE); derive blocker_rank, cycle_detected, and ready." },
  { id: 6, label: "S6 FSM advancement prediction",    prose: "Derive advance_to and cycle_exhausted from obs_signal/obs_verdict/obs_cycle; no negation over beliefs." },
];

/**
 * Extract belief names read (joined) in the SQL.
 * Looks for patterns: FROM belief / JOIN belief ... AND b.name = 'xxx'
 * or b.name = 'xxx' in any context.
 *
 * @param {string} sql
 * @returns {string[]} deduplicated belief names in first-occurrence order
 */
function extractReads(sql) {
  const names = [];
  const seen = new Set();
  // Match: b.name = 'xxx' or sr.name = 'xxx' etc (anything.name = 'xxx')
  const re = /\.\s*name\s*=\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); }
  }
  return names;
}

/**
 * Extract belief names negated in the SQL.
 * Looks for: NOT EXISTS (SELECT 1 FROM belief b WHERE ... AND b.name = 'xxx' ...)
 *
 * @param {string} sql
 * @returns {string[]} deduplicated negated belief names in first-occurrence order
 */
function extractNegates(sql) {
  const names = [];
  const seen = new Set();
  // Match NOT EXISTS blocks and extract b.name = 'xxx' within them
  const notExistsRe = /NOT\s+EXISTS\s*\([\s\S]*?\)/gi;
  let m;
  while ((m = notExistsRe.exec(sql)) !== null) {
    const block = m[0];
    const nameRe = /\.\s*name\s*=\s*'([^']+)'/g;
    let nm;
    while ((nm = nameRe.exec(block)) !== null) {
      if (!seen.has(nm[1])) { seen.add(nm[1]); names.push(nm[1]); }
    }
  }
  return names;
}

/**
 * Find the line number of a rule/extern declaration in the source.
 * Returns 1-indexed line number, or 0 if not found.
 *
 * @param {string} source
 * @param {string} ruleId
 * @param {string} name
 * @returns {number}
 */
function findSrcLine(source, ruleId, name) {
  const lines = source.split("\n");
  // Match `rule R4 wedged_never_started` or `extern R4 wedged_never_started`
  const pattern = new RegExp(`^(?:rule|extern)\\s+${ruleId}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i].trim())) return i + 1;
  }
  return 0;
}

/**
 * Parse annotations for a specific rule from the rules.dl source.
 * Searches within the rule's block (from declaration to next rule/extern/EOF).
 *
 * @param {string} source
 * @param {string} ruleId
 * @returns {{ feeds:string[], cfg:string[], severity:string, since:string, ticket:string, examples:[] }}
 */
function extractAnnotations(source, ruleId) {
  // Find the block for this rule (up to the next rule/extern keyword)
  const startPattern = new RegExp(`\\b(?:rule|extern)\\s+${ruleId}\\b`);
  const startMatch = startPattern.exec(source);
  if (!startMatch) return { feeds: [], cfg: [], severity: "", since: "", ticket: "", examples: [] };

  const startIdx = startMatch.index;
  // Find end: next rule/extern declaration
  const nextPattern = /\b(?:rule|extern)\s+\S+\s+\S+/g;
  nextPattern.lastIndex = startIdx + 1;
  const nextMatch = nextPattern.exec(source);
  const endIdx = nextMatch ? nextMatch.index : source.length;

  const block = source.slice(startIdx, endIdx);
  return parseAnnotations(block);
}

/**
 * buildManifest(ir) — build the RULE_MANIFEST from compiler output.
 *
 * @param {{ rules: Map<string, {ir:{ruleId,name,stratum,negations?:[]}, sql:string, extern:boolean}> }} ir
 * @param {string} [dlSource] — optional rules.dl source for line numbers and annotations
 * @returns {object} frozen RULE_MANIFEST
 */
export function buildManifest(ir, dlSource) {
  const source = dlSource || tryReadDlSource();
  const rulesMap = ir.rules;

  // Group arms by logical rule_id (R10a/R10b → R10)
  // Logical rule_id: strip trailing letter if it has a sibling
  const logicalGroups = new Map(); // logical_id → [arm_ids...]

  for (const [armId] of rulesMap) {
    const logicalId = armToLogical(armId);
    if (!logicalGroups.has(logicalId)) logicalGroups.set(logicalId, []);
    logicalGroups.get(logicalId).push(armId);
  }

  const rules = [];

  for (const [logicalId, armIds] of logicalGroups) {
    // Use first arm for shared metadata
    const firstArm = rulesMap.get(armIds[0]);
    const { ir: firstIr, extern: isExtern } = firstArm;

    // Merge SQL from all arms
    const combinedSql = armIds.map(id => rulesMap.get(id).sql).join("\n");

    // Derive fields
    const allSql = combinedSql;
    const reads = extractReads(allSql);
    const negates = extractNegates(allSql);
    const cfg_keys = cfgConsumers(allSql);

    // Annotations from source
    const annot = source ? extractAnnotations(source, armIds[0]) : { feeds: [], cfg: [], severity: "", since: "", ticket: "", examples: [] };

    // For multi-arm rules (R10a/R10b), also check R10b annotations and merge
    if (armIds.length > 1) {
      for (let i = 1; i < armIds.length; i++) {
        const extraAnnot = source ? extractAnnotations(source, armIds[i]) : { feeds: [], cfg: [], severity: "", since: "", ticket: "", examples: [] };
        for (const f of extraAnnot.feeds) {
          if (!annot.feeds.includes(f)) annot.feeds.push(f);
        }
        for (const c of extraAnnot.cfg) {
          if (!annot.cfg.includes(c)) annot.cfg.push(c);
        }
        if (!annot.severity && extraAnnot.severity) annot.severity = extraAnnot.severity;
        if (!annot.since && extraAnnot.since) annot.since = extraAnnot.since;
        if (!annot.ticket && extraAnnot.ticket) annot.ticket = extraAnnot.ticket;
        annot.examples.push(...extraAnnot.examples);
      }
    }

    // Source line
    const srcLine = source ? findSrcLine(source, armIds[0], firstIr.name) : 0;

    // Build arms
    const arms = armIds.map(armId => {
      const entry = rulesMap.get(armId);
      return {
        arm_id: armId,
        datalog: entry.extern ? null : entry.sql,
        sql: entry.sql.trim(),
      };
    });

    rules.push(Object.freeze({
      rule_id: logicalId,
      name: firstIr.name,
      stratum: firstIr.stratum,
      extern: isExtern,
      feeds: Object.freeze(annot.feeds),
      reads: Object.freeze(reads),
      negates: Object.freeze(negates),
      cfg_keys: Object.freeze(cfg_keys),
      severity: annot.severity,
      since: annot.since,
      ticket: annot.ticket,
      src: Object.freeze({ file: "beliefs/rules.dl", line: srcLine }),
      arms: Object.freeze(arms.map(a => Object.freeze(a))),
      examples: Object.freeze(annot.examples.map(e => Object.freeze(e))),
    }));
  }

  const manifest = Object.freeze({
    strata: Object.freeze(STRATA_META.map(s => Object.freeze({ ...s }))),
    rules: Object.freeze(rules),
  });

  return manifest;
}

/**
 * Convert arm ID to logical rule ID.
 * R10a → R10, R10b → R10, R1 → R1, R16 → R16.
 */
function armToLogical(armId) {
  // If ends with a lowercase letter and there's a numeric part, strip the letter
  const m = armId.match(/^(R\d+)([a-z])$/);
  if (m) return m[1];
  return armId;
}

/**
 * Try to read the rules.dl source file.
 * Returns null if file not found.
 */
function tryReadDlSource() {
  try {
    const dlPath = resolve(__dirname, "..", "rules.dl");
    return readFileSync(dlPath, "utf8");
  } catch {
    return null;
  }
}
