// needs-human-ask.mjs — CTL-1871 COORD-29: pure formatter + parser for the
// ASK comment that accompanies every needs-human label application.
//
// The ASK comment contract:
//   "ASK (${operator}): ${oneLine} — default if silent: ${defaultIfSilent}"
//
// Space-separated em-dash (` — `) is the separator so a sentence-ending period
// in `oneLine` does not create ambiguity with the separator.
//
// This module is zero-I/O — it does nothing but format and parse strings.
// All file writes and HTTP calls belong to the gate (label-guard.mjs).

import { DEFAULT_IF_SILENT, normOneLine } from "./escalation-explanation.mjs";

/** Re-export so callers only need this module for ASK concerns. */
export { DEFAULT_IF_SILENT as ASK_DEFAULT_IF_SILENT };

/** The operator name embedded in every ASK comment when none is specified. */
export const ASK_OPERATOR_DEFAULT = "Ryan";

// The em-dash separator used in the ASK comment format.
const SEP = " — default if silent: ";

/**
 * formatAskComment — produce the one-line ASK comment string.
 *
 * @param {object} explanation  A coerced escalation explanation object.
 *   - `call_to_action` is collapsed to one line as the question body.
 *   - `default_if_silent` names what happens if no human replies.
 * @param {object} [opts]
 *   - `operator` {string} — defaults to ASK_OPERATOR_DEFAULT ("Ryan").
 * @returns {string}  The formatted comment line, e.g.
 *   "ASK (Ryan): Authorize retry of CTL-1 or cancel? — default if silent: No automated action is taken; this escalation stays open until you respond."
 */
export function formatAskComment(explanation, { operator = ASK_OPERATOR_DEFAULT } = {}) {
  const op = normOneLine(operator) || ASK_OPERATOR_DEFAULT;
  const oneLine = normOneLine(explanation?.call_to_action ?? "");
  const dis = normOneLine(explanation?.default_if_silent ?? DEFAULT_IF_SILENT);
  return `ASK (${op}): ${oneLine}${SEP}${dis}`;
}

// The regex is anchored so partial-match is impossible.  The em-dash in SEP is
// U+2014, reproduced literally in the pattern (— works in a RegExp).
const ASK_RE = /^ASK \(([^)]+)\): (.+?) — default if silent: (.+)$/;

/**
 * parseAskComment — reverse of formatAskComment.
 *
 * @param {string} line
 * @returns {{ isAsk: true, operator: string, oneLine: string, default: string }
 *           | { isAsk: false }}
 */
export function parseAskComment(line) {
  if (typeof line !== "string") return { isAsk: false };
  const m = ASK_RE.exec(line.trim());
  if (!m) return { isAsk: false };
  return { isAsk: true, operator: m[1], oneLine: m[2], default: m[3] };
}
