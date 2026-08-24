// json-format.mjs — the byte-exact JSON writer (CTL-1463 Phase 4).
//
// `JSON.stringify` alone cannot reproduce the committed tree byte-for-byte,
// and NOT for the reason the plan's prose alone would suggest — the two
// existing target files disagree with EACH OTHER on non-ASCII escaping, a
// fact only verifiable by inspecting the raw bytes (confirmed here with
// `python3 -c "... b'\xe2\x86\x92' in data"` against the committed tree):
// `.claude-plugin/marketplace.json` stores `→` as the ASCII escape `→`
// (every plugin.json with non-ASCII confirmed clean of that pattern), while
// every `plugin.json` (release-please's own JSON-path patcher output) stores
// it as the literal UTF-8 bytes with NO `\u` escape anywhere in any of the 10
// files. `escapeNonAscii` is therefore a required, per-call parameter, not a
// fixed default — the two Claude-target files need opposite settings.
//
// Key order is never `Object.keys()` of a parsed/merged object (that reflects
// whatever a merge happened to do); it is whatever order the CALLER built the
// object in. This module trusts that order and serializes it faithfully —
// the "explicit ordered field list" lives at the emitter call site, not here.

const SIMPLE_ESCAPES = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function escapeString(str, escapeNonAscii) {
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);
    if (SIMPLE_ESCAPES[ch]) {
      out += SIMPLE_ESCAPES[ch];
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (escapeNonAscii && code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function formatValue(value, { indent, escapeNonAscii, depth }) {
  const pad = " ".repeat(indent * depth);
  const padInner = " ".repeat(indent * (depth + 1));

  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return escapeString(value, escapeNonAscii);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => padInner + formatValue(v, { indent, escapeNonAscii, depth: depth + 1 }));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const items = keys.map(
      (k) => `${padInner}${escapeString(k, escapeNonAscii)}: ${formatValue(value[k], { indent, escapeNonAscii, depth: depth + 1 })}`
    );
    return `{\n${items.join(",\n")}\n${pad}}`;
  }

  throw new Error(`json-format: cannot serialize value of type ${typeof value}`);
}

/**
 * formatJson(value, { indent, escapeNonAscii }) → string, WITHOUT a trailing
 * newline (callers append exactly one "\n" when writing to disk — "a single
 * trailing newline" is a file-write concern, not a serialization concern).
 */
export function formatJson(value, { indent = 2, escapeNonAscii = false } = {}) {
  return formatValue(value, { indent, escapeNonAscii, depth: 0 });
}

/** orderedObject(entries) → a plain object built key-by-key in the given order, skipping undefined values. */
export function orderedObject(entries) {
  const obj = {};
  for (const [key, val] of entries) {
    if (val !== undefined) obj[key] = val;
  }
  return obj;
}
