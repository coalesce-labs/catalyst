// beliefs/compiler/manifest.mjs — CTL-1063 Phase 5
// Builds the RULE_MANIFEST data structure from compiled IR + annotations + SQL.
//
// RULE_MANIFEST shape:
// {
//   preface: {problem: string, datalog_primer: string},
//   strata: [{id:1, label:'S1 ground correlations', prose:'...'},...],  // 6 entries
//   rules: [{
//     rule_id: string,       // 'R1', 'R10' (merged R10a+R10b)
//     name: string,
//     stratum: number,
//     extern: boolean,       // true for R3/R8/R13/R14/R15/R16/R17
//     description: string,   // plain-English explanation (@description annotation)
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

// CTL-1320: each stratum carries a PLAIN-LANGUAGE layer (plain_headline +
// plain_body) that leads in the Rulebook UI, with the technical `label`/`prose`
// demoted to subtext. Single source of truth for the surface copy — the ladder
// and the section headings both read these, so the wording never drifts and the
// embedded "S{id}" prefix is printed exactly once (from `id`, not the label).
const STRATA_META = [
  { id: 1, label: "S1 ground correlations",           plain_headline: "What we directly observe to be true",  plain_body: "The ground floor — raw facts, lined up per worker. No judgment yet.",        prose: "Read obs_* EDB only; establish per-phase session, turn, heartbeat, and job-state correlations." },
  { id: 2, label: "S2 liveness verdicts",             plain_headline: "Who is alive, and who is wedged",       plain_body: "Where 'running' becomes 'alive' or 'wedged'.",                                prose: "Stratified negation over S1 beliefs; derive lease validity, expiry, wedge detection, and board-drift." },
  { id: 3, label: "S3 capacity aggregation",          plain_headline: "How much capacity is free",             plain_body: "A headcount of free slots per host.",                                        prose: "Aggregate over S2 lease_valid beliefs and obs_agent to compute free_slots per host." },
  { id: 4, label: "S4 escalation ladder",             plain_headline: "When it's time to get a human",         plain_body: "The escalation ladder — cheaper moves first, raise a hand last.",             prose: "Negation over intent table; fire diagnostician wake-up, detect action_ineffective, escalate to human." },
  { id: 5, label: "S5 recursive dependency beliefs",  plain_headline: "What is blocked by what",               plain_body: "Follows the blocker chain; flags loops that can't resolve.",                  prose: "Transitive blocker closure (WITH RECURSIVE); derive blocker_rank, cycle_detected, and ready." },
  { id: 6, label: "S6 FSM advancement prediction",    plain_headline: "What happens next",                     plain_body: "Predicts where each worker advances, spots exhausted cycles.",                prose: "Derive advance_to and cycle_exhausted from obs_signal/obs_verdict/obs_cycle; no negation over beliefs." },
];

const PREFACE = Object.freeze({
  problem:
    "The daemon must decide — continuously, automatically, and auditably — which workers are " +
    "alive, which are wedged, which should be retried, and which require human attention. " +
    "A simple 'is the process running?' check is insufficient: a process can be running but " +
    "making no progress (stalled-alive), or registered but never started a turn (never-started " +
    "wedge), or producing output but on a board state that disagrees with Linear (board drift). " +
    "The belief engine encodes these distinctions as a stratified rule set — 17 rules across " +
    "6 strata — where each rule derives a named belief from observed facts. Every conclusion is " +
    "inspectable: the derivation tree traces exactly which facts triggered which rule, making " +
    "the system's reasoning legible to the operators who must trust it.",
  datalog_primer:
    "Datalog is a logic programming language where rules derive new facts from existing ones. " +
    "A rule has the form: conclusion :- premise1, premise2, ... (read: conclusion holds if all " +
    "premises hold). The belief engine organises its rules into strata — layers where each " +
    "stratum's rules may only read beliefs produced by earlier strata. This stratification " +
    "makes negation safe: a rule can say 'not lease_valid' only after all lease_valid beliefs " +
    "have been fully computed (stratum 2 reads stratum 1). Each rule compiles to one or more " +
    "SQL INSERT statements that are executed in stratum order; the belief table accumulates " +
    "conclusions. Extern rules embed hand-authored SQL (for aggregates and WITH RECURSIVE " +
    "queries that the compiler cannot generate); rule blocks use a higher-level Datalog syntax " +
    "that the compiler translates to SQL automatically.",
});


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
  if (!startMatch) return { feeds: [], cfg: [], severity: "", since: "", ticket: "", description: "", narrative: "", subjectdoc: "", value_docs: [], sample: "", samplenote: "", examples: [] };

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
 * CTL-1327: extract the raw `.dl` clause body for a rule arm — the
 * `subject:`/`value:`/`:- … .` text the author wrote — for the drawer's Datalog
 * lens. Returns null for extern rules (no Datalog clause) or when not found.
 *
 * @param {string} source — rules.dl
 * @param {string} armId
 * @returns {string|null}
 */
function extractDatalogClause(source, armId) {
  if (!source) return null;
  const startPattern = new RegExp(`\\b(?:rule|extern)\\s+${armId}\\b`);
  const sm = startPattern.exec(source);
  if (!sm) return null;
  const nextPattern = /\b(?:rule|extern)\s+\S+\s+\S+/g;
  nextPattern.lastIndex = sm.index + 1;
  const nm = nextPattern.exec(source);
  const block = source.slice(sm.index, nm ? nm.index : source.length);
  const lines = block.split("\n");
  // Clause = from the first `subject:`/`value:`/`:-` line to the line that ends
  // the clause with a terminating `.`.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("subject:") || t.startsWith("value:") || t.startsWith(":-")) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim().endsWith(".")) { end = i; break; }
  }
  if (end === -1) end = lines.length - 1;
  return lines.slice(start, end + 1).join("\n").trim() || null;
}

/**
 * CTL-1327: top-level keys of the belief's value json_object — the fields of the
 * head atom's value record. Returns [] when the rule writes no value (e.g.
 * R4/R6 omit the value column). Balanced-paren aware so nested calls (MAX/MIN,
 * sub-SELECTs) don't break the depth-0 split; keys are the even-position string
 * literals.
 *
 * @param {string} sql
 * @returns {string[]}
 */
function extractValueKeys(sql) {
  const at = sql.indexOf("json_object(");
  if (at === -1) return [];
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = at + "json_object".length; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") { depth++; if (depth === 1) start = i + 1; }
    else if (ch === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start === -1 || end === -1) return [];
  const inner = sql.slice(start, end);
  const args = [];
  let d = 0;
  let inStr = false;
  let buf = "";
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (inStr) {
      buf += c;
      if (c === "'") inStr = false;
    } else if (c === "'") {
      inStr = true;
      buf += c;
    } else if (c === "(") { d++; buf += c; }
    else if (c === ")") { d--; buf += c; }
    else if (c === "," && d === 0) { args.push(buf.trim()); buf = ""; }
    else buf += c;
  }
  if (buf.trim()) args.push(buf.trim());
  const keys = [];
  for (let a = 0; a < args.length; a += 2) {
    const m = /^'([^']*)'$/.exec(args[a]);
    if (m) keys.push(m[1]);
  }
  return keys;
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
        if (!annot.description && extraAnnot.description) annot.description = extraAnnot.description;
        if (!annot.narrative && extraAnnot.narrative) annot.narrative = extraAnnot.narrative;
        if (!annot.subjectdoc && extraAnnot.subjectdoc) annot.subjectdoc = extraAnnot.subjectdoc;
        if ((!annot.value_docs || annot.value_docs.length === 0) && extraAnnot.value_docs?.length) annot.value_docs = extraAnnot.value_docs;
        if (!annot.sample && extraAnnot.sample) annot.sample = extraAnnot.sample;
        if (!annot.samplenote && extraAnnot.samplenote) annot.samplenote = extraAnnot.samplenote;
        annot.examples.push(...extraAnnot.examples);
      }
    }

    // Source line
    const srcLine = source ? findSrcLine(source, armIds[0], firstIr.name) : 0;

    // Build arms. CTL-1327: `datalog` is now the REAL `.dl` clause source (not the
    // compiled SQL — the old lens bug), null for extern rules.
    const arms = armIds.map(armId => {
      const entry = rulesMap.get(armId);
      return {
        arm_id: armId,
        datalog: entry.extern ? null : extractDatalogClause(source, armId),
        sql: entry.sql.trim(),
      };
    });

    // CTL-1327: the head atom — a belief is `name(subject) = value{…}`. The
    // subject label comes from the @subject annotation; the value's field keys are
    // parsed from the value json_object in the SQL ([] when the rule writes none).
    const head = Object.freeze({
      subject: annot.subject || "",
      value_keys: Object.freeze(extractValueKeys(allSql)),
    });

    rules.push(Object.freeze({
      rule_id: logicalId,
      name: firstIr.name,
      stratum: firstIr.stratum,
      extern: isExtern,
      description: annot.description ?? "",
      narrative: annot.narrative ?? "",
      // CTL-1328: belief-shape dev-docs (subject + value fields + a realistic
      // example) rendered in the Rulebook detail's main content.
      shape: Object.freeze({
        subjectDoc: annot.subjectdoc ?? "",
        values: Object.freeze(
          (annot.value_docs ?? []).map((v) => Object.freeze({ ...v })),
        ),
        exampleInstance: annot.sample ?? "",
        exampleNote: annot.samplenote ?? "",
      }),
      feeds: Object.freeze(annot.feeds),
      reads: Object.freeze(reads),
      negates: Object.freeze(negates),
      cfg_keys: Object.freeze(cfg_keys),
      head,
      severity: annot.severity,
      since: annot.since,
      ticket: annot.ticket,
      src: Object.freeze({ file: "beliefs/rules.dl", line: srcLine }),
      arms: Object.freeze(arms.map(a => Object.freeze(a))),
      examples: Object.freeze(annot.examples.map(e => Object.freeze(e))),
    }));
  }

  const manifest = Object.freeze({
    preface: PREFACE,
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
