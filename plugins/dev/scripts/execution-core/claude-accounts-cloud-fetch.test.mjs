// claude-accounts-cloud-fetch.test.mjs — CTL-1991. FULLY OFFLINE: every test
// injects explicit env / fetchFn / resolveToken / readFile / writeFile stubs,
// so no test ever reads real files (beyond a tmp dir), touches the network, or
// modifies the host's ~/.config/catalyst.
//
// Run: cd plugins/dev/scripts/execution-core && bun test claude-accounts-cloud-fetch.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, lstatSync, symlinkSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fetchClaudeAccountsEnv,
  materializeClaudeAccountsEnv,
  syncClaudeAccountsFromCloud,
  resolveClaudeAccountsCloudMode,
} from "./claude-accounts-cloud-fetch.mjs";

// Fake content — a realistic claude-accounts.env text (no real credentials)
const FAKE_CONTENT =
  "CLAUDE_TOKEN_acct1='sk-ant-oat01-FAKE-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'\n" +
  "CLAUDE_TOKEN_acct2='sk-ant-oat01-FAKE-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'\n" +
  "_catalyst_active_token=\"$CLAUDE_TOKEN_acct1\"\n" +
  "export CLAUDE_CODE_OAUTH_TOKEN=\"$_catalyst_active_token\"\n";

const FAKE_TOKEN = "ct-test-FAKE-CLOUD-TOKEN-1234567890";

// resolveToken stubs
const goodToken = () => FAKE_TOKEN;
const noToken = () => null;

// A 200-success fetch stub
const successResponse = () => ({ ok: true, status: 200, text: async () => FAKE_CONTENT });

// Silence log output in tests
const noLog = null;

// ── fetchClaudeAccountsEnv ───────────────────────────────────────────────────

describe("fetchClaudeAccountsEnv", () => {
  test("returns { ok:true, content } on 200 with non-empty body", async () => {
    const calls = [];
    const fetchFn = async (url, init) => { calls.push({ url, init }); return successResponse(); };
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(result.ok).toBe(true);
    expect(result.content).toBe(FAKE_CONTENT);
    expect(calls).toHaveLength(1);
  });

  test("uses correct default URL containing the default base + path", async () => {
    const calls = [];
    const fetchFn = async (url, init) => { calls.push(url); return successResponse(); };
    await fetchClaudeAccountsEnv({ env: {}, fetchFn, resolveToken: goodToken, log: noLog });
    expect(calls[0]).toContain("https://api.catalyst-cloud.coalescelabs.ai");
    expect(calls[0]).toContain("/me/secrets/claude-accounts.env");
  });

  test("overrides base URL from CATALYST_CLOUD_BASE_URL", async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return successResponse(); };
    await fetchClaudeAccountsEnv({
      env: { CATALYST_CLOUD_BASE_URL: "https://custom.example.com/api/v2" },
      fetchFn, resolveToken: goodToken, log: noLog,
    });
    expect(calls[0]).toContain("https://custom.example.com/api/v2");
  });

  test("overrides path from CATALYST_CLAUDE_ACCOUNTS_CLOUD_PATH", async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return successResponse(); };
    await fetchClaudeAccountsEnv({
      env: { CATALYST_CLAUDE_ACCOUNTS_CLOUD_PATH: "/v2/secrets/accounts" },
      fetchFn, resolveToken: goodToken, log: noLog,
    });
    expect(calls[0]).toContain("/v2/secrets/accounts");
  });

  test("sends Authorization: Bearer <token> header", async () => {
    let capturedHeaders;
    const fetchFn = async (url, init) => {
      capturedHeaders = init?.headers ?? {};
      return successResponse();
    };
    await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    const authHeader = capturedHeaders["Authorization"] ?? capturedHeaders["authorization"];
    expect(authHeader).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  test("returns { ok:false, reason:'no-cloud-token' } and makes NO HTTP call when token is null", async () => {
    const calls = [];
    const fetchFn = async (...args) => { calls.push(args); return successResponse(); };
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: noToken, log: noLog });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-cloud-token");
    expect(calls).toHaveLength(0);
  });

  test("returns { ok:false, reason:'http-401' } on 401", async () => {
    const fetchFn = async () => ({ ok: false, status: 401, text: async () => "Unauthorized" });
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http-401");
  });

  test("returns { ok:false, reason:'http-503' } on 503", async () => {
    const fetchFn = async () => ({ ok: false, status: 503, text: async () => "Service Unavailable" });
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("http-503");
  });

  test("returns { ok:false, reason:'fetch-threw' } when fetchFn throws", async () => {
    const fetchFn = async () => { throw new Error("network error"); };
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("fetch-threw");
  });

  test("returns { ok:false, reason:'empty' } on 200 with empty body", async () => {
    const fetchFn = async () => ({ ok: true, status: 200, text: async () => "" });
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  test("returns { ok:false, reason:'empty' } on 200 with whitespace-only body", async () => {
    const fetchFn = async () => ({ ok: true, status: 200, text: async () => "   \n   " });
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  test("returns { ok:false, reason:'invalid-bytes' } when content contains NUL byte", async () => {
    const contentWithNul = FAKE_CONTENT + "\u0000injected-nul";
    const fetchFn = async () => ({ ok: true, status: 200, text: async () => contentWithNul });
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid-bytes");
  });

  test("never throws on null env or missing optional fields", async () => {
    const r1 = await fetchClaudeAccountsEnv({
      env: null, fetchFn: async () => { throw new Error("x"); },
      resolveToken: noToken, log: noLog,
    });
    expect(r1.ok).toBe(false);

    // No resolveToken — should short-circuit cleanly
    const r2 = await fetchClaudeAccountsEnv({ log: noLog });
    expect(r2.ok).toBe(false);
  });

  // Positive control: the guard-passing tests above only prove guards. This test
  // confirms the happy path (no-guard, token present, 200 response) returns ok:true.
  test("positive control: happy path does fetch and return ok:true", async () => {
    let fetched = false;
    const fetchFn = async () => { fetched = true; return successResponse(); };
    const result = await fetchClaudeAccountsEnv({ fetchFn, resolveToken: goodToken, log: noLog });
    expect(fetched).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.content).toBe(FAKE_CONTENT);
  });
});

// ── materializeClaudeAccountsEnv ─────────────────────────────────────────────

describe("materializeClaudeAccountsEnv", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctl-1991-mat-"));
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("writes content at 0o600 and file is readable with correct content", async () => {
    const targetPath = join(tmpDir, "claude-accounts.env");
    const result = await materializeClaudeAccountsEnv({
      content: FAKE_CONTENT, path: targetPath, log: noLog,
    });
    expect(result.written).toBe(true);
    const stat = lstatSync(targetPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(targetPath, "utf8")).toBe(FAKE_CONTENT);
  });

  test("leaves no .tmp. litter after successful write", async () => {
    const targetPath = join(tmpDir, "claude-accounts.env");
    await materializeClaudeAccountsEnv({ content: FAKE_CONTENT, path: targetPath, log: noLog });
    const tmpFiles = readdirSync(tmpDir).filter(f => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  test("returns { written:false, reason:'unchanged' } when on-disk content already equals content", async () => {
    const targetPath = join(tmpDir, "claude-accounts.env");
    writeFileSync(targetPath, FAKE_CONTENT, { mode: 0o600 });
    const result = await materializeClaudeAccountsEnv({
      content: FAKE_CONTENT, path: targetPath, log: noLog,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("unchanged");
  });

  // Positive control: the unchanged guard above requires a "real change does write" test.
  test("positive control: rewrites when content changes", async () => {
    const targetPath = join(tmpDir, "claude-accounts.env");
    writeFileSync(targetPath, "OLD CONTENT\n", { mode: 0o600 });
    const result = await materializeClaudeAccountsEnv({
      content: FAKE_CONTENT, path: targetPath, log: noLog,
    });
    expect(result.written).toBe(true);
    expect(readFileSync(targetPath, "utf8")).toBe(FAKE_CONTENT);
  });

  test("replaces a symlink at the target path (does not follow it through)", async () => {
    const realFile = join(tmpDir, "real.env");
    const symlinkPath = join(tmpDir, "link.env");
    writeFileSync(realFile, "REAL FILE CONTENT\n", { mode: 0o600 });
    symlinkSync(realFile, symlinkPath);

    await materializeClaudeAccountsEnv({
      content: FAKE_CONTENT, path: symlinkPath, log: noLog,
    });

    // The symlink should have been replaced with a regular file
    const stat = lstatSync(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(readFileSync(symlinkPath, "utf8")).toBe(FAKE_CONTENT);
    // The original real file is untouched (symlink was not followed during write)
    expect(readFileSync(realFile, "utf8")).toBe("REAL FILE CONTENT\n");
  });

  test("returns { written:false, reason:'error' } when injected writeFile throws", async () => {
    const failWrite = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    const result = await materializeClaudeAccountsEnv({
      content: FAKE_CONTENT,
      path: join(tmpDir, "target.env"),
      writeFile: failWrite,
      log: noLog,
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe("error");
  });

  test("never throws for any input including bad path", async () => {
    const result = await materializeClaudeAccountsEnv({
      content: FAKE_CONTENT, path: "/definitely/does/not/exist/x.env", log: noLog,
    });
    expect(result.written).toBe(false);
  });
});

// ── syncClaudeAccountsFromCloud ──────────────────────────────────────────────

describe("syncClaudeAccountsFromCloud", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctl-1991-sync-"));
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const genuineCloud = { mode: "cloud", inferred: false, recognized: true };
  const clusterMode = { mode: "cluster", inferred: false, recognized: true };
  const inferredCloud = { mode: "cloud", inferred: true, recognized: true };
  const recognizedFalse = { mode: "cloud", inferred: false, recognized: false };

  const successFetch = async () => successResponse();

  test("returns { skipped:true, reason:'not-cloud' } for cluster deployment mode", async () => {
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: clusterMode, mode: "enforce",
      fetchFn: successFetch, resolveToken: goodToken, log: noLog,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not-cloud");
  });

  test("returns { skipped:true, reason:'not-cloud' } for inferred cloud (not genuine)", async () => {
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: inferredCloud, mode: "enforce",
      fetchFn: successFetch, resolveToken: goodToken, log: noLog,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not-cloud");
  });

  test("returns { skipped:true, reason:'not-cloud' } for recognized:false (unrecognized explicit value)", async () => {
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: recognizedFalse, mode: "enforce",
      fetchFn: successFetch, resolveToken: goodToken, log: noLog,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not-cloud");
  });

  test("returns { skipped:true, reason:'disabled' } when mode is 'off' even on genuine cloud", async () => {
    const calls = [];
    const fetchFn = async (...args) => { calls.push(args); return successResponse(); };
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: genuineCloud, mode: "off",
      fetchFn, resolveToken: goodToken, log: noLog,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  test("shadow mode: returns { shadow:true, wouldWrite } without writing any file", async () => {
    const targetPath = join(tmpDir, "shadow.env");
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: genuineCloud, mode: "shadow",
      fetchFn: successFetch, resolveToken: goodToken,
      path: targetPath, log: noLog,
    });
    expect(result.shadow).toBe(true);
    expect(typeof result.wouldWrite).toBe("boolean");
    // No file created
    let exists = false;
    try { lstatSync(targetPath); exists = true; } catch { /* expected */ }
    expect(exists).toBe(false);
  });

  test("shadow mode: wouldWrite:true when target file does not yet exist", async () => {
    const targetPath = join(tmpDir, "new.env");
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: genuineCloud, mode: "shadow",
      fetchFn: successFetch, resolveToken: goodToken,
      path: targetPath, log: noLog,
    });
    expect(result.shadow).toBe(true);
    expect(result.wouldWrite).toBe(true);
  });

  test("shadow mode: wouldWrite:false when target already has the same content", async () => {
    const targetPath = join(tmpDir, "same.env");
    writeFileSync(targetPath, FAKE_CONTENT, { mode: 0o600 });
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: genuineCloud, mode: "shadow",
      fetchFn: successFetch, resolveToken: goodToken,
      path: targetPath, log: noLog,
    });
    expect(result.shadow).toBe(true);
    expect(result.wouldWrite).toBe(false);
  });

  // Positive control: shadow tests above are paired with an enforce-mode write test below.
  test("enforce mode + genuine cloud + successful fetch: materializes the file", async () => {
    const targetPath = join(tmpDir, "enforce.env");
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: genuineCloud, mode: "enforce",
      fetchFn: successFetch, resolveToken: goodToken,
      path: targetPath, log: noLog,
    });
    expect(result.written).toBe(true);
    expect(readFileSync(targetPath, "utf8")).toBe(FAKE_CONTENT);
  });

  test("enforce mode: HTTP failure does NOT touch existing on-disk file", async () => {
    const targetPath = join(tmpDir, "existing.env");
    const originalContent = "ORIGINAL CONTENT — must survive a cloud outage\n";
    writeFileSync(targetPath, originalContent, { mode: 0o600 });
    const failFetch = async () => ({ ok: false, status: 503, text: async () => "Unavailable" });
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: genuineCloud, mode: "enforce",
      fetchFn: failFetch, resolveToken: goodToken,
      path: targetPath, log: noLog,
    });
    expect(result.ok).toBe(false);
    // File untouched — a cloud outage must never blank a working token
    expect(readFileSync(targetPath, "utf8")).toBe(originalContent);
  });

  test("enforce mode: fetchFn throw does NOT touch existing on-disk file", async () => {
    const targetPath = join(tmpDir, "existing2.env");
    const originalContent = "KEEP ME\n";
    writeFileSync(targetPath, originalContent, { mode: 0o600 });
    const result = await syncClaudeAccountsFromCloud({
      deploymentMode: genuineCloud, mode: "enforce",
      fetchFn: async () => { throw new Error("network down"); },
      resolveToken: goodToken, path: targetPath, log: noLog,
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(targetPath, "utf8")).toBe(originalContent);
  });

  test("never throws for any input (no args, bad args, null mode)", async () => {
    const r1 = await syncClaudeAccountsFromCloud({ log: noLog });
    expect(r1).toBeDefined();
    const r2 = await syncClaudeAccountsFromCloud({ deploymentMode: null, mode: null, log: noLog });
    expect(r2).toBeDefined();
  });
});

// ── resolveClaudeAccountsCloudMode ───────────────────────────────────────────

describe("resolveClaudeAccountsCloudMode", () => {
  test("returns 'off' when env var is unset (the default)", () => {
    expect(resolveClaudeAccountsCloudMode({})).toBe("off");
    expect(resolveClaudeAccountsCloudMode(null)).toBe("off");
    expect(resolveClaudeAccountsCloudMode()).toBe("off");
  });

  test("returns 'off' when explicitly set to 'off'", () => {
    expect(resolveClaudeAccountsCloudMode({ CATALYST_CLAUDE_ACCOUNTS_CLOUD: "off" })).toBe("off");
  });

  test("returns 'shadow' when set to 'shadow'", () => {
    expect(resolveClaudeAccountsCloudMode({ CATALYST_CLAUDE_ACCOUNTS_CLOUD: "shadow" })).toBe("shadow");
  });

  test("returns 'enforce' when set to 'enforce'", () => {
    expect(resolveClaudeAccountsCloudMode({ CATALYST_CLAUDE_ACCOUNTS_CLOUD: "enforce" })).toBe("enforce");
  });

  test("returns 'off' (degrade-safe) for unknown values including wrong case", () => {
    expect(resolveClaudeAccountsCloudMode({ CATALYST_CLAUDE_ACCOUNTS_CLOUD: "ENFORCE" })).toBe("off");
    expect(resolveClaudeAccountsCloudMode({ CATALYST_CLAUDE_ACCOUNTS_CLOUD: "yes" })).toBe("off");
    expect(resolveClaudeAccountsCloudMode({ CATALYST_CLAUDE_ACCOUNTS_CLOUD: "1" })).toBe("off");
    expect(resolveClaudeAccountsCloudMode({ CATALYST_CLAUDE_ACCOUNTS_CLOUD: "" })).toBe("off");
  });
});
