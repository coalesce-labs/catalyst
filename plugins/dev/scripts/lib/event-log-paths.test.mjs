// event-log-paths.test.mjs — CTL-1216 Phase 1.
//
// The oracle for every ISO-week assertion below is `date -u +%G-W%V` (see
// __tests__/fixtures/event-log-week-oracle.txt, the SAME fixture list the bash
// parity suite reads — a divergent fixture set is how a parity suite passes
// while the two engines disagree on an untested date).
//
// %G is the ISO YEAR and it is NOT %Y: 2026-12-31, 2027-01-01 and 2027-01-03
// are all 2026-W53, and 2026 is a 53-week year.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import {
  ROTATION_SCHEMES,
  DEFAULT_ROTATION_SCHEME,
  resolveRotationScheme,
  isoWeekParts,
  isoWeekStartMs,
  isoWeeksInYear,
  eventLogBasenameFor,
  parseEventLogBasename,
  eventsDir,
  getEventLogPath,
  resolveEventLogPathsForWindow,
  getPrevEventLogPath,
} from "./event-log-paths.mjs";

const DAY_MS = 86400000;
const TMP_DIRS = [];

function mkTmpEventsDir(names) {
  const dir = mkdtempSync(join(tmpdir(), "ctl1216-events-"));
  TMP_DIRS.push(dir);
  for (const n of names) writeFileSync(join(dir, n), "");
  return dir;
}

function cleanup() {
  for (const d of TMP_DIRS.splice(0)) rmSync(d, { recursive: true, force: true });
}

// ── the shared oracle fixture ───────────────────────────────────────────────

const ORACLE_FILE = join(import.meta.dir, "..", "__tests__", "fixtures", "event-log-week-oracle.txt");

function readOracle() {
  const out = [];
  for (const raw of readFileSync(ORACLE_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // `<YYYY-MM-DD> <%G-W%V>`
    const [date, week] = line.split(/\s+/);
    out.push([date, week]);
  }
  return out;
}

test("the shared oracle fixture is non-empty (positive control: the file was actually read)", () => {
  const rows = readOracle();
  expect(rows.length).toBeGreaterThanOrEqual(9);
});

test("ISO week matches the date(1) oracle at year boundaries", () => {
  let n = 0;
  for (const [date, week] of readOracle()) {
    const { isoYear, isoWeek } = isoWeekParts(new Date(`${date}T00:00:00Z`));
    const rendered = `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
    expect(`${date} ${rendered}`).toBe(`${date} ${week}`);
    n++;
  }
  expect(n).toBeGreaterThanOrEqual(9); // the loop actually ran
});

test("every day in 2024-2030 round-trips into its own week interval", () => {
  let n = 0;
  for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2030, 0, 1); t += DAY_MS) {
    const { isoYear, isoWeek } = isoWeekParts(new Date(t));
    const s = isoWeekStartMs(isoYear, isoWeek);
    expect(t >= s && t < s + 7 * DAY_MS).toBe(true);
    n++;
  }
  expect(n).toBe(2192); // positive control: the loop actually ran
});

test("isoWeeksInYear knows which years have 53", () => {
  expect(isoWeeksInYear(2026)).toBe(53);
  expect(isoWeeksInYear(2027)).toBe(52);
  expect(isoWeeksInYear(2020)).toBe(53);
  expect(isoWeeksInYear(2025)).toBe(52);
});

test("basenames render per scheme", () => {
  const d = new Date("2026-08-22T00:00:00Z");
  expect(eventLogBasenameFor(d, "month")).toBe("2026-08.jsonl");
  expect(eventLogBasenameFor(d, "week")).toBe("2026-W34.jsonl");
});

test("basename week numbers are zero-padded", () => {
  expect(eventLogBasenameFor(new Date("2026-01-05T00:00:00Z"), "week")).toBe("2026-W02.jsonl");
});

test("the shipped default is week (CTL-1216 phase 5)", () => {
  expect(ROTATION_SCHEMES).toEqual(["month", "week"]);
  expect(DEFAULT_ROTATION_SCHEME).toBe("week");
  expect(resolveRotationScheme({ env: {} })).toBe("week");
});

test("month remains explicitly selectable — it is the rollback lever", () => {
  expect(resolveRotationScheme({ env: { CATALYST_EVENT_LOG_ROTATION: "month" } })).toBe("month");
  expect(resolveRotationScheme({ env: { CATALYST_EVENT_LOG_ROTATION: "MONTH" } })).toBe("month");
  expect(resolveRotationScheme({ env: { CATALYST_EVENT_LOG_ROTATION: " month " } })).toBe("month");
});

test("scheme resolution degrades to a REAL scheme — the shipped default", () => {
  expect(resolveRotationScheme({ env: { CATALYST_EVENT_LOG_ROTATION: "week" } })).toBe("week");
  expect(resolveRotationScheme({ env: { CATALYST_EVENT_LOG_ROTATION: "WEEK" } })).toBe("week");
  for (const bad of ["daily", "", "  ", "weekly", "1"]) {
    // NOT "month": degrading to a scheme the fleet is no longer using would let
    // one host with a typo'd knob write somewhere nobody else is looking.
    expect(resolveRotationScheme({ env: { CATALYST_EVENT_LOG_ROTATION: bad } })).toBe(
      DEFAULT_ROTATION_SCHEME,
    );
  }
});

test("scheme resolution reads config when env is absent, env wins when both are set", () => {
  const config = { catalyst: { events: { rotation: "month" } } };
  expect(resolveRotationScheme({ env: {}, config })).toBe("month");
  expect(resolveRotationScheme({ env: { CATALYST_EVENT_LOG_ROTATION: "week" }, config })).toBe("week");
  // A malformed config must degrade, never throw.
  expect(resolveRotationScheme({ env: {}, config: { catalyst: { events: { rotation: 7 } } } })).toBe(
    DEFAULT_ROTATION_SCHEME,
  );
  expect(resolveRotationScheme({ env: {}, config: null })).toBe(DEFAULT_ROTATION_SCHEME);
});

// ── basename → interval ─────────────────────────────────────────────────────

test("parses BOTH schemes into half-open UTC intervals", () => {
  expect(parseEventLogBasename("2026-08.jsonl")).toEqual({
    scheme: "month",
    startMs: Date.UTC(2026, 7, 1),
    endMs: Date.UTC(2026, 8, 1),
  });
  const wk = parseEventLogBasename("2026-W34.jsonl");
  expect(wk.scheme).toBe("week");
  expect(wk.endMs - wk.startMs).toBe(7 * DAY_MS);
  expect(new Date(wk.startMs).getUTCDay()).toBe(1); // an ISO week starts Monday
  expect(wk.startMs).toBe(Date.UTC(2026, 7, 17));
});

test("December months roll the year, not the month index", () => {
  expect(parseEventLogBasename("2026-12.jsonl")).toEqual({
    scheme: "month",
    startMs: Date.UTC(2026, 11, 1),
    endMs: Date.UTC(2027, 0, 1),
  });
});

test("rejects non-log names instead of guessing", () => {
  for (const n of [
    "2026-08.jsonl.legacy.20260813T101010Z.512", // CTL-1813 quarantine file
    "2026-13.jsonl",
    "2026-00.jsonl",
    "2026-W54.jsonl",
    "2026-W00.jsonl",
    "notes.jsonl",
    "2026-08.json",
    "2026-W34.jsonl.tmp",
    "26-08.jsonl",
    "2026-8.jsonl",
    "2026-w34.jsonl",
    "",
  ]) {
    expect(parseEventLogBasename(n)).toBeNull();
  }
});

test("parseEventLogBasename never throws on hostile input", () => {
  for (const n of [null, undefined, 42, {}, []]) {
    expect(parseEventLogBasename(n)).toBeNull();
  }
});

test("W53 is accepted only in years that HAVE 53 weeks", () => {
  expect(parseEventLogBasename("2026-W53.jsonl")).not.toBeNull(); // 2026 has 53
  expect(parseEventLogBasename("2027-W53.jsonl")).toBeNull(); // 2027 has 52
});

// ── directory + window resolution ───────────────────────────────────────────

test("eventsDir honours CATALYST_EVENTS_DIR then CATALYST_DIR then HOME", () => {
  expect(eventsDir({ env: { CATALYST_EVENTS_DIR: "/x/ev", CATALYST_DIR: "/y", HOME: "/h" } })).toBe("/x/ev");
  expect(eventsDir({ env: { CATALYST_DIR: "/y", HOME: "/h" } })).toBe(join("/y", "events"));
  expect(eventsDir({ env: { HOME: "/h" } })).toBe(join("/h", "catalyst", "events"));
});

test("getEventLogPath composes dir + active scheme", () => {
  // Both schemes are named EXPLICITLY here. A test that leaned on whichever
  // default happens to ship would have to be rewritten every time the default
  // moves, and would silently stop testing the other scheme.
  const now = new Date("2026-08-22T12:00:00Z");
  expect(
    getEventLogPath({ env: { CATALYST_DIR: "/c", CATALYST_EVENT_LOG_ROTATION: "month" }, now }),
  ).toBe(join("/c", "events", "2026-08.jsonl"));
  expect(
    getEventLogPath({ env: { CATALYST_DIR: "/c", CATALYST_EVENT_LOG_ROTATION: "week" }, now }),
  ).toBe(join("/c", "events", "2026-W34.jsonl"));
});

test("window resolver returns overlapping files oldest-first, mixing schemes", () => {
  const dir = mkTmpEventsDir(["2026-07.jsonl", "2026-08.jsonl", "2026-W34.jsonl", "README.md"]);
  const paths = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs: Date.UTC(2026, 7, 1),
    nowMs: Date.UTC(2026, 7, 22),
  });
  expect(paths.map((p) => basename(p))).toEqual(["2026-08.jsonl", "2026-W34.jsonl"]);
  cleanup();
});

test("the window resolver skips CTL-1813 quarantine files", () => {
  const dir = mkTmpEventsDir(["2026-08.jsonl", "2026-08.jsonl.legacy.20260813T101010Z.512"]);
  const paths = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs: Date.UTC(2026, 7, 1),
    nowMs: Date.UTC(2026, 7, 22),
  });
  expect(paths.map((p) => basename(p))).toEqual(["2026-08.jsonl"]);
  cleanup();
});

test("a 7-day window at the start of an ISO week reaches back into the PREVIOUS file", () => {
  const dir = mkTmpEventsDir(["2026-W33.jsonl", "2026-W34.jsonl"]);
  const monday = Date.UTC(2026, 7, 17); // 2026-W34 starts Mon 2026-08-17
  const paths = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs: monday - 7 * DAY_MS,
    nowMs: monday + 3600_000,
  });
  expect(paths.map((p) => basename(p))).toEqual(["2026-W33.jsonl", "2026-W34.jsonl"]);
  cleanup();
});

test("the window is half-open: a file ending exactly at sinceMs is excluded", () => {
  const dir = mkTmpEventsDir(["2026-07.jsonl", "2026-08.jsonl"]);
  const paths = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs: Date.UTC(2026, 7, 1), // 2026-07 ends exactly here
    nowMs: Date.UTC(2026, 7, 2),
  });
  expect(paths.map((p) => basename(p))).toEqual(["2026-08.jsonl"]);
  cleanup();
});

test("missing dir / no overlap yields [] and never throws", () => {
  expect(resolveEventLogPathsForWindow({ eventsDir: "/nope/nope", sinceMs: 0, nowMs: 1 })).toEqual([]);
  const dir = mkTmpEventsDir(["2026-01.jsonl"]);
  expect(
    resolveEventLogPathsForWindow({ eventsDir: dir, sinceMs: Date.UTC(2026, 7, 1), nowMs: Date.UTC(2026, 7, 2) }),
  ).toEqual([]);
  cleanup();
});

test("the CURRENT file is included even when it does not exist yet", () => {
  // A brand-new period has no file until the first append; a tail must still target it.
  const dir = mkTmpEventsDir([]);
  const now = Date.now();
  const p = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs: now - 1000,
    nowMs: now,
    env: { CATALYST_EVENTS_DIR: dir },
    includeCurrent: true,
  });
  expect(p.length).toBe(1);
  expect(p[0]).toBe(getEventLogPath({ env: { CATALYST_EVENTS_DIR: dir }, now: new Date(now) }));
  cleanup();
});

test("includeCurrent does not duplicate an already-listed current file", () => {
  const now = Date.UTC(2026, 7, 22);
  const dir = mkTmpEventsDir(["2026-08.jsonl"]);
  const p = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs: now - DAY_MS,
    nowMs: now,
    env: { CATALYST_EVENTS_DIR: dir, CATALYST_EVENT_LOG_ROTATION: "month" },
    includeCurrent: true,
  });
  expect(p.map((x) => basename(x))).toEqual(["2026-08.jsonl"]);
  cleanup();
});

test("getPrevEventLogPath returns the newest existing file strictly older than current", () => {
  const dir = mkTmpEventsDir(["2026-06.jsonl", "2026-07.jsonl", "2026-08.jsonl"]);
  // Explicit `month`: under the shipped `week` default the current file would be
  // 2026-W34.jsonl, which is not in this fixture, so "the newest file older than
  // current" would legitimately be 2026-08 — a different property than the one
  // this test is pinning.
  const env = { CATALYST_EVENTS_DIR: dir, CATALYST_EVENT_LOG_ROTATION: "month" };
  const now = new Date("2026-08-22T00:00:00Z");
  expect(basename(getPrevEventLogPath({ env, now }))).toBe("2026-07.jsonl");
  cleanup();
});

test("getPrevEventLogPath crosses schemes and returns null when there is no older file", () => {
  const dir = mkTmpEventsDir(["2026-07.jsonl", "2026-W34.jsonl"]);
  const env = { CATALYST_EVENTS_DIR: dir, CATALYST_EVENT_LOG_ROTATION: "week" };
  const now = new Date("2026-08-22T00:00:00Z"); // current = 2026-W34
  expect(basename(getPrevEventLogPath({ env, now }))).toBe("2026-07.jsonl");

  const empty = mkTmpEventsDir([]);
  expect(getPrevEventLogPath({ env: { CATALYST_EVENTS_DIR: empty }, now })).toBeNull();
  cleanup();
});
