import { describe, it, expect } from "bun:test";
import { deriveAccountsSummary, createAccountsProbe } from "../accounts-probe.mjs";

const REJECTED_ACTIVE = {
  generatedAt: "2026-08-05T12:00:00.000Z",
  accounts: [
    {
      label: "acctA",
      isActive: true,
      email: "a@x.io",
      overallStatus: "rejected",
      representativeClaim: "seven_day",
      fiveHour: { pct: 40, resetsAt: "2026-08-05T13:00:00.000Z", status: "allowed" },
      sevenDay: { pct: 100, resetsAt: "2026-08-06T00:00:00.000Z", status: "rejected" },
      error: null,
    },
    {
      label: "acctB",
      isActive: false,
      email: "b@x.io",
      overallStatus: "allowed",
      representativeClaim: "five_hour",
      fiveHour: { pct: 10, resetsAt: "2026-08-05T13:00:00.000Z", status: "allowed" },
      sevenDay: { pct: 20, resetsAt: "2026-08-12T00:00:00.000Z", status: "allowed" },
      error: null,
    },
  ],
};

describe("deriveAccountsSummary", () => {
  it("keys the node, picks the active account, and its binding-window status", () => {
    const s = deriveAccountsSummary(REJECTED_ACTIVE, { node: "mini-2" });
    expect(s.node).toBe("mini-2");
    expect(s.active.label).toBe("acctA");
    expect(s.active.bindingWindow).toBe("seven_day"); // == representativeClaim
    expect(s.active.bindingStatus).toBe("rejected"); // sevenDay.status
    expect(s.status).toBe("rejected"); // node-level == active binding status
  });
  it("names a sibling with headroom (allowed, not active) when the active is rejected", () => {
    const s = deriveAccountsSummary(REJECTED_ACTIVE, { node: "mini-2" });
    expect(s.siblingWithHeadroom).toEqual({ label: "acctB", email: "b@x.io" });
  });
  it("returns siblingWithHeadroom=null when no non-active account is allowed", () => {
    const only = { ...REJECTED_ACTIVE, accounts: [REJECTED_ACTIVE.accounts[0]] };
    expect(deriveAccountsSummary(only, { node: "n" }).siblingWithHeadroom).toBeNull();
  });
  it("distinguishes a transport error from rejected (status='error', not loud)", () => {
    const errd = {
      generatedAt: "t",
      accounts: [
        {
          label: "acctA",
          isActive: true,
          email: "a@x.io",
          overallStatus: null,
          representativeClaim: null,
          fiveHour: null,
          sevenDay: null,
          error: "network error",
        },
      ],
    };
    const s = deriveAccountsSummary(errd, { node: "n" });
    expect(s.status).toBe("error");
    expect(s.active.error).toBe("network error");
  });
  it("status='unknown' when no account is active (CLAUDE_CODE_OAUTH_TOKEN unset)", () => {
    const none = { generatedAt: "t", accounts: [{ ...REJECTED_ACTIVE.accounts[1] }] };
    expect(deriveAccountsSummary(none, { node: "n" }).status).toBe("unknown");
  });
  it("NEVER surfaces a token field even if one leaks into the raw record", () => {
    const tainted = structuredClone(REJECTED_ACTIVE);
    tainted.accounts[0].token = "sk-ant-oat-LEAK";
    const s = deriveAccountsSummary(tainted, { node: "n" });
    expect(JSON.stringify(s)).not.toContain("sk-ant-oat");
    expect(JSON.stringify(s)).not.toContain("token");
  });
});

describe("createAccountsProbe (cache)", () => {
  const mkExec = () => {
    // injected fake, counts invocations
    let n = 0;
    const exec = async () => {
      n += 1;
      return { ...REJECTED_ACTIVE, _n: n };
    };
    return { exec, calls: () => n };
  };
  it("probes once, then serves cache within TTL (no second probe)", async () => {
    const { exec, calls } = mkExec();
    let t = 1000;
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => t, node: "n" });
    const a = await p.get();
    t = 2000;
    const b = await p.get();
    expect(calls()).toBe(1);
    expect(b.probedAt).toBe(a.probedAt);
    expect(b.cached).toBe(true);
  });
  it("re-probes after TTL expiry", async () => {
    const { exec, calls } = mkExec();
    let t = 1000;
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => t, node: "n" });
    await p.get();
    t = 7000;
    await p.get();
    expect(calls()).toBe(2);
  });
  it("refresh:true bypasses a fresh cache", async () => {
    const { exec, calls } = mkExec();
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => 1000, node: "n" });
    await p.get();
    await p.get({ refresh: true });
    expect(calls()).toBe(2);
  });
  it("latest() returns the last posture without probing; null before first probe", async () => {
    const { exec, calls } = mkExec();
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => 1000, node: "n" });
    expect(p.latest()).toBeNull();
    await p.get();
    expect(p.latest()).not.toBeNull();
    expect(calls()).toBe(1);
  });
  it("a throwing exec yields an error posture, never throws, and is not cached as fresh", async () => {
    let n = 0;
    const exec = async () => {
      n += 1;
      throw new Error("spawn EACCES");
    };
    const p = createAccountsProbe({ exec, ttlMs: 5000, now: () => 1000, node: "n" });
    const r = await p.get();
    expect(r.status).toBe("error");
    await p.get(); // should retry, not serve a stale error
    expect(n).toBe(2);
  });
});
