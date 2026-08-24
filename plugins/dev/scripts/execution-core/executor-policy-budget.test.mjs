// executor-policy-budget.test.mjs — CTL-2116 Phase 5 (Scenario 3). Pure classifier
// covering the COMMAND-TIME refusal: "may this policy change add Codex load right
// now?" Three-valued by construction — a zero-account or all-unauthenticated read
// is "I could not look", never "there is headroom".
// Run: cd plugins/dev/scripts/execution-core && bun test executor-policy-budget.test.mjs
import { describe, test, expect, mock } from "bun:test";
import {
  DEFAULT_CODEX_BUDGET_FLOOR_PERCENT,
  addsCodexLoad,
  classifyPolicyBudget,
} from "./executor-policy-budget.mjs";

const acct = (h, used, label = "5h") => ({
  label: h,
  status: "ok",
  binding: { label, usedPercent: used, resetsAt: 1e9 },
});

describe("classifyPolicyBudget (CTL-2116)", () => {
  test("allows a change that does NOT add codex load, without reading quota at all", () => {
    const read = mock(() => {
      throw new Error("must not be called");
    });
    expect(classifyPolicyBudget({ addsCodexLoad: false, readAccounts: read }).verdict).toBe(
      "allow",
    );
    expect(read).not.toHaveBeenCalled();
  });

  test("allows when max headroom across usable accounts is at or above the floor", () => {
    const r = classifyPolicyBudget({
      addsCodexLoad: true,
      floorPercent: 20,
      accounts: [acct("acct1", 95), acct("acct2", 60)],
    });
    expect(r.verdict).toBe("allow");
    expect(r.headroomPercent).toBe(40);
  });

  test("REFUSES below the floor and reports EVERY account's figures", () => {
    const r = classifyPolicyBudget({
      addsCodexLoad: true,
      floorPercent: 20,
      accounts: [acct("acct1", 95), acct("acct2", 88)],
    });
    expect(r.verdict).toBe("refuse");
    expect(r.figures).toHaveLength(2);
    expect(r.figures[0]).toMatchObject({
      handle: "acct1",
      window: "5h",
      usedPercent: 95,
      headroomPercent: 5,
    });
    expect(r.message).toContain("5h");
    expect(r.message).toContain("20%");
  });

  test("is INCONCLUSIVE — never 'allow' — when ZERO accounts are discoverable", () => {
    // [].some(p) is false and [].every(p) is true; a zero-account clean pass is
    // the exact false-clean shape this repo has shipped before.
    expect(classifyPolicyBudget({ addsCodexLoad: true, accounts: [] }).verdict).toBe(
      "inconclusive",
    );
  });

  test("is INCONCLUSIVE when every account is unauthenticated/rejected/error", () => {
    expect(
      classifyPolicyBudget({
        addsCodexLoad: true,
        accounts: [{ label: "a", status: "unauthenticated" }],
      }).verdict,
    ).toBe("inconclusive");
  });

  test("is INCONCLUSIVE when a status-ok account reports binding: null (no fabricated 0%)", () => {
    expect(
      classifyPolicyBudget({
        addsCodexLoad: true,
        accounts: [{ label: "a", status: "ok", binding: null }],
      }).verdict,
    ).toBe("inconclusive");
  });

  test("is INCONCLUSIVE when the reader throws", () => {
    expect(
      classifyPolicyBudget({
        addsCodexLoad: true,
        readAccounts: () => {
          throw new Error("x");
        },
      }).verdict,
    ).toBe("inconclusive");
  });

  test("IGNORES a non-ok account rather than counting it as 0% used", () => {
    const r = classifyPolicyBudget({
      addsCodexLoad: true,
      floorPercent: 20,
      accounts: [acct("a", 95), { label: "b", status: "rejected" }],
    });
    expect(r.verdict).toBe("refuse"); // NOT allowed by a phantom fresh account
    expect(r.figures).toHaveLength(1);
  });

  test("names the window from its label, never from position", () => {
    // a weekly-only account must report window "weekly", not "5h".
    const r = classifyPolicyBudget({
      addsCodexLoad: true,
      floorPercent: 20,
      accounts: [acct("a", 95, "weekly")],
    });
    expect(r.figures[0].window).toBe("weekly");
  });

  test("uses readAccounts() when `accounts` is not supplied", () => {
    const read = mock(() => [acct("a", 10)]);
    const r = classifyPolicyBudget({ addsCodexLoad: true, floorPercent: 20, readAccounts: read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(r.verdict).toBe("allow");
  });

  test("DEFAULT_CODEX_BUDGET_FLOOR_PERCENT is 20 and used when floorPercent is omitted", () => {
    expect(DEFAULT_CODEX_BUDGET_FLOOR_PERCENT).toBe(20);
    const r = classifyPolicyBudget({ addsCodexLoad: true, accounts: [acct("a", 85)] }); // headroom 15 < 20
    expect(r.verdict).toBe("refuse");
  });
});

describe("addsCodexLoad", () => {
  test("is true when a phase moves TO codex-exec", () => {
    expect(
      addsCodexLoad({ priorRoutes: { triage: "bg" }, nextRoutes: { triage: "codex-exec" } }),
    ).toBe(true);
  });

  test("is false when a phase moves AWAY from codex-exec", () => {
    expect(
      addsCodexLoad({ priorRoutes: { triage: "codex-exec" }, nextRoutes: { triage: "bg" } }),
    ).toBe(false);
  });

  test("is false when the change is codex→codex (no new load)", () => {
    expect(
      addsCodexLoad({
        priorRoutes: { triage: "codex-exec" },
        nextRoutes: { triage: "codex-exec" },
      }),
    ).toBe(false);
  });

  test("is true for `all codex-exec`, false for `all bg`", () => {
    const allCodex = Object.fromEntries(
      ["triage", "research", "plan", "implement", "pr"].map((p) => [p, "codex-exec"]),
    );
    const allBg = Object.fromEntries(
      ["triage", "research", "plan", "implement", "pr"].map((p) => [p, "bg"]),
    );
    expect(addsCodexLoad({ priorRoutes: {}, nextRoutes: allCodex })).toBe(true);
    expect(addsCodexLoad({ priorRoutes: { triage: "codex-exec" }, nextRoutes: allBg })).toBe(
      false,
    );
  });

  test("is false for a rollback that REMOVES codex routes, true for one that adds them", () => {
    // rollback restoring an OLDER state with fewer codex routes than current.
    expect(
      addsCodexLoad({
        priorRoutes: { triage: "codex-exec", implement: "codex-exec" },
        nextRoutes: { triage: "codex-exec" },
      }),
    ).toBe(false);
    // rollback restoring an OLDER state with MORE codex routes than current.
    expect(
      addsCodexLoad({
        priorRoutes: { triage: "codex-exec" },
        nextRoutes: { triage: "codex-exec", implement: "codex-exec" },
      }),
    ).toBe(true);
  });

  test("handles absent/malformed maps without throwing", () => {
    expect(addsCodexLoad({})).toBe(false);
    expect(addsCodexLoad({ priorRoutes: null, nextRoutes: null })).toBe(false);
  });
});
