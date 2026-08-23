// codex-account-plane.test.mjs — unit suite for the pure Codex account-plane core.
//
// Pinned in .github/workflows/execution-core-tests.yml in the same phase that
// created it: CI runs an ENUMERATED list, so a suite merely written beside its
// sibling never runs (measured on this repo: `grep -c
// 'catalyst-stack-claude-account' .github/workflows/execution-core-tests.yml`
// → 0, i.e. the model suite this one is patterned on is itself CI-inert).
//
// ⚠️ Do NOT baseline this file with a bare `bun test` in this directory:
// `agent-liveness.test.mjs` calls process.exit(), which terminates bun's runner
// before it prints `Ran N tests` and returns rc=0 even when another file failed
// (measured 2026-08-22: fsm-descriptor.test.mjs's 1 failure was masked exactly
// this way). Run this file by name.

import { test, expect, describe } from "bun:test";
import {
  deriveWindowLabel,
  normalizeRateLimits,
  deriveBindingWindow,
  classifyAccountPlane,
  parseNdjson,
  handleFromHomePath,
  isRejectedStatus,
  ACCOUNT_PLANE_STATUS,
} from "./codex-account-plane.mjs";

// ── Fixtures ────────────────────────────────────────────────────────────────
// LIVE is the VERBATIM payload measured on mini-2 (codex-cli 0.147.0,
// 2026-08-22) from `account/rateLimits/read`. Its shape is the whole reason
// this module exists — see the normalizeRateLimits block below.
const LIVE = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787802784 },
    secondary: null,
    planType: "pro",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787802784 },
      secondary: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787462209 },
      secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788049009 },
      planType: "pro",
      rateLimitReachedType: null,
    },
  },
};

// Same shape, but the 5h window is the most-consumed one — so the binding
// window must be the 5h one and NOT the (positionally first) weekly bucket.
const LIVE_TWO_BUCKETS_WITH_HIGH_5H = {
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787802784 },
      secondary: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: 1787462209 },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1788049009 },
      planType: "pro",
      rateLimitReachedType: null,
    },
  },
};

const OK_ACCOUNT = { account: { type: "chatgpt", email: "a@b.c", planType: "pro" } };

describe("deriveWindowLabel", () => {
  test("names windows from duration, never from position", () => {
    expect(deriveWindowLabel(300)).toBe("5h");
    expect(deriveWindowLabel(10080)).toBe("weekly");
    expect(deriveWindowLabel(60)).toBe("1h");
    expect(deriveWindowLabel(1440)).toBe("1d");
    expect(deriveWindowLabel(45)).toBe("45m");
  });

  // A null duration must NOT be labelled with a guess.
  test("null/absent duration is unknown, not 5h", () => {
    expect(deriveWindowLabel(null)).toBe("unknown");
    expect(deriveWindowLabel(undefined)).toBe("unknown");
    expect(deriveWindowLabel("300")).toBe("unknown");
    expect(deriveWindowLabel(0)).toBe("unknown");
    expect(deriveWindowLabel(-5)).toBe("unknown");
    expect(deriveWindowLabel(Number.NaN)).toBe("unknown");
  });

  test("the general fallback covers durations with no named label", () => {
    expect(deriveWindowLabel(120)).toBe("2h");
    expect(deriveWindowLabel(4320)).toBe("3d");
    expect(deriveWindowLabel(90)).toBe("90m");
  });
});

describe("normalizeRateLimits", () => {
  // ⛔ THE REGRESSION THIS FILE EXISTS FOR (measured on mini-2 2026-08-22):
  // the `codex` bucket carries a WEEKLY window in `primary` and null `secondary`.
  // A positional primary→fiveHour mapping (the naive Claude twin) mislabels that
  // weekly window as 5h AND reports the 5h window as absent — while a real 5h
  // window exists under a DIFFERENT bucket, codex_bengalfox.
  test("the weekly-only bucket reports weekly, and reports NO 5h window", () => {
    const buckets = normalizeRateLimits(LIVE);
    const codex = buckets.find((b) => b.limitId === "codex");
    expect(codex.windows.map((w) => w.label)).toEqual(["weekly"]);
    expect(codex.windows.find((w) => w.label === "5h")).toBeUndefined();
    expect(codex.windows[0].usedPercent).toBe(10);
    expect(codex.windows[0].resetsAt).toBe(1787802784);
  });

  test("a two-window bucket reports both, labelled by duration", () => {
    const buckets = normalizeRateLimits(LIVE);
    const spark = buckets.find((b) => b.limitId === "codex_bengalfox");
    expect(spark.windows.map((w) => w.label).sort()).toEqual(["5h", "weekly"]);
    expect(spark.limitName).toBe("GPT-5.3-Codex-Spark");
  });

  test("every limitId is represented exactly once", () => {
    const buckets = normalizeRateLimits(LIVE);
    expect(buckets.map((b) => b.limitId).sort()).toEqual(["codex", "codex_bengalfox"]);
  });

  test("a response with only the legacy single bucket still normalizes", () => {
    const buckets = normalizeRateLimits({ rateLimits: LIVE.rateLimits });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].limitId).toBe("codex");
    expect(buckets[0].windows[0].label).toBe("weekly");
  });

  test("rateLimitReachedType and planType survive normalization", () => {
    const buckets = normalizeRateLimits(LIVE);
    expect(buckets.every((b) => b.planType === "pro")).toBe(true);
    expect(buckets.every((b) => b.rateLimitReachedType === null)).toBe(true);
  });

  // A window with no usable numbers is DROPPED, never emitted as a
  // zero-percent placeholder that would read as "plenty of quota left".
  test("a null-percent window is dropped, not emitted as 0%", () => {
    const buckets = normalizeRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: null, windowDurationMins: 300, resetsAt: 1 },
        secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 2 },
      },
    });
    expect(buckets[0].windows.map((w) => w.label)).toEqual(["weekly"]);
  });

  test("a bucket whose windows are all unusable yields an empty windows list, not a fake one", () => {
    const buckets = normalizeRateLimits({
      rateLimits: { limitId: "codex", primary: null, secondary: null },
    });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].windows).toEqual([]);
  });

  test("malformed input yields [] and never throws", () => {
    for (const bad of [null, undefined, {}, { rateLimits: null }, "nope", 7, [], true]) {
      expect(normalizeRateLimits(bad)).toEqual([]);
    }
  });
});

describe("deriveBindingWindow", () => {
  // Codex has no `representativeClaim`; the binding window is the most-consumed one.
  test("selects the highest usedPercent across all buckets", () => {
    const buckets = normalizeRateLimits(LIVE_TWO_BUCKETS_WITH_HIGH_5H);
    const binding = deriveBindingWindow(buckets);
    expect(binding.label).toBe("5h");
    expect(binding.usedPercent).toBe(97);
    expect(binding.limitId).toBe("codex_bengalfox");
  });

  test("no windows → null, not a fabricated zero", () => {
    expect(deriveBindingWindow([])).toBeNull();
    expect(deriveBindingWindow(null)).toBeNull();
    expect(deriveBindingWindow(undefined)).toBeNull();
    expect(deriveBindingWindow([{ limitId: "codex", windows: [] }])).toBeNull();
  });

  test("a genuine all-zero board binds at 0% rather than reporting nothing", () => {
    const binding = deriveBindingWindow(normalizeRateLimits(LIVE));
    expect(binding.usedPercent).toBe(10);
    const allZero = deriveBindingWindow([
      { limitId: "codex", windows: [{ label: "weekly", usedPercent: 0, resetsAt: 1 }] },
    ]);
    expect(allZero.usedPercent).toBe(0);
    expect(allZero.label).toBe("weekly");
  });
});

describe("classifyAccountPlane", () => {
  test("authenticated with limits → ok", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/acct2",
      initialize: { codexHome: "/h/acct2" },
      account: OK_ACCOUNT,
      rateLimits: LIVE,
    });
    expect(v.status).toBe("ok");
    expect(v.email).toBe("a@b.c");
    expect(v.planType).toBe("pro");
    expect(v.accountType).toBe("chatgpt");
    expect(v.reason).toBeNull();
    expect(v.binding.usedPercent).toBe(10);
  });

  // Measured shape from an empty CODEX_HOME.
  test("unauthenticated home → unauthenticated, never ok", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/empty",
      initialize: { codexHome: "/h/empty" },
      account: { account: null, requiresOpenaiAuth: true },
      rateLimitsError: {
        code: -32600,
        message: "codex account authentication required to read rate limits",
      },
    });
    expect(v.status).toBe("unauthenticated");
    expect(v.reason).toMatch(/authentication required/);
  });

  test("an account/read error alone is unauthenticated, not ok", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/empty",
      initialize: { codexHome: "/h/empty" },
      account: { account: null, requiresOpenaiAuth: true },
      rateLimits: LIVE,
    });
    expect(v.status).toBe("unauthenticated");
  });

  // ⛔ The Codex twin of _ca_entry_rejected_reason: the RPC SUCCEEDS on a
  // throttled account, exactly as a Claude 429 still returns headers. A
  // status derived from "did the call work?" would call this account healthy.
  test("rateLimitReachedType non-null → rejected even though the RPC succeeded", () => {
    const throttled = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1 },
        secondary: null,
        rateLimitReachedType: "rate_limit_reached",
      },
    };
    const v = classifyAccountPlane({
      requestedHome: "/h/acct1",
      initialize: { codexHome: "/h/acct1" },
      account: OK_ACCOUNT,
      rateLimits: throttled,
    });
    expect(v.status).toBe("rejected");
    expect(v.reason).toMatch(/rate_limit_reached/);
  });

  test.each([
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
  ])("every RateLimitReachedType member rejects: %s", (kind) => {
    const v = classifyAccountPlane({
      requestedHome: "/h/a",
      initialize: { codexHome: "/h/a" },
      account: OK_ACCOUNT,
      rateLimits: { rateLimits: { limitId: "codex", primary: null, rateLimitReachedType: kind } },
    });
    expect(v.status).toBe("rejected");
    expect(v.reason).toMatch(new RegExp(kind));
  });

  // A rejection hiding in a NON-first bucket must still reject the account.
  test("a rejection in any bucket rejects the account, not just the first", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/a",
      initialize: { codexHome: "/h/a" },
      account: OK_ACCOUNT,
      rateLimits: {
        rateLimitsByLimitId: {
          codex: { limitId: "codex", primary: null, rateLimitReachedType: null },
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            primary: null,
            rateLimitReachedType: "rate_limit_reached",
          },
        },
      },
    });
    expect(v.status).toBe("rejected");
    expect(v.reason).toMatch(/codex_bengalfox/);
  });

  // ⛔ THE POSITIVE CONTROL. If the child resolved a different home than we asked
  // for, every number below it describes the WRONG ACCOUNT. That is an error,
  // never an ok with good-looking data.
  test("home mismatch is a hard error, not a pass", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/acct1",
      initialize: { codexHome: "/h/acct2" },
      account: { account: { type: "chatgpt", email: "other@b.c", planType: "pro" } },
      rateLimits: LIVE,
    });
    expect(v.status).toBe("error");
    expect(v.reason).toMatch(/requested .*acct1.* but the app-server resolved .*acct2/);
  });

  test("an absent initialize echo cannot be treated as a match", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/acct1",
      initialize: {},
      account: OK_ACCOUNT,
      rateLimits: LIVE,
    });
    expect(v.status).toBe("error");
    expect(v.reason).toMatch(/did not report/);
  });

  test("a transport error outranks every other rung", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/acct1",
      initialize: { codexHome: "/h/acct1" },
      account: OK_ACCOUNT,
      rateLimits: LIVE,
      error: "spawn ENOENT: codex not found",
    });
    expect(v.status).toBe("error");
    expect(v.reason).toMatch(/ENOENT/);
  });

  test("an api-key account type is reported, not silently treated as chatgpt", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/a",
      initialize: { codexHome: "/h/a" },
      account: { account: { type: "apiKey" } },
      rateLimits: LIVE,
    });
    expect(v.accountType).toBe("apiKey");
    expect(v.email).toBeNull();
  });

  test("every verdict carries the full shape, so a consumer never reads undefined", () => {
    for (const v of [
      classifyAccountPlane({ requestedHome: "/h/a", error: "boom" }),
      classifyAccountPlane({}),
      classifyAccountPlane({
        requestedHome: "/h/a",
        initialize: { codexHome: "/h/a" },
        account: OK_ACCOUNT,
        rateLimits: LIVE,
      }),
    ]) {
      expect(Object.keys(v).sort()).toEqual(
        ["accountType", "binding", "buckets", "email", "planType", "reason", "status"].sort(),
      );
      expect(Array.isArray(v.buckets)).toBe(true);
    }
  });

  test("an ok verdict always has a non-null reason of null and a status in the enum", () => {
    const v = classifyAccountPlane({
      requestedHome: "/h/a",
      initialize: { codexHome: "/h/a" },
      account: OK_ACCOUNT,
      rateLimits: LIVE,
    });
    expect(Object.values(ACCOUNT_PLANE_STATUS)).toContain(v.status);
  });
});

describe("isRejectedStatus", () => {
  // Phase 4's alarm imports THIS predicate rather than re-deriving the ladder,
  // so the pager and the CLI can never disagree about what "rejected" means.
  test("only the rejected status is rejected", () => {
    expect(isRejectedStatus("rejected")).toBe(true);
    expect(isRejectedStatus("ok")).toBe(false);
    expect(isRejectedStatus("unauthenticated")).toBe(false);
    expect(isRejectedStatus("error")).toBe(false);
    expect(isRejectedStatus(null)).toBe(false);
    expect(isRejectedStatus(undefined)).toBe(false);
  });
});

describe("parseNdjson", () => {
  test("frames complete lines and holds a partial tail back", () => {
    const s = parseNdjson();
    expect(s.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(s.push("2}\n")).toEqual([{ b: 2 }]);
  });

  test("an unparseable line is skipped, not thrown", () => {
    const s = parseNdjson();
    expect(s.push('not json\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  test("a chunk with no newline yields nothing and loses nothing", () => {
    const s = parseNdjson();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}')).toEqual([]);
    expect(s.push("\n")).toEqual([{ a: 1 }]);
  });

  test("several complete lines in one chunk all come back in order", () => {
    const s = parseNdjson();
    expect(s.push('{"a":1}\n{"a":2}\n{"a":3}\n')).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  test("blank lines and CRLF framing are tolerated", () => {
    const s = parseNdjson();
    expect(s.push('{"a":1}\r\n\n{"a":2}\r\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("a Buffer chunk is accepted as well as a string", () => {
    const s = parseNdjson();
    expect(s.push(Buffer.from('{"a":1}\n'))).toEqual([{ a: 1 }]);
  });

  test("a bare JSON scalar line is skipped — only objects are frames", () => {
    const s = parseNdjson();
    expect(s.push('7\n"str"\nnull\n{"a":1}\n')).toEqual([{ a: 1 }]);
  });
});

describe("handleFromHomePath", () => {
  test("extracts acctN from a codex-home-acctN path", () => {
    expect(handleFromHomePath("/Users/r/catalyst/codex-home-acct2")).toBe("acct2");
    expect(handleFromHomePath("/Users/r/catalyst/codex-home-acct10")).toBe("acct10");
  });

  test("a trailing slash does not defeat the match", () => {
    expect(handleFromHomePath("/Users/r/catalyst/codex-home-acct2/")).toBe("acct2");
  });

  test("a non-conforming path yields null, never a guess", () => {
    expect(handleFromHomePath("/Users/r/.codex")).toBeNull();
    expect(handleFromHomePath("/Users/r/catalyst/codex-home")).toBeNull();
    expect(handleFromHomePath("")).toBeNull();
    expect(handleFromHomePath(null)).toBeNull();
    expect(handleFromHomePath(undefined)).toBeNull();
    expect(handleFromHomePath(42)).toBeNull();
    expect(handleFromHomePath("/Users/r/catalyst/codex-home-acctX")).toBeNull();
    expect(handleFromHomePath("/Users/r/catalyst/codex-home-acct")).toBeNull();
  });
});
