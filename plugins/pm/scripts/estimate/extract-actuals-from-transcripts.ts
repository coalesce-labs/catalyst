#!/usr/bin/env bun
/**
 * Extract per-ticket *actuals* by streaming Claude Code session transcripts (CTL-746).
 *
 * Port of the proven Adva pipeline (ADV-458 backfill-actuals-from-transcripts).
 * This is the **Extract** step of the three-stage estimation pipeline:
 *
 *     Extract (this script)  →  Score (score-tickets.ts)  →  Lookup (reference-class-lookup.ts)
 *
 * Prometheus / OTel only retains a short window of `claude-code-otel` samples,
 * but `~/.claude/projects/` holds every session transcript going back months —
 * a much larger calibration anchor set. This script walks `--transcripts-dir`
 * (default `~/.claude/projects`), matches worktree dir names via `(TEAM)-\d+`,
 * stream-parses each session JSONL file, sums `message.usage.*_tokens` across
 * assistant events, computes cost via the shared `claude-pricing.json` price
 * table, derives session wall-time from first/last timestamp, counts assistant
 * turns, and emits one CSV row per ticket.
 *
 * Output columns are the `otel_*` actuals columns that downstream
 * `score-tickets.ts` joins on `ticket_id`.
 *
 * Generalization vs the ADV original:
 *   - `--out` accepts any output path (no Adva-specific default dir).
 *   - `--team` is a free-form comma list (default ADV,CTL) — works for any prefix.
 *   - Cost prices are loaded from `claude-pricing.json` (shared with the broker /
 *     statusline cost code) rather than hardcoded, so a pricing bump updates every
 *     consumer at once. `--pricing <path>` overrides the lookup.
 *   - Emits `otel_turns` (assistant turn count) — used by the calibrated TURNS band.
 *
 * Usage:
 *   bun extract-actuals-from-transcripts.ts                                   # dry-run (top 10 table)
 *   bun extract-actuals-from-transcripts.ts --apply --out actuals.csv         # write CSV
 *   bun extract-actuals-from-transcripts.ts --team CTL --apply --out a.csv    # single team
 *   bun extract-actuals-from-transcripts.ts --transcripts-dir /tmp/fixture --apply --out /tmp/out.csv
 *   bun extract-actuals-from-transcripts.ts --pricing /path/claude-pricing.json
 *   bun extract-actuals-from-transcripts.ts --verbose
 *
 * Dependency-light: bun + node builtins only (no npm deps).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// -- CLI parsing -------------------------------------------------------------

export interface CliOpts {
  teams: string[];
  transcriptsDir: string;
  out: string | null;
  pricing: string | null;
  dryRun: boolean;
  verbose: boolean;
}

export function parseArgs(argv: string[]): CliOpts {
  const args = argv.slice(2);
  const getFlag = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const teamsRaw = getFlag("--team") ?? "ADV,CTL";
  const teams = teamsRaw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const transcriptsDir = expandTilde(
    getFlag("--transcripts-dir") ?? "~/.claude/projects",
  );
  const apply = args.includes("--apply");
  return {
    teams,
    transcriptsDir,
    out: getFlag("--out"),
    pricing: getFlag("--pricing"),
    dryRun: !apply,
    verbose: args.includes("--verbose"),
  };
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// -- Pricing (loaded from claude-pricing.json) ------------------------------
//
// claude-pricing.json ships in plugins/dev/scripts/. Its schema is
//   { models: { "<model-id>": { inputPerMillion, outputPerMillion,
//                               cacheReadPerMillion, cacheCreation5mPerMillion, ... } } }
// We normalize it into the per-token-class PriceEntry shape below.

export interface PriceEntry {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

export type PriceTable = Array<{ prefix: string; price: PriceEntry }>;

// Fallback price table (USD per 1M tokens) used only if claude-pricing.json is
// not found. Mirrors the published Anthropic list prices for the 4.x families.
const FALLBACK_PRICES: PriceTable = [
  {
    prefix: "claude-opus-4",
    price: { input: 15, output: 75, cache_creation: 18.75, cache_read: 1.5 },
  },
  {
    prefix: "claude-sonnet-4",
    price: { input: 3, output: 15, cache_creation: 3.75, cache_read: 0.3 },
  },
  {
    prefix: "claude-haiku-4",
    price: { input: 1, output: 5, cache_creation: 1.25, cache_read: 0.1 },
  },
];

interface PricingJsonModel {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreation5mPerMillion?: number;
}

interface PricingJson {
  models?: Record<string, PricingJsonModel>;
}

/** Default search paths for claude-pricing.json relative to this script. */
export function defaultPricingPaths(): string[] {
  // .../plugins/pm/scripts/estimate/extract-actuals-from-transcripts.ts
  // → .../plugins/dev/scripts/claude-pricing.json
  const here = dirname(new URL(import.meta.url).pathname);
  const pmRoot = resolve(here, "..", ".."); // plugins/pm
  const pluginsRoot = resolve(pmRoot, ".."); // plugins
  return [
    resolve(pluginsRoot, "dev", "scripts", "claude-pricing.json"),
    resolve(pmRoot, "scripts", "claude-pricing.json"),
  ];
}

/**
 * Build a prefix → PriceEntry table from claude-pricing.json. Each model id in
 * the JSON (e.g. "claude-opus-4-7") is registered both under its full id and
 * under a coarse family prefix (e.g. "claude-opus-4") so transcript model ids
 * with date suffixes still match. Returns the fallback table if no file is found.
 */
export function loadPriceTable(
  explicitPath: string | null,
  log: (msg: string) => void = () => {},
): PriceTable {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : defaultPricingPaths();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const json = JSON.parse(readFileSync(path, "utf8")) as PricingJson;
      const table = pricingJsonToTable(json);
      if (table.length > 0) {
        log(`[pricing] loaded ${table.length} entries from ${path}`);
        return table;
      }
    } catch (err) {
      log(`[pricing] failed to parse ${path}: ${(err as Error).message}`);
    }
  }
  log("[pricing] no claude-pricing.json found; using built-in fallback prices");
  return FALLBACK_PRICES;
}

export function pricingJsonToTable(json: PricingJson): PriceTable {
  const out: PriceTable = [];
  const seenPrefix = new Set<string>();
  const models = json.models ?? {};
  for (const [id, m] of Object.entries(models)) {
    const price: PriceEntry = {
      input: m.inputPerMillion ?? 0,
      output: m.outputPerMillion ?? 0,
      cache_creation: m.cacheCreation5mPerMillion ?? 0,
      cache_read: m.cacheReadPerMillion ?? 0,
    };
    // Full id first (most specific).
    out.push({ prefix: id, price });
    seenPrefix.add(id);
    // Coarse family prefix (claude-<family>-<major>), e.g. claude-opus-4.
    const fam = id.match(/^(claude-[a-z]+-\d+)/);
    if (fam && !seenPrefix.has(fam[1])) {
      out.push({ prefix: fam[1], price });
      seenPrefix.add(fam[1]);
    }
  }
  // Longest prefix first so specific ids win over family prefixes.
  out.sort((a, b) => b.prefix.length - a.prefix.length);
  return out;
}

export function priceForModel(
  model: string | null | undefined,
  table: PriceTable,
): PriceEntry | null {
  if (!model) return null;
  for (const entry of table) {
    if (model.startsWith(entry.prefix)) return entry.price;
  }
  return null;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function computeCostUsd(usage: Usage, price: PriceEntry): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cc = usage.cache_creation_input_tokens ?? 0;
  const cr = usage.cache_read_input_tokens ?? 0;
  return (
    (input * price.input +
      output * price.output +
      cc * price.cache_creation +
      cr * price.cache_read) /
    1_000_000
  );
}

// -- Ticket ID extraction ----------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractTicketId(
  dirName: string,
  teams: string[],
): string | null {
  if (teams.length === 0) return null;
  const alternation = teams.map(escapeRegex).join("|");
  const re = new RegExp(`\\b(${alternation})-(\\d+)\\b`, "i");
  const match = dirName.match(re);
  if (!match) return null;
  return `${match[1].toUpperCase()}-${match[2]}`;
}

// -- Event types -------------------------------------------------------------

export interface AssistantEvent {
  type: string;
  timestamp?: string;
  gitBranch?: string;
  message?: {
    model?: string;
    usage?: Usage;
  };
}

export interface SessionAgg {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  turns: number;
  first_ts: number | null;
  last_ts: number | null;
  models: Set<string>;
  branches: Set<string>;
  unknown_models: Set<string>;
  event_count: number;
}

export function createSessionAgg(): SessionAgg {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
    turns: 0,
    first_ts: null,
    last_ts: null,
    models: new Set<string>(),
    branches: new Set<string>(),
    unknown_models: new Set<string>(),
    event_count: 0,
  };
}

export function feedEvent(
  agg: SessionAgg,
  evt: AssistantEvent,
  table: PriceTable,
): void {
  if (evt.type !== "assistant" || !evt.message) return;
  const usage = evt.message.usage ?? {};
  agg.input_tokens += usage.input_tokens ?? 0;
  agg.output_tokens += usage.output_tokens ?? 0;
  agg.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  agg.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  agg.event_count += 1;
  agg.turns += 1;
  const model = evt.message.model;
  if (model) {
    agg.models.add(model);
    const price = priceForModel(model, table);
    if (price) {
      agg.cost_usd += computeCostUsd(usage, price);
    } else {
      agg.unknown_models.add(model);
    }
  }
  if (evt.timestamp) {
    const t = Date.parse(evt.timestamp);
    if (Number.isFinite(t)) {
      if (agg.first_ts === null || t < agg.first_ts) agg.first_ts = t;
      if (agg.last_ts === null || t > agg.last_ts) agg.last_ts = t;
    }
  }
  if (evt.gitBranch) agg.branches.add(evt.gitBranch);
}

/** Convenience wrapper over feedEvent for array inputs (mostly for tests). */
export function aggregateEvents(
  events: AssistantEvent[],
  table: PriceTable = FALLBACK_PRICES,
): SessionAgg {
  const agg = createSessionAgg();
  for (const evt of events) feedEvent(agg, evt, table);
  return agg;
}

// -- Per-ticket aggregation --------------------------------------------------

export interface TicketAgg {
  ticket_id: string;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  turns: number;
  wall_time_ms: number;
  models: Set<string>;
  branches: Set<string>;
  unknown_models: Set<string>;
}

export function emptyTicketAgg(id: string): TicketAgg {
  return {
    ticket_id: id,
    session_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0,
    turns: 0,
    wall_time_ms: 0,
    models: new Set<string>(),
    branches: new Set<string>(),
    unknown_models: new Set<string>(),
  };
}

export function mergeSession(ticket: TicketAgg, session: SessionAgg): void {
  if (session.event_count === 0) return;
  ticket.session_count += 1;
  ticket.input_tokens += session.input_tokens;
  ticket.output_tokens += session.output_tokens;
  ticket.cache_creation_input_tokens += session.cache_creation_input_tokens;
  ticket.cache_read_input_tokens += session.cache_read_input_tokens;
  ticket.cost_usd += session.cost_usd;
  ticket.turns += session.turns;
  if (session.first_ts !== null && session.last_ts !== null) {
    ticket.wall_time_ms += Math.max(0, session.last_ts - session.first_ts);
  }
  for (const m of session.models) ticket.models.add(m);
  for (const b of session.branches) ticket.branches.add(b);
  for (const m of session.unknown_models) ticket.unknown_models.add(m);
}

// -- JSONL streaming ---------------------------------------------------------

/**
 * Stream-parse a JSONL file one line at a time. Malformed lines are silently
 * skipped (partial writes are common in active transcript files). Never holds
 * more than the currently-buffered chunk in memory.
 */
export async function* streamJsonLines(path: string): AsyncGenerator<unknown> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            yield JSON.parse(line);
          } catch {
            // Skip malformed lines (partial writes, corruption, etc.)
          }
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  const trailing = buffer.trim();
  if (trailing) {
    try {
      yield JSON.parse(trailing);
    } catch {
      // ignore
    }
  }
}

// -- Directory walk ----------------------------------------------------------

function findJsonlFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  return out;
}

async function processSessionFile(
  file: string,
  ticket: TicketAgg,
  table: PriceTable,
  verbose: boolean,
): Promise<void> {
  const session = createSessionAgg();
  try {
    for await (const evt of streamJsonLines(file)) {
      if (
        evt &&
        typeof evt === "object" &&
        (evt as { type?: unknown }).type === "assistant"
      ) {
        feedEvent(session, evt as AssistantEvent, table);
      }
    }
  } catch (err) {
    if (verbose) {
      console.warn(
        `  [transcripts] failed to read ${file}: ${(err as Error).message}`,
      );
    }
    return;
  }
  mergeSession(ticket, session);
}

// -- CSV output --------------------------------------------------------------

export function csvQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export const HEADERS = [
  "ticket_id",
  "session_count",
  "otel_cost_usd",
  "otel_input_tokens",
  "otel_output_tokens",
  "otel_turns",
  "otel_wall_time_hours",
  "otel_tool_success_rate",
  "models",
  "branches",
];

function num(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "0";
}

export function formatCsvRow(ticket: TicketAgg): string {
  const cells = [
    ticket.ticket_id,
    String(ticket.session_count),
    num(ticket.cost_usd, 4),
    String(ticket.input_tokens),
    String(ticket.output_tokens),
    String(ticket.turns),
    num(ticket.wall_time_ms / 3_600_000, 4),
    "",
    [...ticket.models].sort().join("|"),
    [...ticket.branches].sort().join("|"),
  ];
  return cells.map(csvQuote).join(",");
}

export function buildCsv(tickets: TicketAgg[]): string {
  const header = HEADERS.map(csvQuote).join(",");
  return [header, ...tickets.map(formatCsvRow)].join("\n") + "\n";
}

// -- Backfill orchestration --------------------------------------------------

export interface BackfillResult {
  tickets: TicketAgg[];
  csv: string;
  outPath: string | null;
  dirCount: number;
  unknownModels: Set<string>;
}

export async function backfill(opts: CliOpts): Promise<BackfillResult> {
  const log = opts.verbose ? (m: string) => console.log(m) : () => {};
  const table = loadPriceTable(opts.pricing, log);
  const outPath = opts.out ? resolve(opts.out) : null;
  let entries;
  try {
    entries = readdirSync(opts.transcriptsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `cannot read transcripts dir ${opts.transcriptsDir}: ${(err as Error).message}`,
    );
  }
  const byTicket = new Map<string, TicketAgg>();
  let dirCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = extractTicketId(entry.name, opts.teams);
    if (!id) continue;
    dirCount += 1;
    let ticket = byTicket.get(id);
    if (!ticket) {
      ticket = emptyTicketAgg(id);
      byTicket.set(id, ticket);
    }
    const dirPath = join(opts.transcriptsDir, entry.name);
    const files = findJsonlFiles(dirPath);
    for (const file of files) {
      await processSessionFile(file, ticket, table, opts.verbose);
    }
    if (opts.verbose) {
      console.log(
        `  [transcripts] ${entry.name} → ${id} (sessions=${ticket.session_count}, cost=$${ticket.cost_usd.toFixed(2)})`,
      );
    }
  }
  const tickets = [...byTicket.values()].sort(
    (a, b) => b.cost_usd - a.cost_usd,
  );
  const unknownModels = new Set<string>();
  for (const t of tickets) {
    for (const m of t.unknown_models) unknownModels.add(m);
  }
  const csv = buildCsv(tickets);
  return { tickets, csv, outPath, dirCount, unknownModels };
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  console.log(
    `[extract-actuals] teams=${opts.teams.join(",")} transcripts=${opts.transcriptsDir}`,
  );
  const result = await backfill(opts);
  console.log(
    `[extract-actuals] ${result.dirCount} matching dirs → ${result.tickets.length} unique tickets`,
  );
  const topN = result.tickets.slice(0, 10);
  for (const t of topN) {
    const totalTokens = t.input_tokens + t.output_tokens;
    console.log(
      `  ${t.ticket_id.padEnd(10)} sessions=${t.session_count} cost=$${t.cost_usd.toFixed(2)} turns=${t.turns} tokens=${totalTokens.toLocaleString()} wall=${(t.wall_time_ms / 3_600_000).toFixed(1)}h`,
    );
  }
  if (result.unknownModels.size > 0) {
    console.warn(
      `[extract-actuals] WARNING: ${result.unknownModels.size} unknown model(s) — tokens counted, cost skipped: ${[...result.unknownModels].sort().join(", ")}`,
    );
  }
  if (opts.dryRun || !result.outPath) {
    console.log(
      `[extract-actuals] --dry-run: skipping write (pass --apply --out <path> to write)`,
    );
    return;
  }
  mkdirSync(dirname(result.outPath), { recursive: true });
  await Bun.write(result.outPath, result.csv);
  console.log(
    `[extract-actuals] wrote ${result.tickets.length} rows → ${result.outPath}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
