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

try { db?.close(); } catch {}

const width = Math.max(...out.map((o) => o.gate.length));
for (const o of out) console.log(`${o.verdict.padEnd(13)} ${o.gate.padEnd(width)}  ${o.detail}`);
const fail = out.filter((o) => o.verdict === "FAIL").length;
const inc = out.filter((o) => o.verdict === "INCONCLUSIVE").length;
console.log(`\n${out.filter((o) => o.verdict === "PASS").length} pass · ${fail} FAIL · ${inc} INCONCLUSIVE`);
// 0 all-pass · 2 a real failure · 3 could not determine. Same contract as the ledger.
process.exit(fail > 0 ? 2 : inc > 0 ? 3 : 0);
