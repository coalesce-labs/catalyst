// event-log-paths.mjs — THE canonical event-log path resolver (CTL-1216).
//
// Before this file the rotation scheme was re-derived at 32 production sites
// (76 test files), including FOUR byte-identical getEventLogPath() copies
// (execution-core/config.mjs, broker/config.mjs, catalyst-agent/config.mjs,
// orch-monitor/lib/respond-ticket.mjs). Writer and readers agreed only by each
// computing the same string — which is fine while the string never changes and
// is exactly what makes changing it a 32-site sweep.
//
// ── WHY IT LIVES IN lib/ ────────────────────────────────────────────────────
// `lib/` is the zero-npm-import zone (see lib/event-name.mjs): `catalyst doctor`
// resolves its runtime as `command -v bun || command -v node` and must import
// from here on bare Node with no node_modules. This file imports only
// node:fs/node:os/node:path — the same budget as lib/secret-contract.mjs — so
// every stack in the repo can load it, including the standalone catalyst-agent
// (whose "own copy" of getEventLogPath existed precisely because it would not
// import execution-core's).
//
// TypeScript consumers (orch-monitor, otel-forward, event-mirror) import it
// through the event-log-paths.d.mts sidecar, the same shape as
// lib/event-name.d.mts.
//
// ── THE SCHEME IS A KNOB, AND IT DEGRADES TOWARD WHAT IS ALREADY ON DISK ────
// `catalyst.events.rotation` / CATALYST_EVENT_LOG_ROTATION ∈ month | week.
// Any unrecognized value settles at DEFAULT_ROTATION_SCHEME — a REAL scheme, so
// a broken knob can never leave the fleet without a rotation policy. It settles
// at the shipped default rather than at `month`, so one host with a typo'd knob
// does not silently write to a different file from the rest of the fleet.
// Never throws.
//
// ── READERS ARE SCHEME-AGNOSTIC BY CONSTRUCTION ─────────────────────────────
// resolveEventLogPathsForWindow ENUMERATES and PARSES the events directory
// rather than computing "the current one" or "the previous one". That is what
// keeps historical YYYY-MM.jsonl files readable alongside YYYY-Www.jsonl, and
// what lets a 7-day lookback survive a file younger than 7 days. It also means
// a future scheme change needs no third 32-site sweep.

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;

export const ROTATION_SCHEMES = Object.freeze(["month", "week"]);
// CTL-1216 phase 5: the shipped default is WEEK. Measured on mini-2 at
// 2026-08-22T02:14Z the monthly file was 2,587,408,830 bytes / 3,026,635 lines
// at day 21 and growing ~123 MB/day; month over month 2026-06 = 295 MiB,
// 2026-07 = 971 MiB, 2026-08 = 2.41 GiB. Weekly bounds the working file to
// ~860 MB against an extrapolated ~3.7 GB month.
//
// ROLLBACK LEVER: CATALYST_EVENT_LOG_ROTATION=month (or
// catalyst.events.rotation: "month"), then restart. It is NOT destructive —
// readers have been scheme-agnostic since phase 2, so weekly files written in
// the interim stay readable.
export const DEFAULT_ROTATION_SCHEME = "week";

// resolveRotationScheme — env > config > default. DEGRADES TO the default on
// any unrecognized value (including a non-string config value, which is why the
// String() coercion happens after the nullish fallbacks rather than before).
// Never throws.
export function resolveRotationScheme({ env = process.env, config = null } = {}) {
  let raw = env?.CATALYST_EVENT_LOG_ROTATION;
  if (raw === undefined || raw === null || raw === "") {
    raw = config?.catalyst?.events?.rotation;
  }
  if (typeof raw !== "string") return DEFAULT_ROTATION_SCHEME;
  const v = raw.trim().toLowerCase();
  return ROTATION_SCHEMES.includes(v) ? v : DEFAULT_ROTATION_SCHEME;
}

// ── ISO-8601 week arithmetic ────────────────────────────────────────────────
// JS has no built-in. `%G` (the ISO year) is NOT `%Y`: 2027-01-01 is 2026-W53,
// and 2026 is a 53-week year. Verified against `date -u +%G-W%V` via the shared
// fixture __tests__/fixtures/event-log-week-oracle.txt, and round-tripped over
// every day from 2024-01-01 to 2030-01-01 (2192 days, 0 misses).

export function isoWeekParts(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // -> the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const isoWeek = Math.ceil(((d.getTime() - jan1) / DAY_MS + 1) / 7);
  return { isoYear, isoWeek };
}

export function isoWeekStartMs(isoYear, isoWeek) {
  const jan4 = Date.UTC(isoYear, 0, 4); // Jan 4 is ALWAYS in ISO week 1
  const jan4Day = new Date(jan4).getUTCDay() || 7;
  const week1Mon = jan4 - (jan4Day - 1) * DAY_MS;
  return week1Mon + (isoWeek - 1) * WEEK_MS;
}

// isoWeeksInYear — 52 or 53. Dec 28 is ALWAYS in the last ISO week of its year.
export function isoWeeksInYear(isoYear) {
  return isoWeekParts(new Date(Date.UTC(isoYear, 11, 28))).isoWeek;
}

export function eventLogBasenameFor(date, scheme = DEFAULT_ROTATION_SCHEME) {
  if (scheme === "week") {
    const { isoYear, isoWeek } = isoWeekParts(date);
    return `${isoYear}-W${String(isoWeek).padStart(2, "0")}.jsonl`;
  }
  const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${ym}.jsonl`;
}

// parseEventLogBasename — the INVERSE, and the reason readers are
// scheme-agnostic. Returns { scheme, startMs, endMs } (HALF-OPEN: startMs
// inclusive, endMs exclusive) or null.
//
// Null for anything that is not EXACTLY a log file — notably the CTL-1813
// `*.legacy.<stamp>.<pid>` quarantine files, which hold real events but were
// deliberately set aside and must never be folded back into a window.
export function parseEventLogBasename(name) {
  if (typeof name !== "string") return null;

  let m = /^(\d{4})-(\d{2})\.jsonl$/.exec(name);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { scheme: "month", startMs: Date.UTC(y, mo - 1, 1), endMs: Date.UTC(y, mo, 1) };
  }

  m = /^(\d{4})-W(\d{2})\.jsonl$/.exec(name);
  if (m) {
    const y = Number(m[1]);
    const w = Number(m[2]);
    if (w < 1 || w > 53) return null;
    const startMs = isoWeekStartMs(y, w);
    // W53 does not exist in every ISO year. Round-trip to reject a fabricated
    // one rather than silently returning an interval in the following January.
    const rt = isoWeekParts(new Date(startMs));
    if (rt.isoYear !== y || rt.isoWeek !== w) return null;
    return { scheme: "week", startMs, endMs: startMs + WEEK_MS };
  }

  return null;
}

// ── directory + window resolution ───────────────────────────────────────────

// eventsDir — the union of what the four former copies each honoured, so that
// folding them together can only ever REDIRECT a write away from the shared
// production log, never toward it:
//
//   • CATALYST_EVENTS_DIR wins. execution-core/config.mjs's copy ignored it
//     while coordination-publish, recovery-pass-context and
//     daemon-watchdog-predicates already honoured it — i.e. a caller that set
//     it to redirect events into a sandbox still had getEventLogPath() pointing
//     at ~/catalyst/events. Honouring it everywhere closes that.
//   • `resolve` (not `join`) matches the execution-core and broker copies; it
//     is a no-op for the absolute paths every caller actually supplies.
//   • env.HOME ahead of homedir() matches the broker and respond-ticket copies.
export function eventsDir({ env = process.env } = {}) {
  if (env?.CATALYST_EVENTS_DIR) return env.CATALYST_EVENTS_DIR;
  const home = env?.HOME ?? homedir();
  return resolve(env?.CATALYST_DIR ?? join(home, "catalyst"), "events");
}

// getEventLogPath — the drop-in replacement for all FOUR existing copies.
// Resolved PER CALL (never captured at module load) so a long-lived daemon that
// crosses a period boundary writes where the tailer now reads — the CTL-1506 P2
// property otel-forward already depends on.
export function getEventLogPath({ env = process.env, now = new Date(), config = null } = {}) {
  return join(eventsDir({ env }), eventLogBasenameFor(now, resolveRotationScheme({ env, config })));
}

// resolveEventLogPathsForWindow — every file whose interval OVERLAPS the
// half-open window [sinceMs, nowMs], oldest-first, mixing schemes freely.
//
// This is what keeps historical YYYY-MM.jsonl readable (ticket AC 3) and what
// lets a 7-day lookback survive a file younger than 7 days. Enumerating +
// parsing (rather than computing "the previous one") is deliberate: it needs no
// third sweep if the scheme changes again.
//
// Fail-open: an unreadable dir yields [] and never throws. Callers that need to
// distinguish "no events" from "could not look" must check the directory
// themselves — an empty list here is not evidence of an empty window.
export function resolveEventLogPathsForWindow({
  eventsDir: dir,
  sinceMs,
  nowMs = Date.now(),
  env = process.env,
  includeCurrent = false,
} = {}) {
  const resolvedDir = dir ?? eventsDir({ env });
  let names = [];
  try {
    names = readdirSync(resolvedDir);
  } catch {
    names = [];
  }

  const hits = [];
  for (const n of names) {
    const iv = parseEventLogBasename(n); // skips *.legacy.*, *.tmp, foreign files
    if (!iv) continue;
    if (iv.endMs <= sinceMs || iv.startMs > nowMs) continue;
    hits.push({ path: join(resolvedDir, n), startMs: iv.startMs });
  }
  hits.sort((a, b) => a.startMs - b.startMs);
  const out = hits.map((h) => h.path);

  if (includeCurrent) {
    // A brand-new period has no file until the first append, but a tail must
    // still target it.
    const cur = join(resolvedDir, eventLogBasenameFor(new Date(nowMs), resolveRotationScheme({ env })));
    if (!out.includes(cur)) out.push(cur);
  }
  return out;
}

// getPrevEventLogPath — generalizes broker/config.mjs::getPrevMonthEventLogPath
// to "the newest EXISTING file strictly older than the current one", so the
// CTL-1122 ingestion-recency seed works under either scheme (and across a
// scheme change, where "the previous month" may not be the previous file).
// Returns null when there is no older file.
export function getPrevEventLogPath({ env = process.env, now = new Date() } = {}) {
  const dir = eventsDir({ env });
  const cur = getEventLogPath({ env, now });
  const older = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs: 0,
    nowMs: now.getTime(),
    env,
  }).filter((p) => p !== cur);
  return older.length ? older[older.length - 1] : null;
}
