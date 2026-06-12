// beliefs/compiler/annotations.mjs — CTL-1063 Phase 5
// Parses per-rule annotation blocks from rules.dl source.
//
// Annotation syntax (in the extern or rule block, before or after the clause body):
//   @feeds R10
//   @cfg never_started_ms
//   @severity warn
//   @since 2026-06-09
//   @ticket CTL-933
//   @example
//     facts:
//       - table: obs_signal, row: {...}
//     expect: {...}
//     now: 1062000
//
// Multiple @feeds and @cfg lines are allowed; they accumulate.
// @example blocks extend to the next @-tag or end of the block.

/**
 * parseAnnotations(ruleBlock) — parse annotation tags from a rule/extern block string.
 *
 * @param {string} ruleBlock — text of a single rule or extern block
 * @returns {{ feeds:string[], cfg:string[], severity:string, since:string, ticket:string, examples:Array }}
 */
export function parseAnnotations(ruleBlock) {
  const feeds = [];
  const cfg = [];
  let severity = "";
  let since = "";
  let ticket = "";
  const examples = [];

  // Split into lines for easier processing
  const lines = ruleBlock.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith("@feeds ")) {
      feeds.push(line.slice("@feeds ".length).trim());
      i++;
    } else if (line.startsWith("@cfg ")) {
      cfg.push(line.slice("@cfg ".length).trim());
      i++;
    } else if (line.startsWith("@severity ")) {
      severity = line.slice("@severity ".length).trim();
      i++;
    } else if (line.startsWith("@since ")) {
      since = line.slice("@since ".length).trim();
      i++;
    } else if (line.startsWith("@ticket ")) {
      ticket = line.slice("@ticket ".length).trim();
      i++;
    } else if (line === "@example") {
      // Collect all lines until the next @-tag at the start of a trimmed line
      i++;
      const exampleLines = [];
      while (i < lines.length) {
        const nextLine = lines[i].trim();
        if (nextLine.startsWith("@")) break;
        exampleLines.push(lines[i]);
        i++;
      }
      // Parse the example block (YAML-ish)
      examples.push(parseExample(exampleLines.join("\n")));
    } else {
      i++;
    }
  }

  return { feeds, cfg, severity, since, ticket, examples };
}

/**
 * parseExample(text) — parse a single @example block.
 * Returns a structured object with facts, expect, now fields.
 * This is a lightweight parser — it handles the specific format used in rules.dl.
 *
 * @param {string} text
 * @returns {{ facts: Array<{table:string, row:object}>, expect: object, now: number|null }}
 */
function parseExample(text) {
  const lines = text.split("\n");
  const facts = [];
  let expect = null;
  let now = null;

  let mode = null; // 'facts' | 'expect' | 'now'

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("facts:")) {
      mode = "facts";
      continue;
    }
    if (line.startsWith("expect:")) {
      mode = "expect";
      // expect value may be inline
      const val = line.slice("expect:".length).trim();
      if (val) {
        try { expect = JSON.parse(val.replace(/'/g, '"')); } catch { expect = val; }
      }
      continue;
    }
    if (line.startsWith("now:")) {
      mode = "now";
      const val = line.slice("now:".length).trim();
      now = parseInt(val, 10);
      continue;
    }

    if (mode === "facts" && line.startsWith("- table:")) {
      // Parse: - table: obs_signal, row: {ticket: 'CTL-X', ...}
      const tableMatch = line.match(/- table:\s*(\S+?),\s*row:\s*(\{[\s\S]*\})/);
      if (tableMatch) {
        try {
          // Replace single quotes with double quotes for JSON parsing
          const rowStr = tableMatch[2].replace(/'/g, '"');
          const row = JSON.parse(rowStr);
          facts.push({ table: tableMatch[1], row });
        } catch {
          facts.push({ table: tableMatch[1], row: tableMatch[2] });
        }
      }
      continue;
    }

    if (mode === "expect" && expect === null) {
      // expect value on next line
      try { expect = JSON.parse(line.replace(/'/g, '"')); } catch { expect = line; }
    }
  }

  return { facts, expect, now };
}

/**
 * checkCfgAnnotations(ruleId, sql, annotatedCfg) — verify @cfg annotations match SQL.
 *
 * Finds cfg keys actually consumed by the SQL (via cfgConsumers) and checks that
 * every annotated key is actually used.
 *
 * @param {string} ruleId
 * @param {string} sql
 * @param {string[]} annotatedCfg — list of keys from @cfg annotations
 * @returns {string[]} error messages (empty = all good)
 */
import { cfgConsumers } from "./cfg-consumers.mjs";

export function checkCfgAnnotations(ruleId, sql, annotatedCfg) {
  const errors = [];
  const consumed = new Set(cfgConsumers(sql));

  for (const key of annotatedCfg) {
    if (!consumed.has(key)) {
      errors.push(`${ruleId}: @cfg(${key}) is annotated but not found in SQL`);
    }
  }

  return errors;
}

/**
 * checkFeedsAnnotations(ruleId, feeds, allCompiledSql) — verify @feeds refer to known rules.
 *
 * @param {string} ruleId
 * @param {string[]} feeds — list of rule IDs from @feeds annotations
 * @param {Map<string, {sql:string}>|Set<string>} allCompiledSql — Map of ruleId→entry, or Set of ruleIds
 * @returns {string[]} error messages (empty = all good)
 */
export function checkFeedsAnnotations(ruleId, feeds, allCompiledSql) {
  const errors = [];
  const known = allCompiledSql instanceof Set
    ? allCompiledSql
    : new Set(allCompiledSql.keys());

  for (const feed of feeds) {
    if (!known.has(feed)) {
      errors.push(`${ruleId}: @feeds(${feed}) references unknown rule`);
    }
  }

  return errors;
}
