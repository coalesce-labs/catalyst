// api-key-health.test.mjs — tests for the shared API-key-health helper (CTL-343).
// Run from plugins/dev/scripts/broker: bun test ../lib/api-key-health.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveApiKey,
  formatMissingKeyWarning,
  formatLoadedKeyInfo,
  probeGroq,
  deriveGroqEndpoint,
} from "./api-key-health.mjs";

// ─── resolveApiKey ───────────────────────────────────────────────────────────

describe("resolveApiKey", () => {
  let tmp;
  let savedEnv;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "akh-"));
    savedEnv = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedEnv;
  });

  test("returns env source when env var is set (highest precedence)", () => {
    process.env.GROQ_API_KEY = "gsk_envTest123456";
    const cfgPath = join(tmp, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ groq: { apiKey: "gsk_cfgTestABCDEFG" } }));
    const result = resolveApiKey({
      envName: "GROQ_API_KEY",
      configKeyPath: "groq.apiKey",
      configPath: cfgPath,
    });
    expect(result.source).toBe("env");
    expect(result.value).toBe("gsk_envTest123456");
    expect(result.prefix).toBe("gsk_envTest1");
  });

  test("falls back to project config when env not set and projectKey given", () => {
    const projectCfgPath = join(tmp, "config-myproj.json");
    const globalCfgPath = join(tmp, "config.json");
    writeFileSync(projectCfgPath, JSON.stringify({ groq: { apiKey: "gsk_projABCDEFGHIJ" } }));
    writeFileSync(globalCfgPath, JSON.stringify({ groq: { apiKey: "gsk_globalXXXXXXXXX" } }));
    const result = resolveApiKey({
      envName: "GROQ_API_KEY",
      configKeyPath: "groq.apiKey",
      configPath: globalCfgPath,
      projectConfigPath: projectCfgPath,
    });
    expect(result.source).toBe("project-config");
    expect(result.value).toBe("gsk_projABCDEFGHIJ");
    expect(result.prefix).toBe("gsk_projABCD");
  });

  test("falls back to global config when env + project config absent", () => {
    const globalCfgPath = join(tmp, "config.json");
    writeFileSync(globalCfgPath, JSON.stringify({ groq: { apiKey: "gsk_globalXXXXXXXXX" } }));
    const result = resolveApiKey({
      envName: "GROQ_API_KEY",
      configKeyPath: "groq.apiKey",
      configPath: globalCfgPath,
    });
    expect(result.source).toBe("config");
    expect(result.value).toBe("gsk_globalXXXXXXXXX");
    expect(result.prefix).toBe("gsk_globalXX");
  });

  test("returns null source when nothing is set", () => {
    const result = resolveApiKey({
      envName: "GROQ_API_KEY",
      configKeyPath: "groq.apiKey",
      configPath: join(tmp, "does-not-exist.json"),
    });
    expect(result.source).toBeNull();
    expect(result.value).toBe("");
    expect(result.prefix).toBeNull();
  });

  test("handles missing project config gracefully (falls through)", () => {
    const globalCfgPath = join(tmp, "config.json");
    writeFileSync(globalCfgPath, JSON.stringify({ groq: { apiKey: "gsk_globalXXXXXXXXX" } }));
    const result = resolveApiKey({
      envName: "GROQ_API_KEY",
      configKeyPath: "groq.apiKey",
      configPath: globalCfgPath,
      projectConfigPath: join(tmp, "config-missing.json"),
    });
    expect(result.source).toBe("config");
    expect(result.value).toBe("gsk_globalXXXXXXXXX");
  });

  test("handles malformed config JSON gracefully", () => {
    const cfgPath = join(tmp, "config.json");
    writeFileSync(cfgPath, "{ not valid json");
    const result = resolveApiKey({
      envName: "GROQ_API_KEY",
      configKeyPath: "groq.apiKey",
      configPath: cfgPath,
    });
    expect(result.source).toBeNull();
    expect(result.value).toBe("");
  });

  test("empty-string env value is treated as not-set (falls through to config)", () => {
    process.env.GROQ_API_KEY = "";
    const cfgPath = join(tmp, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ groq: { apiKey: "gsk_fromCfgXXXXXX" } }));
    const result = resolveApiKey({
      envName: "GROQ_API_KEY",
      configKeyPath: "groq.apiKey",
      configPath: cfgPath,
    });
    expect(result.source).toBe("config");
    expect(result.value).toBe("gsk_fromCfgXXXXXX");
  });

  test("nested configKeyPath traversal (a.b.c) works correctly", () => {
    const cfgPath = join(tmp, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ linear: { auth: { apiToken: "lin_abcdefXYZ" } } }));
    // Use a synthetic env var name unlikely to be set on the host
    const result = resolveApiKey({
      envName: "CTL343_TEST_NESTED_TOKEN",
      configKeyPath: "linear.auth.apiToken",
      configPath: cfgPath,
    });
    expect(result.source).toBe("config");
    expect(result.value).toBe("lin_abcdefXYZ");
  });
});

// ─── formatMissingKeyWarning ─────────────────────────────────────────────────

describe("formatMissingKeyWarning", () => {
  test("includes all four required pieces", () => {
    const out = formatMissingKeyWarning({
      name: "GROQ_API_KEY",
      envName: "GROQ_API_KEY",
      configPath: "~/.config/catalyst/config.json",
      configKeyPath: "groq.apiKey",
      getUrl: "https://console.groq.com/keys",
    });
    expect(out).toContain("GROQ_API_KEY");
    expect(out).toContain("~/.config/catalyst/config.json");
    expect(out).toContain("groq.apiKey");
    expect(out).toContain("https://console.groq.com/keys");
  });

  test("includes 'how to set' hints (env export + config-edit guidance)", () => {
    const out = formatMissingKeyWarning({
      name: "GROQ_API_KEY",
      envName: "GROQ_API_KEY",
      configPath: "~/.config/catalyst/config.json",
      configKeyPath: "groq.apiKey",
      getUrl: "https://console.groq.com/keys",
    });
    expect(out).toMatch(/export GROQ_API_KEY/);
  });
});

// ─── formatLoadedKeyInfo ─────────────────────────────────────────────────────

describe("formatLoadedKeyInfo", () => {
  test("includes prefix + source", () => {
    const out = formatLoadedKeyInfo({
      name: "GROQ_API_KEY",
      source: "config",
      prefix: "gsk_jWb52Ioy",
    });
    expect(out).toContain("GROQ_API_KEY");
    expect(out).toContain("gsk_jWb52Ioy");
    expect(out).toContain("config");
  });

  test("env source is labelled clearly", () => {
    const out = formatLoadedKeyInfo({
      name: "GROQ_API_KEY",
      source: "env",
      prefix: "gsk_envXXXXX",
    });
    expect(out).toContain("env");
  });

  test("project-config source surfaces clearly", () => {
    const out = formatLoadedKeyInfo({
      name: "GROQ_API_KEY",
      source: "project-config",
      prefix: "gsk_projZZZZZ",
    });
    expect(out).toContain("project-config");
  });
});

// ─── deriveGroqEndpoint ──────────────────────────────────────────────────────

describe("deriveGroqEndpoint", () => {
  test("returns default Groq endpoint when gateway disabled", () => {
    const endpoint = deriveGroqEndpoint({ gateway: null });
    expect(endpoint.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(endpoint.extraHeaders).toEqual({});
  });

  test("returns default when gateway.enabled is false", () => {
    const endpoint = deriveGroqEndpoint({
      gateway: { enabled: false, baseUrl: "https://gateway.test/groq" },
    });
    expect(endpoint.url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  test("substitutes gateway baseUrl when enabled", () => {
    const endpoint = deriveGroqEndpoint({
      gateway: { enabled: true, baseUrl: "https://gateway.internal/groq" },
    });
    expect(endpoint.url).toBe("https://gateway.internal/groq/chat/completions");
  });

  test("strips trailing slash from baseUrl", () => {
    const endpoint = deriveGroqEndpoint({
      gateway: { enabled: true, baseUrl: "https://gateway.internal/groq/" },
    });
    expect(endpoint.url).toBe("https://gateway.internal/groq/chat/completions");
  });

  test("merges gateway headers", () => {
    const endpoint = deriveGroqEndpoint({
      gateway: { enabled: true, baseUrl: "https://gateway.internal/groq", headers: { "X-Project": "Adva" } },
    });
    expect(endpoint.extraHeaders).toEqual({ "X-Project": "Adva" });
  });

  test("no extraHeaders when gateway.headers absent", () => {
    const endpoint = deriveGroqEndpoint({
      gateway: { enabled: true, baseUrl: "https://gateway.internal/groq" },
    });
    expect(endpoint.extraHeaders).toEqual({});
  });

  test("indicates gateway is in use", () => {
    const ep1 = deriveGroqEndpoint({ gateway: { enabled: true, baseUrl: "https://g/groq" } });
    expect(ep1.gatewayEnabled).toBe(true);
    const ep2 = deriveGroqEndpoint({ gateway: null });
    expect(ep2.gatewayEnabled).toBe(false);
  });
});

// ─── probeGroq ───────────────────────────────────────────────────────────────

describe("probeGroq", () => {
  test("returns missing when apiKey is empty", async () => {
    const result = await probeGroq({ apiKey: "", endpoint: "x", fetch: async () => ({}) });
    expect(result.status).toBe("missing");
  });

  test("returns missing when apiKey is null", async () => {
    const result = await probeGroq({ apiKey: null, endpoint: "x", fetch: async () => ({}) });
    expect(result.status).toBe("missing");
  });

  test("returns ok with modelCount on 200", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }),
    });
    const result = await probeGroq({
      apiKey: "gsk_xx",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      fetch: fakeFetch,
    });
    expect(result.status).toBe("ok");
    expect(result.modelCount).toBe(3);
  });

  test("returns unauthorized on 401", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"code":"invalid_api_key"}}',
    });
    const result = await probeGroq({
      apiKey: "gsk_xx",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      fetch: fakeFetch,
    });
    expect(result.status).toBe("unauthorized");
    expect(result.error).toContain("401");
  });

  test("returns unauthorized on 403", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });
    const result = await probeGroq({
      apiKey: "gsk_xx",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      fetch: fakeFetch,
    });
    expect(result.status).toBe("unauthorized");
  });

  test("returns error on 5xx", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    });
    const result = await probeGroq({
      apiKey: "gsk_xx",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      fetch: fakeFetch,
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("503");
  });

  test("returns error on fetch throw", async () => {
    const fakeFetch = async () => { throw new Error("network down"); };
    const result = await probeGroq({
      apiKey: "gsk_xx",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      fetch: fakeFetch,
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("network down");
  });

  test("calls /v1/models endpoint (derived from chat endpoint)", async () => {
    let calledUrl;
    const fakeFetch = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    await probeGroq({
      apiKey: "gsk_xx",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      fetch: fakeFetch,
    });
    expect(calledUrl).toBe("https://api.groq.com/openai/v1/models");
  });

  test("sends Authorization Bearer header", async () => {
    let calledHeaders;
    const fakeFetch = async (_url, init) => {
      calledHeaders = init?.headers ?? {};
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    await probeGroq({
      apiKey: "gsk_test",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      fetch: fakeFetch,
    });
    expect(calledHeaders.Authorization).toBe("Bearer gsk_test");
  });
});
