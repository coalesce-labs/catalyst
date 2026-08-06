#!/usr/bin/env node
// dsl-cli.mjs — thin wrapper that the bash `cmd_query` shells to.
//
// Reads `--query "<nl>"` (Groq-translated) or `--dsl '<json>'` (Groq-bypassed)
// and emits one JSON object on stdout:
//   { dsl, jqPredicate, jqSort, jqLimit }
//
// On `--explain`, the same JSON is emitted but the bash caller skips
// running the predicate. On error, prints a structured error to stderr and
// exits with one of:
//   2 — usage error
//   3 — Groq HTTP / parse / refused error
//   4 — DSL validation error (unknown field, bad operator)

import {
  compile,
  groqTranslate,
  parseGroqResponse,
  rewriteNode,
  DslError,
  GroqHttpError,
  GroqResponseError,
} from "./dsl-compile.mjs";
import { SYSTEM_PROMPT } from "./dsl-prompt.mjs";
// CTL-1616 PR5 fold (design §8/§9, risk 8 — DOCUMENTED BEHAVIOR CHANGE, not a no-op): this
// site used to be `process.env.GROQ_API_KEY || readGroqApiKeyFromConfig()` — a local 2-tier
// ladder (env, then dsl-compile.mjs's own config-only reader) independent of every other
// Groq call site. It now calls the SAME shared resolver broker/config.mjs already adopted
// (lib/api-key-health.mjs resolveApiKey), with the identical {envName, configKeyPath} this
// codebase's one other adopted site uses — joining broker/config.mjs onto ONE Groq-key
// ladder instead of three independently-hand-rolled ones (design table: "GROQ_API_KEY — 2
// ladders; resolveApiKey adopted by 1 of 3 sites; tier count differs"). FLAGGED: resolveApiKey
// enforces `typeof value === "string"` at its config tier (the old readGroqApiKeyFromConfig
// did not) and is capable of an additional project-config tier via an optional
// projectConfigPath (not wired here, matching broker/config.mjs's own call shape) — see this
// PR's report for the full behavior-change writeup.
import { resolveApiKey } from "./api-key-health.mjs";

function parseArgs(argv) {
  const out = { query: null, dsl: null, explain: false, limit: null, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--query":   out.query = argv[++i]; break;
      case "--dsl":     out.dsl = argv[++i]; break;
      case "--explain": out.explain = true; break;
      case "--limit":   out.limit = parseInt(argv[++i], 10); break;
      case "--since":   out.since = argv[++i]; break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
      default:
        process.stderr.write(`error: unknown flag: ${a}\n`);
        process.exit(2);
    }
  }
  return out;
}

function printUsage() {
  process.stderr.write(`usage: dsl-cli.mjs (--query "<nl>" | --dsl '<json>') [--explain] [--limit N] [--since DURATION]\n`);
}

// Convert --since "1h" / "30m" / "today" into an extra ts gte clause
// AND-merged onto the DSL filter. Relative only in v1.
function applySinceFlag(dsl, since) {
  if (!since) return dsl;
  let isoCutoff;
  if (since === "today") {
    const d = new Date();
    isoCutoff = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  } else {
    const m = since.match(/^(\d+)([smhd])$/);
    if (!m) {
      throw new DslError(`--since must be 'today' or N[smhd] (e.g. '30m', '2h')`, { code: "invalid" });
    }
    const n = parseInt(m[1], 10);
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    isoCutoff = new Date(Date.now() - n * mult).toISOString();
  }
  const cutoffLeaf = { field: "ts", gte: isoCutoff };
  const existing = dsl.filter ?? {};
  const merged = Object.keys(existing).length === 0
    ? cutoffLeaf
    : { and: [existing, cutoffLeaf] };
  return { ...dsl, filter: merged };
}

function applyLimitFlag(dsl, limit) {
  if (limit === null || limit === undefined) return dsl;
  return { ...dsl, limit };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.query == null && args.dsl == null) {
    process.stderr.write("error: --query or --dsl required\n");
    printUsage();
    process.exit(2);
  }

  let dsl;
  try {
    if (args.dsl != null) {
      dsl = parseGroqResponse(args.dsl);
    } else {
      const apiKey = resolveApiKey({ envName: "GROQ_API_KEY", configKeyPath: "groq.apiKey" }).value;
      dsl = await groqTranslate(args.query, { apiKey, systemPrompt: SYSTEM_PROMPT });
    }
  } catch (err) {
    return reportError(err);
  }

  // Time placeholders → ISO; --since → extra ts clause; --limit override.
  if (dsl.filter) dsl.filter = rewriteNode(dsl.filter);
  if (args.since) {
    try { dsl = applySinceFlag(dsl, args.since); } catch (err) { return reportError(err); }
  }
  if (args.limit !== null) dsl = applyLimitFlag(dsl, args.limit);

  let compiled;
  try {
    compiled = compile(dsl);
  } catch (err) {
    return reportError(err);
  }

  process.stdout.write(JSON.stringify({
    dsl,
    jqPredicate: compiled.jqPredicate,
    jqSort: compiled.jqSort,
    jqLimit: compiled.jqLimit,
    explain: args.explain,
  }) + "\n");
}

function reportError(err) {
  if (err instanceof DslError) {
    const payload = { error: err.message, code: err.code };
    if (err.field) payload.field = err.field;
    if (err.suggestion) payload.suggestion = err.suggestion;
    process.stderr.write(JSON.stringify(payload) + "\n");
    process.exit(err.code === "unknown_field" || err.code === "invalid" ? 4 : 3);
  }
  if (err instanceof GroqHttpError) {
    process.stderr.write(JSON.stringify({
      error: err.message, code: "groq_http", status: err.status, body: err.body,
    }) + "\n");
    process.exit(3);
  }
  if (err instanceof GroqResponseError) {
    process.stderr.write(JSON.stringify({
      error: err.message, code: "groq_response", raw: err.raw,
    }) + "\n");
    process.exit(3);
  }
  process.stderr.write(`error: ${err.message ?? String(err)}\n`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err.stack ?? err.message ?? err}\n`);
  process.exit(1);
});
