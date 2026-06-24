// rule-source-highlight.ts — CTL-1328: a tiny, dependency-free syntax highlighter
// for the Rulebook drawer's Datalog/SQL code blocks. Tokenizes the raw source and
// emits HTML using the SAME hljs token classes the app already themes in app.css
// (keyword=purple, string=green, number=yellow, comment=muted) — so the colours
// match ticket-description code blocks without pulling in highlight.js + its
// languages (the heavy markdown engine the ticket route lazy-loads).
//
// SAFETY: every token's text is HTML-escaped before it goes into the output; the
// only un-escaped markup is our own <span> tags. So the result is safe to
// dangerouslySetInnerHTML even though the source (the frozen RULE_MANIFEST) is
// already trusted.

// SQL + the .dl DSL keywords (matched case-insensitively).
const KEYWORDS = new Set([
  // SQL
  "select", "from", "join", "left", "right", "inner", "outer", "on", "where",
  "and", "or", "not", "exists", "in", "is", "null", "insert", "ignore", "into",
  "values", "case", "when", "then", "else", "end", "as", "union", "all", "with",
  "recursive", "group", "by", "order", "limit", "distinct", "desc", "asc",
  "having", "set", "update",
  // .dl DSL. NB: `subject`/`value` are deliberately omitted — they appear as the
  // clause-head labels but ALSO as column refs (sr.subject), and colouring those
  // mid-expression reads wrong; the `not`/`guard`/`provenance`/`:-` tokens carry
  // the .dl shape already.
  "rule", "extern", "stratum", "guard", "provenance",
]);

// Aggregate / json / cast helpers — rendered as built-ins (distinct colour).
const BUILTINS = new Set([
  "json_object", "json_array", "json_group_array", "json_extract", "cast",
  "coalesce", "max", "min", "count", "sum", "abs",
]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlight a Datalog (.dl) clause or SQL string into HTML with hljs token spans.
 * Returns escaped plain text for the gaps; only keywords/strings/numbers/comments
 * and the `:-` operator are wrapped.
 */
export function highlightRuleSource(code: string | null): string {
  if (!code) return "";
  // comment | string | `:-` | number | word ; everything between matches is plain.
  const re =
    /(\/\*[\s\S]*?\*\/|--[^\n]*|\/\/[^\n]*)|('(?:[^']|'')*')|(:-)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += esc(code.slice(last, m.index));
    const full = m[0];
    const [, comment, str, arrow, num, word] = m;
    if (comment != null) {
      out += `<span class="hljs-comment">${esc(comment)}</span>`;
    } else if (str != null) {
      out += `<span class="hljs-string">${esc(str)}</span>`;
    } else if (arrow != null) {
      out += `<span class="hljs-keyword">${esc(arrow)}</span>`;
    } else if (num != null) {
      out += `<span class="hljs-number">${esc(num)}</span>`;
    } else if (word != null) {
      const lw = word.toLowerCase();
      if (KEYWORDS.has(lw)) out += `<span class="hljs-keyword">${esc(word)}</span>`;
      else if (BUILTINS.has(lw)) out += `<span class="hljs-built_in">${esc(word)}</span>`;
      else out += esc(word);
    } else {
      out += esc(full);
    }
    last = m.index + full.length;
  }
  if (last < code.length) out += esc(code.slice(last));
  return out;
}
