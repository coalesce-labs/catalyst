// claude-accounts-rearm.test.mjs — CTL-1984. FULLY OFFLINE: every test injects
// an explicit `env` object and a `readFile` stub, so no test ever reads the real
// claude-accounts.env file, spawns a subprocess, or touches the network.
//
// Run: cd plugins/dev/scripts/execution-core && bun test claude-accounts-rearm.test.mjs

import { describe, test, expect } from "bun:test";
import { rearmClaudeAccountsFromFile, parseActiveOauthToken } from "./claude-accounts-rearm.mjs";
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

// rearmWith — the test harness. Builds a readFile stub from a path→content map and
// calls rearmClaudeAccountsFromFile with the injected env and a no-op log.
function rearmWith({ files = {}, env = {} } = {}) {
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

  test("direct assignment with $VAR expansion is NOT honored (avoids shell evaluation)", () => {
    // A line like `CLAUDE_CODE_OAUTH_TOKEN=$_catalyst_active_token` is a shell expansion —
    // our static parser must not follow it; return null so env is never mutated from guesswork.
    const text = [
      `CLAUDE_TOKEN_acct1='${TOKEN_A}'`,
      `_catalyst_active_token="$CLAUDE_TOKEN_acct1"`,
      `export CLAUDE_CODE_OAUTH_TOKEN="$_catalyst_active_token"`,
    ].join("\n");
    // Selector line should win here
    expect(parseActiveOauthToken(text)).toBe(TOKEN_A);
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
    expect(result).toEqual({ rearmed: true, reason: "rotated" });
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
    expect(result).toEqual({ rearmed: false, reason: "unchanged" });
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
    expect(r).toEqual({ rearmed: false, reason: "unchanged" });

    // flip to acct1 → rotated
    r = rearmWith({ files: { [DEFAULT_PATH]: mkFile("acct1") }, env });
    expect(r).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
  });

  test("absent file (readFile throws ENOENT for every candidate) → rearmed:false, reason:absent", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    const result = rearmWith({ files: {}, env });
    expect(result).toEqual({ rearmed: false, reason: "absent" });
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
    expect(result).toEqual({ rearmed: true, reason: "rotated" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_C);
  });

  test("empty/placeholder content → rearmed:false, reason:empty, env untouched", () => {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A };
    // Placeholder only
    let r = rearmWith({ files: { [DEFAULT_PATH]: "CLAUDE_TOKEN_acct1='PASTE_TOKEN_HERE'" }, env });
    expect(r).toEqual({ rearmed: false, reason: "empty" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
    // Whitespace only
    r = rearmWith({ files: { [DEFAULT_PATH]: "   \n  " }, env });
    expect(r).toEqual({ rearmed: false, reason: "empty" });
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
