#!/usr/bin/env bun
/**
 * Collect per-ticket SIGNALS into the score-tickets input CSV (CTL-813).
 *
 * This is the missing JOIN step of the corpus-refresh write side:
 *
 *   Extract (extract-actuals-from-transcripts.ts)
 *        ↘ actuals.csv (otel_* columns)
 *   Linear (linearis issues list --status Done)   ──┐
 *   GitHub (gh pr list --state merged + files[])  ──┼→ Collect (this script) → signals.csv → Score
 *   compound-log (compound-log.sh aggregate)      ──┘
 *
 * Output columns are score-tickets.ts SignalRow plus `human_actual_points`
 * (the per-ticket post-merge human re-score from the compound-log — the
 * ground-truth override Score honors when present).
 *
 * v1 limitations (documented, not silent):
 *   - commits / review_comments / ci_runs / had_force_push are emitted EMPTY.
 *     Filling them needs per-PR timeline API calls (an API storm); Score
 *     simply casts no vote / skips the modifier for empty columns. Entries
 *     are still strictly richer than the CTL-751 bootstrap corpus (which had
 *     NO structural signals at all).
 *   - Only PRs in the CURRENT repo are matched (gh pr list runs in cwd), so
 *     run it from the repo whose team you pass. Cross-repo teams (e.g. ADV
 *     anchors in the committed corpus) are preserved by refresh-corpus.sh's
 *     merge step, not re-collected here.
 *
 * Usage:
 *   bun collect-ticket-signals.ts --team CTL --out signals.csv \
 *     [--actuals actuals.csv] [--compound-log aggregate.json] \
 *     [--limit 250] [--pr-limit 1000] [--dry-run] [--verbose]
 *
 * Dependency-light: bun + node builtins; shells to `linearis` and `gh`.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { splitCsvLine } from "./score-tickets";

// -- Types --------------------------------------------------------------------

export interface LinearTicket {
  identifier: string;
  title: string;
  state: string;
  priority: number | null;
  project: string;
  created_at: string;
  updated_at: string;
  estimate: number | null;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface MergedPr {
  number: number;
  title: string;
  headRefName: string;
  createdAt: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PrFile[];
}

export interface ActualsRow {
  otel_cost_usd: string;
  otel_input_tokens: string;
  otel_output_tokens: string;
  otel_turns: string;
  otel_wall_time_hours: string;
  otel_tool_success_rate: string;
}

/** One output row — SignalRow columns + the human re-score override. */
export type OutputRow = Record<(typeof OUTPUT_HEADERS)[number], string>;

export const OUTPUT_HEADERS = [
  "ticket_id",
  "title",
  "state",
  "priority",
  "project",
  "created_at",
  "closed_at",
  "current_estimate",
  "pr_number",
  "additions",
  "deletions",
  "changed_files",
  "commits",
  "review_comments",
  "ci_runs",
  "hours_to_merge",
  "had_force_push",
  "otel_cost_usd",
  "otel_input_tokens",
  "otel_output_tokens",
  "otel_turns",
  "otel_wall_time_hours",
  "otel_tool_success_rate",
  "domains_touched",
  "has_migration",
  "has_frontend",
  "has_backend",
  "human_actual_points",
] as const;

// -- Ticket-id extraction -------------------------------------------------------

/**
 * Extract a ticket id for the given teams from a merged PR. Branch name wins
 * (orchestrator branches embed the id: `ryan/ctl-813-...`, `CTL-813`); the PR
 * title is the fallback (`feat(dev): ... (CTL-813)`). Case-insensitive;
 * returns the UPPERCASED id or null.
 */
export function ticketIdFromPr(
  pr: Pick<MergedPr, "headRefName" | "title">,
  teams: string[],
): string | null {
  const pattern = new RegExp(`\\b(${teams.join("|")})-(\\d+)\\b`, "i");
  for (const source of [pr.headRefName, pr.title]) {
    const m = pattern.exec(source ?? "");
    if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  }
  return null;
}

// -- Domain + structural-flag heuristics ----------------------------------------

/**
 * Top-level domain of a repo path. `plugins/<name>` keeps two segments (the
 * plugin is the unit of distribution); everything else is the first segment.
 * Matches the methodology's "distinct pkgs" intent (estimation-methodology §1b).
 */
export function domainOf(path: string): string {
  const parts = path.split("/");
  if (parts[0] === "plugins" && parts.length > 1) return `plugins/${parts[1]}`;
  return parts[0];
}

export function domainsFromPaths(paths: string[]): string[] {
  return [...new Set(paths.map(domainOf))].sort();
}

const FRONTEND_RE = /^website\/|\/orch-monitor\/src\/|\.(tsx|css)$/;
const BACKEND_RE = /\.(mjs|ts|sh)$/;

/**
 * Structural flags for the Score floors/modifiers. Catalyst-tuned:
 * frontend = website/ or the orch-monitor SPA or .tsx/.css; backend = script
 * code (.mjs/.ts/.sh) that is not a frontend path. has_migration keys off the
 * path containing "migration" (rare in this repo, kept for schema parity).
 */
export function structuralFlags(paths: string[]): {
  has_migration: boolean;
  has_frontend: boolean;
  has_backend: boolean;
} {
  let has_migration = false;
  let has_frontend = false;
  let has_backend = false;
  for (const p of paths) {
    if (/migration/i.test(p)) has_migration = true;
    if (FRONTEND_RE.test(p)) has_frontend = true;
    else if (BACKEND_RE.test(p)) has_backend = true;
  }
  return { has_migration, has_frontend, has_backend };
}

// -- Actuals CSV parsing ---------------------------------------------------------

/** Parse the Extract step's actuals CSV into a ticket_id → otel columns map. */
export function parseActualsCsv(content: string): Map<string, ActualsRow> {
  const map = new Map<string, ActualsRow>();
  const lines = content.trim().split("\n");
  if (lines.length < 2) return map;
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = values[j] ?? "";
    if (!row.ticket_id) continue;
    map.set(row.ticket_id.toUpperCase(), {
      otel_cost_usd: row.otel_cost_usd ?? "",
      otel_input_tokens: row.otel_input_tokens ?? "",
      otel_output_tokens: row.otel_output_tokens ?? "",
      otel_turns: row.otel_turns ?? "",
      otel_wall_time_hours: row.otel_wall_time_hours ?? "",
      otel_tool_success_rate: row.otel_tool_success_rate ?? "",
    });
  }
  return map;
}

// -- Compound-log aggregate parsing ----------------------------------------------

/**
 * ticket_id → estimate_actual from `compound-log.sh aggregate` output.
 * Anything non-numeric is dropped; Score re-validates against the allowed
 * points scale.
 */
export function parseCompoundAggregate(json: string): Map<string, number> {
  const map = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return map;
  }
  const tickets = (parsed as { tickets?: Record<string, { estimate_actual?: unknown }> })
    ?.tickets;
  if (!tickets || typeof tickets !== "object") return map;
  for (const [key, entry] of Object.entries(tickets)) {
    const v = entry?.estimate_actual;
    if (typeof v === "number" && Number.isFinite(v)) map.set(key.toUpperCase(), v);
  }
  return map;
}

// -- Join -------------------------------------------------------------------------

export function hoursBetween(fromIso: string, toIso: string): number | null {
  const t0 = Date.parse(fromIso);
  const t1 = Date.parse(toIso);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return (t1 - t0) / 3_600_000;
}

/**
 * Join Linear tickets with their merged PR, transcript actuals, and the
 * compound-log human re-score into score-tickets input rows.
 *
 * closed_at: linearis never populates completedAt, so the merged PR's
 * mergedAt is the closed timestamp; tickets without a matched PR fall back
 * to updated_at (every input ticket is Done by query). Tickets with NEITHER
 * a PR nor actuals are dropped — they would score as signal-less default-M
 * noise (Tier 3 with zero votes).
 */
export function buildSignalRows(
  tickets: LinearTicket[],
  prsByTicket: Map<string, MergedPr>,
  actuals: Map<string, ActualsRow>,
  humanActuals: Map<string, number>,
  opts: { verbose?: boolean } = {},
): OutputRow[] {
  const rows: OutputRow[] = [];
  for (const t of tickets) {
    const id = t.identifier.toUpperCase();
    const pr = prsByTicket.get(id) ?? null;
    const act = actuals.get(id) ?? null;
    if (!pr && !act) {
      if (opts.verbose) console.log(`  [collect] ${id}: no PR + no actuals — dropped`);
      continue;
    }
    const paths = pr ? pr.files.map((f) => f.path) : [];
    const flags = structuralFlags(paths);
    const human = humanActuals.get(id);
    const hours =
      pr && pr.createdAt && pr.mergedAt ? hoursBetween(pr.createdAt, pr.mergedAt) : null;
    rows.push({
      ticket_id: id,
      title: t.title ?? "",
      state: t.state ?? "",
      priority: t.priority != null ? String(t.priority) : "",
      project: t.project ?? "",
      created_at: t.created_at ?? "",
      closed_at: pr?.mergedAt || t.updated_at || "",
      current_estimate: t.estimate != null ? String(t.estimate) : "",
      pr_number: pr ? String(pr.number) : "",
      additions: pr ? String(pr.additions) : "",
      deletions: pr ? String(pr.deletions) : "",
      changed_files: pr ? String(pr.changedFiles) : "",
      commits: "",
      review_comments: "",
      ci_runs: "",
      hours_to_merge: hours != null ? hours.toFixed(2) : "",
      had_force_push: "",
      otel_cost_usd: act?.otel_cost_usd ?? "",
      otel_input_tokens: act?.otel_input_tokens ?? "",
      otel_output_tokens: act?.otel_output_tokens ?? "",
      otel_turns: act?.otel_turns ?? "",
      otel_wall_time_hours: act?.otel_wall_time_hours ?? "",
      otel_tool_success_rate: act?.otel_tool_success_rate ?? "",
      domains_touched: domainsFromPaths(paths).join("|"),
      has_migration: paths.length ? String(flags.has_migration) : "",
      has_frontend: paths.length ? String(flags.has_frontend) : "",
      has_backend: paths.length ? String(flags.has_backend) : "",
      human_actual_points: human != null ? String(human) : "",
    });
  }
  return rows;
}

// -- CSV output ---------------------------------------------------------------------

function csvQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(rows: OutputRow[]): string {
  const header = OUTPUT_HEADERS.map(csvQuote).join(",");
  const lines = rows.map((r) => OUTPUT_HEADERS.map((h) => csvQuote(r[h])).join(","));
  return [header, ...lines].join("\n") + "\n";
}

// -- External fetchers (CLI shells; injectable in tests via the pure join) ----------

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed (exit ${code}): ${stderr.slice(0, 400)}`);
  }
  return stdout;
}

export async function fetchDoneTickets(team: string, limit: number): Promise<LinearTicket[]> {
  const out = await run([
    "linearis",
    "issues",
    "list",
    "--team",
    team,
    "--status",
    "Done",
    "--limit",
    String(limit),
  ]);
  const parsed = JSON.parse(out) as {
    nodes: Array<{
      identifier: string;
      title?: string;
      state?: { name?: string };
      priority?: number;
      project?: { name?: string } | null;
      createdAt?: string;
      updatedAt?: string;
      estimate?: number | null;
    }>;
  };
  return (parsed.nodes ?? []).map((n) => ({
    identifier: n.identifier,
    title: n.title ?? "",
    state: n.state?.name ?? "Done",
    priority: typeof n.priority === "number" ? n.priority : null,
    project: n.project?.name ?? "",
    created_at: n.createdAt ?? "",
    updated_at: n.updatedAt ?? "",
    estimate: typeof n.estimate === "number" ? n.estimate : null,
  }));
}

export async function fetchMergedPrs(limit: number): Promise<MergedPr[]> {
  const out = await run([
    "gh",
    "pr",
    "list",
    "--state",
    "merged",
    "--limit",
    String(limit),
    "--json",
    "number,title,headRefName,createdAt,mergedAt,additions,deletions,changedFiles,files",
  ]);
  return JSON.parse(out) as MergedPr[];
}

/** First PR per ticket by mergedAt DESC order of gh output → latest merge wins. */
export function indexPrsByTicket(prs: MergedPr[], teams: string[]): Map<string, MergedPr> {
  const map = new Map<string, MergedPr>();
  for (const pr of prs) {
    const id = ticketIdFromPr(pr, teams);
    if (id && !map.has(id)) map.set(id, pr);
  }
  return map;
}

// -- CLI ------------------------------------------------------------------------------

interface CliOpts {
  team: string;
  out: string | null;
  actuals: string | null;
  compoundLog: string | null;
  limit: number;
  prLimit: number;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const args = argv.slice(2);
  const getFlag = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  return {
    team: getFlag("--team") ?? "CTL",
    out: getFlag("--out"),
    actuals: getFlag("--actuals"),
    compoundLog: getFlag("--compound-log"),
    limit: Number.parseInt(getFlag("--limit") ?? "250", 10),
    prLimit: Number.parseInt(getFlag("--pr-limit") ?? "1000", 10),
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  console.log(`[collect] team=${opts.team} limit=${opts.limit} pr-limit=${opts.prLimit}`);

  const tickets = await fetchDoneTickets(opts.team, opts.limit);
  console.log(`[collect] ${tickets.length} Done ticket(s) from Linear`);

  const prs = await fetchMergedPrs(opts.prLimit);
  const prsByTicket = indexPrsByTicket(prs, [opts.team]);
  console.log(`[collect] ${prs.length} merged PR(s) → ${prsByTicket.size} ticket-matched`);

  let actuals = new Map<string, ActualsRow>();
  if (opts.actuals) {
    try {
      actuals = parseActualsCsv(readFileSync(resolve(opts.actuals), "utf8"));
      console.log(`[collect] ${actuals.size} actuals row(s) from ${opts.actuals}`);
    } catch (err) {
      console.warn(`[collect] actuals unreadable (${(err as Error).message}) — proceeding without`);
    }
  }

  let human = new Map<string, number>();
  if (opts.compoundLog) {
    try {
      human = parseCompoundAggregate(readFileSync(resolve(opts.compoundLog), "utf8"));
      console.log(`[collect] ${human.size} human re-score(s) from compound-log`);
    } catch (err) {
      console.warn(
        `[collect] compound-log unreadable (${(err as Error).message}) — proceeding without`,
      );
    }
  }

  const rows = buildSignalRows(tickets, prsByTicket, actuals, human, {
    verbose: opts.verbose,
  });
  const csv = toCsv(rows);
  console.log(`[collect] ${rows.length} signal row(s) built (${tickets.length - rows.length} dropped: no PR + no actuals)`);

  if (opts.dryRun || !opts.out) {
    console.log(`[collect] --dry-run / no --out: skipping write`);
    console.log(csv.split("\n").slice(0, 5).join("\n"));
    return;
  }

  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, csv);
  console.log(`[collect] wrote ${rows.length} rows → ${outPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
