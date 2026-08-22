// claude-accounts-rearm.test.mjs — CTL-1984. FULLY OFFLINE: every test injects
// an explicit `env` object and a `readFile` stub, so no test ever reads the real
// claude-accounts.env file, spawns a subprocess, or touches the network.
//
// Run: cd plugins/dev/scripts/execution-core && bun test claude-accounts-rearm.test.mjs

import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  rearmClaudeAccountsFromFile,
  parseActiveOauthToken,
  parseActiveOauthTokenDetailed,
  rearmEventEnvelope,
  makeRearmSignalHandler,
  wireRearmSighup,
} from "./claude-accounts-rearm.mjs";
import {
  registerRearmHook,
  clearRearmHook,
  armSecret,
  resetArmState,
} from "../lib/secret-contract.mjs";

// Fake token literals — no real credentials appear in this file.
const TOKEN_A = "sk-ant-oat01-FAKE-STALE-TOKEN-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "sk-ant-oat01-FAKE-ROTATED-TOKEN-BBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_C = "sk-ant-oat01-FAKE-THIRD-TOKEN-CCCCCCCCCCCCCCCCCCCCCCCCCC";

// Default file path the hook uses when CLAUDE_ACCOUNTS_ENV is unset.
const DEFAULT_PATH = `${process.env.HOME}/.config/catalyst/claude-accounts.env`;

// silentLog — a no-op logger for tests that don't assert on log output.
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// rearmWith — the test harness. Builds a readFile stub from a path→content map and
// calls rearmClaudeAccountsFromFile with the injected env and a no-op log.
//
// CTL-2147: also injects a no-op `emit` and a fixed `host` by default. Without this,
// every one of the tests below (none of which care about the event envelope) would
// fall through to rearmClaudeAccountsFromFile's real default `emit` — appending to
// THIS machine's actual ~/catalyst/events/YYYY-MM.jsonl on every test run, which
// breaks the file's own "FULLY OFFLINE" guarantee (top-of-file comment). Tests that
// DO care about emission (below) override `emit` explicitly.
function rearmWith({ files = {}, env = {}, emit = () => true, host = "test-host" } = {}) {
  return rearmClaudeAccountsFromFile({
    env,
    readFile: (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        const v = files[p];
        if (v instanceof Error) throw v;
        return v;
      }
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      throw err;
    },
    log: null, // silence hook logs in test output
    emit,
    host,
  });
}

// ── parseActiveOauthToken unit tests ──────────────────────────────────────────

describe("parseActiveOauthToken", () => {
  test("selector line drives selection — active slot is acct2", () => {
    const text = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'  # a@example.com`,
      `CLAUDE_TOKEN_acct2='${TOKEN_B}'  # b@example.com`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct2"`,
      `export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"`,
    ].join("\n");
    expect(parseActiveOauthToken(text)).toBe(TOKEN_B);
  });

  test("flipping selector to acct1 returns acct1 token", () => {
    const text = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `CLAUDE_TOKEN_acct2='${TOKEN_B}'`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct1"`,
    ].join("\n");
    expect(parseActiveOauthToken(text)).toBe(TOKEN_A);
  });

  test("selector with curly-brace expansion: ${CLAUDE_TOKEN_acct2}", () => {
    const text = [
      `CLAUDE_TOKEN_acct2='${TOKEN_B}'`,
      `_catalyst_active_token="$\{CLAUDE_TOKEN_acct2}"`,
    ].join("\n");
    expect(parseActiveOauthToken(text)).toBe(TOKEN_B);
  });

  test("direct literal assignment fallback (no selector line)", () => {
    const text = `export CLAUDE_CODE_OAUTH_TOKEN='${TOKEN_C}'`;
    expect(parseActiveOauthToken(text)).toBe(TOKEN_C);
  });

  test("direct assignment with $VAR expansion is NOT honored (selector wins here)", () => {
    // A line like `CLAUDE_CODE_OAUTH_TOKEN=$_catalyst_active_token` is a shell expansion —
    // our static parser must not follow it; return null so env is never mutated from guesswork.
    const text = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct1"`,
      `export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"`,
    ].join("\n");
    // Selector line should win here — Path 1 resolves before Path 2 is reached.
    expect(parseActiveOauthToken(text)).toBe(TOKEN_A);
  });

  test("CTL-1984 review regression: canonical format with UNPROVISIONED active slot returns null (never the quoted $-reference)", () => {
    // The canonical launcher file always carries the direct line
    // `export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"`. When the selected
    // slot is a placeholder (not yet provisioned), Path 1 misses and Path 2 is reached.
    // The quoted RHS strips to the literal "$_catalyst_active_token" — a variable NAME.
    // The parser MUST reject it (return null), never install a broken credential.
    // Two real slots present (acct3 is the placeholder active slot) so the single-account
    // Path-3 fallback (size===1) does not fire — this isolates the Path-2 guard.
    const text = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `CLAUDE_TOKEN_acct2='${TOKEN_B}'`,
      `CLAUDE_TOKEN_acct3='PASTE_TOKEN_HERE'`, // active slot not yet provisioned
      `_catalyst_active_token="$CLAUDE_TOKEN_acct3"`,
      `export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"`,
    ].join("\n");
    expect(parseActiveOauthToken(text)).toBeNull();
  });

  test("CTL-1984 review regression: quoted direct $-reference with no selector returns null", () => {
    // No selector line at all; the only CLAUDE_CODE_OAUTH_TOKEN line is a quoted
    // shell reference. Path 2 must not strip the quotes and return "$SOMEVAR".
    const text = `export CLAUDE_CODE_OAUTH_TOKEN="$SOMEVAR"`;
    expect(parseActiveOauthToken(text)).toBeNull();
  });

  test("CTL-1984 review regression: token collection rejects a $-reference value (Path 1)", () => {
    // A CLAUDE_TOKEN_* whose value is itself a quoted shell reference must not be
    // captured into the token map as the literal "$SOMEVAR", or the selector would
    // hand back a variable NAME as the credential.
    const text = [
      `CLAUDE_TOKEN_acct1="$SOMEVAR"`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct1"`,
    ].join("\n");
    expect(parseActiveOauthToken(text)).toBeNull();
  });

  test("single CLAUDE_TOKEN_* with no selector — implicit single-account file", () => {
    const text = `CLAUDE_TOKEN_only='${TOKEN_A}'`;
    expect(parseActiveOauthToken(text)).toBe(TOKEN_A);
  });

  test("PLACEHOLDER value is ignored", () => {
    const text = `CLAUDE_TOKEN_acct1='PASTE_TOKEN_HERE'`;
    expect(parseActiveOauthToken(text)).toBeNull();
  });

  test("blank/empty file returns null", () => {
    expect(parseActiveOauthToken("")).toBeNull();
    expect(parseActiveOauthToken("  \n  ")).toBeNull();
  });

  test("comments are skipped", () => {
    const text = [
      "# CLAUDE_TOKEN_ignored='should-not-appear'",
      `CLAUDE_TOKEN_real='${TOKEN_B}'`,
    ].join("\n");
    expect(parseActiveOauthToken(text)).toBe(TOKEN_B);
  });
});

describe("parseActiveOauthTokenDetailed (CTL-2147)", () => {
  test("returns the selector's handle alongside the token", () => {
    const text = [
      "CLAUDE_TOKEN_acct1='tok-one'",
      "CLAUDE_TOKEN_acct2='tok-two'",
      '_catalyst_active_token="$CLAUDE_TOKEN_acct2"',
    ].join("\n");
    expect(parseActiveOauthTokenDetailed(text)).toEqual({ token: "tok-two", handle: "acct2" });
  });

  test("returns handle:null for the direct-literal path (no selector to name)", () => {
    const text = "export CLAUDE_CODE_OAUTH_TOKEN='tok-direct'";
    expect(parseActiveOauthTokenDetailed(text)).toEqual({ token: "tok-direct", handle: null });
  });

  test("returns handle for the implicit single-account file", () => {
    expect(parseActiveOauthTokenDetailed("CLAUDE_TOKEN_acct7='solo'"))
      .toEqual({ token: "solo", handle: "acct7" });
  });

  test("returns {token:null,handle:null} on a placeholder-only file", () => {
    expect(parseActiveOauthTokenDetailed("CLAUDE_TOKEN_acct1='PASTE_TOKEN_HERE'"))
      .toEqual({ token: null, handle: null });
  });

  // Back-compat: the existing exported shape must not change for existing callers.
  test("parseActiveOauthToken still returns the bare token string", () => {
    expect(parseActiveOauthToken('CLAUDE_TOKEN_acct2=\'t2\'\n_catalyst_active_token="$CLAUDE_TOKEN_acct2"'))
      .toBe("t2");
  });
});

// ── rearmClaudeAccountsFromFile integration tests ────────────────────────────

describe("rearmClaudeAccountsFromFile", () => {
  test("rotated: active-slot token changed → returns rearmed:true and mutates env", () => {
    const fileContent = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `CLAUDE_TOKEN_acct2='${TOKEN_B}'`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct2"`,
    ].join("\n");
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    const result = rearmWith({ files: { [DEFAULT_PATH]: fileContent }, env });
    expect(result).toEqual({ rearmed: true, reason: "rotated", handle: "acct2" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_B);
    expect(env.CATALYST_CLAUDE_ACCOUNTS_SOURCE).toBe("shared-file-resynced");
  });

  test("unchanged: active-slot token equals current env → rearmed:false, env untouched", () => {
    const fileContent = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct1"`,
    ].join("\n");
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    const result = rearmWith({ files: { [DEFAULT_PATH]: fileContent }, env });
    expect(result).toEqual({ rearmed: false, reason: "unchanged", handle: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
    expect(env.CATALYST_CLAUDE_ACCOUNTS_SOURCE).toBeUndefined();
  });

  test("slot switch: flipping selector from acct2 to acct1 returns rotated", () => {
    const mkFile = (active) =>
      [
        `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
        `CLAUDE_TOKEN_acct2='${TOKEN_B}'`,
        `_catalyst_active_token="$CLAUDE_TOKEN_${active}"`,
      ].join("\n");

    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B };

    // acct2 is active → unchanged
    let r = rearmWith({ files: { [DEFAULT_PATH]: mkFile("acct2") }, env });
    expect(r).toEqual({ rearmed: false, reason: "unchanged", handle: null });

    // flip to acct1 → rotated
    r = rearmWith({ files: { [DEFAULT_PATH]: mkFile("acct1") }, env });
    expect(r).toEqual({ rearmed: true, reason: "rotated", handle: "acct1" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
  });

  test("absent file (readFile throws ENOENT for every candidate) → rearmed:false, reason:absent", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    const result = rearmWith({ files: {}, env });
    expect(result).toEqual({ rearmed: false, reason: "absent", handle: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
  });

  test("CLAUDE_ACCOUNTS_ENV override is honored — override path read instead of default", () => {
    const overridePath = "/custom/path/claude-accounts.env";
    const fileContent = `CLAUDE_TOKEN_custom='${TOKEN_C}'`;
    const env = {
      CLAUDE_ACCOUNTS_ENV: overridePath,
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A,
    };
    const result = rearmWith({
      files: {
        [overridePath]: fileContent,
        // default path deliberately not present
      },
      env,
    });
    expect(result).toEqual({ rearmed: true, reason: "rotated", handle: "custom" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_C);
  });

  test("empty/placeholder content → rearmed:false, reason:empty, env untouched", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    // Placeholder only
    let r = rearmWith({ files: { [DEFAULT_PATH]: "CLAUDE_TOKEN_acct1='PASTE_TOKEN_HERE'" }, env });
    expect(r).toEqual({ rearmed: false, reason: "empty", handle: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
    // Whitespace only
    r = rearmWith({ files: { [DEFAULT_PATH]: "   \n  " }, env });
    expect(r).toEqual({ rearmed: false, reason: "empty", handle: null });
  });

  test("CTL-1984 review regression: unprovisioned active slot → reason:empty, env NOT set to a $-reference", () => {
    // The exact live failure the review remediation prevents: a canonical file whose
    // selected slot is a placeholder. Pre-fix, Path 2 returned "$_catalyst_active_token"
    // and this hook set env.CLAUDE_CODE_OAUTH_TOKEN to that garbage. It must instead
    // treat the file as yielding no token and leave the current credential untouched.
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_C };
    const fileContent = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `CLAUDE_TOKEN_acct2='${TOKEN_B}'`,
      `CLAUDE_TOKEN_acct3='PASTE_TOKEN_HERE'`, // active slot not yet provisioned
      `_catalyst_active_token="$CLAUDE_TOKEN_acct3"`,
      `export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"`,
    ].join("\n");
    const r = rearmWith({ files: { [DEFAULT_PATH]: fileContent }, env });
    expect(r).toEqual({ rearmed: false, reason: "empty", handle: null });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_C);
    expect(env.CATALYST_CLAUDE_ACCOUNTS_SOURCE).toBeUndefined();
  });

  test("NUL byte in file → candidate rejected by byte guard → rearmed:false, env untouched", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    // Buffer with NUL embedded; file exists but is malformed
    const buf = Buffer.from(`CLAUDE_TOKEN_acct1='${TOKEN_B}'\x00`, "utf8");
    const r = rearmWith({ files: { [DEFAULT_PATH]: buf }, env });
    // The file was found (anyFound=true) but the NUL guard rejects it; tok stays null.
    // Per plan spec: either "absent" or "empty" is acceptable for this byte-guard path.
    expect(["absent", "empty"]).toContain(r.reason);
    expect(r.rearmed).toBe(false);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
  });

  test("non-ENOENT read error → rearmed:false, reason:error, never throws", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    const bang = new Error("EPERM: permission denied");
    // Inject a throwing readFile (non-ENOENT)
    const result = rearmClaudeAccountsFromFile({
      env,
      readFile: () => { throw bang; },
      log: null,
    });
    // anyFound=true (readFile was called but threw), tok=null → empty OR the outer
    // try/catch catches a re-throw and returns error. Either way: never throws.
    expect(() => result).not.toThrow();
    // The outer try/catch swallows any unhandled path
    expect(["absent", "empty", "error"]).toContain(result.reason);
    expect(result.rearmed).toBe(false);
  });

  test("never throws — a readFile that throws is caught and returns error shape", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    // A readFile that always throws a non-ENOENT (forces the outer catch)
    expect(() =>
      rearmClaudeAccountsFromFile({
        env,
        readFile: () => { throw new Error("catastrophic failure"); },
        log: null,
      }),
    ).not.toThrow();
  });
});

// ── Hook-path integration via armSecret ──────────────────────────────────────

describe("hook-path integration: armSecret uses registered hook for claude-accounts.env", () => {
  test("armSecret takes the hook path after registerRearmHook — armed:true, restartRequired:false", () => {
    resetArmState("claude-accounts.env");
    clearRearmHook("claude-accounts.env");

    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    const fileContent = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `CLAUDE_TOKEN_acct2='${TOKEN_B}'`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct2"`,
    ].join("\n");

    registerRearmHook("claude-accounts.env", (ctx) =>
      rearmWith({
        files: { [DEFAULT_PATH]: fileContent },
        env: ctx.env,
      }),
    );

    const result = armSecret("claude-accounts.env", { env });
    expect(result).toEqual({ armed: true, rotated: true, restartRequired: false });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_B);

    clearRearmHook("claude-accounts.env");
    resetArmState("claude-accounts.env");
  });

  test("armSecret: hook returns rearmed:false → armed:false, rotated:false, restartRequired:false", () => {
    resetArmState("claude-accounts.env");
    clearRearmHook("claude-accounts.env");

    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    // File has same active token → unchanged
    const fileContent = `CLAUDE_TOKEN_acct1='${TOKEN_A}'`;
    registerRearmHook("claude-accounts.env", (ctx) =>
      rearmWith({ files: { [DEFAULT_PATH]: fileContent }, env: ctx.env }),
    );

    const result = armSecret("claude-accounts.env", { env });
    expect(result).toEqual({ armed: false, rotated: false, restartRequired: false });

    clearRearmHook("claude-accounts.env");
    resetArmState("claude-accounts.env");
  });
});

// ── Event emission (CTL-2147 Phase 1) ────────────────────────────────────────

describe("rearmClaudeAccountsFromFile emits (CTL-2147)", () => {
  const FILE = "CLAUDE_TOKEN_acct2='new-tok'\n_catalyst_active_token=\"$CLAUDE_TOKEN_acct2\"";

  test("emits account.rearm.applied ONCE on a rotation, carrying the handle", () => {
    const emitted = [];
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "old-tok" };
    const r = rearmClaudeAccountsFromFile({
      env, readFile: () => FILE, log: silentLog, emit: (e) => { emitted.push(e); return true; },
    });
    expect(r).toEqual({ rearmed: true, reason: "rotated", handle: "acct2" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].attributes["event.name"]).toBe("account.rearm.applied");
    expect(emitted[0].attributes["account.handle"]).toBe("acct2");
  });

  test("NEVER puts a token value anywhere in the envelope", () => {
    const emitted = [];
    rearmClaudeAccountsFromFile({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "old-tok" }, readFile: () => FILE,
      log: silentLog, emit: (e) => { emitted.push(e); return true; },
    });
    expect(JSON.stringify(emitted[0])).not.toContain("new-tok");
    expect(JSON.stringify(emitted[0])).not.toContain("old-tok");
  });

  test("does NOT emit when the token is unchanged", () => {
    const emitted = [];
    const r = rearmClaudeAccountsFromFile({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "new-tok" }, readFile: () => FILE,
      log: silentLog, emit: (e) => { emitted.push(e); return true; },
    });
    expect(r.rearmed).toBe(false);
    expect(r.reason).toBe("unchanged");
    expect(emitted).toHaveLength(0);
  });

  test("does NOT emit on absent/empty/error, and still never throws", () => {
    const emitted = [];
    const push = (e) => { emitted.push(e); return true; };
    expect(rearmClaudeAccountsFromFile({ env: {}, readFile: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }, log: silentLog, emit: push }).reason).toBe("absent");
    expect(rearmClaudeAccountsFromFile({ env: {}, readFile: () => "# comment only\n", log: silentLog, emit: push }).reason).toBe("empty");
    expect(emitted).toHaveLength(0);
  });

  // FAIL-OPEN: the rearm is the load-bearing act; telemetry must never break it.
  test("still rearms when emit throws", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "old-tok" };
    const r = rearmClaudeAccountsFromFile({
      env, readFile: () => FILE, log: silentLog, emit: () => { throw new Error("log full"); },
    });
    expect(r.rearmed).toBe(true);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("new-tok");
  });
});

describe("rearmEventEnvelope (CTL-2147)", () => {
  test("builds a v2 envelope with event.name + account.handle + node.name", () => {
    const env = rearmEventEnvelope({ handle: "acct2", host: "mini", ts: "2026-08-21T23:00:00Z" });
    expect(env.attributes["event.name"]).toBe("account.rearm.applied");
    expect(env.attributes["account.handle"]).toBe("acct2");
    expect(env.attributes["node.name"]).toBe("mini");
    expect(env.severityText).toBe("INFO");
    expect(env.body?.payload?.handle).toBe("acct2");
  });

  test("tolerates a null handle (direct-literal file) without inventing one", () => {
    expect(rearmEventEnvelope({ handle: null, host: "mini" }).attributes["account.handle"]).toBeNull();
  });
});

describe("handleRearmSignal (CTL-2147)", () => {
  test("invokes armSecret for claude-accounts.env exactly once per signal", () => {
    const calls = [];
    const h = makeRearmSignalHandler({ armSecret: (id, o) => { calls.push(id); return { armed: true }; }, log: silentLog });
    h();
    expect(calls).toEqual(["claude-accounts.env"]);
  });

  test("does NOT arm github-token or run cluster-sync (narrow by design)", () => {
    const calls = [];
    const h = makeRearmSignalHandler({ armSecret: (id) => { calls.push(id); return {}; }, log: silentLog });
    h();
    expect(calls).not.toContain("github-token");
  });

  test("never throws when armSecret throws (a signal must not kill the daemon)", () => {
    const h = makeRearmSignalHandler({ armSecret: () => { throw new Error("boom"); }, log: silentLog });
    expect(() => h()).not.toThrow();
  });

  test("is re-entrant-safe: N signals produce N arms, no accumulated state", () => {
    let n = 0;
    const h = makeRearmSignalHandler({ armSecret: () => { n += 1; return {}; }, log: silentLog });
    h(); h(); h();
    expect(n).toBe(3);
  });
});

// wireRearmSighup — CTL-2147. The daemon's ACTUAL production wiring (main() calls
// this, not an inline process.on). daemon-signals.test.mjs additionally source-scans
// daemon.mjs to prove this function is really called there with the real armSecret;
// these tests prove the function itself correctly registers a SIGHUP listener that
// invokes armSecret when fired — main() itself is never called from a test (it boots
// real timers/fs.watch/child processes), so this is the closest a test gets to
// firing the real signal path without booting the whole daemon.
describe("wireRearmSighup (CTL-2147)", () => {
  test("registers exactly one SIGHUP listener on the given emitter", () => {
    const proc = new EventEmitter();
    wireRearmSighup(proc, { armSecret: () => ({ armed: true }), log: silentLog });
    expect(proc.listenerCount("SIGHUP")).toBe(1);
  });

  test("firing SIGHUP invokes armSecret for claude-accounts.env", () => {
    const proc = new EventEmitter();
    const calls = [];
    wireRearmSighup(proc, { armSecret: (id) => { calls.push(id); return { armed: true }; }, log: silentLog });
    proc.emit("SIGHUP");
    expect(calls).toEqual(["claude-accounts.env"]);
  });

  test("does NOT register on SIGINT/SIGTERM (narrow by design — not a shutdown path)", () => {
    const proc = new EventEmitter();
    wireRearmSighup(proc, { armSecret: () => ({ armed: true }), log: silentLog });
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  test("returns the registered handler so a caller can also invoke it directly", () => {
    const proc = new EventEmitter();
    const calls = [];
    const handler = wireRearmSighup(proc, { armSecret: (id) => { calls.push(id); return {}; }, log: silentLog });
    handler();
    expect(calls).toEqual(["claude-accounts.env"]);
  });

  test("a throwing armSecret does not propagate out of the emitted signal (daemon survives)", () => {
    const proc = new EventEmitter();
    wireRearmSighup(proc, { armSecret: () => { throw new Error("boom"); }, log: silentLog });
    expect(() => proc.emit("SIGHUP")).not.toThrow();
  });
});
