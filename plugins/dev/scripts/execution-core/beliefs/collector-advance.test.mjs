// collector-advance.test.mjs — CTL-966 belief-store N4: the obs_verdict +
// obs_cycle fact layer. Verifies the collection blocks in collector.mjs against
// real verify.json artifacts (parsed by readVerifyVerdict) and a real event log
// (counted by countRemediateCycles) — the SAME readers the procedural
// deriveAdvancement consumes.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { collectTickFacts, __resetBeliefsCollectorForTests } from "./collector.mjs";
import { __resetEventScanIndexForTest } from "../event-scan.mjs";

const DAY = 86_400_000;
const NOW = 1781030108000;

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl966-collect-"));
  tmps.push(d);
  return d;
}
beforeEach(() => {
  __resetBeliefsCollectorForTests();
  __resetEventScanIndexForTest();
});
afterEach(() => {
  __resetBeliefsCollectorForTests();
  __resetEventScanIndexForTest();
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// writeVerify — drop a verify.json under orchDir/workers/<ticket>/.
function writeVerify(orchDir, ticket, body) {
  const wdir = join(orchDir, "workers", ticket);
  mkdirSync(wdir, { recursive: true });
  writeFileSync(join(wdir, "verify.json"), JSON.stringify(body));
}

// writeEventLog — write the remediate-complete events for a set of tickets, in
// the unified event-log envelope shape ({ ts, attributes: { "event.name" } })
// that scanEventsChunked / countRemediateCycles parse.
function writeEventLog(path, tickets) {
  const lines = tickets.map((t) =>
    JSON.stringify({
      ts: "2026-06-09T10:00:00Z",
      attributes: { "event.name": `phase.remediate.complete.${t}` },
    }),
  );
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
}

function oneSignal(ticket = "CTL-100", phase = "verify", status = "done") {
  return () => [
    {
      ticket,
      phase,
      status,
      liveness: { kind: "bg", value: "aaa1" },
      updatedAt: "2026-06-09T10:00:00Z",
      raw: { generation: 1, startedAt: "2026-06-09T09:00:00Z" },
    },
  ];
}

function collect(db, { orchDir, eventLogPath, readSignals }) {
  return collectTickFacts({
    db,
    orchDir,
    now: NOW,
    host: "mini",
    env: { CATALYST_BELIEFS_SHADOW: "1" },
    eventLogPath,
    getAgents: () => [],
    readSignals,
    readJobState: () => ({ exists: false }),
    findTranscriptFn: () => null,
    linearCache: { get: () => undefined },
  });
}

describe("obs_verdict — schema + collection (CTL-966)", () => {
  test("table + index created by openBeliefsDb", () => {
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(tables).toContain("obs_verdict");
    expect(tables).toContain("obs_cycle");
    const idx = db.query("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    expect(idx).toContain("idx_obs_verdict_tick");
    expect(idx).toContain("idx_obs_cycle_tick");
    db.close();
  });

  test("regression_risk >= 5 → verdict 'fail' row", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    writeVerify(orchDir, "CTL-100", { regression_risk: 7, findings: [] });
    const res = collect(db, {
      orchDir,
      eventLogPath: join(scratch(), "absent.jsonl"),
      readSignals: oneSignal("CTL-100"),
    });
    expect(res.ok).toBe(true);
    const row = db.query("SELECT ticket, verdict FROM obs_verdict").get();
    expect(row).toEqual({ ticket: "CTL-100", verdict: "fail" });
    db.close();
  });

  test("high-severity finding → verdict 'fail'", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    writeVerify(orchDir, "CTL-100", { regression_risk: 1, findings: [{ severity: "high" }] });
    collect(db, { orchDir, eventLogPath: join(scratch(), "absent.jsonl"), readSignals: oneSignal("CTL-100") });
    expect(db.query("SELECT verdict FROM obs_verdict").get().verdict).toBe("fail");
    db.close();
  });

  test("low risk, no high finding → verdict 'pass'", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    writeVerify(orchDir, "CTL-100", { regression_risk: 2, findings: [{ severity: "low" }] });
    collect(db, { orchDir, eventLogPath: join(scratch(), "absent.jsonl"), readSignals: oneSignal("CTL-100") });
    expect(db.query("SELECT verdict FROM obs_verdict").get().verdict).toBe("pass");
    db.close();
  });

  test("missing verify.json → NO obs_verdict row (null verdict contract)", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    // no verify.json written
    collect(db, { orchDir, eventLogPath: join(scratch(), "absent.jsonl"), readSignals: oneSignal("CTL-100") });
    expect(db.query("SELECT COUNT(*) AS n FROM obs_verdict").get().n).toBe(0);
    db.close();
  });

  test("malformed verify.json (non-numeric risk) → NO row", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    writeVerify(orchDir, "CTL-100", { regression_risk: "high", findings: [] });
    collect(db, { orchDir, eventLogPath: join(scratch(), "absent.jsonl"), readSignals: oneSignal("CTL-100") });
    expect(db.query("SELECT COUNT(*) AS n FROM obs_verdict").get().n).toBe(0);
    db.close();
  });
});

describe("obs_cycle — collection via countRemediateCycles (CTL-966)", () => {
  test("counts phase.remediate.complete.<ticket> events from the event log", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const elog = join(scratch(), "events.jsonl");
    // CTL-100 has 2 completed remediate cycles
    writeEventLog(elog, ["CTL-100", "CTL-100"]);
    collect(db, { orchDir, eventLogPath: elog, readSignals: oneSignal("CTL-100") });
    expect(db.query("SELECT ticket, remediate_count FROM obs_cycle").get()).toEqual({
      ticket: "CTL-100",
      remediate_count: 2,
    });
    db.close();
  });

  test("never-remediated ticket → remediate_count 0 (exact cap-boundary comparison)", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const elog = join(scratch(), "events.jsonl");
    writeEventLog(elog, []); // empty log
    collect(db, { orchDir, eventLogPath: elog, readSignals: oneSignal("CTL-100") });
    expect(db.query("SELECT remediate_count FROM obs_cycle").get().remediate_count).toBe(0);
    db.close();
  });

  test("exact suffix match: CTL-9 events do not count toward CTL-90", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const elog = join(scratch(), "events.jsonl");
    writeEventLog(elog, ["CTL-9", "CTL-9", "CTL-90"]);
    collect(db, { orchDir, eventLogPath: elog, readSignals: oneSignal("CTL-90") });
    expect(db.query("SELECT remediate_count FROM obs_cycle WHERE ticket='CTL-90'").get().remediate_count).toBe(1);
    db.close();
  });
});

describe("obs_verdict / obs_cycle — 14-day retention prune (CTL-966)", () => {
  test("rows older than 14 days are pruned", () => {
    const orchDir = scratch();
    const db = openBeliefsDb({ path: join(scratch(), "b.db") });
    const elog = join(scratch(), "events.jsonl");
    writeEventLog(elog, ["CTL-100"]);
    writeVerify(orchDir, "CTL-100", { regression_risk: 7, findings: [] });

    // tick 1 — old (now = NOW - 15 days). prune runs on the first tick after boot.
    collectTickFacts({
      db,
      orchDir,
      now: NOW - 15 * DAY,
      host: "mini",
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      eventLogPath: elog,
      pruneEveryTicks: 1,
      getAgents: () => [],
      readSignals: oneSignal("CTL-100"),
      readJobState: () => ({ exists: false }),
      findTranscriptFn: () => null,
      linearCache: { get: () => undefined },
    });
    expect(db.query("SELECT COUNT(*) AS n FROM obs_verdict").get().n).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM obs_cycle").get().n).toBe(1);

    // tick 2 — current; prune removes the >14d-old rows from tick 1.
    collectTickFacts({
      db,
      orchDir,
      now: NOW,
      host: "mini",
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      eventLogPath: join(scratch(), "absent.jsonl"),
      pruneEveryTicks: 1,
      getAgents: () => [],
      readSignals: () => [], // no signals this tick → no NEW verdict/cycle rows
      readJobState: () => ({ exists: false }),
      findTranscriptFn: () => null,
      linearCache: { get: () => undefined },
    });
    // the old rows are gone; no new ones added this tick
    expect(db.query("SELECT COUNT(*) AS n FROM obs_verdict").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM obs_cycle").get().n).toBe(0);
    db.close();
  });
});
