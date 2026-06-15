// cli/beliefs-shadow-status.test.mjs — CTL-935 Phase 6: flag-live verification.
// Run: cd plugins/dev/scripts/execution-core && bun test cli/beliefs-shadow-status.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeShadowStatus, STALE_THRESHOLD_MS, CONTIGUITY_GAP_THRESHOLD_MS,
  queryBeliefStats, renderText, main,
} from "./beliefs-shadow-status.mjs";
import { openBeliefsDb } from "../beliefs/schema.mjs";

const NOW = 1_000_000_000; // fixed reference epoch for all tests

// ─── INACTIVE ────────────────────────────────────────────────────────────────

describe("INACTIVE — flag off", () => {
  test("beliefsShadow=false, source=config → INACTIVE", () => {
    const result = computeShadowStatus({
      flagActive: false,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 5,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("INACTIVE");
    expect(result.sourceWarning).toBe(false);
  });

  test("beliefsShadow=false, source=default → INACTIVE, no sourceWarning", () => {
    const result = computeShadowStatus({
      flagActive: false,
      flagSource: "default",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.status).toBe("INACTIVE");
    expect(result.sourceWarning).toBe(false);
  });
});

// ─── ACTIVE ───────────────────────────────────────────────────────────────────

describe("ACTIVE — flag on, fresh ticks, no gap", () => {
  test("beliefsShadow=true, source=config → ACTIVE, sourceWarning=false", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.source).toBe("config");
    expect(result.sourceWarning).toBe(false);
  });

  test("env-override source → ACTIVE with sourceWarning=true", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "env-override",
      latestTickMs: NOW - 10_000,
      tickCount: 50,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.sourceWarning).toBe(true);
    expect(result.source).toBe("env-override");
  });

  test("contiguity OK when tickGapMs is null (single tick)", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 1,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.contiguityViolation).toBe(false);
  });

  test("contiguity OK when tickGapMs < threshold", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 10,
      tickGapMs: CONTIGUITY_GAP_THRESHOLD_MS - 1,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.contiguityViolation).toBe(false);
  });
});

// ─── NO-DATA ─────────────────────────────────────────────────────────────────

describe("NO-DATA — flag on but no ticks (the empty-log failure mode)", () => {
  test("beliefsShadow=true, tickCount=0 → NO-DATA (flag set but daemon not ticking)", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.status).toBe("NO-DATA");
  });

  test("NO-DATA is NOT a pass: passed=false", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.passed).toBe(false);
  });
});

// ─── COLLECTION-STALE ────────────────────────────────────────────────────────

describe("COLLECTION-STALE — flag on, ticks exist, but newest tick too old", () => {
  test("newest tick older than STALE_THRESHOLD_MS → COLLECTION-STALE even when flag=true", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - STALE_THRESHOLD_MS - 1,
      tickCount: 5,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("COLLECTION-STALE");
    expect(result.passed).toBe(false);
  });

  test("newest tick exactly at threshold boundary is NOT stale", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - STALE_THRESHOLD_MS,
      tickCount: 5,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    // At exactly the boundary it's still fresh (strictly-greater-than).
    expect(result.status).toBe("ACTIVE");
  });
});

// ─── CONTIGUITY-VIOLATION ────────────────────────────────────────────────────

describe("CONTIGUITY-VIOLATION — gap in tick stream", () => {
  test("tickGapMs >= threshold → contiguityViolation=true, status reflects it", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: CONTIGUITY_GAP_THRESHOLD_MS,
      nowMs: NOW,
    });
    expect(result.contiguityViolation).toBe(true);
    expect(result.status).toBe("CONTIGUITY-VIOLATION");
  });

  test("CONTIGUITY-VIOLATION is NOT a pass", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: CONTIGUITY_GAP_THRESHOLD_MS + 1,
      nowMs: NOW,
    });
    expect(result.passed).toBe(false);
  });
});

// ─── passed flag ─────────────────────────────────────────────────────────────

describe("passed flag summary", () => {
  test("ACTIVE without violations → passed=true", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.passed).toBe(true);
  });

  test("ACTIVE with sourceWarning → passed=true (warning, not failure)", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "env-override",
      latestTickMs: NOW - 10_000,
      tickCount: 50,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.passed).toBe(true);
    expect(result.sourceWarning).toBe(true);
  });

  test("INACTIVE → passed=false", () => {
    const result = computeShadowStatus({
      flagActive: false,
      flagSource: "default",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.passed).toBe(false);
  });
});

// ─── threshold exports ────────────────────────────────────────────────────────

describe("exported threshold constants", () => {
  test("STALE_THRESHOLD_MS is >= 90_000 (plan: >90s)", () => {
    expect(STALE_THRESHOLD_MS).toBeGreaterThanOrEqual(90_000);
  });

  test("CONTIGUITY_GAP_THRESHOLD_MS is positive", () => {
    expect(CONTIGUITY_GAP_THRESHOLD_MS).toBeGreaterThan(0);
  });
});

// ─── queryBeliefStats — live beliefs.db reader (CTL-935 remediate coverage) ────
// The LAG() OVER (ORDER BY now_ms) max-consecutive-gap SQL and the <2-tick
// null-gap branch were untested. Seed a real scratch db and assert the metrics.

const tmps = [];
function scratchDb() {
  const d = mkdtempSync(join(tmpdir(), "ctl935-shadow-status-"));
  tmps.push(d);
  return openBeliefsDb({ path: join(d, "b.db") });
}
function seedTick(db, nowMs) {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [nowMs, "mini"]);
}
afterEach(() => {
  while (tmps.length) {
    try { rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* */ }
  }
});

describe("queryBeliefStats", () => {
  test("zero ticks → count 0, null latest, null gap", () => {
    const db = scratchDb();
    try {
      const stats = queryBeliefStats(db);
      expect(stats.tickCount).toBe(0);
      expect(stats.latestTickMs).toBe(null);
      expect(stats.tickGapMs).toBe(null);
    } finally { db.close(); }
  });

  test("single tick → count 1, latest set, gap null (<2 ticks)", () => {
    const db = scratchDb();
    try {
      seedTick(db, 1_000);
      const stats = queryBeliefStats(db);
      expect(stats.tickCount).toBe(1);
      expect(stats.latestTickMs).toBe(1_000);
      expect(stats.tickGapMs).toBe(null);
    } finally { db.close(); }
  });

  test("N ticks → latest = max, tickGapMs = max consecutive gap", () => {
    const db = scratchDb();
    try {
      // Gaps: 500, 2000, 300 → max consecutive gap is 2000.
      [1_000, 1_500, 3_500, 3_800].forEach((t) => seedTick(db, t));
      const stats = queryBeliefStats(db);
      expect(stats.tickCount).toBe(4);
      expect(stats.latestTickMs).toBe(3_800);
      expect(stats.tickGapMs).toBe(2_000);
    } finally { db.close(); }
  });

  test("returns null when the db handle throws", () => {
    const throwingDb = { query() { throw new Error("db closed"); } };
    expect(queryBeliefStats(throwingDb)).toBe(null);
  });
});

// ─── renderText — per-verdict text rendering ──────────────────────────────────

describe("renderText", () => {
  test("INACTIVE renders status/passed/source, no age/gap lines", () => {
    const txt = renderText(computeShadowStatus({ flagActive: false, flagSource: "config", nowMs: NOW }));
    expect(txt).toContain("status:  INACTIVE");
    expect(txt).toContain("passed:  false");
    expect(txt).toContain("source:  config");
    expect(txt).not.toContain("age:");
  });

  test("env-override surfaces the durability warning", () => {
    const txt = renderText(computeShadowStatus({
      flagActive: true, flagSource: "env-override",
      latestTickMs: NOW - 5_000, tickCount: 3, tickGapMs: 1_000, nowMs: NOW,
    }));
    expect(txt).toContain("warning: flag set via env-override");
    expect(txt).toContain("age:");
  });

  test("CONTIGUITY-VIOLATION renders the gap line", () => {
    const txt = renderText(computeShadowStatus({
      flagActive: true, flagSource: "config",
      latestTickMs: NOW - 1_000, tickCount: 5,
      tickGapMs: CONTIGUITY_GAP_THRESHOLD_MS + 1, nowMs: NOW,
    }));
    expect(txt).toContain("gap:");
    expect(txt).toContain("contiguity violation");
  });
});

// ─── main (CLI entry) — async dispatch + exit codes ───────────────────────────

describe("main (CLI entry)", () => {
  test("flag off → INACTIVE, resolves to numeric exit 1", async () => {
    const out = [];
    const code = await main([], { env: {}, out: (s) => out.push(s) });
    expect(typeof code).toBe("number");
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("INACTIVE");
  });

  test("--json emits a parseable result object", async () => {
    const out = [];
    const code = await main(["--json"], { env: {}, out: (s) => out.push(s) });
    expect(typeof code).toBe("number");
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("passed");
  });

  test("--db at a seeded scratch db + flag on → reads ticks, ACTIVE/exit 0", async () => {
    const d = mkdtempSync(join(tmpdir(), "ctl935-shadow-main-"));
    tmps.push(d);
    const dbPath = join(d, "b.db");
    const db = openBeliefsDb({ path: dbPath });
    const now = Date.now();
    // Two fresh, contiguous ticks → ACTIVE.
    seedTick(db, now - 2_000);
    seedTick(db, now - 1_000);
    db.close();
    const out = [];
    const code = await main(["--db", dbPath, "--json"], {
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      out: (s) => out.push(s),
    });
    expect(typeof code).toBe("number");
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.passed).toBe(true);
    expect(code).toBe(0);
  });
});
