#!/usr/bin/env bun
/**
 * Reference-class lookup: given a ticket's signals, return the k nearest closed
 * tickets by signal similarity + their actuals distribution (CTL-186, CTL-746).
 *
 * Port of the proven Adva pipeline read-side. This is the **Lookup** step:
 *
 *     Extract (extract-actuals-from-transcripts.ts)  →  Score (score-tickets.ts)  →  Lookup (this script)
 *
 * The Score step writes a corpus JSON (`*.corpus.json`) of closed tickets, each
 * with structural signals (LOC, files, domains, FE/BE/migration flags) and
 * actuals (cost_usd, turns, wall_hours). This lookup loads that corpus and, for
 * a query ticket, returns the k nearest neighbours by a blended similarity over:
 *   - title token overlap (Jaccard),
 *   - log-scale numeric closeness on LOC + changed_files,
 *   - domain-set overlap (Jaccard),
 *   - structural-flag agreement.
 *
 * It then summarizes the neighbours' actuals (cost / turns / wall-hours
 * medians + range) and votes a reference-class T-shirt + story points. This is
 * the read-side that phase-triage (and a human estimator) consult to anchor a
 * new ticket against the closest historical reference class — outside-view
 * estimation rather than inside-view guessing.
 *
 * Usage (query by free-form signals):
 *   bun reference-class-lookup.ts --corpus corpus.json \
 *       --title "wire estimation into scheduler write-back" \
 *       --loc 320 --files 8 --domains "plugins/pm|plugins/dev" --backend -k 5
 *
 * Usage (query by an existing corpus ticket id — leave-one-out):
 *   bun reference-class-lookup.ts --corpus corpus.json --ticket CTL-497 -k 5
 *
 * Output: JSON to stdout (--json) or a human table (default).
 *
 * Dependency-light: bun + node builtins only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// -- Types (mirror score-tickets corpus schema) ------------------------------

export type TShirt = "XS" | "S" | "M" | "L" | "XL";

export const TSHIRT_POINTS: Record<TShirt, number> = {
  XS: 1,
  S: 3,
  M: 5,
  L: 8,
  XL: 13,
};

export const SIZES: TShirt[] = ["XS", "S", "M", "L", "XL"];

export interface CorpusEntry {
  ticket_id: string;
  title: string;
  tier: number;
  tshirt: TShirt;
  points: number;
  confidence: string;
  rationale: string;
  signals: {
    loc: number | null;
    changed_files: number | null;
    domains: string[];
    has_migration: boolean;
    has_frontend: boolean;
    has_backend: boolean;
  };
  actuals: {
    cost_usd: number | null;
    turns: number | null;
    wall_hours: number | null;
  };
}

export interface Corpus {
  generated_at?: string;
  schema?: string;
  count?: number;
  entries: CorpusEntry[];
}

/** The query: a partial corpus entry — only the signal fields are needed. */
export interface Query {
  ticket_id?: string;
  title: string;
  loc: number | null;
  changed_files: number | null;
  domains: string[];
  has_migration: boolean;
  has_frontend: boolean;
  has_backend: boolean;
}

// -- CLI parsing -------------------------------------------------------------

interface CliOpts {
  corpus: string;
  ticket: string | null;
  title: string;
  loc: number | null;
  files: number | null;
  domains: string[];
  hasMigration: boolean;
  hasFrontend: boolean;
  hasBackend: boolean;
  k: number;
  json: boolean;
}

export function parseArgs(argv: string[]): CliOpts {
  const args = argv.slice(2);
  const getFlag = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const kRaw = getFlag("-k") ?? getFlag("--k");
  const locRaw = getFlag("--loc");
  const filesRaw = getFlag("--files");
  const domainsRaw = getFlag("--domains");
  return {
    corpus: getFlag("--corpus") ?? "",
    ticket: getFlag("--ticket"),
    title: getFlag("--title") ?? "",
    loc: locRaw !== null ? Number.parseFloat(locRaw) : null,
    files: filesRaw !== null ? Number.parseFloat(filesRaw) : null,
    domains: domainsRaw
      ? domainsRaw.split("|").map((d) => d.trim()).filter(Boolean)
      : [],
    hasMigration: args.includes("--migration"),
    hasFrontend: args.includes("--frontend"),
    hasBackend: args.includes("--backend"),
    k: kRaw ? Math.max(1, Number.parseInt(kRaw, 10)) : 5,
    json: args.includes("--json"),
  };
}

// -- Corpus loading ----------------------------------------------------------

export function loadCorpus(path: string): Corpus {
  const raw = readFileSync(resolve(path), "utf8");
  const json = JSON.parse(raw) as Corpus;
  if (!Array.isArray(json.entries)) {
    throw new Error(`corpus ${path} has no entries[] array`);
  }
  return json;
}

// -- Similarity components ---------------------------------------------------

export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Closeness of two positive magnitudes on a log scale, in [0,1].
 * Identical → 1; an order of magnitude apart → ~0.5; far apart → →0.
 * Returns null when either side is missing (so it can be skipped, not penalized).
 */
export function logCloseness(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  if (a <= 0 && b <= 0) return 1;
  const la = Math.log10(Math.max(a, 1));
  const lb = Math.log10(Math.max(b, 1));
  const d = Math.abs(la - lb); // 1.0 == one order of magnitude
  return 1 / (1 + d);
}

export interface SimilarityBreakdown {
  title: number;
  loc: number | null;
  files: number | null;
  domains: number;
  flags: number;
  blended: number;
}

/**
 * Blend the similarity components with fixed weights. Numeric components that
 * are null (missing on either side) are dropped and the remaining weights are
 * renormalized so a sparse query still scores fairly.
 */
export function similarity(query: Query, entry: CorpusEntry): SimilarityBreakdown {
  const title = jaccard(titleTokens(query.title), titleTokens(entry.title));
  const loc = logCloseness(query.loc, entry.signals.loc);
  const files = logCloseness(query.changed_files, entry.signals.changed_files);
  const domains = jaccard(
    new Set(query.domains),
    new Set(entry.signals.domains),
  );
  // Structural-flag agreement: fraction of the three flags that match.
  let flagMatches = 0;
  if (query.has_migration === entry.signals.has_migration) flagMatches++;
  if (query.has_frontend === entry.signals.has_frontend) flagMatches++;
  if (query.has_backend === entry.signals.has_backend) flagMatches++;
  const flags = flagMatches / 3;

  const components: Array<{ value: number; weight: number }> = [
    { value: title, weight: 0.35 },
    { value: domains, weight: 0.2 },
    { value: flags, weight: 0.1 },
  ];
  if (loc !== null) components.push({ value: loc, weight: 0.25 });
  if (files !== null) components.push({ value: files, weight: 0.1 });

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const blended =
    totalWeight === 0
      ? 0
      : components.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight;

  return { title, loc, files, domains, flags, blended };
}

// -- k-NN --------------------------------------------------------------------

export interface Neighbor {
  entry: CorpusEntry;
  similarity: number;
  breakdown: SimilarityBreakdown;
}

export function kNearest(
  query: Query,
  corpus: CorpusEntry[],
  k: number,
  excludeTicketId?: string,
): Neighbor[] {
  const scored: Neighbor[] = [];
  for (const entry of corpus) {
    if (excludeTicketId && entry.ticket_id === excludeTicketId) continue;
    const breakdown = similarity(query, entry);
    scored.push({ entry, similarity: breakdown.blended, breakdown });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

// -- Actuals distribution + vote ---------------------------------------------

export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

export interface DistSummary {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

function summarize(values: Array<number | null>): DistSummary {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length === 0) return { n: 0, median: null, min: null, max: null };
  return {
    n: xs.length,
    median: median(xs),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}

export interface LookupResult {
  query: Query;
  k: number;
  neighbors: Array<{
    ticket_id: string;
    title: string;
    tshirt: TShirt;
    points: number;
    similarity: number;
    actuals: CorpusEntry["actuals"];
  }>;
  reference_class: {
    tshirt: TShirt;
    points: number;
    votes: Record<TShirt, number>;
    confidence: "high" | "medium" | "low";
  };
  actuals_distribution: {
    cost_usd: DistSummary;
    turns: DistSummary;
    wall_hours: DistSummary;
  };
}

/** Vote a reference-class T-shirt from the neighbours' assigned sizes. */
export function voteReferenceClass(neighbors: Neighbor[]): {
  tshirt: TShirt;
  votes: Record<TShirt, number>;
  count: number;
} {
  const votes: Record<TShirt, number> = { XS: 0, S: 0, M: 0, L: 0, XL: 0 };
  for (const n of neighbors) votes[n.entry.tshirt]++;
  let best: TShirt = "M";
  let bestCount = 0;
  for (const size of SIZES) {
    if (votes[size] > bestCount) {
      bestCount = votes[size];
      best = size;
    }
  }
  return { tshirt: best, votes, count: bestCount };
}

export function lookup(
  query: Query,
  corpus: CorpusEntry[],
  k: number,
): LookupResult {
  const neighbors = kNearest(query, corpus, k, query.ticket_id);
  const vote = voteReferenceClass(neighbors);
  const confidence: "high" | "medium" | "low" =
    vote.count >= Math.ceil(neighbors.length * 0.6)
      ? "high"
      : vote.count >= 2
        ? "medium"
        : "low";

  return {
    query,
    k,
    neighbors: neighbors.map((n) => ({
      ticket_id: n.entry.ticket_id,
      title: n.entry.title,
      tshirt: n.entry.tshirt,
      points: n.entry.points,
      similarity: Number(n.similarity.toFixed(4)),
      actuals: n.entry.actuals,
    })),
    reference_class: {
      tshirt: vote.tshirt,
      points: TSHIRT_POINTS[vote.tshirt],
      votes: vote.votes,
      confidence,
    },
    actuals_distribution: {
      cost_usd: summarize(neighbors.map((n) => n.entry.actuals.cost_usd)),
      turns: summarize(neighbors.map((n) => n.entry.actuals.turns)),
      wall_hours: summarize(neighbors.map((n) => n.entry.actuals.wall_hours)),
    },
  };
}

// -- Query resolution --------------------------------------------------------

/** Build a Query from CLI opts, optionally pulling signals from a corpus ticket. */
export function resolveQuery(opts: CliOpts, corpus: Corpus): Query {
  if (opts.ticket) {
    const entry = corpus.entries.find(
      (e) => e.ticket_id.toUpperCase() === opts.ticket!.toUpperCase(),
    );
    if (!entry) {
      throw new Error(`ticket ${opts.ticket} not found in corpus`);
    }
    return {
      ticket_id: entry.ticket_id,
      title: entry.title,
      loc: entry.signals.loc,
      changed_files: entry.signals.changed_files,
      domains: entry.signals.domains,
      has_migration: entry.signals.has_migration,
      has_frontend: entry.signals.has_frontend,
      has_backend: entry.signals.has_backend,
    };
  }
  return {
    title: opts.title,
    loc: opts.loc,
    changed_files: opts.files,
    domains: opts.domains,
    has_migration: opts.hasMigration,
    has_frontend: opts.hasFrontend,
    has_backend: opts.hasBackend,
  };
}

// -- Human-readable output ---------------------------------------------------

function fmtNum(n: number | null, digits = 2): string {
  return n === null ? "—" : n.toFixed(digits);
}

export function formatTable(result: LookupResult): string {
  const lines: string[] = [];
  const q = result.query;
  lines.push(
    `Reference-class lookup for: ${q.ticket_id ?? "(ad-hoc)"} "${q.title.slice(0, 60)}"`,
  );
  lines.push(
    `  signals: loc=${fmtNum(q.loc, 0)} files=${fmtNum(q.changed_files, 0)} domains=[${q.domains.join(",")}] mig=${q.has_migration} fe=${q.has_frontend} be=${q.has_backend}`,
  );
  lines.push("");
  lines.push(`Top ${result.neighbors.length} nearest closed tickets:`);
  lines.push(
    `  ${"ticket".padEnd(10)} ${"sim".padEnd(6)} ${"size".padEnd(4)} ${"pts".padEnd(3)} ${"cost$".padEnd(8)} ${"turns".padEnd(6)} ${"wall_h".padEnd(7)} title`,
  );
  for (const n of result.neighbors) {
    lines.push(
      `  ${n.ticket_id.padEnd(10)} ${n.similarity.toFixed(3).padEnd(6)} ${n.tshirt.padEnd(4)} ${String(n.points).padEnd(3)} ${fmtNum(n.actuals.cost_usd).padEnd(8)} ${fmtNum(n.actuals.turns, 0).padEnd(6)} ${fmtNum(n.actuals.wall_hours).padEnd(7)} ${n.title.slice(0, 50)}`,
    );
  }
  lines.push("");
  const rc = result.reference_class;
  const votes = SIZES.map((s) => `${s}=${rc.votes[s]}`).join(" ");
  lines.push(
    `Reference class → ${rc.tshirt} (${rc.points} pts), confidence=${rc.confidence}  [votes: ${votes}]`,
  );
  const d = result.actuals_distribution;
  lines.push(
    `Actuals (neighbour medians): cost=$${fmtNum(d.cost_usd.median)} (n=${d.cost_usd.n}, ${fmtNum(d.cost_usd.min)}–${fmtNum(d.cost_usd.max)}), ` +
      `turns=${fmtNum(d.turns.median, 0)} (n=${d.turns.n}), ` +
      `wall=${fmtNum(d.wall_hours.median)}h (n=${d.wall_hours.n})`,
  );
  return lines.join("\n") + "\n";
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (!opts.corpus) {
    console.error("Error: --corpus <corpus.json> is required");
    process.exit(1);
  }
  if (!opts.ticket && !opts.title) {
    console.error("Error: provide either --ticket <id> or --title <text>");
    process.exit(1);
  }

  let corpus: Corpus;
  try {
    corpus = loadCorpus(opts.corpus);
  } catch (err) {
    console.error(`Error loading corpus: ${(err as Error).message}`);
    process.exit(1);
  }

  let query: Query;
  try {
    query = resolveQuery(opts, corpus);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = lookup(query, corpus.entries, opts.k);

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatTable(result));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
