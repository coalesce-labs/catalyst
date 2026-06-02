// sequencing.mjs — CTL-537 sequencing-seam pure core + defaultCheckSequencing.
// No I/O except injected seams (readTriage for Phase 2; spawn/cache for Phase 3).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "./config.mjs";

const GO = Object.freeze({ verdict: "go", hard_dependencies: [] });

// defaultReadTriage — reads the triage.json artifact for a ticket, or null if
// missing/unreadable. Degrading to null causes buildSequencingContext to use
// id-only context for that ticket.
export function defaultReadTriage(orchDir, ticket) {
  try {
    return JSON.parse(readFileSync(join(orchDir, "workers", ticket, "triage.json"), "utf8"));
  } catch {
    return null;
  }
}

function compact(triage, id) {
  if (!triage) return { id };
  const { classification, summary } = triage;
  const result = { id };
  if (classification != null) result.classification = classification;
  if (summary != null) result.summary = summary;
  return result;
}

export function buildSequencingContext({ candidate, inFlightTickets, orchDir, readTriage = defaultReadTriage }) {
  return {
    candidate: compact(readTriage(orchDir, candidate), candidate),
    inFlight: [...inFlightTickets].map((id) => compact(readTriage(orchDir, id), id)),
  };
}

export function buildSequencingPrompt(context) {
  return [
    "You are a scheduling judge for parallel autonomous coding workers.",
    "A candidate ticket is about to be dispatched while others are already in-flight.",
    "Decide whether to admit it now, hold it (soft code-area conflict), or block it on a",
    "hard dependency. Respond with ONLY a JSON object:",
    '{"verdict":"go"|"hold","reason":"...","hard_dependencies":[{"candidate":"<id>","blocked_by":"<id>","reason":"..."}]}',
    'Use "hold" for soft conflicts (likely to touch the same code area). Use',
    "hard_dependencies ONLY for a true ordering dependency (candidate cannot correctly",
    'land until an in-flight ticket merges). Default to "go" when unsure.',
    "",
    `CONTEXT:\n${JSON.stringify(context, null, 2)}`,
  ].join("\n");
}

const VALID = new Set(["go", "hold"]);

export function parseSequencingVerdict(raw) {
  try {
    let obj = JSON.parse(raw);
    // Unwrap a `claude --output-format json` envelope if present.
    if (obj && typeof obj === "object" && typeof obj.result === "string") {
      obj = JSON.parse(obj.result);
    } else if (obj && typeof obj === "object" && typeof obj.text === "string") {
      obj = JSON.parse(obj.text);
    }
    if (!obj || !VALID.has(obj.verdict)) return { ...GO };
    const deps = Array.isArray(obj.hard_dependencies)
      ? obj.hard_dependencies.filter((d) => d && d.candidate && d.blocked_by)
      : [];
    return {
      verdict: obj.verdict,
      reason: typeof obj.reason === "string" ? obj.reason : "",
      hard_dependencies: deps,
    };
  } catch {
    return { ...GO };
  }
}

export function sequencingCacheKey(candidateId, inFlightIds) {
  return `${candidateId}::${[...inFlightIds].sort().join(",")}`;
}

// ── Phase 3: defaultCheckSequencing ──

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";
const _cache = new Map();

export function __resetSequencingCacheForTests() {
  _cache.clear();
}

function defaultSpawn(prompt) {
  const r = spawnSync(CLAUDE_BIN, ["--print", "--output-format", "json", prompt], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function defaultCheckSequencing({
  candidate,
  inFlightTickets,
  orchDir,
  readTriage = defaultReadTriage,
  spawn = defaultSpawn,
  cache = _cache,
}) {
  const key = sequencingCacheKey(candidate, inFlightTickets);
  if (cache.has(key)) return cache.get(key);
  let verdict;
  try {
    const context = buildSequencingContext({ candidate, inFlightTickets, orchDir, readTriage });
    const out = spawn(buildSequencingPrompt(context));
    verdict = out.status === 0 ? parseSequencingVerdict(out.stdout) : { ...GO };
  } catch (err) {
    log.warn({ candidate, err: err.message }, "sequencing: judgment threw — fail-open go");
    verdict = { ...GO };
  }
  cache.set(key, verdict);
  return verdict;
}
