// ratelimit-poller.test.mjs — CTL-787. The account rate-limit poller core:
// 200-body parse + emit, 429 backoff/skip, success backoff reset, missing-token
// no-op, non-200/null-body no-op, one-shot cached email, file-fallback token
// read, and stop(). All dependencies injected; tick() awaited directly — no
// real timer, no real network, no real keychain.
//
// Run: cd plugins/dev/scripts/execution-core && bun test ratelimit-poller.test.mjs

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRatelimitPoller } from "./ratelimit-poller.mjs";
import { RATELIMIT_EVENT_SAMPLED, emitRatelimitEvent } from "./ratelimit-event.mjs";

// Recording fake clock — setInterval returns a stable handle; tests drive
// w.tick() directly.
function recordingClock() {
  const handle = { id: Symbol("interval") };
  let cleared = false;
  return {
    setInterval: () => handle,
    clearInterval: (h) => {
      if (h === handle) cleared = true;
    },
    handle,
    wasCleared: () => cleared,
  };
}

// A representative live 200 body (validated shape from GET /api/oauth/usage on
// 2026-06-06). The per-model 7d buckets come back as OBJECTS { utilization,
// resets_at }, same as five_hour/seven_day — NOT bare numbers — so the poller
// must normalize them to the numeric utilization (see pctOf).
function usageBody(overrides = {}) {
  return {
    five_hour: { utilization: 42, resets_at: "2026-06-06T18:00:00Z" },
    seven_day: { utilization: 17, resets_at: "2026-06-13T00:00:00Z" },
    seven_day_opus: { utilization: 12, resets_at: "2026-06-13T00:00:00Z" },
    seven_day_sonnet: { utilization: 5, resets_at: "2026-06-13T00:00:00Z" },
    ...overrides,
  };
}

const TOKEN = "sk-oauth-FAKE-TOKEN-never-logged";
const EMAIL = "ryan@rozich.com";

// Build a test harness. All seams injected; defaults to a healthy 200 path.
// credentialMode defaults to "oauth-login" so existing OAuth-path tests are
// unaffected. New accounts-env tests pass credentialMode:"accounts-env" and
// a probeAccounts seam explicitly.
function harness({
  readToken = () => TOKEN,
  fetchUsage = async () => ({ status: 200, body: usageBody() }),
  resolveEmail = async () => ({
    email: EMAIL,
    rateLimitTier: "default_claude_max_20x",
    subscriptionType: "active",
  }),
  probeAccounts = async () => ({ accounts: [] }),
  config = { enabled: true, intervalMs: 300000, usageEndpoint: "https://example/usage", credentialMode: "oauth-login" },
} = {}) {
  const emitted = [];
  const fetchCalls = [];
  const resolveCalls = [];
  const clock = recordingClock();
  const w = startRatelimitPoller({
    clock,
    config,
    probeAccounts,
    readToken,
    fetchUsage: async (token, opts) => {
      fetchCalls.push({ token, opts });
      return fetchUsage(token, opts);
    },
    resolveEmail: async (token, opts) => {
      resolveCalls.push({ token, opts });
      return resolveEmail(token, opts);
    },
    emit: (name, payload) => emitted.push({ name, payload }),
  });
  return { w, emitted, fetchCalls, resolveCalls, clock };
}

// ─── 200 parse + emit ────────────────────────────────────────────────────────

describe("tick — 200 body", () => {
  test("parses a 200 body and emits one account.ratelimit.sampled with all fields", async () => {
    const { w, emitted } = harness();
    await w.tick();
    expect(emitted.length).toBe(1);
    const { name, payload } = emitted[0];
    expect(name).toBe(RATELIMIT_EVENT_SAMPLED);
    expect(payload.email).toBe(EMAIL);
    expect(payload.fiveHourPct).toBe(42);
    expect(payload.sevenDayPct).toBe(17);
    expect(payload.fiveHourResetsAt).toBe("2026-06-06T18:00:00Z");
    expect(payload.sevenDayResetsAt).toBe("2026-06-13T00:00:00Z");
    expect(payload.opusPct).toBe(12);
    expect(payload.sonnetPct).toBe(5);
    expect(payload.subscriptionType).toBe("active");
    expect(payload.rateLimitTier).toBe("default_claude_max_20x");
  });

  test("zero utilization is carried through (not dropped)", async () => {
    const { w, emitted } = harness({
      fetchUsage: async () => ({
        status: 200,
        body: usageBody({
          five_hour: { utilization: 0, resets_at: "x" },
          seven_day: { utilization: 0, resets_at: "y" },
        }),
      }),
    });
    await w.tick();
    expect(emitted[0].payload.fiveHourPct).toBe(0);
    expect(emitted[0].payload.sevenDayPct).toBe(0);
  });

  test("per-model 7d buckets are normalized to numbers (object shape) — guards the [object Object] bug", async () => {
    const { w, emitted } = harness();
    await w.tick();
    const { payload } = emitted[0];
    // The live API returns objects; pctOf must extract the numeric utilization,
    // never the whole object (which would stringify to "[object Object]" in Loki).
    expect(payload.opusPct).toBe(12);
    expect(payload.sonnetPct).toBe(5);
    expect(typeof payload.opusPct).toBe("number");
    expect(typeof payload.sonnetPct).toBe("number");
  });

  test("per-model 7d buckets also accept bare-number shape (back-compat)", async () => {
    const { w, emitted } = harness({
      fetchUsage: async () => ({
        status: 200,
        body: usageBody({ seven_day_opus: 9, seven_day_sonnet: 3 }),
      }),
    });
    await w.tick();
    expect(emitted[0].payload.opusPct).toBe(9);
    expect(emitted[0].payload.sonnetPct).toBe(3);
  });

  test("absent per-model 7d buckets emit null (omitted downstream)", async () => {
    const { w, emitted } = harness({
      fetchUsage: async () => ({
        status: 200,
        body: usageBody({ seven_day_opus: undefined, seven_day_sonnet: undefined }),
      }),
    });
    await w.tick();
    expect(emitted[0].payload.opusPct).toBeNull();
    expect(emitted[0].payload.sonnetPct).toBeNull();
  });
});

// ─── 429 backoff ─────────────────────────────────────────────────────────────

describe("tick — 429 backoff", () => {
  test("429 emits nothing and the next tick is skipped", async () => {
    let status = 429;
    const { w, emitted, fetchCalls } = harness({
      fetchUsage: async () => ({ status, body: null }),
    });

    await w.tick(); // 429 — no emit, sets skipCounter=1
    expect(emitted.length).toBe(0);
    expect(fetchCalls.length).toBe(1);

    await w.tick(); // skipped — fetch not called again
    expect(fetchCalls.length).toBe(1);
    expect(emitted.length).toBe(0);
  });

  test("success after 429 resets backoff (no further skips)", async () => {
    let status = 429;
    const { w, emitted, fetchCalls } = harness({
      fetchUsage: async () => (status === 429 ? { status: 429, body: null } : { status: 200, body: usageBody() }),
    });

    await w.tick(); // 429 → skipCounter=1
    await w.tick(); // skipped
    status = 200;
    await w.tick(); // real attempt → 200, emit, reset backoff
    expect(emitted.length).toBe(1);
    const fetchesSoFar = fetchCalls.length;

    await w.tick(); // not skipped anymore (backoff reset) → emits again
    expect(emitted.length).toBe(2);
    expect(fetchCalls.length).toBe(fetchesSoFar + 1);
  });

  // CTL-787 reviewer FIX 1: the skip loop consumes skipCounter ticks BEFORE the
  // next real attempt, so N skips ⇒ an inter-attempt gap of (N+1)*intervalMs.
  // Capping the skip COUNT at floor(CAP/interval) overshoots the 15-min cap;
  // the GAP must be capped instead. Drive sustained 429s and assert the gap
  // between consecutive real fetch attempts never exceeds BACKOFF_CAP_MS — for
  // BOTH the 5-min default cadence and the 180s interval floor.
  const BACKOFF_CAP_MS = 15 * 60_000;

  async function maxObservedGapMs(intervalMs) {
    // Always-429: every real attempt grows the backoff toward the cap.
    const { w, fetchCalls } = harness({
      fetchUsage: async () => ({ status: 429, body: null }),
      config: { enabled: true, intervalMs, usageEndpoint: "https://example/usage", credentialMode: "oauth-login" },
    });
    let maxSkipRun = 0; // most skipped ticks observed before any real attempt
    let skipsSinceLastFetch = 0;
    let lastFetchCount = 0;
    // Many ticks so the backoff saturates at maxMultiplier and we observe the
    // steady-state skip run repeatedly.
    for (let i = 0; i < 200; i++) {
      await w.tick();
      if (fetchCalls.length > lastFetchCount) {
        // A real attempt fired this tick — close out the preceding skip run.
        if (skipsSinceLastFetch > maxSkipRun) maxSkipRun = skipsSinceLastFetch;
        skipsSinceLastFetch = 0;
        lastFetchCount = fetchCalls.length;
      } else {
        // A skipped tick (skipCounter consumed; no fetch).
        skipsSinceLastFetch++;
      }
    }
    // gap between two consecutive real attempts = (skips + 1) * intervalMs.
    return (maxSkipRun + 1) * intervalMs;
  }

  test("backoff never lets the inter-attempt gap exceed BACKOFF_CAP_MS — 5-min default", async () => {
    const gap = await maxObservedGapMs(300000);
    expect(gap).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(gap).toBe(15 * 60_000); // (2+1)*5min — saturates exactly at the cap
  });

  test("backoff never lets the inter-attempt gap exceed BACKOFF_CAP_MS — 180s floor", async () => {
    const gap = await maxObservedGapMs(180000);
    expect(gap).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(gap).toBe(15 * 60_000); // (4+1)*3min — saturates exactly at the cap
  });
});

// ─── missing token ───────────────────────────────────────────────────────────

test("missing token → no throw, no emit, no fetch", async () => {
  const { w, emitted, fetchCalls } = harness({ readToken: () => null });
  await expect(w.tick()).resolves.toBeUndefined();
  expect(emitted.length).toBe(0);
  expect(fetchCalls.length).toBe(0);
});

// ─── non-200 / null body ─────────────────────────────────────────────────────

test("non-200 status → no throw, no emit", async () => {
  const { w, emitted } = harness({ fetchUsage: async () => ({ status: 500, body: null }) });
  await expect(w.tick()).resolves.toBeUndefined();
  expect(emitted.length).toBe(0);
});

test("200 with null body → no throw, no emit", async () => {
  const { w, emitted } = harness({ fetchUsage: async () => ({ status: 200, body: null }) });
  await w.tick();
  expect(emitted.length).toBe(0);
});

test("network error (status 0) → no throw, no emit", async () => {
  const { w, emitted } = harness({ fetchUsage: async () => ({ status: 0, body: null }) });
  await w.tick();
  expect(emitted.length).toBe(0);
});

// ─── email resolved once + cached ────────────────────────────────────────────

test("email is resolved exactly once and cached across ticks", async () => {
  const { w, emitted, resolveCalls } = harness();
  await w.tick();
  await w.tick();
  await w.tick();
  expect(resolveCalls.length).toBe(1);
  expect(emitted.every((e) => e.payload.email === EMAIL)).toBe(true);
});

test("a null-resolving profile is not retried every tick (email stays null)", async () => {
  const { w, emitted, resolveCalls } = harness({ resolveEmail: async () => null });
  await w.tick();
  await w.tick();
  expect(resolveCalls.length).toBe(1);
  expect(emitted[0].payload.email).toBe(null);
});

// ─── token file fallback (non-darwin path) ───────────────────────────────────

test("injected readToken reading a credentials file returns the accessToken", async () => {
  // Simulate the non-darwin file-fallback branch without touching the keychain:
  // an injected readToken that parses a real ~/.claude/.credentials.json shape.
  const dir = mkdtempSync(join(tmpdir(), "ctl787-cred-"));
  const credPath = join(dir, ".credentials.json");
  writeFileSync(
    credPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "file-token-abc" } }),
  );
  const fileReadToken = () => {
    try {
      const raw = require("node:fs").readFileSync(credPath, "utf8");
      return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
    } catch {
      return null;
    }
  };
  const { w, fetchCalls } = harness({ readToken: fileReadToken });
  await w.tick();
  expect(fetchCalls.length).toBe(1);
  expect(fetchCalls[0].token).toBe("file-token-abc");
});

// ─── transient resilience ────────────────────────────────────────────────────

test("a throwing fetchUsage does not crash tick and emits nothing", async () => {
  const { w, emitted } = harness({
    fetchUsage: async () => {
      throw new Error("boom");
    },
  });
  await expect(w.tick()).resolves.toBeUndefined();
  expect(emitted.length).toBe(0);
});

// ─── injected now() controls the emitted envelope ts (CTL-787 FIX 3) ─────────

test("an injected now() controls the emitted envelope's ts", async () => {
  // Use the REAL emitRatelimitEvent writing to a temp logPath so the assertion
  // proves now is threaded end-to-end: startRatelimitPoller → emit → logPath +
  // now → buildRatelimitEnvelope.ts. (The default harness emit seam discards the
  // opts arg, so it cannot observe now; this drives the production emit instead.)
  const dir = mkdtempSync(join(tmpdir(), "ctl787-now-"));
  const logPath = join(dir, "events.jsonl");
  const FIXED_TS = "2025-01-02T03:04:05Z";
  const clock = recordingClock();
  const w = startRatelimitPoller({
    clock,
    // credentialMode:"oauth-login" — this is an OAuth-path test (it injects
    // readToken/fetchUsage/resolveEmail). Without it, the CTL-2056 default
    // credMode "accounts-env" would route the tick through the real
    // defaultProbeAccounts and ignore these seams (the tick would spawn a
    // real probe and hang).
    config: { enabled: true, intervalMs: 300000, usageEndpoint: "https://example/usage", credentialMode: "oauth-login" },
    readToken: () => TOKEN,
    fetchUsage: async () => ({ status: 200, body: usageBody() }),
    resolveEmail: async () => ({ email: EMAIL, rateLimitTier: null, subscriptionType: null }),
    // Real emitter, redirected to a temp file via logPath; now is threaded through.
    emit: (name, payload, opts) => emitRatelimitEvent(name, payload, { ...opts, logPath }),
    now: () => FIXED_TS,
  });
  await w.tick();
  const line = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).pop();
  const envelope = JSON.parse(line);
  expect(envelope.ts).toBe(FIXED_TS);
  expect(envelope.observedTs).toBe(FIXED_TS);
});

// ─── stop() ──────────────────────────────────────────────────────────────────

test("stop() calls clock.clearInterval with the registered handle", () => {
  const clock = recordingClock();
  const w = startRatelimitPoller({
    clock,
    config: { enabled: true, intervalMs: 300000, usageEndpoint: "https://x/usage", credentialMode: "oauth-login" },
    readToken: () => null,
    fetchUsage: async () => ({ status: 0, body: null }),
    resolveEmail: async () => null,
    emit: () => {},
  });
  expect(clock.wasCleared()).toBe(false);
  w.stop();
  expect(clock.wasCleared()).toBe(true);
});

// ─── CTL-2056: accounts-env credential path ──────────────────────────────────

// Shared probe JSON fixture (mirrors the plan's representative shape).
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
        fiveHour: { pct: 3.0, resetsAt: "2026-08-20T04:40:00Z", status: "allowed" },
        sevenDay: { pct: 10.0, resetsAt: "2026-08-26T00:00:00Z", status: "allowed" },
      },
      ...(overrides.accounts ? [] : []),
    ],
    ...overrides,
  };
}

function accountsHarness({
  probeAccounts = async () => probeJson(),
} = {}) {
  const emitted = [];
  const clock = recordingClock();
  const w = startRatelimitPoller({
    clock,
    config: { enabled: true, intervalMs: 300000, usageEndpoint: "https://x/usage", credentialMode: "accounts-env" },
    probeAccounts,
    readToken: () => { throw new Error("should not be called on accounts-env path"); },
    fetchUsage: async () => { throw new Error("should not be called on accounts-env path"); },
    resolveEmail: async () => { throw new Error("should not be called on accounts-env path"); },
    emit: (name, payload) => emitted.push({ name, payload }),
  });
  return { w, emitted, clock };
}

describe("tick — accounts-env path (CTL-2056)", () => {
  test("emits the ACTIVE account's 5h/7d utilisation with 0-100 pct unchanged", async () => {
    const { w, emitted } = accountsHarness();
    await w.tick();
    expect(emitted.length).toBe(1);
    const { name, payload } = emitted[0];
    expect(name).toBe(RATELIMIT_EVENT_SAMPLED);
    expect(payload.email).toBe("ops@coalesce.dev");
    expect(payload.fiveHourPct).toBe(96.0);
    expect(payload.sevenDayPct).toBe(89.0);
    expect(payload.fiveHourResetsAt).toBe("2026-08-20T04:40:00Z");
    expect(payload.sevenDayResetsAt).toBe("2026-08-26T00:00:00Z");
    // These fields are unavailable via the setup-token path.
    expect(payload.opusPct).toBeNull();
    expect(payload.sonnetPct).toBeNull();
    expect(payload.rateLimitTier).toBeNull();
    expect(payload.subscriptionType).toBeNull();
  });

  test("falls back to highest 5h-utilisation account when none is marked active", async () => {
    const probe = probeJson({
      accounts: [
        { email: "a@x.com", isActive: false, fiveHour: { pct: 3.0, resetsAt: "2026-08-20T04:40:00Z" }, sevenDay: { pct: 10 } },
        { email: "b@x.com", isActive: false, fiveHour: { pct: 96.0, resetsAt: "2026-08-20T04:40:00Z" }, sevenDay: { pct: 89 } },
      ],
    });
    const { w, emitted } = accountsHarness({ probeAccounts: async () => probe });
    await w.tick();
    expect(emitted.length).toBe(1);
    expect(emitted[0].payload.email).toBe("b@x.com");
    expect(emitted[0].payload.fiveHourPct).toBe(96.0);
  });

  test("empty probe → skips the tick, emits nothing, does not throw", async () => {
    const { w, emitted } = accountsHarness({ probeAccounts: async () => ({ accounts: [] }) });
    await expect(w.tick()).resolves.toBeUndefined();
    expect(emitted.length).toBe(0);
  });

  test("throwing probe → skips the tick, emits nothing, does not throw", async () => {
    const { w, emitted } = accountsHarness({ probeAccounts: async () => { throw new Error("spawn error"); } });
    await expect(w.tick()).resolves.toBeUndefined();
    expect(emitted.length).toBe(0);
  });

  test("legacy OAuth path still works when credentialMode=oauth-login", async () => {
    const { w, emitted } = harness({
      config: { enabled: true, intervalMs: 300000, usageEndpoint: "https://example/usage", credentialMode: "oauth-login" },
    });
    await w.tick();
    expect(emitted.length).toBe(1);
    expect(emitted[0].name).toBe(RATELIMIT_EVENT_SAMPLED);
    expect(emitted[0].payload.email).toBe(EMAIL);
  });
});
