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
  defaultLayer2Path,
  buildMintCurlArgs,
  parseMintResponse,
  createReminter,
  createAsyncReminter,
  createOrchestratorActorRearmHook,
  linearReminter,
  withAuthRemint,
} from "./linear-remint.mjs";
import { createLinearBreaker, withBreaker } from "./linear-breaker.mjs";
import { resolveLayer2Path, armSecret, registerRearmHook, resetArmState } from "../lib/secret-contract.mjs";

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

// ── defaultLayer2Path (CTL-1616 PR4 fold) ─────────────────────────────────────
// defaultLayer2Path/readOrchestratorCreds are folded onto the shared secret contract
// (resolveLayer2Path / resolveSecret("linear-orchestrator-actor")) so the Layer-2 chain +
// config-path read are defined ONCE. This asserts the delegation, not a re-implementation.
describe("defaultLayer2Path (CTL-1616 PR4 fold)", () => {
  test("delegates to the shared secret contract's resolveLayer2Path — no second chain", () => {
    expect(defaultLayer2Path()).toBe(resolveLayer2Path());
  });
});

// ── createOrchestratorActorRearmHook (CTL-1616 PR4) ───────────────────────────
// Pure adapter, unit-tested against a FAKE reminter only — never linearReminter (the real
// process-wide singleton), which would attempt a genuine network mint against api.linear.app
// using whatever real Layer-2 credentials the host running this test happens to have.
describe("createOrchestratorActorRearmHook (CTL-1616 PR4)", () => {
  test("adapts a reminter whose attempt() returns true into {rearmed:true}", () => {
    expect(createOrchestratorActorRearmHook({ attempt: () => true })({ env: {} })).toEqual({ rearmed: true });
  });
  test("adapts a reminter whose attempt() returns false into {rearmed:false}", () => {
    expect(createOrchestratorActorRearmHook({ attempt: () => false })({ env: {} })).toEqual({ rearmed: false });
  });
  test("end-to-end against a fully injected createReminter — mint/readCreds/applyToken never touch the real network", () => {
    let mintCalls = 0;
    const fakeReminter = createReminter({
      readCreds: () => ({ clientId: "c", clientSecret: "s" }),
      mint: () => {
        mintCalls += 1;
        return "tok";
      },
      applyToken: () => {},
      logger: silentLogger,
    });
    expect(createOrchestratorActorRearmHook(fakeReminter)({ env: {} })).toEqual({ rearmed: true });
    expect(mintCalls).toBe(1);
  });
});

// ── linear-orchestrator-actor rearm-hook wiring (CTL-1616 PR4) ────────────────
// Exercises the ACTUAL registerRearmHook/armSecret seam this row is wired through in
// production (design §8/§9: "the cooldown reminters register as the row's on-401 rearm
// hook") — with an INJECTED fake reminter, never the real linearReminter singleton.
describe("linear-orchestrator-actor rearm-hook wiring (CTL-1616 PR4)", () => {
  afterEach(() => {
    // Restore production wiring exactly as the module registers it at import time, so this
    // describe block leaves no cross-test contamination for anything that runs after it in
    // the same process.
    registerRearmHook("linear-orchestrator-actor", createOrchestratorActorRearmHook(linearReminter));
    resetArmState("linear-orchestrator-actor");
  });

  test("armSecret routes through the registered hook (armed path), not the hookless-degrade path", () => {
    let attempts = 0;
    const fakeReminter = { attempt: () => { attempts += 1; return true; } };
    registerRearmHook("linear-orchestrator-actor", createOrchestratorActorRearmHook(fakeReminter));
    expect(armSecret("linear-orchestrator-actor", { env: {} })).toEqual({ armed: true, rotated: true, restartRequired: false });
    expect(attempts).toBe(1);
  });

  test("a false attempt() (cooldown active / no creds / mint failed) reports no rotation", () => {
    registerRearmHook("linear-orchestrator-actor", createOrchestratorActorRearmHook({ attempt: () => false }));
    expect(armSecret("linear-orchestrator-actor", { env: {} })).toEqual({ armed: false, rotated: false, restartRequired: false });
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

  // CTL-1339: the opt-in per-call wall-clock cap rides a 3rd `opts` arg that the
  // wrapper must forward to the wrapped exec on BOTH attempts.
  test("forwards the 3rd opts arg to the wrapped exec on a clean (single) call", () => {
    const reminter = makeReminter();
    const calls = [];
    const raw = (...all) => { calls.push(all); return { code: 0, stdout: "ok", stderr: "" }; };
    const exec = withAuthRemint(raw, { reminter, now: () => 0 });
    exec("linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 }]);
  });

  test("forwards the 3rd opts arg on BOTH the initial call AND the post-remint retry", () => {
    const reminter = makeReminter(true); // mint succeeds → retry happens
    let callN = 0;
    const calls = [];
    const raw = (...all) => {
      callN++;
      calls.push(all);
      return callN === 1
        ? { code: 1, stdout: "", stderr: "Unauthorized" } // initial: auth error
        : { code: 0, stdout: "retry-ok", stderr: "" }; // retry: success
    };
    const exec = withAuthRemint(raw, { reminter, now: () => 0 });
    const r = exec("linearis", ["issues", "read", "CTL-1"], { timeoutMs: 8000 });
    expect(r.stdout).toBe("retry-ok");
    expect(callN).toBe(2);
    // the opts must reach BOTH spawns — the timeout applies on the retry too.
    expect(calls[0][2]).toEqual({ timeoutMs: 8000 });
    expect(calls[1][2]).toEqual({ timeoutMs: 8000 });
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

// ── createAsyncReminter (CTL-1577) ───────────────────────────────────────────
describe("createAsyncReminter", () => {
  test("mints, applies, and honors the cooldown across overlapping attempts", async () => {
    let mints = 0;
    let applied = null;
    const r = createAsyncReminter({
      readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
      mint: async () => {
        mints++;
        return "tok-async";
      },
      applyToken: (t) => {
        applied = t;
      },
      cooldownMs: 60_000,
      logger: silentLogger,
    });
    expect(await r.attempt(1_000)).toBe(true);
    expect(applied).toBe("tok-async");
    // Within the cooldown window: no second mint, even after a success.
    expect(await r.attempt(30_000)).toBe(false);
    expect(mints).toBe(1);
    // Past the window: mints again.
    expect(await r.attempt(70_000)).toBe(true);
    expect(mints).toBe(2);
  });

  test("failed mint is fail-open (false, token untouched) and still cooled down", async () => {
    let applied = false;
    const r = createAsyncReminter({
      readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
      mint: async () => null,
      applyToken: () => {
        applied = true;
      },
      cooldownMs: 60_000,
      logger: silentLogger,
    });
    expect(await r.attempt(1_000)).toBe(false);
    expect(applied).toBe(false);
    expect(await r.attempt(2_000)).toBe(false); // cooled down — no storm on revoked creds
  });

  test("no creds configured is a permanent no-op", async () => {
    const r = createAsyncReminter({
      readCreds: () => null,
      mint: async () => "tok",
      logger: silentLogger,
    });
    expect(await r.attempt(1_000)).toBe(false);
  });

  // CTL-1612 round 2: failureCooldownMs defaults to cooldownMs, so an existing
  // caller (linearAsyncReminter below) that omits it sees NO behavior change —
  // asserted by the two tests above already passing unmodified.
  describe("failureCooldownMs (CTL-1612 round 2)", () => {
    test("a FAILED mint retries after the short failureCooldownMs, not the long cooldownMs", async () => {
      let mints = 0;
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => (mints++ === 0 ? null : "tok-after-retry"),
        applyToken: () => {},
        cooldownMs: 60_000,
        failureCooldownMs: 5_000,
        logger: silentLogger,
      });
      expect(await r.attempt(0)).toBe(false); // fails, mints=1
      expect(mints).toBe(1);
      // Still within failureCooldownMs (5s) — no retry yet.
      expect(await r.attempt(3_000)).toBe(false);
      expect(mints).toBe(1);
      // Past failureCooldownMs but well short of the full 60s cooldownMs.
      expect(await r.attempt(6_000)).toBe(true);
      expect(mints).toBe(2);
    });

    test("a SUCCESSFUL mint still waits the full cooldownMs, not failureCooldownMs", async () => {
      let mints = 0;
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => {
          mints++;
          return "tok";
        },
        applyToken: () => {},
        cooldownMs: 60_000,
        failureCooldownMs: 5_000,
        logger: silentLogger,
      });
      expect(await r.attempt(0)).toBe(true); // succeeds, mints=1
      // Past failureCooldownMs (5s) but still within the long cooldownMs (60s) —
      // a success must NOT fast-track the next attempt via failureCooldownMs.
      expect(await r.attempt(10_000)).toBe(false);
      expect(mints).toBe(1);
      expect(await r.attempt(61_000)).toBe(true);
      expect(mints).toBe(2);
    });

    test("omitting failureCooldownMs defaults it to cooldownMs (byte-identical to pre-CTL-1612 behavior)", async () => {
      let mints = 0;
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => {
          mints++;
          return null;
        },
        cooldownMs: 60_000,
        logger: silentLogger,
      });
      expect(await r.attempt(0)).toBe(false);
      expect(mints).toBe(1);
      // No failureCooldownMs override → still gated by the full 60s cooldown,
      // exactly as before this parameter existed.
      expect(await r.attempt(10_000)).toBe(false);
      expect(mints).toBe(1);
    });
  });

  // CTL-1612 round 3 (Codex P2 follow-up): the cooldown gate is TIME-only —
  // deferred-promise mints prove the IN-FLIGHT LATCH is doing independent
  // work, not just the timing gate (each test below calls attempt() a second
  // time with a `now` far past any cooldown window, which the time gate ALONE
  // would happily let through).
  describe("in-flight latch (CTL-1612 round 3)", () => {
    test("a second attempt returns false while the first is still pending, even past the cooldown window", async () => {
      let mints = 0;
      let resolveMint;
      const pending = new Promise((res) => {
        resolveMint = res;
      });
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => {
          mints++;
          return pending; // stays unresolved until resolveMint() is called
        },
        applyToken: () => {},
        cooldownMs: 60_000,
        logger: silentLogger,
      });

      const firstAttempt = r.attempt(0); // synchronously reaches the await and latches inFlight
      // `now` here is WAY past cooldownMs (60s) from lastAttempt(0) — the pure
      // time gate would pass this. Only the in-flight latch can still block it.
      expect(await r.attempt(999_999)).toBe(false);
      expect(mints).toBe(1); // the second call never invoked mint at all

      resolveMint("tok-first");
      expect(await firstAttempt).toBe(true);
    });

    test("a later attempt succeeds once the first has resolved", async () => {
      let mints = 0;
      let resolveMint;
      const pending = new Promise((res) => {
        resolveMint = res;
      });
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => {
          mints++;
          return pending;
        },
        applyToken: () => {},
        cooldownMs: 60_000,
        logger: silentLogger,
      });

      const firstAttempt = r.attempt(0);
      resolveMint("tok-first");
      expect(await firstAttempt).toBe(true);
      expect(mints).toBe(1);

      // Past cooldownMs AND the first attempt has fully resolved (inFlight
      // cleared in the finally) — this one must proceed and mint again.
      expect(await r.attempt(61_000)).toBe(true);
      expect(mints).toBe(2);
    });
  });

  // CTL-1612 round 5 (Codex P2 follow-up): initialLastAttempt lets a caller
  // that already has a fresh token in hand at construction (the monitor's
  // shell startup mint) seed the cooldown gate so the FIRST attempt() call
  // doesn't immediately re-mint.
  describe("initialLastAttempt (CTL-1612 round 5)", () => {
    test("omitting it defaults to -Infinity — first attempt() always fires (unchanged pre-existing behavior)", async () => {
      let mints = 0;
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => {
          mints++;
          return "tok";
        },
        applyToken: () => {},
        cooldownMs: 60_000,
        logger: silentLogger,
      });
      // now=0 would fail a real cooldown gate if lastAttempt were seeded to
      // anything greater than -Infinity — proves the default is untouched.
      expect(await r.attempt(0)).toBe(true);
      expect(mints).toBe(1);
    });

    test("seeding it to a recent timestamp blocks the first attempt() until cooldownMs has elapsed from that seed", async () => {
      let mints = 0;
      const seedNow = 1_000_000;
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => {
          mints++;
          return "tok";
        },
        applyToken: () => {},
        cooldownMs: 60_000,
        logger: silentLogger,
        initialLastAttempt: seedNow,
      });
      // Just past the seed, still well within cooldownMs — blocked.
      expect(await r.attempt(seedNow + 5_000)).toBe(false);
      expect(mints).toBe(0);
      // Past cooldownMs from the SEED (not from -Infinity) — proceeds.
      expect(await r.attempt(seedNow + 61_000)).toBe(true);
      expect(mints).toBe(1);
    });

    test("applyToken is never called by seeding alone — a seed with no real mint yet still requires an actual successful attempt() before any token is applied", async () => {
      let applied = null;
      const r = createAsyncReminter({
        readCreds: () => ({ clientId: "id", clientSecret: "sec" }),
        mint: async () => "tok",
        applyToken: (t) => {
          applied = t;
        },
        cooldownMs: 60_000,
        logger: silentLogger,
        initialLastAttempt: Date.now(),
      });
      expect(applied).toBeNull();
    });
  });
});
