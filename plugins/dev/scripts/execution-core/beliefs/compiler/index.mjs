// beliefs/compiler/index.mjs — CTL-1063 Phase 1: mini-Datalog compiler
// Pure ESM, zero dependencies.
//
// Pipeline: tokenize → parse → lower(IR) → emitSql(ir) → emit()
//
// Grammar (rules.dl):
//   rule <ID> <NAME>
//   stratum <N>
//   subject: <EXPR>
//   [value: <EXPR>]
//   :-
//     <TABLE> <ALIAS>[,]
//     [<TABLE> <ALIAS> ON <COND>[,]]
//     ...
//     [guard <EXPR>[,]]
//     ...
//     [not <BELIEF_NAME>(<SUBJECT_EXPR>)[,]]
//     ...
//     provenance [<KIND>:<REF>, ...].
//
// The first join in the body is always `tick t` (no ON clause needed).
// Subsequent joins may have ON clauses.

// ── Sets exported for coverage ledger ────────────────────────────────────────

/** Rule IDs that are compiled from rules.dl (Phase 1: R1, R2, R4) */
const COMPILED_RULE_IDS = new Set(["R1", "R2", "R4"]);

/** Rule IDs that are extern (hand-written SQL in rules.dl, never compiled).
 * Phase 2: R3,R8,R13,R14,R15,R16,R17.
 * Phase 3: R5,R6,R7,R9,R10a,R10b,R11,R12. */
export const EXTERN_RULE_IDS = new Set([
  "R3", "R5", "R6", "R7", "R8", "R9",
  "R10a", "R10b", "R11", "R12",
  "R13", "R14", "R15", "R16", "R17",
]);

/** Rule IDs that are still inline in rules.mjs (not yet migrated to rules.dl).
 * Phase 3 complete: all rules migrated. */
export const PENDING_INLINE_IDS = new Set();

import { parseExterns } from "./extern.mjs";
import { buildManifest } from "./manifest.mjs";

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Strip block comments (/* ... *\/) and line comments (//) then split into
 * logical tokens preserving bracket contents intact.
 *
 * We use a simple character-walk rather than a regex engine so that nested
 * SQL expressions (parentheses, string literals, etc.) survive untouched
 * inside bracket groups and ON/guard/value expressions.
 */
function tokenize(source) {
  // 1. Remove block comments
  let s = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  // 2. Remove line comments
  s = s.replace(/\/\/[^\n]*/g, "");
  return s;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * parseRules(source) → Array of raw rule objects.
 * Each rule object has the shape:
 *   { ruleId, stratum, name, subjectRaw, valueRaw, bodyLines }
 * bodyLines is an array of raw strings (trimmed, comma stripped, dot stripped).
 */
function parseRules(source) {
  const text = tokenize(source);
  const rules = [];

  // Split on `rule` keyword boundaries — each rule block starts with `rule <ID> <NAME>`
  // We find all occurrences of the `rule` keyword at the start of a token sequence.
  const rulePattern = /\brule\s+(\S+)\s+(\S+)([\s\S]*?)(?=\brule\s+\S+\s+\S+|\s*$)/g;

  let m;
  while ((m = rulePattern.exec(text)) !== null) {
    const ruleId = m[1];
    const name = m[2];
    const body = m[3].trim();

    // Parse stratum
    const stratumMatch = body.match(/\bstratum\s+(\d+)/);
    if (!stratumMatch) throw new Error(`Rule ${ruleId}: missing stratum`);
    const stratum = parseInt(stratumMatch[1], 10);

    // Parse subject (everything after `subject:` up to newline or next keyword)
    const subjectMatch = body.match(/\bsubject\s*:\s*(.+?)(?=\n\s*(?:value\s*:|:-|\bstratum\b)|\n\s*$)/s);
    if (!subjectMatch) throw new Error(`Rule ${ruleId}: missing subject:`);
    const subjectRaw = subjectMatch[1].trim();

    // Parse optional value
    const valueMatch = body.match(/\bvalue\s*:\s*(.+?)(?=\n\s*:-|\n\s*$)/s);
    const valueRaw = valueMatch ? valueMatch[1].trim() : null;

    // Parse body (after :-)
    const bodyMatch = body.match(/:-\s*([\s\S]+)$/);
    if (!bodyMatch) throw new Error(`Rule ${ruleId}: missing :- body`);
    const bodyText = bodyMatch[1].trim();

    // Split body into logical lines, handling the provenance bracket specially
    const bodyLines = parseBodyLines(bodyText);

    rules.push({ ruleId, stratum, name, subjectRaw, valueRaw, bodyLines });
  }

  return rules;
}

/**
 * Parse the body section (after :-) into individual clause lines.
 *
 * Grammar for body items:
 *   - `provenance [...]` — terminated by `].` (bracket then dot)
 *   - `guard <EXPR>` — terminated by comma (expr may contain dots/parens)
 *   - `not <NAME>(<EXPR>)` — terminated by comma (closing paren + comma)
 *   - `TABLE ALIAS` or `TABLE ALIAS ON <COND>` — terminated by comma
 *
 * The key insight: the ONLY safe separator is a comma that is NOT inside
 * parentheses or square brackets. The body-terminating `.` only appears as
 * `].` (after the provenance bracket). We do NOT use `.` as a generic
 * separator since SQL expressions contain dots (table.column).
 *
 * Algorithm: consume chars tracking paren/bracket depth; split on top-level
 * commas; the provenance line ends with `]` (the `.` after the bracket is
 * consumed and discarded as a body terminator).
 */
function parseBodyLines(bodyText) {
  const lines = [];
  let current = "";
  let parenDepth = 0;
  let inBracket = false;
  let i = 0;

  while (i < bodyText.length) {
    const ch = bodyText[i];

    if (ch === "[" && parenDepth === 0 && !inBracket) {
      // Start of provenance bracket
      inBracket = true;
      current += ch;
      i++;
    } else if (ch === "]" && inBracket) {
      // End of provenance bracket
      inBracket = false;
      current += ch;
      i++;
      // Skip optional trailing `.` (body terminator after provenance)
      if (i < bodyText.length && bodyText[i] === ".") {
        i++;
      }
      // Provenance is always the last item; push and stop
      const trimmed = current.trim();
      if (trimmed) lines.push(trimmed);
      current = "";
      break;
    } else if (ch === "(" && !inBracket) {
      parenDepth++;
      current += ch;
      i++;
    } else if (ch === ")" && !inBracket) {
      parenDepth--;
      current += ch;
      i++;
    } else if (ch === "," && parenDepth === 0 && !inBracket) {
      // Top-level comma — end of current clause
      const trimmed = current.trim();
      if (trimmed) lines.push(trimmed);
      current = "";
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  // Any remaining content (shouldn't happen in well-formed input, but be safe)
  const remaining = current.trim();
  // Strip trailing dot if present (body terminator without provenance bracket)
  const clean = remaining.endsWith(".") ? remaining.slice(0, -1).trim() : remaining;
  if (clean) lines.push(clean);

  return lines;
}

// ── IR Lowering ───────────────────────────────────────────────────────────────

/**
 * lowerRule(rawRule) → IR object per the spec shape.
 *
 * IR shape:
 * {
 *   ruleId: string,
 *   stratum: number,
 *   name: string,
 *   subjectExpr: string,
 *   valueExpr: string|null,
 *   joins: Array<{table:string, alias:string, on:string|null}>,
 *   guards: string[],
 *   negations: Array<{name:string, subject:string}>,
 *   provenanceRefs: Array<{kind:string, ref:string}>,
 * }
 */
function lowerRule(raw) {
  const { ruleId, stratum, name, subjectRaw, valueRaw, bodyLines } = raw;

  const joins = [];
  const guards = [];
  const negations = [];
  let provenanceRefs = [];

  for (const line of bodyLines) {
    if (line.startsWith("provenance")) {
      // provenance [kind:ref, ...]
      const bracketMatch = line.match(/\[([^\]]*)\]/);
      if (bracketMatch) {
        provenanceRefs = parseProvenance(bracketMatch[1]);
      }
    } else if (line.startsWith("guard ")) {
      const expr = line.slice("guard ".length).trim();
      guards.push(expr);
    } else if (line.startsWith("not ")) {
      // not belief_name(subject_expr)
      const negMatch = line.match(/^not\s+(\w+)\((.+)\)$/s);
      if (!negMatch) throw new Error(`Rule ${ruleId}: malformed 'not' clause: ${line}`);
      negations.push({ name: negMatch[1], subject: negMatch[2].trim() });
    } else {
      // Join clause: TABLE ALIAS [ON COND]
      const joinIR = parseJoinClause(line, ruleId);
      if (joinIR) joins.push(joinIR);
    }
  }

  // The first join must be tick t — add it if not present or verify
  // In the grammar, the body starts with `tick t,` so it appears as the first join.
  // We keep joins in order as parsed.

  return {
    ruleId,
    stratum,
    name,
    subjectExpr: subjectRaw,
    valueExpr: valueRaw,
    joins,
    guards,
    negations,
    provenanceRefs,
  };
}

/**
 * Parse a join clause line: `TABLE ALIAS [ON COND]`
 * The ON condition may contain spaces and SQL operators.
 */
function parseJoinClause(line, ruleId) {
  // Match: word word [ON rest...]
  const m = line.match(/^(\S+)\s+(\S+)(?:\s+ON\s+([\s\S]+))?$/i);
  if (!m) {
    // Could be a blank line or something we don't recognize — skip
    if (line.trim() === "") return null;
    throw new Error(`Rule ${ruleId}: cannot parse join clause: "${line}"`);
  }
  return {
    table: m[1],
    alias: m[2],
    on: m[3] ? m[3].trim() : null,
  };
}

/**
 * Parse provenance spec: `kind:ref, kind:ref, ...`
 * Returns Array<{kind:string, ref:string}>
 */
function parseProvenance(spec) {
  const refs = [];
  // Split on commas that are NOT inside parentheses (to handle function calls in refs)
  const parts = splitOutsideParens(spec, ",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // kind is a single char before the first colon
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) throw new Error(`Provenance entry missing colon: "${trimmed}"`);
    const kind = trimmed.slice(0, colonIdx).trim();
    const ref = trimmed.slice(colonIdx + 1).trim();
    refs.push({ kind, ref });
  }
  return refs;
}

function splitOutsideParens(str, sep) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of str) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

// ── SQL Emitter ───────────────────────────────────────────────────────────────

/**
 * emitSql(ir) → SQL string (canonical INSERT OR IGNORE shape).
 *
 * Output shape:
 *   INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject[, value], rule_id, source_fact_ids)
 *   SELECT t.tick_id, <stratum>, '<name>', <subjectExpr>[, <valueExpr>], '<ruleId>',
 *          json_array(<'kind' || ref, ...>)
 *   FROM tick t
 *   JOIN <table> <alias> ON <on>
 *   ...
 *   WHERE t.tick_id = :tick
 *     AND <guard>
 *     ...
 *     AND NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id AND b.name = '<name>' AND b.subject = <subject>)
 *     ...
 */
function emitSql(ir) {
  const { ruleId, stratum, name, subjectExpr, valueExpr, joins, guards, negations, provenanceRefs } = ir;

  const hasValue = valueExpr !== null;

  // Column list
  const cols = hasValue
    ? "tick_id, stratum, name, subject, value, rule_id, source_fact_ids"
    : "tick_id, stratum, name, subject, rule_id, source_fact_ids";

  // SELECT list
  const provenance = provenanceRefs
    .map(({ kind, ref }) => `'${kind}' || ${ref}`)
    .join(", ");
  const jsonArray = `json_array(${provenance})`;

  const selectItems = hasValue
    ? `t.tick_id, ${stratum}, '${name}', ${subjectExpr},\n       ${valueExpr},\n       '${ruleId}', ${jsonArray}`
    : `t.tick_id, ${stratum}, '${name}', ${subjectExpr}, '${ruleId}',\n       ${jsonArray}`;

  // FROM + JOINs
  // The first join should be tick t (no ON)
  let fromClause = "";
  for (let i = 0; i < joins.length; i++) {
    const { table, alias, on } = joins[i];
    if (i === 0) {
      // tick t — bare FROM
      fromClause += `FROM ${table} ${alias}`;
    } else if (on) {
      fromClause += `\nJOIN ${table} ${alias} ON ${on}`;
    } else {
      fromClause += `\nJOIN ${table} ${alias}`;
    }
  }

  // WHERE clause
  const whereConditions = [`t.tick_id = :tick`];
  for (const g of guards) {
    whereConditions.push(g);
  }
  for (const neg of negations) {
    whereConditions.push(
      `NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id` +
      ` AND b.name = '${neg.name}' AND b.subject = ${neg.subject})`
    );
  }

  const whereClause = whereConditions.map((c, i) => (i === 0 ? `WHERE ${c}` : `  AND ${c}`)).join("\n");

  return (
    `INSERT OR IGNORE INTO belief (${cols})\n` +
    `SELECT ${selectItems}\n` +
    `${fromClause}\n` +
    `${whereClause}`
  );
}

// ── Manifest Serializer ───────────────────────────────────────────────────────

/**
 * serializeManifest(manifest) → JS expression string for embedding in generated module.
 *
 * Emits a deepFreeze() call around the JSON data so that nested arrays and
 * objects are all frozen, not just the outer object.  The helper function is
 * inlined at the call-site in the generated file.
 *
 * @param {object} manifest
 * @returns {string}  — a self-contained JS expression
 */
function serializeManifest(manifest) {
  // JSON.stringify produces double-quoted strings, which is valid JS.
  return JSON.stringify(manifest, null, 2);
}

/**
 * Emit the deep-freeze helper and the RULE_MANIFEST constant.
 * Returns two lines: the helper function + the export const.
 */
function emitManifestBlock(manifest) {
  const json = serializeManifest(manifest);
  const lines = [
    "// Deep-freeze helper for RULE_MANIFEST (CTL-1063 Phase 5).",
    "function _deepFreeze(o) {",
    "  Object.freeze(o);",
    "  if (Array.isArray(o)) { o.forEach(_deepFreeze); }",
    "  else if (o !== null && typeof o === 'object') { Object.values(o).forEach(_deepFreeze); }",
    "  return o;",
    "}",
    "",
    `export const RULE_MANIFEST = _deepFreeze(${json});`,
  ];
  return "\n" + lines.join("\n") + "\n";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * compile(source) → { rules:Map, getRule(id)→sql|null, emit()→moduleText, getGeneratedStrata()→Array }
 *
 * @param {string} source — contents of rules.dl
 */
export function compile(source) {
  // ── Compiled rules (Datalog → SQL) ────────────────────────────────────────
  const rawRules = parseRules(source);
  const rulesMap = new Map();

  for (const raw of rawRules) {
    const ir = lowerRule(raw);
    const sql = emitSql(ir);
    rulesMap.set(raw.ruleId, { ir, sql, extern: false });
  }

  // ── Extern rules (verbatim SQL from rules.dl) ─────────────────────────────
  const externMap = parseExterns(source);
  for (const [ruleId, entry] of externMap) {
    // Extern rules are stored with a synthetic ir-like shape for stratum/name access
    rulesMap.set(ruleId, {
      ir: { ruleId: entry.ruleId, stratum: entry.stratum, name: entry.name },
      sql: entry.sql,
      extern: true,
    });
  }

  /**
   * getRule(id) → SQL string (compiled or extern), or null if not in rules.dl.
   */
  function getRule(id) {
    const entry = rulesMap.get(id);
    return entry ? entry.sql : null;
  }

  /**
   * getManifestEntry(id) → {ruleId, name, stratum, extern:bool} or undefined.
   */
  function getManifestEntry(id) {
    const entry = rulesMap.get(id);
    if (!entry) return undefined;
    return {
      ruleId: entry.ir.ruleId,
      name: entry.ir.name,
      stratum: entry.ir.stratum,
      extern: entry.extern,
    };
  }

  /**
   * getGeneratedStrata() → Array of strata arrays.
   * Each stratum is [[ruleId, sql], ...] for both compiled and extern rules.
   */
  function getGeneratedStrata() {
    // Group by stratum, preserving rule order within stratum
    const byStratum = new Map();
    for (const [ruleId, { ir, sql }] of rulesMap) {
      const s = ir.stratum;
      if (!byStratum.has(s)) byStratum.set(s, []);
      byStratum.get(s).push([ruleId, sql]);
    }
    // Return array sorted by stratum number
    const strata = [];
    for (const [, entries] of [...byStratum.entries()].sort(([a], [b]) => a - b)) {
      strata.push(entries);
    }
    return strata;
  }

  /**
   * emit(rulesSha?, dlSource?) → module text for rules.generated.mjs
   * CTL-1063 Phase 4: accepts an optional RULES_SHA string to embed in the output.
   * CTL-1063 Phase 5: accepts optional dlSource string to build RULE_MANIFEST.
   *
   * @param {string} [rulesSha] — 16-char hex content hash of rules.dl (from compile-rules.mjs)
   * @param {string} [dlSource] — contents of rules.dl (for annotation/manifest generation)
   */
  function emit(rulesSha, dlSource) {
    const strata = getGeneratedStrata();

    // Build export const lines (both compiled and extern)
    const constLines = [];
    for (const [, { ir, sql }] of rulesMap) {
      const exportName = `${ir.ruleId}_${ir.name}`;
      constLines.push(`export const ${exportName} = \`\n${sql}\`;`);
    }

    // Build GENERATED_STRATA lines
    const strataLines = [];
    const stratumComments = { 1: "S1", 2: "S2", 3: "S3", 4: "S4", 5: "S5", 6: "S6" };
    for (const stratum of strata) {
      const stratumNum = rulesMap.get(stratum[0][0]).ir.stratum;
      const comment = stratumComments[stratumNum] || `S${stratumNum}`;
      const entries = stratum
        .map(([id]) => {
          const { ir } = rulesMap.get(id);
          return `    ['${id}', ${id}_${ir.name}]`;
        })
        .join(",\n");
      strataLines.push(`  // ${comment}\n  [\n${entries},\n  ]`);
    }

    const header = [
      "// GENERATED by beliefs/compile-rules.mjs — do not edit by hand.",
      "// Source: beliefs/rules.dl",
      "// Regenerate: cd plugins/dev/scripts/execution-core && bun beliefs/compile-rules.mjs",
      "",
    ].join("\n");

    // CTL-1063 Phase 4: RULES_SHA line — emitted only when a sha was provided.
    const rulesShaLineLine = typeof rulesSha === "string" && rulesSha
      ? `\nexport const RULES_SHA = '${rulesSha}';\n`
      : "";

    // CTL-1063 Phase 5: RULE_MANIFEST — built from IR + annotations + SQL.
    let ruleManifestBlock = "";
    if (dlSource) {
      const manifest = buildManifest({ rules: rulesMap }, dlSource);
      ruleManifestBlock = emitManifestBlock(manifest);
    }

    const body = [
      header,
      constLines.join("\n\n"),
      rulesShaLineLine,
      ruleManifestBlock,
      "export const GENERATED_STRATA = [",
      strata.length > 0 ? strataLines.join(",\n") : "",
      "];",
      "",
    ].join("\n");

    return body;
  }

  return { rules: rulesMap, getRule, getManifestEntry, emit, getGeneratedStrata };
}
