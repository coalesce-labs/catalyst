#!/usr/bin/env bun
/**
 * Score ticket signals with the CALIBRATED AI-native heuristic table and emit
 * one corpus entry per ticket: T-shirt + story points + confidence + rationale (CTL-746).
 *
 * Port of the proven Adva pipeline (ADV-424 score-tickets), re-anchored on the
 * calibrated thresholds from the calibration report. This is the **Score** step:
 *
 *     Extract (extract-actuals-from-transcripts.ts)  →  Score (this script)  →  Lookup (reference-class-lookup.ts)
 *
 * Reads a CSV that joins ticket signals (LOC / files / domains / structural flags)
 * with actuals (otel_cost_usd / otel_turns / otel_wall_time_hours from the Extract
 * step), votes each populated signal into a T-shirt bucket, takes the mode, applies
 * structural floors + override modifiers, then maps the T-shirt to Linear-standard
 * story points. Writes both a markdown review table and a JSON corpus file that the
 * reference-class lookup (CTL-186) reads.
 *
 * Calibration vs the ADV original (this corpus, re-derived 2026-06):
 *   - AI-native anchor bands (COST_USD, TURNS, WALL_HOURS) re-derived as the
 *     GEOMETRIC MIDPOINTS of the observed per-size actuals cluster medians on
 *     this transcript corpus. See plugins/pm/docs/estimation-methodology.md.
 *   - The `commits` signal is DROPPED: squash-merge makes it degenerate
 *     (318 / 444 tickets = exactly 1 commit), so it carries near-zero signal.
 *   - LOC and changed-files bands are kept AS-IS from ADV-424 (they calibrated
 *     well and are merge-strategy-independent).
 *   - Output is a corpus entry (T-shirt + points + confidence + rationale), not
 *     just a review table — it is the read-side reference class for CTL-186.
 *
 * Usage:
 *   bun score-tickets.ts --in signals.csv                         # dry-run preview
 *   bun score-tickets.ts --in signals.csv --out estimates.md      # write md + .json sidecar
 *   bun score-tickets.ts --in signals.csv --json corpus.json      # explicit corpus path
 *   bun score-tickets.ts --in signals.csv --check-labels          # skip estimate-source:human
 *
 * Environment:
 *   LINEAR_API_TOKEN   required only when --check-labels is passed
 *
 * Dependency-light: bun + node builtins only.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// -- Types -------------------------------------------------------------------

export type TShirt = "XS" | "S" | "M" | "L" | "XL";
export type Confidence = "high" | "medium" | "low";
export type Tier = 1 | 2 | 3 | 4;

/** Linear-standard story points for each T-shirt (CTL-184 estimation schema). */
export const TSHIRT_POINTS: Record<TShirt, number> = {
  XS: 1,
  S: 3,
  M: 5,
  L: 8,
  XL: 13,
};

export interface SignalRow {
  ticket_id: string;
  title: string;
  state: string;
  priority: string;
  project: string;
  created_at: string;
  closed_at: string;
  current_estimate: string;
  pr_number: string;
  additions: string;
  deletions: string;
  changed_files: string;
  commits: string;
  review_comments: string;
  ci_runs: string;
  hours_to_merge: string;
  had_force_push: string;
  otel_cost_usd: string;
  otel_input_tokens: string;
  otel_output_tokens: string;
  otel_turns: string;
  otel_wall_time_hours: string;
  otel_tool_success_rate: string;
  domains_touched: string;
  has_migration: string;
  has_frontend: string;
  has_backend: string;
  /**
   * CTL-813: optional post-merge human re-score (story points) from the
   * compound-log (`collect-ticket-signals.ts` joins it in). When present and
   * a valid point value, it OVERRIDES the voted score — human ground truth
   * beats the heuristic. Absent on older CSVs.
   */
  human_actual_points?: string;
}

export interface ScoredRow {
  ticket_id: string;
  title: string;
  tier: Tier;
  proposed_tshirt: TShirt;
  points: number;
  confidence: Confidence;
  reasoning: string;
  similar_tickets: string;
}

/** A corpus entry: the read-side reference class consumed by CTL-186 lookup. */
export interface CorpusEntry {
  ticket_id: string;
  title: string;
  tier: Tier;
  tshirt: TShirt;
  points: number;
  confidence: Confidence;
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

// -- CLI parsing -------------------------------------------------------------

interface CliOpts {
  in: string;
  out: string | null;
  json: string | null;
  dryRun: boolean;
  checkLabels: boolean;
  verbose: boolean;
  team: string;
}

function parseArgs(argv: string[]): CliOpts {
  const args = argv.slice(2);
  const getFlag = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  return {
    in: getFlag("--in") ?? "",
    out: getFlag("--out"),
    json: getFlag("--json"),
    dryRun: args.includes("--dry-run"),
    checkLabels: args.includes("--check-labels"),
    verbose: args.includes("--verbose"),
    team: getFlag("--team") ?? "CTL",
  };
}

// -- CSV parsing -------------------------------------------------------------

/**
 * Split a single CSV line that uses RFC-4180 quoting (double-quote escaping).
 * Handles quoted fields with embedded commas and doubled double-quotes.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++; // skip opening quote
      let field = "";
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ",") i++; // skip separator
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

export function parseCsv(content: string): SignalRow[] {
  const lines = content.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows: SignalRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line);
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j] ?? "";
    }
    rows.push(obj as unknown as SignalRow);
  }
  return rows;
}

// -- Tier detection ----------------------------------------------------------

/**
 * Classify a row by available signal richness.
 *
 * Tier 1: closed + PR + at least one actuals (otel_*) column populated
 * Tier 2: closed + PR + all actuals columns empty
 * Tier 3: closed + no PR
 * Tier 4: open (closed_at empty) → scored by nearest-neighbor against the closed pool
 */
export function detectTier(row: SignalRow): Tier {
  if (row.closed_at === "") return 4;
  if (row.pr_number === "") return 3;
  const hasActuals =
    row.otel_cost_usd !== "" ||
    row.otel_turns !== "" ||
    row.otel_wall_time_hours !== "" ||
    row.otel_input_tokens !== "" ||
    row.otel_output_tokens !== "";
  return hasActuals ? 1 : 2;
}

// =============================================================================
// CALIBRATED HEURISTIC TABLE
// =============================================================================
//
// Bands re-derived as geometric midpoints of the observed per-size actuals
// cluster medians on this transcript corpus (CTL-746 calibration, 2026-06).
// A geometric-midpoint boundary b between adjacent size medians m_lo and m_hi
// is b = sqrt(m_lo * m_hi), which is the natural split on the log scale these
// metrics live on. See plugins/pm/docs/estimation-methodology.md for the
// derivation table.
//
// LOC and changed-files rows are KEPT AS-IS from ADV-424 (merge-strategy
// independent, calibrated well). The `commits` signal is DROPPED entirely
// (squash-degenerate: 318/444 = exactly 1 commit on this corpus).

export const SIZES: TShirt[] = ["XS", "S", "M", "L", "XL"];
export const SIZE_INDEX: Record<TShirt, number> = {
  XS: 0,
  S: 1,
  M: 2,
  L: 3,
  XL: 4,
};

/** Total LOC (additions + deletions) → T-shirt. KEPT AS-IS from ADV-424. */
export function locToSize(loc: number): TShirt {
  if (loc < 50) return "XS";
  if (loc < 200) return "S";
  if (loc < 800) return "M";
  if (loc < 2000) return "L";
  return "XL";
}

/** Changed file count → T-shirt. KEPT AS-IS from ADV-424. */
export function filesToSize(files: number): TShirt {
  if (files <= 2) return "XS";
  if (files <= 5) return "S";
  if (files <= 15) return "M";
  if (files <= 30) return "L";
  return "XL";
}

/**
 * Actuals cost (USD) → T-shirt. CALIBRATED band (geometric midpoints, this corpus):
 *   XS <27 | S 27-79 | M 79-147 | L 147-244 | XL 244+
 */
export function costToSize(costUsd: number): TShirt {
  if (costUsd < 27) return "XS";
  if (costUsd < 79) return "S";
  if (costUsd < 147) return "M";
  if (costUsd < 244) return "L";
  return "XL";
}

/**
 * Actuals assistant turns → T-shirt. CALIBRATED band (geometric midpoints):
 *   XS <131 | S 131-208 | M 208-371 | L 371-624 | XL 624+
 */
export function turnsToSize(turns: number): TShirt {
  if (turns < 131) return "XS";
  if (turns < 208) return "S";
  if (turns < 371) return "M";
  if (turns < 624) return "L";
  return "XL";
}

/**
 * Actuals wall-clock hours → T-shirt. CALIBRATED band (geometric midpoints):
 *   XS <0.30 | S 0.30-0.81 | M 0.81-3.9 | L 3.9-23 | XL 23+
 */
export function wallHoursToSize(hours: number): TShirt {
  if (hours < 0.3) return "XS";
  if (hours < 0.81) return "S";
  if (hours < 3.9) return "M";
  if (hours < 23) return "L";
  return "XL";
}

/** Domain count (distinct packages/apps touched) → T-shirt. KEPT AS-IS. */
export function domainsToSize(count: number): TShirt {
  if (count <= 1) return "S";
  if (count === 2) return "M";
  if (count === 3) return "L";
  return "XL";
}

// -- Mode computation --------------------------------------------------------

/**
 * Find the most-common T-shirt among a list of signal votes.
 * Iterates in SIZES order so ties resolve toward XS (conservative).
 */
export function modeSize(sizes: TShirt[]): { mode: TShirt; count: number } {
  if (sizes.length === 0) return { mode: "M", count: 0 };
  const counts: Record<TShirt, number> = { XS: 0, S: 0, M: 0, L: 0, XL: 0 };
  for (const s of sizes) counts[s]++;
  let best: TShirt = "M";
  let bestCount = 0;
  for (const size of SIZES) {
    if (counts[size] > bestCount) {
      bestCount = counts[size];
      best = size;
    }
  }
  return { mode: best, count: bestCount };
}

// -- Structural floors -------------------------------------------------------

/**
 * Apply floor constraints from boolean structural signals.
 * has_migration=true → minimum M
 * has_frontend=true AND has_backend=true → minimum M
 */
export function applyStructuralFloors(
  size: TShirt,
  row: SignalRow,
): { size: TShirt; floors: string[] } {
  const floors: string[] = [];
  let idx = SIZE_INDEX[size];
  const minM = SIZE_INDEX["M"];

  if (row.has_migration === "true" && idx < minM) {
    idx = minM;
    floors.push("has-migration→floor-M");
  }
  if (row.has_frontend === "true" && row.has_backend === "true" && idx < minM) {
    idx = minM;
    floors.push("FE+BE→floor-M");
  }

  return { size: SIZES[idx], floors };
}

// -- Override modifiers ------------------------------------------------------

/**
 * Apply override modifiers to the base T-shirt size.
 *
 * +1 for force-push OR >20 CI runs (rework signal)
 * +1 for 3+ distinct directories touched
 * -1 if single file changed with significant additions (proxy for generated file)
 */
export function applyModifiers(
  base: TShirt,
  row: SignalRow,
): { size: TShirt; modifiers: string[] } {
  const mods: string[] = [];
  let idx = SIZE_INDEX[base];

  const ciRuns = Number.parseFloat(row.ci_runs);
  const forcePush = row.had_force_push === "true";

  if (forcePush || (Number.isFinite(ciRuns) && ciRuns > 20)) {
    idx = Math.min(idx + 1, 4);
    mods.push(forcePush ? "force-push(+1)" : ">20-CI-runs(+1)");
  }

  const domains = row.domains_touched
    ? row.domains_touched.split("|").filter(Boolean)
    : [];
  if (domains.length >= 3) {
    idx = Math.min(idx + 1, 4);
    mods.push("3+-dirs(+1)");
  }

  const changedFiles = Number.parseFloat(row.changed_files);
  const additions = Number.parseFloat(row.additions);
  if (
    Number.isFinite(changedFiles) &&
    changedFiles === 1 &&
    Number.isFinite(additions) &&
    additions > 200
  ) {
    idx = Math.max(idx - 1, 0);
    mods.push("single-large-file(-1)");
  }

  return { size: SIZES[idx], modifiers: mods };
}

// -- Closed-ticket scoring ---------------------------------------------------

export interface ScoringDetail {
  tshirt: TShirt;
  confidence: Confidence;
  signalParts: string[];
  reasoning: string;
}

/**
 * Score a Tier 1-3 row using measurable signals + calibrated actuals bands.
 * NOTE: the `commits` signal is intentionally NOT voted (squash-degenerate).
 */
export function scoreClosedTicket(row: SignalRow, tier: Tier): ScoringDetail {
  const votes: TShirt[] = [];
  const signalParts: string[] = [];

  // LOC signal (additions + deletions) — structural, kept as-is.
  const additions = Number.parseFloat(row.additions);
  const deletions = Number.parseFloat(row.deletions);
  if (Number.isFinite(additions) && Number.isFinite(deletions)) {
    const loc = additions + deletions;
    const s = locToSize(loc);
    votes.push(s);
    signalParts.push(`LOC=${loc}→${s}`);
  }

  // File count signal — structural, kept as-is.
  const changedFiles = Number.parseFloat(row.changed_files);
  if (Number.isFinite(changedFiles) && changedFiles > 0) {
    const s = filesToSize(changedFiles);
    votes.push(s);
    signalParts.push(`files=${changedFiles}→${s}`);
  }

  // NOTE: commits signal DROPPED — squash-merge degenerate (CTL-746 calibration).

  // Domain count signal — structural, kept as-is.
  const domains = row.domains_touched
    ? row.domains_touched.split("|").filter(Boolean)
    : [];
  if (domains.length > 0) {
    const s = domainsToSize(domains.length);
    votes.push(s);
    signalParts.push(`domains=${domains.length}→${s}`);
  }

  // Calibrated actuals signals (Tier 1 only — these are the strong votes).
  if (tier === 1) {
    const costUsd = Number.parseFloat(row.otel_cost_usd);
    if (Number.isFinite(costUsd) && costUsd > 0) {
      const s = costToSize(costUsd);
      votes.push(s);
      signalParts.push(`cost=$${costUsd.toFixed(2)}→${s}`);
    }
    const turns = Number.parseFloat(row.otel_turns);
    if (Number.isFinite(turns) && turns > 0) {
      const s = turnsToSize(turns);
      votes.push(s);
      signalParts.push(`turns=${turns}→${s}`);
    }
    const wallHours = Number.parseFloat(row.otel_wall_time_hours);
    if (Number.isFinite(wallHours) && wallHours > 0) {
      const s = wallHoursToSize(wallHours);
      votes.push(s);
      signalParts.push(`wall=${wallHours.toFixed(2)}h→${s}`);
    }
  }

  if (votes.length === 0) {
    return {
      tshirt: "M",
      confidence: "low",
      signalParts,
      reasoning: "no measurable signals; defaulting to M",
    };
  }

  const { mode, count } = modeSize(votes);
  const confidence: Confidence =
    count >= 3 ? "high" : count >= 2 ? "medium" : "low";

  const floored = applyStructuralFloors(mode, row);
  const modified = applyModifiers(floored.size, row);

  const reasonParts: string[] = [signalParts.join(", ")];
  if (floored.floors.length > 0) reasonParts.push(floored.floors.join(", "));
  if (modified.modifiers.length > 0) {
    reasonParts.push(modified.modifiers.join(", "));
  }

  return {
    tshirt: modified.size,
    confidence,
    signalParts,
    reasoning: reasonParts.join("; "),
  };
}

// -- Nearest-neighbor for Tier 4 (open tickets) ------------------------------

export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface Neighbor {
  ticket_id: string;
  tshirt: TShirt;
  similarity: number;
}

export function nearestNeighbors(
  row: SignalRow,
  pool: Array<{ row: SignalRow; tshirt: TShirt }>,
  k = 5,
): Neighbor[] {
  const myTokens = titleTokens(row.title);
  const scored: Neighbor[] = pool.map(({ row: pr, tshirt }) => ({
    ticket_id: pr.ticket_id,
    tshirt,
    similarity: jaccardSimilarity(myTokens, titleTokens(pr.title)),
  }));
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

// -- Row scorer --------------------------------------------------------------

export function scoreRow(
  row: SignalRow,
  tier: Tier,
  closedPool: Array<{ row: SignalRow; tshirt: TShirt; tier: Tier }>,
): ScoredRow {
  let tshirt: TShirt;
  let confidence: Confidence;
  let reasoning: string;
  let similar = "";

  if (tier === 4) {
    const tier12Pool = closedPool.filter((p) => p.tier === 1 || p.tier === 2);
    if (tier12Pool.length === 0) {
      tshirt = "M";
      confidence = "low";
      reasoning = "no Tier 1-2 pool available; defaulting to M";
    } else {
      const neighbors = nearestNeighbors(row, tier12Pool);
      const tshirts = neighbors.map((n) => n.tshirt);
      const mode = modeSize(tshirts);
      tshirt = mode.mode;
      confidence = mode.count >= 3 ? "high" : mode.count >= 2 ? "medium" : "low";
      similar = neighbors
        .slice(0, 3)
        .map((n) => `${n.ticket_id}(${n.tshirt})`)
        .join(", ");
      reasoning = `NN from Tier 1-2: ${mode.count}/${neighbors.length} votes for ${mode.mode}`;
    }
  } else {
    const detail = scoreClosedTicket(row, tier);
    tshirt = detail.tshirt;
    confidence = detail.confidence;
    reasoning = detail.reasoning;
  }

  return {
    ticket_id: row.ticket_id,
    title: row.title,
    tier,
    proposed_tshirt: tshirt,
    points: TSHIRT_POINTS[tshirt],
    confidence,
    reasoning,
    similar_tickets: similar,
  };
}

// -- Human re-score override (CTL-813) ----------------------------------------

/** Reverse of TSHIRT_POINTS — points value → T-shirt. */
export const POINTS_TSHIRT: Record<number, TShirt> = {
  1: "XS",
  3: "S",
  5: "M",
  8: "L",
  13: "XL",
};

/**
 * Parse the row's `human_actual_points` column. Returns the points value when
 * it is one of the allowed scale values {1,3,5,8,13}, else null (invalid
 * values are reported by the caller, never silently coerced).
 */
export function humanOverridePoints(row: SignalRow): number | null {
  const raw = row.human_actual_points ?? "";
  if (raw === "") return null;
  const pts = Number.parseInt(raw, 10);
  return POINTS_TSHIRT[pts] ? pts : null;
}

/**
 * Apply the compound-log human re-score as a final override: the post-merge
 * human ground truth beats any heuristic vote, so the corpus entry should
 * anchor on it. Confidence becomes "high" and the rationale is annotated so
 * provenance survives into the corpus. No-op when the column is absent or
 * invalid (the caller warns on invalid).
 */
export function applyHumanOverride(scored: ScoredRow, row: SignalRow): ScoredRow {
  const pts = humanOverridePoints(row);
  if (pts === null) return scored;
  return {
    ...scored,
    proposed_tshirt: POINTS_TSHIRT[pts],
    points: pts,
    confidence: "high",
    reasoning: `${scored.reasoning}; human re-score override (compound-log)`,
  };
}

// -- Corpus entry builder ----------------------------------------------------

function numOrNull(s: string): number | null {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function buildCorpusEntry(row: SignalRow, scored: ScoredRow): CorpusEntry {
  const additions = numOrNull(row.additions);
  const deletions = numOrNull(row.deletions);
  const loc =
    additions !== null && deletions !== null ? additions + deletions : null;
  const domains = row.domains_touched
    ? row.domains_touched.split("|").filter(Boolean)
    : [];
  return {
    ticket_id: row.ticket_id,
    title: row.title,
    tier: scored.tier,
    tshirt: scored.proposed_tshirt,
    points: scored.points,
    confidence: scored.confidence,
    rationale: scored.reasoning,
    signals: {
      loc,
      changed_files: numOrNull(row.changed_files),
      domains,
      has_migration: row.has_migration === "true",
      has_frontend: row.has_frontend === "true",
      has_backend: row.has_backend === "true",
    },
    actuals: {
      cost_usd: numOrNull(row.otel_cost_usd),
      turns: numOrNull(row.otel_turns),
      wall_hours: numOrNull(row.otel_wall_time_hours),
    },
  };
}

// -- Label filtering ---------------------------------------------------------

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const HUMAN_LABEL = "estimate-source:human";

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Linear API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `Linear API errors: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!json.data) throw new Error("Linear API returned no data");
  return json.data;
}

async function fetchHumanLabeledTickets(
  token: string,
  teamId: string,
): Promise<Set<string>> {
  type LabelsQ = {
    team: { labels: { nodes: Array<{ id: string; name: string }> } };
  };
  const labelsData = await gql<LabelsQ>(
    token,
    `query($teamId: String!) {
       team(id: $teamId) { labels(first: 250) { nodes { id name } } }
     }`,
    { teamId },
  );
  const label = labelsData.team.labels.nodes.find((n) => n.name === HUMAN_LABEL);
  if (!label) return new Set();
  type IssuesQ = { issues: { nodes: Array<{ identifier: string }> } };
  const issuesData = await gql<IssuesQ>(
    token,
    `query($labelId: ID!) {
       issues(filter: { labels: { id: { eq: $labelId } } }, first: 250) {
         nodes { identifier }
       }
     }`,
    { labelId: label.id },
  );
  return new Set(issuesData.issues.nodes.map((n) => n.identifier.toUpperCase()));
}

async function resolveTeamId(teamKey: string): Promise<string> {
  const proc = Bun.spawn(["linearis", "teams", "list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error("linearis teams list failed");
  const json = JSON.parse(await new Response(proc.stdout).text()) as {
    nodes: Array<{ id: string; key: string }>;
  };
  const match = json.nodes.find(
    (t) => t.key.toLowerCase() === teamKey.toLowerCase(),
  );
  if (!match) throw new Error(`Team key "${teamKey}" not found`);
  return match.id;
}

// -- Output ------------------------------------------------------------------

export function inferTeamKey(rows: SignalRow[]): string {
  if (rows.length === 0) return "CTL";
  const m = rows[0].ticket_id.match(/^([A-Z]+)-\d+$/);
  return m ? m[1] : "CTL";
}

const CONFIDENCE_ORDER: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function sortRows(rows: ScoredRow[]): ScoredRow[] {
  return [...rows].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
  });
}

export function formatMarkdown(rows: ScoredRow[], csvPath: string): string {
  const date = new Date().toISOString().split("T")[0];
  const lines = [
    `# Proposed T-shirt Estimates (calibrated)`,
    ``,
    `Generated: ${date}  `,
    `Source: \`${csvPath}\``,
    ``,
    `| Ticket | Title | Tier | T-shirt | Points | Confidence | Reasoning | Similar |`,
    `|--------|-------|------|---------|--------|------------|-----------|---------|`,
  ];
  for (const row of rows) {
    const title = row.title.replace(/\|/g, "\\|").slice(0, 60);
    const reasoning = row.reasoning.replace(/\|/g, "\\|");
    const similar = row.similar_tickets.replace(/\|/g, "\\|");
    lines.push(
      `| ${row.ticket_id} | ${title} | ${row.tier} | ${row.proposed_tshirt} | ${row.points} | ${row.confidence} | ${reasoning} | ${similar} |`,
    );
  }
  lines.push(``, `## Summary`, ``);
  const dist: Record<TShirt, number> = { XS: 0, S: 0, M: 0, L: 0, XL: 0 };
  for (const r of rows) dist[r.proposed_tshirt]++;
  lines.push(
    `Distribution: XS=${dist.XS} S=${dist.S} M=${dist.M} L=${dist.L} XL=${dist.XL} (total ${rows.length})`,
  );
  const tierCounts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of rows) tierCounts[r.tier]++;
  lines.push(
    `Tiers: T1=${tierCounts[1]} T2=${tierCounts[2]} T3=${tierCounts[3]} T4=${tierCounts[4]}`,
  );
  return lines.join("\n") + "\n";
}

export function formatCorpusJson(entries: CorpusEntry[]): string {
  return (
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        schema: "catalyst.estimation.corpus.v1",
        count: entries.length,
        entries,
      },
      null,
      2,
    ) + "\n"
  );
}

// -- Default output paths ----------------------------------------------------

function dateStr(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function defaultOutPath(): string {
  return `thoughts/shared/pm/analyses/${dateStr()}-proposed-estimates.md`;
}

/** Corpus JSON path: explicit --json, else mdPath with .json, else default. */
export function corpusPathFor(mdPath: string, explicit: string | null): string {
  if (explicit) return resolve(explicit);
  return mdPath.replace(/\.md$/i, ".corpus.json");
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (!opts.in) {
    console.error("Error: --in <csv-path> is required");
    process.exit(1);
  }

  const csvPath = resolve(opts.in);
  const outPath = resolve(opts.out ?? defaultOutPath());
  const corpusPath = corpusPathFor(outPath, opts.json);

  console.log(`[score] in=${csvPath} out=${outPath} corpus=${corpusPath}`);

  let csvContent: string;
  try {
    csvContent = await Bun.file(csvPath).text();
  } catch {
    console.error(`Error: cannot read CSV at ${csvPath}`);
    process.exit(1);
  }

  const rawRows = parseCsv(csvContent);
  console.log(`[score] parsed ${rawRows.length} rows`);

  let skipSet = new Set<string>();
  if (opts.checkLabels) {
    const token =
      process.env.LINEAR_API_TOKEN ?? process.env.LINEAR_API_KEY ?? "";
    if (!token) {
      console.warn(
        "[score] --check-labels: LINEAR_API_TOKEN not set; skipping label filter",
      );
    } else {
      try {
        const teamKey = opts.team || inferTeamKey(rawRows);
        const teamId = await resolveTeamId(teamKey);
        skipSet = await fetchHumanLabeledTickets(token, teamId);
        if (skipSet.size > 0) {
          console.log(
            `[score] skipping ${skipSet.size} ticket(s) with ${HUMAN_LABEL}: ${[...skipSet].join(", ")}`,
          );
        }
      } catch (err) {
        console.warn(
          `[score] label check failed: ${(err as Error).message}; proceeding without filter`,
        );
      }
    }
  }

  const rows = rawRows.filter((r) => !skipSet.has(r.ticket_id.toUpperCase()));

  const tieredRows = rows.map((row) => ({ row, tier: detectTier(row) }));

  const closedPool: Array<{ row: SignalRow; tshirt: TShirt; tier: Tier }> = [];
  for (const { row, tier } of tieredRows) {
    if (tier !== 4) {
      const { tshirt } = scoreClosedTicket(row, tier);
      // CTL-813: a human re-score anchors the NN pool too — neighbors should
      // vote with ground truth, not the heuristic it corrects.
      const humanPts = humanOverridePoints(row);
      closedPool.push({ row, tshirt: humanPts !== null ? POINTS_TSHIRT[humanPts] : tshirt, tier });
    }
  }

  if (opts.verbose) {
    console.log(
      `[score] closed pool: ${closedPool.length} rows (Tier 1-3) for nearest-neighbor`,
    );
  }

  // CTL-813: warn (don't silently drop) when a human re-score is present but
  // not on the points scale — the override only honors {1,3,5,8,13}.
  for (const { row } of tieredRows) {
    const raw = row.human_actual_points ?? "";
    if (raw !== "" && humanOverridePoints(row) === null) {
      console.warn(
        `[score] ${row.ticket_id}: human_actual_points=${raw} not in {1,3,5,8,13} — override ignored`,
      );
    }
  }

  const scored = tieredRows.map(({ row, tier }) =>
    applyHumanOverride(scoreRow(row, tier, closedPool), row),
  );
  const corpus = tieredRows.map(({ row }, i) =>
    buildCorpusEntry(row, scored[i]),
  );

  const sorted = sortRows(scored);
  const markdown = formatMarkdown(sorted, csvPath);
  const corpusJson = formatCorpusJson(corpus);

  if (opts.dryRun) {
    console.log(`[score] --dry-run: skipping write (${scored.length} rows)`);
    console.log(markdown.slice(0, 900));
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  await Bun.write(outPath, markdown);
  mkdirSync(dirname(corpusPath), { recursive: true });
  await Bun.write(corpusPath, corpusJson);

  const t1 = scored.filter((r) => r.tier === 1).length;
  const t4 = scored.filter((r) => r.tier === 4).length;
  console.log(
    `[score] wrote ${scored.length} rows → ${outPath} (Tier1=${t1} Tier4-NN=${t4})`,
  );
  console.log(`[score] wrote ${corpus.length} corpus entries → ${corpusPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
