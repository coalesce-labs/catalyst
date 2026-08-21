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

// ── P8: EVERY REPO ON THE TUNNEL, compared over a MATCHED WINDOW.
//
// ⛔ THIS IS THE GATE THE PARITY LEDGER STRUCTURALLY CANNOT BE. The ledger scopes its
// comparison to the repos that appear IN THE WINDOW, so a repo with no activity
// contributes no smee events and can never show up as unjoined. A CLEAN verdict over
// a morning's traffic therefore says NOTHING about a dormant repo — and the smee
// channel `smee.io/WDgeZys5ST0uqtL` carries EIGHT webhooks, six of them for
// fleet-orchestrated teams.
//
// ⛔⛔ AND THE FIRST CUT OF THIS GATE WAS ITSELF UNSOUND — it inferred coverage from
// RAW ROW COUNTS, and that inference is wrong. `check_suites` on both replicas begins
// at 2026-08-18 06:52:49Z and `push_events` is younger still with a DIFFERENT START
// PER HOST (mini-2 07:04, laptop 11:38). Comparing those counts against a 24-hour
// smee window measures when the table started filling, not what it covers. It
// reported `ryanrozich/personal-os` as a partial-ingestion FAIL; on a matched window
// that repo reads 1 smee suite / 1 replica suite and 1 smee push / 1 replica push —
// **covered**. A gate that fabricates a FAIL on the eve of a retirement is worse than
// no gate, so the comparison is now windowed on both sides.
//
// ⚠️ A repo with NO traffic in the window is INCONCLUSIVE and always will be. You
// cannot measure the coverage of a repo that is not being used; only generating
// traffic can (CTL-1965 option D). "No traffic to disprove it" is the oldest
// false-clean in this repository, and the honest gate says so rather than passing.

/** Rows this replica holds for a repo, strictly inside the window. */
function replicaCountsInWindow(db, repo, sinceMs) {
  return db.prepare(`
    SELECT (SELECT COUNT(*) FROM push_events e  WHERE e.repo_id = $r AND e.updated_at >= $t) AS pushes,
           (SELECT COUNT(*) FROM check_suites c WHERE c.repo_id = $r AND c.updated_at >= $t AND c.status = 'completed') AS suites
  `).get({ $r: repo, $t: sinceMs });
}

/**
 * The window both sides are measured over.
 *
 * ⛔ It starts at the LATEST of the two tables' first rows, not at an arbitrary "last
 * N hours". A window that reaches back before a table began filling counts smee
 * events the replica never had the chance to receive, which is precisely the error
 * this function exists to stop repeating. Per host, because the start differs.
 */
function matchedWindowStart(db) {
  const r = db.prepare(`
    SELECT (SELECT MIN(updated_at) FROM push_events)  AS p,
           (SELECT MIN(updated_at) FROM check_suites) AS c
  `).get();
  const vals = [r?.p, r?.c].filter((x) => Number.isInteger(x));
  return vals.length === 2 ? Math.max(...vals) : null;
}

function repoCoverage(db, repos, sinceMs, smeeCounts) {
  const out = [];
  for (const repo of repos) {
    let r;
    try {
      r = replicaCountsInWindow(db, repo, sinceMs);
    } catch (e) {
      out.push({ repo, verdict: "INCONCLUSIVE", detail: `cannot query: ${e.message}` });
      continue;
    }
    const smee = smeeCounts?.[repo] ?? null;
    if (!smee) {
      // No webhook arm to compare against — either the caller supplied none, or the
      // repo produced nothing in the window. Either way this is not evidence.
      const seen = (r.pushes ?? 0) + (r.suites ?? 0);
      out.push({
        repo,
        verdict: seen > 0 ? "PASS" : "INCONCLUSIVE",
        detail: seen > 0
          ? `replica has push_events ${r.pushes} · suites ${r.suites} in the window (no smee arm supplied, so this is presence, not parity)`
          : "no traffic in the matched window — coverage is UNPROVEN, not absent. Only generating traffic can settle it (CTL-1965 option D)",
      });
      continue;
    }
    const missPush = smee.pushes - r.pushes;
    const missSuite = smee.suites - r.suites;
    if (smee.pushes === 0 && smee.suites === 0) {
      out.push({ repo, verdict: "INCONCLUSIVE", detail: "no smee traffic in the matched window — coverage UNPROVEN (CTL-1965 option D)" });
    } else if (missPush <= 0 && missSuite <= 0) {
      out.push({ repo, verdict: "PASS", detail: `matched window: pushes ${r.pushes}/${smee.pushes} · suites ${r.suites}/${smee.suites}` });
    } else {
      out.push({ repo, verdict: "FAIL", detail: `matched window SHORTFALL: pushes ${r.pushes}/${smee.pushes} · suites ${r.suites}/${smee.suites}` });
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
  const since = matchedWindowStart(db);
  if (since === null) {
    say("P8-repo-coverage", "INCONCLUSIVE", "cannot establish a matched window (push_events/check_suites empty) — no per-repo verdict is derivable");
  } else {
    // ⚠️ NO SMEE ARM IS SUPPLIED HERE, and that is stated rather than hidden. Reading
    // the webhook side means streaming a multi-GB event log, which is the ledger's job
    // (`github-feed-parity-run.mjs`), not a preflight's. Without it this gate reports
    // PRESENCE — which repos this replica is receiving push/suite rows for at all —
    // and INCONCLUSIVE for every repo that is quiet. It can therefore surface a repo
    // nobody is covering; it cannot certify one as fully covered. Pair it with the
    // ledger, and with CTL-1965 option D for the dormant ones.
    say("P8-window", "INCONCLUSIVE", `matched window starts ${new Date(since).toISOString()} (the later of the two tables' first rows) — PRESENCE only, no smee arm; pair with the ledger`);
    for (const c of repoCoverage(db, TUNNEL_REPOS, since, null)) say(`P8-repo:${c.repo}`, c.verdict, c.detail);
  }
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
