import { describe, expect, test } from "bun:test";
import { makeOpenPrVerifier } from "./unowned-pr-verify.mjs";

describe("makeOpenPrVerifier (CAT-11)", () => {
  test("delegates and memoizes a verifiable result per ticket until TTL expiry", async () => {
    let clock = 100;
    const calls = [];
    const result = { ok: false, prs: [{ number: 72 }] };
    const verify = makeOpenPrVerifier({
      checkOpenPrs: (ticket) => { calls.push(ticket); return result; },
      getQuota: () => null,
      now: () => clock,
      ttlMs: 50,
    });
    expect(await verify("PROJ-1")).toBe(result);
    expect(await verify("PROJ-1")).toBe(result);
    expect(await verify("PROJ-5")).toBe(result);
    expect(calls).toEqual(["PROJ-1", "PROJ-5"]);
    clock = 151;
    await verify("PROJ-1");
    expect(calls).toEqual(["PROJ-1", "PROJ-5", "PROJ-1"]);
  });

  test("does not memoize unverifiable results", async () => {
    let calls = 0;
    const verify = makeOpenPrVerifier({
      checkOpenPrs: () => { calls += 1; return { unverifiable: true, prs: [] }; },
      getQuota: () => null,
      now: () => 1,
      ttlMs: 100,
    });
    await verify("PROJ-5");
    await verify("PROJ-5");
    expect(calls).toBe(2);
  });

  test("quota floor spares without enumeration and is not memoized", async () => {
    let checks = 0;
    let remaining = 499;
    const verify = makeOpenPrVerifier({
      checkOpenPrs: () => { checks += 1; return { ok: true, prs: [] }; },
      getQuota: () => ({ core: { remaining } }),
      minRemaining: 500,
    });
    expect(await verify("PROJ-5")).toEqual({ unverifiable: true, reason: "github-quota-floor" });
    remaining = 500;
    expect(await verify("PROJ-5")).toEqual({ ok: true, prs: [] });
    expect(checks).toBe(1);
  });

  test("missing quota proceeds and thrown checks become retryable unverifiable results", async () => {
    let calls = 0;
    const verify = makeOpenPrVerifier({
      checkOpenPrs: () => { calls += 1; throw new Error("gh failed"); },
      getQuota: () => null,
    });
    expect(await verify("PROJ-5")).toEqual({ unverifiable: true, reason: "gh failed" });
    expect(await verify("PROJ-5")).toEqual({ unverifiable: true, reason: "gh failed" });
    expect(calls).toBe(2);
  });

  test("disabled verifier returns null", async () => {
    let calls = 0;
    const verify = makeOpenPrVerifier({ checkOpenPrs: () => { calls += 1; }, enabled: false });
    expect(await verify("PROJ-5")).toBeNull();
    expect(calls).toBe(0);
  });
});
