// usage.test.mjs — CTL-812 Domain 1. tickUsage(): per-account emit of
// account.ratelimit.sampled with the full contract field set (incl. the NEW
// five_hour/seven_day pace), exact pace math against the locked fixtures, the
// object/bare/absent bucket shapes, zero-utilization carried through, email/tier
// resolved once per account, and a 429 stopping the REMAINING accounts this run
// (shared limiter). Plus computePace() unit cases. All seams injected; no real
// network. tickUsage()/computePace() are pure given their fakes.
//
// SECRETS HYGIENE: every fixture token is obviously fake.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test usage.test.mjs

import { describe, test, expect } from "bun:test";
import { computePace, pctOf, tickUsage, RATELIMIT_EVENT_SAMPLED } from "./usage.mjs";

const FIVE_HOUR_MS = 5 * 3600_000;
const SEVEN_DAY_MS = 7 * 86_400_000;

const TOKEN_A = "FAKE-token-account-a-never-logged";
const TOKEN_B = "FAKE-token-account-b-never-logged";

// A representative live 200 body (validated shape from GET /api/oauth/usage).
function usageBody(overrides = {}) {
  return {
    five_hour: { utilization: 42, resets_at: "2026-06-06T18:00:00Z" },
    seven_day: { utilization: 17, resets_at: "2026-06-13T00:00:00Z" },
    seven_day_opus: { utilization: 12, resets_at: "2026-06-13T00:00:00Z" },
    seven_day_sonnet: { utilization: 5, resets_at: "2026-06-13T00:00:00Z" },
    ...overrides,
  };
}

// Build a tickUsage harness: records every emit; defaults to one healthy
// active account on the 200 path.
function harness({
  accounts = [{ source: "active", token: TOKEN_A }],
  fetchUsage = async () => ({ status: 200, body: usageBody() }),
  resolveEmail = async () => ({
    email: "ryan@rozich.com",
    rateLimitTier: "default_claude_max_20x",
    subscriptionType: "active",
  }),
  now = () => Date.parse("2026-06-06T12:00:00Z"),
  nowIso = undefined,
} = {}) {
  const emitted = [];
  const fetchCalls = [];
  const resolveCalls = [];
  const promise = tickUsage({
    accounts,
    fetchUsage: async (token, opts) => {
      fetchCalls.push({ token, opts });
      return fetchUsage(token, opts);
    },
    resolveEmail: async (token, opts) => {
      resolveCalls.push({ token, opts });
      return resolveEmail(token, opts);
    },
    emit: (name, spec, opts) => emitted.push({ name, spec, opts }),
    now,
    nowIso,
  });
  return { promise, emitted, fetchCalls, resolveCalls };
}

// ─── computePace — pure unit (the locked fixtures) ───────────────────────────

describe("computePace — locked fixtures", () => {
  test("5h window, 1h elapsed, 8% used → -0.12", () => {
    // window started 11:00, resets_at = 16:00 (start + 5h); now = 12:00 (1h in).
    const nowMs = Date.parse("2026-06-06T12:00:00Z");
    const resetsAt = "2026-06-06T16:00:00Z";
    expect(computePace(8, resetsAt, FIVE_HOUR_MS, nowMs)).toBe(-0.12);
  });

  test("7d window, day 1 (1d elapsed), 30% used → +0.157", () => {
    // window started 06-06, resets_at = 06-13 (start + 7d); now = 06-07 (1d in).
    const nowMs = Date.parse("2026-06-07T00:00:00Z");
    const resetsAt = "2026-06-13T00:00:00Z";
    expect(computePace(30, resetsAt, SEVEN_DAY_MS, nowMs)).toBe(0.157);
  });

  test("on-pace exactly → 0 (50% used at the 5h midpoint)", () => {
    const nowMs = Date.parse("2026-06-06T13:30:00Z"); // 2.5h into a 5h window
    const resetsAt = "2026-06-06T16:00:00Z"; // started 11:00
    expect(computePace(50, resetsAt, FIVE_HOUR_MS, nowMs)).toBe(0);
  });

  test("null utilization or null resetsAt → null", () => {
    const nowMs = Date.parse("2026-06-06T12:00:00Z");
    expect(computePace(null, "2026-06-06T16:00:00Z", FIVE_HOUR_MS, nowMs)).toBe(null);
    expect(computePace(8, null, FIVE_HOUR_MS, nowMs)).toBe(null);
  });

  test("an unparseable resetsAt → null", () => {
    const nowMs = Date.parse("2026-06-06T12:00:00Z");
    expect(computePace(8, "not-a-date", FIVE_HOUR_MS, nowMs)).toBe(null);
  });

  test("zero utilization computes a (negative) pace, not null", () => {
    const nowMs = Date.parse("2026-06-06T12:00:00Z"); // 1h into 5h window
    const resetsAt = "2026-06-06T16:00:00Z";
    expect(computePace(0, resetsAt, FIVE_HOUR_MS, nowMs)).toBe(-0.2);
  });

  test("result is rounded to exactly 3 decimals", () => {
    // 7d, 1d elapsed (1/7 = 0.142857…), 0% used → -0.142857… → -0.143.
    const nowMs = Date.parse("2026-06-07T00:00:00Z");
    const resetsAt = "2026-06-13T00:00:00Z";
    expect(computePace(0, resetsAt, SEVEN_DAY_MS, nowMs)).toBe(-0.143);
  });
});

// ─── pctOf — bucket shapes ───────────────────────────────────────────────────

describe("pctOf — bucket shapes", () => {
  test("object bucket → its utilization", () => {
    expect(pctOf({ utilization: 42, resets_at: "x" })).toBe(42);
  });
  test("bare-number bucket → the number (back-compat)", () => {
    expect(pctOf(9)).toBe(9);
  });
  test("absent bucket (null/undefined) → null, not 0", () => {
    expect(pctOf(null)).toBe(null);
    expect(pctOf(undefined)).toBe(null);
  });
  test("object bucket with no utilization → null", () => {
    expect(pctOf({ resets_at: "x" })).toBe(null);
  });
  test("zero utilization is carried (not coerced to null)", () => {
    expect(pctOf({ utilization: 0, resets_at: "x" })).toBe(0);
  });
});

// ─── tickUsage — 200 emit with the full contract ─────────────────────────────

describe("tickUsage — 200 emit (contract)", () => {
  test("emits one account.ratelimit.sampled with every contract attr incl. pace", async () => {
    // resets_at picked so the pace math is checkable: 5h window started 11:00
    // (resets 16:00), now 12:00 → 1h in → elapsed 0.2; 42% → pace 0.42-0.2=0.22.
    // 7d window started 06-06 (resets 06-13), now 06-06T12:00 → 0.5d in →
    // elapsed 0.5/7 = 0.0714…; 17% → pace 0.17-0.0714 = 0.0986 → 0.099.
    const { promise, emitted } = harness({
      fetchUsage: async () => ({
        status: 200,
        body: usageBody({
          five_hour: { utilization: 42, resets_at: "2026-06-06T16:00:00Z" },
          seven_day: { utilization: 17, resets_at: "2026-06-13T00:00:00Z" },
        }),
      }),
      now: () => Date.parse("2026-06-06T12:00:00Z"),
    });
    const count = await promise;
    expect(count).toBe(1);
    expect(emitted.length).toBe(1);

    const { name, spec } = emitted[0];
    expect(name).toBe(RATELIMIT_EVENT_SAMPLED);
    expect(spec.entity).toBe("account");
    expect(spec.label).toBe("ryan@rozich.com");

    const a = spec.attrs;
    expect(a["account.email"]).toBe("ryan@rozich.com");
    expect(a["ratelimit.five_hour_pct"]).toBe(42);
    expect(a["ratelimit.seven_day_pct"]).toBe(17);
    expect(a["ratelimit.five_hour_resets_at"]).toBe("2026-06-06T16:00:00Z");
    expect(a["ratelimit.seven_day_resets_at"]).toBe("2026-06-13T00:00:00Z");
    expect(a["ratelimit.seven_day_opus_pct"]).toBe(12);
    expect(a["ratelimit.seven_day_sonnet_pct"]).toBe(5);
    expect(a["subscription.type"]).toBe("active");
    expect(a["rate_limit.tier"]).toBe("default_claude_max_20x");
    // NEW pace attrs:
    expect(a["ratelimit.five_hour_pace"]).toBe(0.22); // 0.42 - 0.20
    expect(a["ratelimit.seven_day_pace"]).toBe(0.099); // 0.17 - 0.5/7
  });

  test("body.payload mirrors the same fields (incl. pace) for human readability", async () => {
    const { promise, emitted } = harness({
      fetchUsage: async () => ({
        status: 200,
        body: usageBody({
          five_hour: { utilization: 42, resets_at: "2026-06-06T16:00:00Z" },
          seven_day: { utilization: 17, resets_at: "2026-06-13T00:00:00Z" },
        }),
      }),
      now: () => Date.parse("2026-06-06T12:00:00Z"),
    });
    await promise;
    const p = emitted[0].spec.payload;
    expect(p.email).toBe("ryan@rozich.com");
    expect(p.fiveHourPct).toBe(42);
    expect(p.fiveHourPace).toBe(0.22);
    expect(p.sevenDayPace).toBe(0.099);
  });

  test("nowIso is forwarded to emit as opts.now (envelope ts seam)", async () => {
    const { promise, emitted } = harness({ nowIso: () => "2026-06-06T12:00:00Z" });
    await promise;
    expect(typeof emitted[0].opts.now).toBe("function");
    expect(emitted[0].opts.now()).toBe("2026-06-06T12:00:00Z");
  });
});

// ─── tickUsage — bucket shapes + zero utilization ────────────────────────────

describe("tickUsage — bucket shapes", () => {
  test("per-model 7d objects are normalized to numbers (guards [object Object])", async () => {
    const { promise, emitted } = harness();
    await promise;
    const a = emitted[0].spec.attrs;
    expect(a["ratelimit.seven_day_opus_pct"]).toBe(12);
    expect(a["ratelimit.seven_day_sonnet_pct"]).toBe(5);
    expect(typeof a["ratelimit.seven_day_opus_pct"]).toBe("number");
  });

  test("bare-number per-model buckets are accepted (back-compat)", async () => {
    const { promise, emitted } = harness({
      fetchUsage: async () => ({ status: 200, body: usageBody({ seven_day_opus: 9, seven_day_sonnet: 3 }) }),
    });
    await promise;
    const a = emitted[0].spec.attrs;
    expect(a["ratelimit.seven_day_opus_pct"]).toBe(9);
    expect(a["ratelimit.seven_day_sonnet_pct"]).toBe(3);
  });

  test("absent per-model buckets emit null (dropped downstream by the put() pattern)", async () => {
    const { promise, emitted } = harness({
      fetchUsage: async () => ({ status: 200, body: usageBody({ seven_day_opus: undefined, seven_day_sonnet: undefined }) }),
    });
    await promise;
    const a = emitted[0].spec.attrs;
    expect(a["ratelimit.seven_day_opus_pct"]).toBe(null);
    expect(a["ratelimit.seven_day_sonnet_pct"]).toBe(null);
  });

  test("zero utilization is carried through (not dropped); pace still computed", async () => {
    const { promise, emitted } = harness({
      fetchUsage: async () => ({
        status: 200,
        body: usageBody({
          five_hour: { utilization: 0, resets_at: "2026-06-06T16:00:00Z" },
          seven_day: { utilization: 0, resets_at: "2026-06-13T00:00:00Z" },
        }),
      }),
      now: () => Date.parse("2026-06-06T12:00:00Z"),
    });
    await promise;
    const a = emitted[0].spec.attrs;
    expect(a["ratelimit.five_hour_pct"]).toBe(0);
    expect(a["ratelimit.seven_day_pct"]).toBe(0);
    expect(a["ratelimit.five_hour_pace"]).toBe(-0.2); // 0 - 1h/5h
  });

  test("missing resets_at → pace null (but pct still emitted)", async () => {
    const { promise, emitted } = harness({
      fetchUsage: async () => ({
        status: 200,
        body: usageBody({
          five_hour: { utilization: 42 }, // no resets_at
          seven_day: { utilization: 17 },
        }),
      }),
    });
    await promise;
    const a = emitted[0].spec.attrs;
    expect(a["ratelimit.five_hour_pct"]).toBe(42);
    expect(a["ratelimit.five_hour_pace"]).toBe(null);
    expect(a["ratelimit.seven_day_pace"]).toBe(null);
  });
});

// ─── tickUsage — email/tier resolved once per account ────────────────────────

describe("tickUsage — email resolution", () => {
  test("email/tier are resolved exactly once per account", async () => {
    const { promise, resolveCalls, fetchCalls } = harness({
      accounts: [
        { source: "active", token: TOKEN_A },
        { source: "backup", token: TOKEN_B, file: "b.json" },
      ],
    });
    await promise;
    // One resolve + one fetch per account.
    expect(resolveCalls.length).toBe(2);
    expect(fetchCalls.length).toBe(2);
    expect(resolveCalls.map((c) => c.token).sort()).toEqual([TOKEN_A, TOKEN_B].sort());
  });

  test("a null-resolving profile still emits with email null + label 'unknown'", async () => {
    const { promise, emitted } = harness({ resolveEmail: async () => null });
    await promise;
    expect(emitted.length).toBe(1);
    expect(emitted[0].spec.attrs["account.email"]).toBe(null);
    expect(emitted[0].spec.label).toBe("unknown");
  });

  test("an account with no token is skipped (no resolve, no fetch, no emit)", async () => {
    const { promise, emitted, fetchCalls, resolveCalls } = harness({
      accounts: [{ source: "backup", token: null, file: "x.json" }],
    });
    const count = await promise;
    expect(count).toBe(0);
    expect(emitted.length).toBe(0);
    expect(fetchCalls.length).toBe(0);
    expect(resolveCalls.length).toBe(0);
  });
});

// ─── tickUsage — multi-account + 429 shared limiter ──────────────────────────

describe("tickUsage — multiple accounts", () => {
  test("emits one event per healthy account, in order", async () => {
    const { promise, emitted } = harness({
      accounts: [
        { source: "active", token: TOKEN_A },
        { source: "backup", token: TOKEN_B, file: "b.json" },
      ],
      resolveEmail: async (token) =>
        token === TOKEN_A
          ? { email: "a@x.com", rateLimitTier: "t1", subscriptionType: "active" }
          : { email: "b@x.com", rateLimitTier: "t2", subscriptionType: "active" },
    });
    const count = await promise;
    expect(count).toBe(2);
    expect(emitted.map((e) => e.spec.attrs["account.email"])).toEqual(["a@x.com", "b@x.com"]);
  });

  test("a 429 on the FIRST account stops the run — no emit for it or later accounts", async () => {
    const fetchTokens = [];
    const { promise, emitted } = harness({
      accounts: [
        { source: "active", token: TOKEN_A },
        { source: "backup", token: TOKEN_B, file: "b.json" },
      ],
      fetchUsage: async (token) => {
        fetchTokens.push(token);
        return { status: 429, body: null };
      },
    });
    const count = await promise;
    expect(count).toBe(0);
    expect(emitted.length).toBe(0);
    // The shared limiter stops the loop: account B is never even fetched.
    expect(fetchTokens).toEqual([TOKEN_A]);
  });

  test("a 429 on the SECOND account keeps the first emit, skips the rest", async () => {
    const fetchTokens = [];
    const { promise, emitted } = harness({
      accounts: [
        { source: "active", token: TOKEN_A },
        { source: "backup", token: TOKEN_B, file: "b.json" },
        { source: "backup", token: "FAKE-token-c", file: "c.json" },
      ],
      fetchUsage: async (token) => {
        fetchTokens.push(token);
        return token === TOKEN_A ? { status: 200, body: usageBody() } : { status: 429, body: null };
      },
    });
    const count = await promise;
    expect(count).toBe(1); // only A emitted
    expect(emitted.length).toBe(1);
    // A fetched + B fetched (429 → break); C never fetched.
    expect(fetchTokens).toEqual([TOKEN_A, TOKEN_B]);
  });
});

// ─── tickUsage — non-200 / null body / resilience ────────────────────────────

describe("tickUsage — non-200 / resilience", () => {
  test("a non-200 (non-429) skips that account's emit but continues to the next", async () => {
    const { promise, emitted } = harness({
      accounts: [
        { source: "active", token: TOKEN_A },
        { source: "backup", token: TOKEN_B, file: "b.json" },
      ],
      fetchUsage: async (token) =>
        token === TOKEN_A ? { status: 500, body: null } : { status: 200, body: usageBody() },
    });
    const count = await promise;
    expect(count).toBe(1); // only B emitted; A's 500 is skipped, not a stop
    expect(emitted.length).toBe(1);
  });

  test("a 200 with null body emits nothing but does not stop the run", async () => {
    const { promise, emitted } = harness({
      accounts: [
        { source: "active", token: TOKEN_A },
        { source: "backup", token: TOKEN_B, file: "b.json" },
      ],
      fetchUsage: async (token) =>
        token === TOKEN_A ? { status: 200, body: null } : { status: 200, body: usageBody() },
    });
    expect(await promise).toBe(1);
    expect(emitted.length).toBe(1);
  });

  test("a throwing fetchUsage for one account does not crash the run", async () => {
    const { promise, emitted } = harness({
      accounts: [
        { source: "active", token: TOKEN_A },
        { source: "backup", token: TOKEN_B, file: "b.json" },
      ],
      fetchUsage: async (token) => {
        if (token === TOKEN_A) throw new Error("boom");
        return { status: 200, body: usageBody() };
      },
    });
    await expect(promise).resolves.toBe(1);
    expect(emitted.length).toBe(1);
  });

  test("an empty accounts list emits nothing and returns 0", async () => {
    const { promise, emitted } = harness({ accounts: [] });
    expect(await promise).toBe(0);
    expect(emitted.length).toBe(0);
  });
});
