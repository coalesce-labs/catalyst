// ratelimit-accounts-probe.test.mjs — CTL-2056.
// Unit tests for defaultProbeAccounts and pickActiveAccount.
// All subprocess/network calls are injected; no real exec, no env file I/O.
//
// Run: cd plugins/dev/scripts/execution-core && bun test ratelimit-accounts-probe.test.mjs

import { test, expect, describe } from "bun:test";
import { defaultProbeAccounts, pickActiveAccount } from "./ratelimit-accounts-probe.mjs";

// Typical claude-accounts-usage --json output (two accounts: one active, one spare).
function probeJson(overrides = {}) {
  return {
    generatedAt: "2026-08-19T23:40:00Z",
    accounts: [
      {
        label: "acct1",
        email: "ops@coalesce.dev",
        isActive: true,
        overallStatus: "allowed_warning",
        fiveHour: { pct: 96.0, resetsAt: "2026-08-20T04:40:00Z", status: "allowed_warning" },
        sevenDay: { pct: 89.0, resetsAt: "2026-08-26T00:00:00Z", status: "allowed" },
      },
      {
        label: "acct2",
        email: "spare@coalesce.dev",
        isActive: false,
        overallStatus: "allowed",
        fiveHour: { pct: 3.0, resetsAt: "2026-08-20T04:40:00Z", status: "allowed" },
        sevenDay: { pct: 10.0, resetsAt: "2026-08-26T00:00:00Z", status: "allowed" },
      },
    ],
    ...overrides,
  };
}

// ─── defaultProbeAccounts ─────────────────────────────────────────────────────

describe("defaultProbeAccounts", () => {
  test("parses --json stdout and returns the full probe record", async () => {
    const probe = probeJson();
    const execFn = async () => ({ stdout: JSON.stringify(probe) });
    const result = await defaultProbeAccounts({ execFn });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0].email).toBe("ops@coalesce.dev");
    expect(result.accounts[0].isActive).toBe(true);
  });

  test("returns { accounts: [] } when probe exits nonzero with no parseable stdout", async () => {
    const execFn = async () => {
      const err = new Error("exit 1");
      err.stdout = "";
      throw err;
    };
    const result = await defaultProbeAccounts({ execFn });
    expect(result).toEqual({ accounts: [] });
  });

  test("returns { accounts: [] } when probe throws without stdout", async () => {
    const execFn = async () => { throw new Error("spawn failed"); };
    const result = await defaultProbeAccounts({ execFn });
    expect(result).toEqual({ accounts: [] });
  });

  test("returns { accounts: [] } when stdout is not valid JSON", async () => {
    const execFn = async () => ({ stdout: "not json" });
    const result = await defaultProbeAccounts({ execFn });
    expect(result).toEqual({ accounts: [] });
  });

  test("returns { accounts: [] } when parsed JSON has no accounts array", async () => {
    const execFn = async () => ({ stdout: JSON.stringify({ generatedAt: "2026-08-19T00:00:00Z" }) });
    const result = await defaultProbeAccounts({ execFn });
    expect(result).toEqual({ accounts: [] });
  });

  test("never throws on any execFn failure", async () => {
    const execFn = async () => { throw new TypeError("boom"); };
    await expect(defaultProbeAccounts({ execFn })).resolves.toEqual({ accounts: [] });
  });
});

// ─── pickActiveAccount ────────────────────────────────────────────────────────

describe("pickActiveAccount", () => {
  test("returns the isActive account when present", () => {
    const probe = probeJson();
    const account = pickActiveAccount(probe);
    expect(account.email).toBe("ops@coalesce.dev");
    expect(account.isActive).toBe(true);
  });

  test("falls back to highest fiveHour.pct when no account is active", () => {
    const probe = probeJson({
      accounts: [
        { email: "a@x.com", isActive: false, fiveHour: { pct: 3.0 }, sevenDay: { pct: 10 } },
        { email: "b@x.com", isActive: false, fiveHour: { pct: 96.0 }, sevenDay: { pct: 89 } },
      ],
    });
    const account = pickActiveAccount(probe);
    expect(account.email).toBe("b@x.com");
    expect(account.fiveHour.pct).toBe(96.0);
  });

  test("returns null when accounts array is empty", () => {
    expect(pickActiveAccount({ accounts: [] })).toBeNull();
  });

  test("returns null when probe is null", () => {
    expect(pickActiveAccount(null)).toBeNull();
  });

  test("returns null when probe has no accounts key", () => {
    expect(pickActiveAccount({})).toBeNull();
  });

  test("handles missing fiveHour.pct gracefully in fallback selection", () => {
    const probe = {
      accounts: [
        { email: "no-pct@x.com", isActive: false, fiveHour: {} },
        { email: "has-pct@x.com", isActive: false, fiveHour: { pct: 50 } },
      ],
    };
    const account = pickActiveAccount(probe);
    expect(account.email).toBe("has-pct@x.com");
  });
});
