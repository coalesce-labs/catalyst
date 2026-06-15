// linear-remint.test.mjs — CTL-785: in-process token re-mint on mid-run 401.
// Run: cd plugins/dev/scripts/execution-core && bun test linear-remint.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAuthError,
  isBatchAuthError,
  readOrchestratorCreds,
  buildMintCurlArgs,
  parseMintResponse,
  createReminter,
  withAuthRemint,
} from "./linear-remint.mjs";
import { createLinearBreaker, withBreaker } from "./linear-breaker.mjs";

const silentLogger = { warn() {}, info() {}, error() {} };

// ── isAuthError ───────────────────────────────────────────────────────────────

describe("isAuthError", () => {
  test("matches 'Authentication required'", () =>
    expect(isAuthError("Authentication required, not authenticated")).toBe(true));
  test("matches AUTHENTICATION_ERROR code text", () =>
    expect(isAuthError("error: AUTHENTICATION_ERROR")).toBe(true));
  test("matches HTTP 401", () =>
    expect(isAuthError("HTTP 401")).toBe(true));
  test("matches 401 standalone", () =>
    expect(isAuthError("401")).toBe(true));
  test("matches Unauthorized", () =>
    expect(isAuthError("Unauthorized")).toBe(true));
  test("does NOT match rate-limit errors", () =>
    expect(isAuthError("Rate limit exceeded")).toBe(false));
  test("does NOT match generic errors", () =>
    expect(isAuthError("network timeout")).toBe(false));
  test("does NOT match empty string", () =>
    expect(isAuthError("")).toBe(false));
  test("does NOT match null", () =>
    expect(isAuthError(null)).toBe(false));
  test("does NOT match undefined", () =>
    expect(isAuthError(undefined)).toBe(false));
  // CTL-1078: OAuth scope-rejection shapes
  test("matches '400 invalid_scope'", () =>
    expect(isAuthError("error: 400 invalid_scope")).toBe(true));
  test("matches 'invalid_scope' standalone", () =>
    expect(isAuthError("invalid_scope")).toBe(true));
  test("matches 'forbidden'", () =>
    expect(isAuthError("forbidden")).toBe(true));
  test("matches 'HTTP 403'", () =>
    expect(isAuthError("HTTP 403")).toBe(true));
  test("matches 'insufficient_scope'", () =>
    expect(isAuthError("insufficient_scope")).toBe(true));
  test("does NOT match '429 Rate limit' (must not overlap isRateLimitError)", () =>
    expect(isAuthError("429 Rate limit exceeded")).toBe(false));
});

// ── isBatchAuthError ──────────────────────────────────────────────────────────

describe("isBatchAuthError", () => {
  test("true on extensions.code AUTHENTICATION_ERROR", () =>
    expect(isBatchAuthError([{ extensions: { code: "AUTHENTICATION_ERROR" } }])).toBe(true));
  test("true on auth message", () =>
    expect(isBatchAuthError([{ message: "Authentication required" }])).toBe(true));
  test("false on RATELIMITED", () =>
    expect(isBatchAuthError([{ extensions: { code: "RATELIMITED" } }])).toBe(false));
  test("false on empty array", () =>
    expect(isBatchAuthError([])).toBe(false));
  test("false on undefined", () =>
    expect(isBatchAuthError(undefined)).toBe(false));
});

// ── readOrchestratorCreds ─────────────────────────────────────────────────────

describe("readOrchestratorCreds", () => {
  let scratch;
  beforeEach(() => {
    scratch = join(tmpdir(), `remint-test-${Math.floor(Math.random() * 1e9)}`);
    mkdirSync(scratch, { recursive: true });
  });
  afterEach(() => {
    try { unlinkSync(join(scratch, "config.json")); } catch { /* ok */ }
  });

  function writeCfg(obj) {
    writeFileSync(join(scratch, "config.json"), JSON.stringify(obj));
    return join(scratch, "config.json");
  }

  test("reads clientId+clientSecret from the correct path", () => {
    const p = writeCfg({
      catalyst: { linear: { bot: { orchestrator: {
        clientId: "my-client-id",
        clientSecret: "my-secret",
      } } } },
    });
    expect(readOrchestratorCreds(p)).toEqual({ clientId: "my-client-id", clientSecret: "my-secret" });
  });

  test("null when file missing", () => {
    expect(readOrchestratorCreds(join(scratch, "nonexistent.json"))).toBeNull();
  });

  test("null when JSON is malformed", () => {
    writeFileSync(join(scratch, "config.json"), "not-json");
    expect(readOrchestratorCreds(join(scratch, "config.json"))).toBeNull();
  });

  test("null when clientId is absent", () => {
    const p = writeCfg({ catalyst: { linear: { bot: { orchestrator: { clientSecret: "s" } } } } });
    expect(readOrchestratorCreds(p)).toBeNull();
  });

  test("null when clientSecret is absent", () => {
    const p = writeCfg({ catalyst: { linear: { bot: { orchestrator: { clientId: "c" } } } } });
    expect(readOrchestratorCreds(p)).toBeNull();
  });

  test("null when clientId is empty string", () => {
    const p = writeCfg({ catalyst: { linear: { bot: { orchestrator: { clientId: "", clientSecret: "s" } } } } });
    expect(readOrchestratorCreds(p)).toBeNull();
  });

  test("null when clientSecret is empty string", () => {
    const p = writeCfg({ catalyst: { linear: { bot: { orchestrator: { clientId: "c", clientSecret: "" } } } } });
    expect(readOrchestratorCreds(p)).toBeNull();
  });

  test("null when orchestrator key is entirely absent", () => {
    const p = writeCfg({ catalyst: { linear: { bot: {} } } });
    expect(readOrchestratorCreds(p)).toBeNull();
  });
});

// ── buildMintCurlArgs ─────────────────────────────────────────────────────────

describe("buildMintCurlArgs", () => {
  test("uses --noproxy '*' and POSTs to the oauth token endpoint", () => {
    const { args } = buildMintCurlArgs({ clientId: "c", clientSecret: "s" });
    expect(args).toContain("--noproxy");
    expect(args[args.indexOf("--noproxy") + 1]).toBe("*");
    expect(args).toContain("-X");
    expect(args[args.indexOf("-X") + 1]).toBe("POST");
    expect(args).toContain("https://api.linear.app/oauth/token");
  });

  test("reads payload from stdin (--data @-), secret NOT in argv", () => {
    const { args, payload } = buildMintCurlArgs({ clientId: "cid", clientSecret: "verysecret" });
    expect(args).toContain("--data");
    expect(args[args.indexOf("--data") + 1]).toBe("@-");
    // secret must not appear in argv
    expect(args.join(" ")).not.toContain("verysecret");
    // but does appear in payload (sent via stdin)
    expect(payload).toContain("verysecret");
  });

  test("payload includes client_credentials grant and correct scope", () => {
    const { payload } = buildMintCurlArgs({ clientId: "c", clientSecret: "s" });
    expect(payload).toContain("grant_type=client_credentials");
    expect(payload).toContain("read%2Cwrite%2Ccomments%3Acreate%2Capp%3Aassignable%2Capp%3Amentionable");
  });

  test("payload includes the widened app-actor scope (CTL-1173)", () => {
    const { payload } = buildMintCurlArgs({ clientId: "c", clientSecret: "s" });
    expect(payload).toContain("read%2Cwrite%2Ccomments%3Acreate%2Capp%3Aassignable%2Capp%3Amentionable");
  });

  test("payload sets actor=app so the token is minted as an app-actor (CTL-1173)", () => {
    const { payload } = buildMintCurlArgs({ clientId: "c", clientSecret: "s" });
    expect(payload).toContain("actor=app");
  });

  test("sets --max-time", () => {
    const { args } = buildMintCurlArgs({ clientId: "c", clientSecret: "s" });
    expect(args).toContain("--max-time");
  });
});

// ── parseMintResponse ─────────────────────────────────────────────────────────

describe("parseMintResponse", () => {
  test("returns access_token on success", () =>
    expect(parseMintResponse({ code: 0, stdout: JSON.stringify({ access_token: "tok123" }) })).toBe("tok123"));
  test("null on non-zero exit code", () =>
    expect(parseMintResponse({ code: 1, stdout: JSON.stringify({ access_token: "tok" }) })).toBeNull());
  test("null on unparseable body", () =>
    expect(parseMintResponse({ code: 0, stdout: "not-json" })).toBeNull());
  test("null when access_token missing from body", () =>
    expect(parseMintResponse({ code: 0, stdout: JSON.stringify({ error: "invalid_client" }) })).toBeNull());
  test("null on empty body", () =>
    expect(parseMintResponse({ code: 0, stdout: "" })).toBeNull());
});

// ── createReminter ────────────────────────────────────────────────────────────

describe("createReminter", () => {
  test("attempt() with no creds → false, mint never called", () => {
    const mintCalls = [];
    const r = createReminter({
      logger: silentLogger,
      readCreds: () => null,
      mint: (c) => { mintCalls.push(c); return "tok"; },
    });
    expect(r.attempt(0)).toBe(false);
    expect(mintCalls).toHaveLength(0);
  });

  test("attempt() mints, calls applyToken, returns true", () => {
    const applied = [];
    const r = createReminter({
      logger: silentLogger,
      readCreds: () => ({ clientId: "c", clientSecret: "s" }),
      mint: () => "fresh-token",
      applyToken: (t) => applied.push(t),
    });
    expect(r.attempt(0)).toBe(true);
    expect(applied).toEqual(["fresh-token"]);
  });

  test("cooldown: second attempt within cooldownMs → false, mint called ONCE", () => {
    let mintCount = 0;
    const r = createReminter({
      logger: silentLogger,
      cooldownMs: 60_000,
      readCreds: () => ({ clientId: "c", clientSecret: "s" }),
      mint: () => { mintCount++; return "tok"; },
      applyToken: () => {},
    });
    r.attempt(0);
    expect(r.attempt(59_999)).toBe(false);
    expect(mintCount).toBe(1);
  });

  test("cooldown applies even to failed mints (storm guard)", () => {
    let mintCount = 0;
    const r = createReminter({
      logger: silentLogger,
      cooldownMs: 60_000,
      readCreds: () => ({ clientId: "c", clientSecret: "s" }),
      mint: () => { mintCount++; return null; }, // mint fails
      applyToken: () => {},
    });
    r.attempt(0); // fails (null token), but lastAttempt set
    expect(r.attempt(59_999)).toBe(false); // still in cooldown
    expect(mintCount).toBe(1);
  });

  test("after cooldown elapses, attempt() mints again", () => {
    let mintCount = 0;
    const r = createReminter({
      logger: silentLogger,
      cooldownMs: 60_000,
      readCreds: () => ({ clientId: "c", clientSecret: "s" }),
      mint: () => { mintCount++; return "tok"; },
      applyToken: () => {},
    });
    r.attempt(0);
    r.attempt(60_000); // exactly at cooldown boundary → allowed
    expect(mintCount).toBe(2);
  });

  test("default applyToken sets process.env.LINEAR_API_TOKEN and LINEAR_API_KEY", () => {
    const saved = { key: process.env.LINEAR_API_TOKEN, key2: process.env.LINEAR_API_KEY };
    try {
      delete process.env.LINEAR_API_TOKEN;
      delete process.env.LINEAR_API_KEY;
      const r = createReminter({
        logger: silentLogger,
        cooldownMs: 0,
        readCreds: () => ({ clientId: "c", clientSecret: "s" }),
        mint: () => "new-tok",
        // use default applyToken by not passing it
      });
      r.attempt(0);
      expect(process.env.LINEAR_API_TOKEN).toBe("new-tok");
      expect(process.env.LINEAR_API_KEY).toBe("new-tok");
    } finally {
      if (saved.key !== undefined) process.env.LINEAR_API_TOKEN = saved.key;
      else delete process.env.LINEAR_API_TOKEN;
      if (saved.key2 !== undefined) process.env.LINEAR_API_KEY = saved.key2;
      else delete process.env.LINEAR_API_KEY;
    }
  });

  test("mint returns null → attempt returns false", () => {
    const r = createReminter({
      logger: silentLogger,
      readCreds: () => ({ clientId: "c", clientSecret: "s" }),
      mint: () => null,
      applyToken: () => {},
    });
    expect(r.attempt(0)).toBe(false);
  });
});

// ── withAuthRemint ────────────────────────────────────────────────────────────

describe("withAuthRemint", () => {
  function makeReminter(willSucceed = true) {
    let attempts = 0;
    return {
      attempt() { attempts++; return willSucceed; },
      get attempts() { return attempts; },
    };
  }

  test("clean call passes through untouched, reminter not consulted", () => {
    const reminter = makeReminter();
    const calls = [];
    const raw = (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: "ok", stderr: "" }; };
    const exec = withAuthRemint(raw, { reminter, now: () => 0 });
    const r = exec("linearis", ["issues", "list"]);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(reminter.attempts).toBe(0);
  });

  test("non-auth failure passes through without remint", () => {
    const reminter = makeReminter();
    const calls = [];
    const raw = () => { calls.push(1); return { code: 1, stdout: "", stderr: "Rate limit exceeded" }; };
    const exec = withAuthRemint(raw, { reminter, now: () => 0 });
    const r = exec("linearis", ["x"]);
    expect(r.code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(reminter.attempts).toBe(0);
  });

  test("auth failure → reminter.attempt() true → raw exec retried ONCE, retry result returned", () => {
    const reminter = makeReminter(true); // mint succeeds
    let callN = 0;
    const raw = () => {
      callN++;
      // first call: auth error; retry: success
      return callN === 1
        ? { code: 1, stdout: "", stderr: "Unauthorized" }
        : { code: 0, stdout: "retry-ok", stderr: "" };
    };
    const exec = withAuthRemint(raw, { reminter, now: () => 0 });
    const r = exec("linearis", ["x"]);
    expect(r.stdout).toBe("retry-ok");
    expect(callN).toBe(2); // spawned twice
    expect(reminter.attempts).toBe(1);
  });

  test("auth failure → attempt() false (no creds/cooldown) → original result returned, single spawn", () => {
    const reminter = makeReminter(false); // mint fails / in cooldown
    let callN = 0;
    const raw = () => { callN++; return { code: 1, stdout: "", stderr: "AUTHENTICATION_ERROR" }; };
    const exec = withAuthRemint(raw, { reminter, now: () => 0 });
    const r = exec("linearis", ["x"]);
    expect(r.code).toBe(1);
    expect(callN).toBe(1); // NOT retried
    expect(reminter.attempts).toBe(1); // attempt WAS consulted
  });

  test("retry also failing returns the retry result without a third spawn", () => {
    const reminter = makeReminter(true);
    let callN = 0;
    const raw = () => {
      callN++;
      // both calls return auth error
      return { code: 1, stdout: "", stderr: "Unauthorized" };
    };
    const exec = withAuthRemint(raw, { reminter, now: () => 0 });
    const r = exec("linearis", ["x"]);
    expect(r.code).toBe(1);
    expect(callN).toBe(2); // original + one retry only
  });
});

// ── breaker + remint composition ──────────────────────────────────────────────

describe("breaker + remint composition", () => {
  test("withBreaker(withAuthRemint(raw)): open breaker short-circuits — raw NEVER spawned, reminter NOT consulted", () => {
    const breaker = createLinearBreaker({ logger: silentLogger, baseCooldownMs: 1000 });
    let spawnCount = 0;
    const reminter = { attempt() { throw new Error("reminter should not be called"); } };
    const raw = () => { spawnCount++; return { code: 0, stdout: "", stderr: "" }; };
    // open the breaker
    breaker.recordRateLimited(0);
    const exec = withBreaker(withAuthRemint(raw, { reminter }), { breaker, now: () => 500 });
    const r = exec("linearis", ["x"]);
    expect(r.stderr).toBe("circuit-open");
    expect(spawnCount).toBe(0);
  });

  test("auth-fail → remint → retry-success: breaker records success", () => {
    const breaker = createLinearBreaker({ logger: silentLogger });
    let callN = 0;
    const applied = [];
    const reminter = createReminter({
      logger: silentLogger,
      readCreds: () => ({ clientId: "c", clientSecret: "s" }),
      mint: () => "new-tok",
      applyToken: (t) => applied.push(t),
      cooldownMs: 0,
    });
    const raw = () => {
      callN++;
      return callN === 1
        ? { code: 1, stdout: "", stderr: "Unauthorized" }
        : { code: 0, stdout: "ok", stderr: "" };
    };
    let clock = 0;
    const exec = withBreaker(withAuthRemint(raw, { reminter, now: () => clock }), {
      breaker,
      now: () => clock,
    });
    const r = exec("linearis", ["x"]);
    expect(r.code).toBe(0);
    expect(callN).toBe(2);
    expect(applied).toEqual(["new-tok"]);
    expect(breaker.isOpen(0)).toBe(false); // success closed the path
  });
});
