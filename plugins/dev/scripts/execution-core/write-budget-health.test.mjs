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
const check = (ledger, over = {}) =>
  checkLinearWriteBudget({
    env: {},
    nowFn: NOW,
    path: "/seal/ledger.json",
    exists: () => true,
    readLedgerFn: () =>
      ledger === null ? { state: "unusable", reason: "unparseable" } : { state: "loaded", ledger },
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
});
