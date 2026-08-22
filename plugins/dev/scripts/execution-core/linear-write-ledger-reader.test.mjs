// linear-write-ledger-reader.test.mjs — CTL-2027 Phase 2.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLinearWriteLedgerForBoard } from "./linear-write-ledger-reader.mjs";
import { defaultBudgetPath } from "./linear-write-proxy.mjs";
import { utcDayOf } from "./linear-write-budget.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctl2027-ledger-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const NOW = Date.parse("2026-08-22T04:00:00Z");
const TODAY = utcDayOf(NOW);

describe("readLinearWriteLedgerForBoard", () => {
  test("no ledger file at all → null (fail-open, never a guess)", () => {
    const env = { CATALYST_DIR: dir };
    expect(readLinearWriteLedgerForBoard(env, NOW)).toBeNull();
  });

  test("a corrupt ledger file → null", () => {
    const env = { CATALYST_DIR: dir };
    writeFileSync(defaultBudgetPath(env), "{not json", "utf8");
    expect(readLinearWriteLedgerForBoard(env, NOW)).toBeNull();
  });

  test("a loaded ledger for TODAY is returned as-is", () => {
    const env = { CATALYST_DIR: dir };
    writeFileSync(defaultBudgetPath(env), JSON.stringify({ day: TODAY, total: 4, byTicket: { "CTL-1": 4 } }), "utf8");
    expect(readLinearWriteLedgerForBoard(env, NOW)).toEqual({
      day: TODAY,
      total: 4,
      byTicket: { "CTL-1": 4 },
      converged: {},
      exhaustedAnnounced: false,
    });
  });

  test("a ledger from a PREVIOUS UTC day is ROLLED to an empty ledger for today", () => {
    const env = { CATALYST_DIR: dir };
    writeFileSync(
      defaultBudgetPath(env),
      JSON.stringify({ day: "2026-08-21", total: 300, byTicket: { "T-1": 300 } }),
      "utf8"
    );
    const rolled = readLinearWriteLedgerForBoard(env, NOW);
    expect(rolled.day).toBe(TODAY);
    expect(rolled.total).toBe(0);
    expect(rolled.byTicket).toEqual({});
  });
});
