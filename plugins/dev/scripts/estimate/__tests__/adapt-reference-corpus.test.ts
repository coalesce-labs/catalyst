// adapt-reference-corpus.test.ts — Phase 1 unit tests (CTL-751)
// Run: bun test plugins/pm/scripts/estimate/__tests__/adapt-reference-corpus.test.ts
import { describe, test, expect } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adaptCorpus } from "../adapt-reference-corpus.ts";
import { loadCorpus } from "../reference-class-lookup.ts";

const FIXTURE_FLAT = {
  _meta: {
    generated: "2026-01-01T00:00:00Z",
    source_ticket: "CTL-746",
    n_tickets: 3,
  },
  "CTL-10": {
    ticket: "CTL-10",
    actuals: { turns: 84, cost_usd: 30.0, wall_time_hours: 2.5, sessions: 1, tokens: {} },
    git: { commits: 3, loc_added: 200, loc_deleted: 50, files_changed: 6 },
    heuristic: { tshirt: "S", points: 3, loc_total: 250 },
  },
  "CTL-20": {
    ticket: "CTL-20",
    actuals: { turns: 200, cost_usd: 80.0, wall_time_hours: 8.0, sessions: 2, tokens: {} },
    git: null,
    heuristic: { tshirt: "M", points: 5, loc_total: null },
  },
  "CTL-99": {
    ticket: "CTL-99",
    actuals: { turns: 50, cost_usd: 10.0, wall_time_hours: 1.0, sessions: 1, tokens: {} },
    git: null,
    heuristic: { tshirt: "XS" },  // no points → should be dropped
  },
};

describe("adaptCorpus", () => {
  test("drops _meta and entries with no heuristic.points", () => {
    const corpus = adaptCorpus(FIXTURE_FLAT);
    expect(corpus.entries).toBeArray();
    expect(corpus.entries).toHaveLength(2);
    const ids = corpus.entries.map((e) => e.ticket_id);
    expect(ids).toContain("CTL-10");
    expect(ids).toContain("CTL-20");
    expect(ids).not.toContain("CTL-99");
    expect(ids).not.toContain("_meta");
  });

  test("git-bearing entry maps signals correctly", () => {
    const corpus = adaptCorpus(FIXTURE_FLAT);
    const e = corpus.entries.find((x) => x.ticket_id === "CTL-10")!;
    expect(e).toBeDefined();
    // loc = loc_added + loc_deleted
    expect(e.signals.loc).toBe(250);
    // changed_files from git.files_changed
    expect(e.signals.changed_files).toBe(6);
    // actuals key rename: wall_time_hours → wall_hours
    expect(e.actuals.wall_hours).toBe(2.5);
    expect((e.actuals as any).wall_time_hours).toBeUndefined();
    // tshirt + points from heuristic
    expect(e.tshirt).toBe("S");
    expect(e.points).toBe(3);
    // cost_usd + turns preserved
    expect(e.actuals.cost_usd).toBe(30.0);
    expect(e.actuals.turns).toBe(84);
  });

  test("git-less entry has null signals.loc and null signals.changed_files", () => {
    const corpus = adaptCorpus(FIXTURE_FLAT);
    const e = corpus.entries.find((x) => x.ticket_id === "CTL-20")!;
    expect(e).toBeDefined();
    expect(e.signals.loc).toBeNull();
    expect(e.signals.changed_files).toBeNull();
  });

  test("every entry has all required keys", () => {
    const corpus = adaptCorpus(FIXTURE_FLAT);
    for (const e of corpus.entries) {
      expect(typeof e.ticket_id).toBe("string");
      expect(typeof e.title).toBe("string");
      expect(e.signals).toBeDefined();
      expect("loc" in e.signals).toBe(true);
      expect("changed_files" in e.signals).toBe(true);
      expect(Array.isArray(e.signals.domains)).toBe(true);
      expect(typeof e.signals.has_migration).toBe("boolean");
      expect(typeof e.signals.has_frontend).toBe("boolean");
      expect(typeof e.signals.has_backend).toBe("boolean");
      expect(e.actuals).toBeDefined();
      expect("cost_usd" in e.actuals).toBe(true);
      expect("turns" in e.actuals).toBe(true);
      expect("wall_hours" in e.actuals).toBe(true);
      expect(typeof e.tshirt).toBe("string");
      expect(typeof e.points).toBe("number");
    }
  });

  test("loadCorpus accepts the output (round-trip via tmp file)", () => {
    const corpus = adaptCorpus(FIXTURE_FLAT);
    const tmp = join(tmpdir(), `ctl-751-test-${Date.now()}.json`);
    try {
      writeFileSync(tmp, JSON.stringify(corpus, null, 2), "utf8");
      const loaded = loadCorpus(tmp);
      expect(loaded.entries).toHaveLength(corpus.entries.length);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  });

  test("output has schema, generated_at, count fields", () => {
    const corpus = adaptCorpus(FIXTURE_FLAT, "2026-01-01T00:00:00Z");
    expect(corpus.schema).toBe("catalyst.estimation.corpus.v1");
    expect(corpus.generated_at).toBe("2026-01-01T00:00:00Z");
    expect(corpus.count).toBe(2);
  });
});
