// dsl-compile.mjs — DSL → jq predicate (CLI), DSL → JS predicate (TUI), and
// Groq translation entry point for CTL-313.
//
// Single source of truth for query semantics. The bash CLI and the Ink TUI
// both import from this module so behavior cannot drift.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  CANONICAL_FIELDS,
  FIELD_PATH_SET,
  isWhitelistedField,
  suggestField,
} from "./dsl-fields.mjs";

// ─── Errors ──────────────────────────────────────────────────────────────────
//
// We expose three distinct error classes so callers (the CLI, the TUI) can
// branch on cause without parsing message text. CLAUDE.md no-silent-fallbacks:
// every internal failure surfaces as one of these, never as a fall-through.

export class DslError extends Error {
  constructor(message, { code, field, suggestion } = {}) {
    super(message);
    this.name = "DslError";
    this.code = code ?? "invalid";
    if (field !== undefined) this.field = field;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

export class GroqHttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GroqHttpError";
    this.status = status;
    this.body = body;
  }
}

export class GroqResponseError extends Error {
  constructor(message, { raw, cause } = {}) {
    super(message);
    this.name = "GroqResponseError";
    this.raw = raw;
    if (cause) this.cause = cause;
  }
}

// ─── Field validation ────────────────────────────────────────────────────────

export function validateField(path) {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, error: "field must be a non-empty string", suggestion: null };
  }
  if (isWhitelistedField(path)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `unknown field: ${path}`,
    suggestion: suggestField(path),
  };
}

// ─── Path access (JS evaluator helper) ───────────────────────────────────────
//
// Splits a jq-style path like `attributes."event.name"` or
// `resource."service.name"` into segments and walks the event object.
// We only need to support the exact paths in CANONICAL_FIELDS; we don't
// implement the full jq grammar.

function splitPath(path) {
  const segments = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === ".") { i++; continue; }
    if (path[i] === '"') {
      const end = path.indexOf('"', i + 1);
      if (end === -1) throw new Error(`unterminated quoted segment in path: ${path}`);
      segments.push(path.slice(i + 1, end));
      i = end + 1;
    } else {
      let end = i;
      while (end < path.length && path[end] !== "." && path[end] !== '"') end++;
      segments.push(path.slice(i, end));
      i = end;
    }
  }
  return segments;
}

export function getField(event, path) {
  const segments = splitPath(path);
  let cur = event;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ─── JS evaluator (TUI) ──────────────────────────────────────────────────────

export function evalJs(node, event) {
  if (!node || typeof node !== "object") {
    throw new DslError("filter node must be an object", { code: "invalid" });
  }
  if (Array.isArray(node)) {
    throw new DslError("filter node cannot be an array", { code: "invalid" });
  }
  if ("and" in node) {
    if (!Array.isArray(node.and)) throw new DslError("'and' must be an array", { code: "invalid" });
    return node.and.every((sub) => evalJs(sub, event));
  }
  if ("or" in node) {
    if (!Array.isArray(node.or)) throw new DslError("'or' must be an array", { code: "invalid" });
    return node.or.some((sub) => evalJs(sub, event));
  }
  if ("not" in node) {
    return !evalJs(node.not, event);
  }
  if (Object.keys(node).length === 0) {
    return true;
  }
  if (typeof node.field !== "string") {
    throw new DslError("leaf node missing 'field'", { code: "invalid" });
  }
  const v = getField(event, node.field);
  return evalLeaf(node, v);
}

function evalLeaf(leaf, v) {
  if ("eq" in leaf)         return v === leaf.eq;
  if ("ne" in leaf)         return v !== leaf.ne;
  if ("gt" in leaf)         return v !== undefined && v !== null && v > leaf.gt;
  if ("gte" in leaf)        return v !== undefined && v !== null && v >= leaf.gte;
  if ("lt" in leaf)         return v !== undefined && v !== null && v < leaf.lt;
  if ("lte" in leaf)        return v !== undefined && v !== null && v <= leaf.lte;
  if ("in" in leaf) {
    if (!Array.isArray(leaf.in)) throw new DslError("'in' must be an array", { code: "invalid" });
    return leaf.in.includes(v);
  }
  if ("startsWith" in leaf) return typeof v === "string" && v.startsWith(leaf.startsWith);
  if ("endsWith" in leaf)   return typeof v === "string" && v.endsWith(leaf.endsWith);
  if ("contains" in leaf)   return typeof v === "string" && v.includes(leaf.contains);
  if ("exists" in leaf)     return leaf.exists ? (v !== undefined && v !== null) : (v === undefined || v === null);
  const ops = Object.keys(leaf).filter((k) => k !== "field");
  throw new DslError(`unknown leaf operator: ${ops.join(", ")}`, { code: "invalid" });
}

// ─── jq compiler (CLI) ───────────────────────────────────────────────────────
//
// Each leaf compiles to a parenthesized jq fragment. We use `// ""` then
// `tostring` for string operators so a null/missing field yields false rather
// than a runtime jq error — but the comparison still requires the LHS to
// actually be a string. (`null | tostring` → `"null"` which would silently
// match `startsWith("n")`; we avoid that by using `// ""` first.)

function jqLiteral(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new DslError(`unsupported literal type: ${typeof v}`, { code: "invalid" });
}

function jqLiteralStream(arr) {
  return arr.map(jqLiteral).join(", ");
}

function compileLeaf(leaf) {
  if (typeof leaf.field !== "string") {
    throw new DslError("leaf node missing 'field'", { code: "invalid" });
  }
  const v = validateField(leaf.field);
  if (!v.ok) {
    throw new DslError(v.error, { code: "unknown_field", field: leaf.field, suggestion: v.suggestion });
  }
  const path = `.${leaf.field}`;
  if ("eq" in leaf)  return `(${path} == ${jqLiteral(leaf.eq)})`;
  if ("ne" in leaf)  return `(${path} != ${jqLiteral(leaf.ne)})`;
  if ("gt" in leaf)  return `(${path} != null and ${path} > ${jqLiteral(leaf.gt)})`;
  if ("gte" in leaf) return `(${path} != null and ${path} >= ${jqLiteral(leaf.gte)})`;
  if ("lt" in leaf)  return `(${path} != null and ${path} < ${jqLiteral(leaf.lt)})`;
  if ("lte" in leaf) return `(${path} != null and ${path} <= ${jqLiteral(leaf.lte)})`;
  if ("in" in leaf) {
    if (!Array.isArray(leaf.in)) throw new DslError("'in' must be an array", { code: "invalid" });
    return `(${path} | IN(${jqLiteralStream(leaf.in)}))`;
  }
  if ("startsWith" in leaf) return `((${path} // "") | tostring | startswith(${jqLiteral(leaf.startsWith)}))`;
  if ("endsWith" in leaf)   return `((${path} // "") | tostring | endswith(${jqLiteral(leaf.endsWith)}))`;
  if ("contains" in leaf)   return `((${path} // "") | tostring | contains(${jqLiteral(leaf.contains)}))`;
  if ("exists" in leaf)     return leaf.exists ? `(${path} != null)` : `(${path} == null)`;
  const ops = Object.keys(leaf).filter((k) => k !== "field");
  throw new DslError(`unknown leaf operator: ${ops.join(", ")}`, { code: "invalid" });
}

export function compileJq(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new DslError("filter node must be an object", { code: "invalid" });
  }
  if ("and" in node) {
    if (!Array.isArray(node.and)) throw new DslError("'and' must be an array", { code: "invalid" });
    if (node.and.length === 0) return "true";
    return `(${node.and.map(compileJq).join(" and ")})`;
  }
  if ("or" in node) {
    if (!Array.isArray(node.or)) throw new DslError("'or' must be an array", { code: "invalid" });
    if (node.or.length === 0) return "false";
    return `(${node.or.map(compileJq).join(" or ")})`;
  }
  if ("not" in node) {
    // jq's `not` is a postfix filter: `value | not`, not a prefix function.
    return `((${compileJq(node.not)}) | not)`;
  }
  if (Object.keys(node).length === 0) return "true";
  return compileLeaf(node);
}

export function compileSort(spec) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec !== "object" || Array.isArray(spec)) {
    throw new DslError("sort must be an object or null", { code: "invalid" });
  }
  if (typeof spec.field !== "string") {
    throw new DslError("sort.field must be a string", { code: "invalid" });
  }
  const v = validateField(spec.field);
  if (!v.ok) {
    throw new DslError(v.error, { code: "unknown_field", field: spec.field, suggestion: v.suggestion });
  }
  const order = spec.order ?? "asc";
  if (order !== "asc" && order !== "desc") {
    throw new DslError(`sort.order must be 'asc' or 'desc'`, { code: "invalid" });
  }
  const base = `sort_by(.${spec.field})`;
  return order === "desc" ? `${base} | reverse` : base;
}

export function compileLimit(n) {
  if (n === null || n === undefined) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new DslError("limit must be a non-negative integer", { code: "invalid" });
  }
  return `.[:${n}]`;
}

// ─── Time-placeholder rewriting ──────────────────────────────────────────────
//
// The Groq prompt instructs the model to emit placeholders like `{NOW-1h}` or
// `{TODAY}` rather than concrete ISO timestamps, since the model has no
// reliable clock. Callers (CLI and TUI) rewrite these to real ISO strings
// after parsing the DSL and before compiling, so the predicate is always
// resolved against the time of *evaluation*, not of generation.

export function rewriteTimePlaceholders(value) {
  if (typeof value !== "string") return value;
  if (value === "{TODAY}") {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }
  const m = value.match(/^\{NOW(?:-(\d+)([smhd]))?\}$/);
  if (!m) return value;
  const n = m[1] ? parseInt(m[1], 10) : 0;
  const unit = m[2] ?? "s";
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000;
  return new Date(Date.now() - n * mult).toISOString();
}

export function rewriteNode(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(rewriteNode);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "and" || k === "or") out[k] = v.map(rewriteNode);
    else if (k === "not") out[k] = rewriteNode(v);
    else if (typeof v === "string") out[k] = rewriteTimePlaceholders(v);
    else out[k] = v;
  }
  return out;
}

// ─── Top-level entry point ───────────────────────────────────────────────────

export function compile(dsl) {
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) {
    throw new DslError("dsl must be an object", { code: "invalid" });
  }
  const filter = dsl.filter ?? {};
  const jqPredicate = compileJq(filter);
  const jqSort = compileSort(dsl.sort ?? null);
  const jqLimit = compileLimit(dsl.limit ?? null);
  const jsPredicate = (event) => evalJs(filter, event);
  return { jqPredicate, jqSort, jqLimit, jsPredicate };
}

// ─── Groq client ─────────────────────────────────────────────────────────────

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";

export function readGroqApiKeyFromConfig(configPath) {
  const path = configPath ?? resolve(homedir(), ".config/catalyst/config.json");
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return cfg?.groq?.apiKey ?? "";
  } catch {
    return "";
  }
}

export function parseGroqResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GroqResponseError("Groq returned non-JSON output", { raw, cause: err });
  }
  if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
    const reason = parsed.error.toLowerCase();
    let code = "refused";
    if (reason.includes("unknown field")) code = "unknown_field";
    else if (reason.startsWith("refused")) code = "refused";
    else code = "groq_rejected";
    throw new DslError(parsed.error, { code });
  }
  return parsed;
}

export async function groqTranslate(nlText, opts = {}) {
  const { apiKey, model, fetchImpl, systemPrompt } = opts;
  if (!apiKey) {
    throw new GroqHttpError("GROQ_API_KEY is not set — cannot translate query", { status: 0 });
  }
  if (!systemPrompt) {
    throw new Error("groqTranslate requires opts.systemPrompt — see lib/dsl-prompt.mjs");
  }
  const f = fetchImpl ?? globalThis.fetch;
  const res = await f(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model ?? DEFAULT_GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: nlText },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new GroqHttpError(`Groq HTTP ${res.status}`, { status: res.status, body });
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new GroqResponseError("Groq response missing choices[0].message.content", { raw: JSON.stringify(json) });
  }
  return parseGroqResponse(content);
}

async function safeText(res) {
  try { return await res.text(); } catch { return "<unreadable response body>"; }
}

// Re-export so the test file and the CLI have one import path.
export { CANONICAL_FIELDS, FIELD_PATH_SET, suggestField };
