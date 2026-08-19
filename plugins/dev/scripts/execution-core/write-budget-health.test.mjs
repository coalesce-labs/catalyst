// write-budget-health.test.mjs — CTL-1936 AC5 (the doctor half).

import { describe, expect, test } from "bun:test";
import { checkLinearWriteBudget } from "./write-budget-health.mjs";
import { emptyLedger, recordWrite, utcDayOf } from "./linear-write-budget.mjs";

const NOW = () => Date.parse("2026-08-18T04:00:00Z");
const DAY = utcDayOf(NOW());
const spend = (l, t, n) => {
  let x = l;
  for (let i = 0; i < n; i++) x = recordWrite(x, t);
  return x;
};
// Spreads `n` writes round-robin across many tickets so no single ticket crosses
// DEFAULT_PER_TICKET_CAP (50) — isolates the daily-total check from the per-ticket one.
const spendSpread = (l, n) => {
  let x = l;
  for (let i = 0; i < n; i++) x = recordWrite(x, `T-${i % 30}`);
  return x;
};
const check = (ledger, over = {}) =>
  checkLinearWriteBudget({
    env: {},
    nowFn: NOW,
    path: "/seal/ledger.json",
    exists: () => true,
    readLedgerFn: () =>
      ledger === null ? { state: "unusable", reason: "unparseable" } : { state: "loaded", ledger },
    // CTL-2073: hermetic by default — a bare `exists`/readLedgerFn stub above is for
    // the LEDGER path only. Without an explicit envFileExists override here, every
    // test below would fall through to the real existsSync/readFileSync against
    // whatever ~/.config/catalyst/execution-core.env happens to be on the machine
    // running the suite (a real file on a fleet host) — deterministically false
    // regardless of host, so dailyBudget/perTicketCap always resolve to the
    // DEFAULT_* constants unless a test below deliberately overrides this.
    envFileExists: () => false,
    ...over,
  });

describe("checkLinearWriteBudget", () => {
  test("a quiet host passes and states its spend", () => {
    const r = check(spend(emptyLedger(DAY), "CTL-1", 4));
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("4/300");
  });

  test("⛔ an exhausted host is NOT reported healthy", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < 300; i++) l = recordWrite(l, `T-${i}`);
    const r = check(l);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("WRITE-EXHAUSTED");
  });

  test("a capped single ticket is surfaced before the host runs out", () => {
    // The runaway shape: the host is not out of budget, but one caller is capped.
    const r = check(spend(emptyLedger(DAY), "CTL-1805", 60));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("CTL-1805");
    expect(r.detail).toContain("per-ticket cap");
  });

  test("⛔ YESTERDAY's exhausted ledger does not report TODAY as exhausted", () => {
    // The budget resets on the UTC day boundary. Judging the stored totals without the
    // roll would keep a recovered host reading exhausted for a whole day.
    let l = emptyLedger("2026-08-17");
    for (let i = 0; i < 300; i++) l = recordWrite(l, `T-${i}`);
    const r = check(l);
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("0/300");
  });

  test("⛔ an unusable ledger warns — it is not 'nothing spent'", () => {
    const r = check(null);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("NOT being bounded");
  });

  test("an absent ledger is INFO, not a problem and not a clean bill of health", () => {
    const r = check(emptyLedger(DAY), { exists: () => false });
    expect(r.status).toBe("info");
    expect(r.detail).toContain("has not proxied a Linear write");
  });

  test("⛔ never FAILs — doctor's FAIL count gates worker activation", () => {
    let l = emptyLedger(DAY);
    for (let i = 0; i < 500; i++) l = recordWrite(l, "CTL-1805");
    expect(check(l).status).not.toBe("fail");
    expect(check(null).status).not.toBe("fail");
  });

  // CTL-2073: doctor's own process.env is NOT the daemon's env — the daemon's
  // launcher sources execution-core.env, an interactive/ssh shell does not. Before
  // this fix, a host running the daemon at a real 2000/day budget with an unset
  // shell var reported WRITE-EXHAUSTED at 684/300 while refusing nothing.
  test("⭐ reads the DAEMON's budget from execution-core.env, not doctor's own shell env", () => {
    const r = check(spendSpread(emptyLedger(DAY), 684), {
      env: {}, // doctor's own shell — unset, exactly as measured on mini
      envFileExists: () => true,
      envFileRead: () => "CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n",
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("684/2000");
  });

  test("⭐ NEGATIVE CONTROL: the same spend against the OLD 300 default is WRITE-EXHAUSTED", () => {
    // Proves the fixture isn't just always-pass — the same 684 spend, same
    // envFileExists=false hermetic default (no execution-core.env), genuinely
    // exhausts the fallback DEFAULT_DAILY_BUDGET.
    const r = check(spendSpread(emptyLedger(DAY), 684));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("WRITE-EXHAUSTED");
    expect(r.detail).toContain("684/300");
  });

  test("execution-core.env value survives quoting (CATALYST_LINEAR_WRITE_DAILY_BUDGET=\"2000\")", () => {
    const r = check(spend(emptyLedger(DAY), "CTL-1", 4), {
      envFileExists: () => true,
      envFileRead: () => 'CATALYST_LINEAR_WRITE_DAILY_BUDGET="2000"\n',
    });
    expect(r.detail).toContain("4/2000");
  });

  test("an unreadable execution-core.env falls through to the default, not a throw", () => {
    const r = check(spend(emptyLedger(DAY), "CTL-1", 4), {
      envFileExists: () => true,
      envFileRead: () => {
        throw new Error("EACCES");
      },
    });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("4/300");
  });

  test("doctor's own exported env is still honored when execution-core.env has no value for it", () => {
    const r = check(spend(emptyLedger(DAY), "CTL-1", 4), {
      env: { CATALYST_LINEAR_WRITE_DAILY_BUDGET: "500" },
      envFileExists: () => true,
      envFileRead: () => "SOME_OTHER_VAR=1\n",
    });
    expect(r.detail).toContain("4/500");
  });

  test("execution-core.env takes precedence over doctor's own (possibly stale) exported env", () => {
    const r = check(spend(emptyLedger(DAY), "CTL-1", 4), {
      env: { CATALYST_LINEAR_WRITE_DAILY_BUDGET: "300" },
      envFileExists: () => true,
      envFileRead: () => "CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n",
    });
    expect(r.detail).toContain("4/2000");
  });
});
