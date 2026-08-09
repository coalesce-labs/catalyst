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
      // A snapshot only gates while it is FRESH (Codex P2 round 1), so this
      // fixture now carries the sampledAt the real snapshot writes.
      getQuota: () => ({ core: { remaining, sampledAt: Date.now() } }),
      minRemaining: 500,
    });
    expect(await verify("PROJ-5")).toEqual({ unverifiable: true, reason: "github-quota-floor" });
    remaining = 500;
    expect(await verify("PROJ-5")).toEqual({ ok: true, prs: [] });
    expect(checks).toBe(1);
  });

  // CAT-11 (Codex P2 round 1): a below-floor snapshot that stops being refreshed
  // (sampler disabled / unable to write) must NOT hide unowned tickets forever.
  test("a STALE below-floor snapshot no longer gates verification", async () => {
    let checks = 0;
    const verify = makeOpenPrVerifier({
      checkOpenPrs: () => { checks += 1; return { ok: true, prs: [] }; },
      getQuota: () => ({ core: { remaining: 1, sampledAt: Date.now() - 60 * 60_000 } }),
      minRemaining: 500,
      quotaMaxAgeMs: 15 * 60_000,
    });
    expect(await verify("PROJ-5")).toEqual({ ok: true, prs: [] });
    expect(checks).toBe(1);
  });

  // Likewise once the snapshot's OWN reset time has passed, the low reading is moot.
  test("a below-floor snapshot past its reset time no longer gates", async () => {
    const verify = makeOpenPrVerifier({
      checkOpenPrs: () => ({ ok: true, prs: [] }),
      getQuota: () => ({ core: { remaining: 1, sampledAt: Date.now(), resetAt: Date.now() - 1000 } }),
      minRemaining: 500,
    });
    expect(await verify("PROJ-5")).toEqual({ ok: true, prs: [] });
  });

  // Non-vacuity: a fresh, pre-reset, below-floor snapshot still gates.
  test("a FRESH below-floor snapshot still gates", async () => {
    const verify = makeOpenPrVerifier({
      checkOpenPrs: () => ({ ok: true, prs: [] }),
      getQuota: () => ({ core: { remaining: 1, sampledAt: Date.now(), resetAt: Date.now() + 600_000 } }),
      minRemaining: 500,
    });
    expect(await verify("PROJ-5")).toEqual({ unverifiable: true, reason: "github-quota-floor" });
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
