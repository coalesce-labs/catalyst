// beliefs/report.mjs — CTL-935 Phase 5: weekly disagreement report.
// Computes a gate-flip decision report from beliefs.db shadow_comparison rows:
//   - per-rule agreement rates (R4/R5/R6/R7/R8/R16/R17)
//   - per-guard raw counts with both derivations side-by-side (~16 guards)
//   - incident replay verdicts (CTL-722/657/604) via Phase-4 harness
// Delivers as CLI (markdown) and JSON (for orch-monitor HTTP endpoint).

import { openBeliefsDb } from "./schema.mjs";
import { LEGACY_GUARDS } from "./guards.mjs";
import { INCIDENTS, replayIncident } from "./incident-replay.mjs";

const DAY_MS = 86_400_000;
const DEFAULT_SINCE_DAYS = 7;

// ── computeReport ─────────────────────────────────────────────────────────────

// computeReport(db, {sinceMs, nowMs}) → {window, perRule, perGuard, replays}
// All aggregations are windowed by tick.now_ms >= sinceMs. Never throws —
// returns an empty-but-well-formed report on empty db or any error.
export function computeReport(db, { sinceMs = null, nowMs = null } = {}) {
  const resolvedNow = nowMs ?? Date.now();
  const resolvedSince = sinceMs ?? (resolvedNow - DEFAULT_SINCE_DAYS * DAY_MS);

  let window = { sinceMs: resolvedSince, nowMs: resolvedNow, tickCount: 0, rulesShaSet: [] };
  let perRule = [];
  let perGuard = [];
  let degraded = false;       // CTL-935 remediate: set true if a query throws.
  let degradedReason = null;  // so callers can tell "errored" from "quiet week".
  const replays = runReplays(db);

  try {
    // Window metadata: tick count + rules_sha set over the window.
    const winRow = db.query(
      `SELECT COUNT(*) AS cnt, GROUP_CONCAT(DISTINCT rules_sha) AS sha_list
       FROM tick WHERE now_ms >= ?`,
    ).get(resolvedSince);
    window.tickCount = winRow?.cnt ?? 0;
    window.rulesShaSet = winRow?.sha_list ? winRow.sha_list.split(",").filter(Boolean) : [];
    window.multipleRulesSha = window.rulesShaSet.length > 1;

    // Per-rule agreement rates over shadow_comparison joined to tick.
    // Guard-only-no-rule rows have rule_id=NULL and are excluded by IS NOT NULL.
    const ruleRows = db.query(
      `SELECT sc.rule_id,
              COUNT(*) AS total,
              SUM(sc.agree) AS agree_count,
              COUNT(*) - SUM(sc.agree) AS disagree
         FROM shadow_comparison sc
         JOIN tick t ON t.tick_id = sc.tick_id
        WHERE t.now_ms >= ?
          AND sc.rule_id IS NOT NULL
        GROUP BY sc.rule_id
        ORDER BY sc.rule_id`,
    ).all(resolvedSince);
    perRule = ruleRows.map((r) => ({
      rule_id: r.rule_id,
      total: r.total,
      agree: r.agree_count,
      disagree: r.disagree,
      agreementRate: r.total > 0 ? r.agree_count / r.total : null,
    }));

    // Per-guard counts: aggregate from shadow_comparison, then fill every
    // canonical guard with zero counts so the report always has all ~16 rows.
    // Carries both derivations side-by-side (procedural + belief) for scenario-2.
    // Sample columns (rule_id, procedural, belief) use MIN to pick a stable non-null example.
    const rawGuardRows = db.query(
      `SELECT sc.legacy_guard,
              COUNT(*) AS total,
              SUM(sc.agree) AS agree_count,
              COUNT(*) - SUM(sc.agree) AS disagree,
              MIN(sc.rule_id) AS rule_id,
              MIN(sc.procedural) AS procedural,
              MIN(sc.belief) AS belief,
              MIN(sc.differing_input) AS differing_input
         FROM shadow_comparison sc
         JOIN tick t ON t.tick_id = sc.tick_id
        WHERE t.now_ms >= ?
          AND sc.legacy_guard IS NOT NULL
        GROUP BY sc.legacy_guard
        ORDER BY sc.legacy_guard`,
    ).all(resolvedSince);
    const guardCountMap = new Map();
    for (const r of rawGuardRows) {
      guardCountMap.set(r.legacy_guard, {
        legacy_guard: r.legacy_guard,
        total: r.total,
        agree: r.agree_count,
        disagree: r.disagree,
        rule_id: r.rule_id ?? null,
        procedural: r.procedural ?? null,
        belief: r.belief ?? null,
        differing_input: r.differing_input ?? null,
      });
    }
    // LEFT JOIN in JS: fill every canonical guard with zero defaults.
    perGuard = LEGACY_GUARDS.map((g) => guardCountMap.get(g) ?? {
      legacy_guard: g, total: 0, agree: 0, disagree: 0,
      rule_id: null, procedural: null, belief: null, differing_input: null,
    });
  } catch (err) {
    // Shadow contract: report errors must not propagate to callers. But flag
    // the result as degraded (CTL-935 remediate) so a query/schema failure that
    // leaves perRule/perGuard partial isn't misread as "100% agreement". A LATER
    // query throwing can leave tickCount non-zero while the tables are empty —
    // degraded distinguishes that from a legitimately quiet window.
    degraded = true;
    degradedReason = err?.message ?? String(err);
  }

  return { window, perRule, perGuard, replays, degraded, degradedReason };
}

// runReplays — run the three reference incident replays.
// Each replay uses its own fresh in-memory db (isolates from the report db
// so replay fixtures don't pollute the window tick count).
function runReplays(_db) {
  const keys = ["CTL-722", "CTL-657", "CTL-604"];
  return keys.map((id) => {
    const fixture = INCIDENTS[id];
    if (!fixture) return { id, title: id, passed: false, checks: [] };
    let replayDb = null;
    try {
      // Fresh isolated db — openBeliefsDb with in-memory path.
      replayDb = openBeliefsDb({ path: ":memory:" });
      const result = replayIncident(replayDb, fixture);
      return {
        id: result.id,
        title: result.title,
        passed: result.passed,
        checks: result.checks,
      };
    } catch {
      return { id, title: fixture.title ?? id, passed: false, checks: [] };
    } finally {
      try { replayDb?.close(); } catch { /* best-effort */ }
    }
  });
}

// ── renderMarkdown ────────────────────────────────────────────────────────────

export function renderMarkdown(report) {
  const { window, perRule, perGuard, replays } = report;
  const lines = [];

  // Header
  const sinceDate = new Date(window.sinceMs).toISOString().slice(0, 10);
  const nowDate = new Date(window.nowMs).toISOString().slice(0, 10);
  lines.push(`## Belief Shadow Disagreement Report`);
  if (report.degraded) {
    // CTL-935 remediate: a report-machinery error left the tables partial.
    // Banner it so an empty/partial table isn't misread as "no disagreements".
    lines.push(`> ⚠️ **Report incomplete** — a query errored${report.degradedReason ? ` (${report.degradedReason})` : ""}; counts below may be partial.`);
  }
  lines.push(`**Window**: ${sinceDate} → ${nowDate}  `);
  lines.push(`**Ticks**: ${window.tickCount}  `);
  lines.push(`**rules_sha**: ${window.rulesShaSet.length === 0 ? "n/a" : window.rulesShaSet.join(", ")}  `);
  if (window.multipleRulesSha) {
    lines.push(`**⚠️ Multiple rules_sha in window** — disagreements span rule versions and are not directly comparable.`);
  }
  lines.push("");

  // Per-rule table
  lines.push(`### Per-Rule Agreement Rates`);
  lines.push(`| rule_id | total | agree | disagree | agreement_rate |`);
  lines.push(`|---------|-------|-------|----------|----------------|`);
  for (const r of perRule) {
    const rate = r.agreementRate != null ? (r.agreementRate * 100).toFixed(1) + "%" : "n/a";
    lines.push(`| ${r.rule_id} | ${r.total} | ${r.agree} | ${r.disagree} | ${rate} |`);
  }
  if (perRule.length === 0) lines.push(`| (no data) | — | — | — | — |`);
  lines.push("");

  // Per-guard table
  lines.push(`### Per-Guard Raw Counts`);
  lines.push(`| legacy_guard | total | disagree | rule_id | procedural | belief |`);
  lines.push(`|--------------|-------|----------|---------|------------|--------|`);
  for (const g of perGuard) {
    lines.push(`| ${g.legacy_guard} | ${g.total} | ${g.disagree} | ${g.rule_id ?? "—"} | ${g.procedural ?? "—"} | ${g.belief ?? "—"} |`);
  }
  lines.push("");

  // Incident replays
  lines.push(`### Incident Replay Verdicts`);
  lines.push(`| incident | passed | checks |`);
  lines.push(`|----------|--------|--------|`);
  for (const r of replays) {
    const passing = r.checks.filter((c) => c.pass).length;
    lines.push(`| ${r.id} | ${r.passed ? "✅" : "❌"} | ${passing}/${r.checks.length} |`);
  }
  lines.push("");

  return lines.join("\n");
}

// ── renderJson ────────────────────────────────────────────────────────────────

export function renderJson(report) {
  return JSON.stringify(report, null, 2);
}

// ── main (CLI entry) ──────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2), { env = process.env, out = console.log } = {}) {
  let sinceDays = DEFAULT_SINCE_DAYS;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") asJson = true;
    else if (a === "--since-days" && argv[i + 1]) {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) sinceDays = v;
    }
  }
  const nowMs = Date.now();
  const sinceMs = nowMs - sinceDays * DAY_MS;
  const db = openBeliefsDb({ env });
  try {
    const report = computeReport(db, { sinceMs, nowMs });
    out(asJson ? renderJson(report) : renderMarkdown(report));
    return 0;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

if (import.meta.main) {
  process.exit(main());
}
