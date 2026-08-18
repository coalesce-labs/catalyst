#!/usr/bin/env bun
// CTL-1929 rollout preflight — the runbook's P2/P6/P7 gates, run on ONE host.
//
// ⛔ EVERY GATE IS THREE-VALUED. "could not look" is never "covered": a probe that
// throws, a replica that will not open, or a zero-row count each report their own
// verdict rather than degrading to a pass. That is the property the whole cutover
// rests on, so it is the property this script is built around.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { githubSuppressibleNames, GITHUB_CONSUMED_NAMES } from "./github-feed-gate.mjs";
import { readGithubCoverage } from "./github-feed-gate-install.mjs";
import { availableStreams } from "./github-feed-source.mjs";

const DB = process.env.CATALYST_REPLICA_DB ?? join(homedir(), "catalyst", "catalyst-replica.db");
const out = [];
const say = (gate, verdict, detail) => { out.push({ gate, verdict, detail }); };

let db = null;
try { db = new Database(DB, { readonly: true }); }
catch (e) { say("replica-open", "INCONCLUSIVE", `cannot open ${DB}: ${e.message}`); }

// ── P6: migration 0028 ran HERE. Not the SDK version, not the lockfile — the column.
if (db) {
  try {
    const cols = db.prepare("PRAGMA table_info(check_suites)").all().map((r) => r.name);
    if (cols.length === 0) say("P6-migration-0028", "FAIL", "check_suites table absent");
    else if (cols.includes("pull_request_numbers")) say("P6-migration-0028", "PASS", `${cols.length} columns, pull_request_numbers present`);
    else say("P6-migration-0028", "FAIL", `check_suites present but NO pull_request_numbers (still 0.1.17) — cols: ${cols.join(",")}`);
  } catch (e) { say("P6-migration-0028", "INCONCLUSIVE", e.message); }

  // ── P7: MIGRATED IS NOT WRITTEN. The DDL comes from @catalyst-cloud/schema; the
  // row binding comes from @catalyst-cloud/replicate, and the engine DROPS columns the
  // bundled schema does not know. So a present column proves nothing about content.
  // 0028 is additive with no backfill: the ~760 pre-existing rows stay NULL forever and
  // only suites arriving after the restart carry an association.
  try {
    const t = db.prepare("SELECT COUNT(*) n FROM check_suites").get().n;
    let populated = 0;
    try {
      populated = db.prepare("SELECT COUNT(*) n FROM check_suites WHERE pull_request_numbers IS NOT NULL AND pull_request_numbers != ''").get().n;
    } catch { populated = -1; }
    if (populated < 0) say("P7-association-written", "FAIL", `column not queryable; ${t} suite rows`);
    else if (populated === 0) say("P7-association-written", "INCONCLUSIVE", `${t} suite rows, 0 with an association — expected until fresh CI runs post-restart (no backfill). NOT a pass.`);
    else say("P7-association-written", "PASS", `${populated}/${t} suite rows carry an association`);
  } catch (e) { say("P7-association-written", "INCONCLUSIVE", e.message); }

  // ── The stream is actually served here.
  try {
    const keys = availableStreams(db).map((s) => s.key);
    say("streams-served", keys.includes("checkSuiteCompleted") ? "PASS" : "FAIL",
      `${keys.includes("checkSuiteCompleted") ? "checkSuiteCompleted served" : "checkSuiteCompleted NOT served"} · ${keys.join(",")}`);
  } catch (e) { say("streams-served", "INCONCLUSIVE", e.message); }
}

// ── P8: EVERY REPO ON THE TUNNEL, not just the ones that were noisy today.
//
// ⛔ THIS IS THE GATE THE PARITY LEDGER STRUCTURALLY CANNOT BE. The ledger scopes its
// comparison to the repos that appear IN THE WINDOW, so a repo with no activity
// contributes no smee events and can never show up as unjoined. A CLEAN verdict over
// a morning's traffic therefore says NOTHING about a dormant repo — and the smee
// channel `smee.io/WDgeZys5ST0uqtL` carries EIGHT webhooks, six of them for
// fleet-orchestrated teams, of which only two were active enough to measure.
//
// Measured 2026-08-18: catalyst (99 push_events / 898 suites) and catalyst-cloud
// (43 / 71) are covered; `ryanrozich/personal-os` is ACTIVE (82 PRs updated in 48 h)
// with its PRs and reviews ingested and **0 pushes / 0 suites** — a confirmed partial
// ingestion gap; Adva, catalyst-otel, slides, evergreen and adva-crm have been dormant
// for 7–8 days, so their zeroes prove nothing in either direction. → CTL-1965.
//
// ⚠️ A dormant repo is INCONCLUSIVE, never a pass. "No traffic to disprove it" is the
// oldest false-clean in this repository.
const DORMANT_MS = 48 * 60 * 60 * 1000;

function repoCoverage(db, repos) {
  const out = [];
  for (const repo of repos) {
    let r;
    try {
      r = db.prepare(`
        SELECT (SELECT COUNT(*) FROM pull_requests p WHERE p.repo_id = $r) AS prs,
               (SELECT MAX(updated_at) FROM pull_requests p WHERE p.repo_id = $r) AS newest,
               (SELECT COUNT(*) FROM push_events e WHERE e.repo_id = $r) AS pushes,
               (SELECT COUNT(*) FROM check_suites c WHERE c.repo_id = $r) AS suites
      `).get({ $r: repo });
    } catch (e) {
      out.push({ repo, verdict: "INCONCLUSIVE", detail: `cannot query: ${e.message}` });
      continue;
    }
    const active = Number.isInteger(r?.newest) && Date.now() - r.newest < DORMANT_MS;
    if (r.pushes > 0 && r.suites > 0) {
      out.push({ repo, verdict: "PASS", detail: `push_events ${r.pushes} · suites ${r.suites}` });
    } else if (!active) {
      // ⛔ The honest verdict. The repo may be perfectly ingested and simply quiet;
      // nothing here can tell, and a retirement decision must not read this as a pass.
      out.push({ repo, verdict: "INCONCLUSIVE", detail: `dormant (newest PR activity ${r.newest ? new Date(r.newest).toISOString().slice(0, 10) : "never"}), push_events ${r.pushes} · suites ${r.suites} — quiet, so coverage is UNPROVEN either way` });
    } else {
      out.push({ repo, verdict: "FAIL", detail: `ACTIVE (${r.prs} PRs, newest ${new Date(r.newest).toISOString().slice(0, 16)}) but push_events ${r.pushes} · suites ${r.suites} — partial ingestion` });
    }
  }
  return out;
}

// ── P2: 12 of 12, resolved from THIS host's replica.
const cov = readGithubCoverage();
if (!cov.ok) {
  // ⛔ ok:false is "could not read the replica", which is not a covered host and must
  // never be counted as one — the safe set it returns would otherwise read as a real
  // measurement of a 10/12 host.
  say("P2-coverage", "INCONCLUSIVE", "readGithubCoverage ok:false — the replica could not be read, so coverage is UNKNOWN, not 10/12");
} else {
  const s = githubSuppressibleNames(cov);
  const missing = GITHUB_CONSUMED_NAMES.filter((n) => !s.includes(n));
  say("P2-coverage", missing.length === 0 ? "PASS" : "FAIL",
    `${s.length}/${GITHUB_CONSUMED_NAMES.length} · ${JSON.stringify(cov)}${missing.length ? " · missing: " + missing.join(", ") : ""}`);
}

/**
 * The repos whose webhooks share the retiring smee channel `smee.io/WDgeZys5ST0uqtL`,
 * measured 2026-08-18 by walking `gh api repos/<owner>/<repo>/hooks`.
 *
 * ⛔ FROZEN AND REPORTED AS FROZEN, not enumerated. GitHub has no "list every webhook
 * pointing at this URL" endpoint — the only way to build this is to iterate candidate
 * repos, which means the list is exactly as complete as the guess behind it. The first
 * cut of this file wrapped a `gh` call around it that could only ever fall through to
 * this same list; a code path that pretends to check and always defaults is the shape
 * of every check-that-cannot-fire in this codebase, so it is gone and the staleness is
 * declared instead.
 *
 * ⚠️ RE-ENUMERATE BEFORE ACTING ON THIS GATE:
 *   for r in <repos>; do gh api "repos/$r/hooks" --jq '.[]|select(.active)|.id'; done
 */
const TUNNEL_REPOS = Object.freeze([
  "coalesce-labs/catalyst",        // webhook 616654741 — CTL
  "coalesce-labs/catalyst-cloud",  // webhook 657402518 — CTC
  "ryanrozich/personal-os",        // webhook 661338344 — not in the registry
  "rightsite-cloud/Adva",          // webhook 616654744 — ADV
  "coalesce-labs/catalyst-otel",   // webhook 657402515 — OTL
  "ryanrozich/slides",             // webhook 616654742 — SLI
  "coalesce-labs/evergreen",       // webhook 657402511 — EVR
  "rightsite-cloud/adva-crm",      // webhook 657251876 — CRM
]);

if (db) {
  for (const c of repoCoverage(db, TUNNEL_REPOS)) say(`P8-repo:${c.repo}`, c.verdict, c.detail);
  say(
    "P8-repo-list-source",
    "INCONCLUSIVE",
    `frozen list of ${TUNNEL_REPOS.length} repos measured 2026-08-18 — re-enumerate the channel's webhooks before acting; a stale list silently shrinks what is checked`,
  );
}

try { db?.close(); } catch {}

const width = Math.max(...out.map((o) => o.gate.length));
for (const o of out) console.log(`${o.verdict.padEnd(13)} ${o.gate.padEnd(width)}  ${o.detail}`);
const fail = out.filter((o) => o.verdict === "FAIL").length;
const inc = out.filter((o) => o.verdict === "INCONCLUSIVE").length;
console.log(`\n${out.filter((o) => o.verdict === "PASS").length} pass · ${fail} FAIL · ${inc} INCONCLUSIVE`);
// 0 all-pass · 2 a real failure · 3 could not determine. Same contract as the ledger.
process.exit(fail > 0 ? 2 : inc > 0 ? 3 : 0);
