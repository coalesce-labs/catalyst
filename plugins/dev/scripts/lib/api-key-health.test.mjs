// api-key-health.test.mjs — tests for the shared API-key-health helper (CTL-343).
// Run from plugins/dev/scripts/broker: bun test ../lib/api-key-health.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveApiKey,
  formatMissingKeyWarning,
  formatLoadedKeyInfo,
  probeGroq,
  deriveGroqEndpoint,
} from "./api-key-health.mjs";

const SCRIPTS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

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

// ─── CTL-1616 PR5: Groq call-site fold parity ────────────────────────────────
//
// broker/config.mjs, lib/dsl-cli.mjs, and orch-monitor/cli/hud.tsx are the 3 Groq-key call
// sites the design table tracks ("GROQ_API_KEY — 2 ladders; resolveApiKey adopted by 1 of 3
// sites; tier count differs"). PR5 folds the other 2 onto the SAME resolveApiKey call shape
// broker/config.mjs already uses. dsl-cli.mjs runs its CLI `main()` unconditionally at import
// (unsafe to import in a test) and hud.tsx is a TSX Ink component (not unit-testable at this
// call site without a full render harness) — so this suite proves the fold TWO ways instead:
// (1) a STRUCTURAL check that all 3 sites now call resolveApiKey with the identical
// {envName, configKeyPath} arguments (extracted from source text, the same idiom
// __tests__/health-responder.test.sh's T54 uses for a render function it can't invoke
// directly), and (2) a FUNCTIONAL fixture proving those extracted arguments resolve
// IDENTICALLY across a {env, config, none} matrix — i.e. the 3 sites are not just
// syntactically aligned but behaviorally identical for the same inputs.
describe("Groq call-site fold parity (CTL-1616 PR5)", () => {
  // Pulls the FIRST `resolveApiKey({ envName: "...", configKeyPath: "..." }` call's two
  // literal arguments out of a file's source text. Deliberately dumb (no AST) — this only
  // needs to catch a call-site regression back to a hand-rolled ladder, not parse arbitrary JS.
  function extractResolveApiKeyArgs(sourcePath) {
    const src = readFileSync(sourcePath, "utf8");
    const m = src.match(/resolveApiKey\(\s*\{\s*envName:\s*"([^"]+)"\s*,\s*configKeyPath:\s*"([^"]+)"/);
    if (!m) throw new Error(`no resolveApiKey({envName, configKeyPath}) call found in ${sourcePath}`);
    return { envName: m[1], configKeyPath: m[2] };
  }

  const SITES = {
    "broker/config.mjs": join(SCRIPTS_DIR, "broker", "config.mjs"),
    "lib/dsl-cli.mjs": join(SCRIPTS_DIR, "lib", "dsl-cli.mjs"),
    "orch-monitor/cli/hud.tsx": join(SCRIPTS_DIR, "orch-monitor", "cli", "hud.tsx"),
  };

  test("structural: all 3 sites call resolveApiKey with the identical {envName, configKeyPath}", () => {
    const args = Object.fromEntries(
      Object.entries(SITES).map(([name, path]) => [name, extractResolveApiKeyArgs(path)]),
    );
    expect(args["lib/dsl-cli.mjs"]).toEqual(args["broker/config.mjs"]);
    expect(args["orch-monitor/cli/hud.tsx"]).toEqual(args["broker/config.mjs"]);
    expect(args["broker/config.mjs"]).toEqual({ envName: "GROQ_API_KEY", configKeyPath: "groq.apiKey" });
  });

  test("structural: neither folded site still references the OLD hand-rolled ladder", () => {
    const dslCli = readFileSync(SITES["lib/dsl-cli.mjs"], "utf8");
    const hud = readFileSync(SITES["orch-monitor/cli/hud.tsx"], "utf8");
    // The old pattern was an actual ASSIGNMENT — `apiKey = process.env.GROQ_API_KEY ||
    // readGroqApiKeyFromConfig()` (or the bracket-index hud.tsx variant) — matched here on the
    // live `apiKey =` prefix so this doesn't false-positive on this PR's own explanatory
    // comments (above), which quote that old pattern verbatim as prose.
    const oldPattern = /apiKey\s*=\s*process\.env(\.|\[)["']?GROQ_API_KEY["']?\]?\s*\|\|\s*readGroqApiKeyFromConfig\(\)/;
    expect(dslCli).not.toMatch(oldPattern);
    expect(hud).not.toMatch(oldPattern);
    // And the import of the old function is gone too (not merely unused).
    expect(dslCli).not.toMatch(/import\s*\{[^}]*readGroqApiKeyFromConfig[^}]*\}\s*from\s*["']\.\/dsl-compile\.mjs["']/);
    expect(hud).not.toMatch(/import\s*\{[^}]*readGroqApiKeyFromConfig[^}]*\}\s*from\s*["']\.\.\/\.\.\/lib\/dsl-compile\.mjs["']/);
  });

  describe("functional: the shared fixture resolves identically for every extracted call site", () => {
    let tmp;
    let savedEnv;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "groq-fold-parity-"));
      savedEnv = process.env.GROQ_API_KEY;
      delete process.env.GROQ_API_KEY;
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
      if (savedEnv === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = savedEnv;
    });

    const callArgsPerSite = () =>
      Object.fromEntries(
        Object.entries(SITES).map(([name, path]) => [name, extractResolveApiKeyArgs(path)]),
      );

    test("env tier: identical result for every site's extracted args", () => {
      process.env.GROQ_API_KEY = "gsk_sharedEnvFixture1";
      const cfgPath = join(tmp, "config.json");
      writeFileSync(cfgPath, JSON.stringify({ groq: { apiKey: "gsk_shouldNotWin" } }));
      const perSite = callArgsPerSite();
      const results = Object.fromEntries(
        Object.entries(perSite).map(([name, args]) => [name, resolveApiKey({ ...args, configPath: cfgPath })]),
      );
      for (const r of Object.values(results)) {
        expect(r).toEqual({ value: "gsk_sharedEnvFixture1", source: "env", prefix: "gsk_sharedEn" });
      }
    });

    test("config tier: identical result for every site's extracted args (env unset)", () => {
      const cfgPath = join(tmp, "config.json");
      writeFileSync(cfgPath, JSON.stringify({ groq: { apiKey: "gsk_sharedCfgFixture2" } }));
      const perSite = callArgsPerSite();
      const results = Object.fromEntries(
        Object.entries(perSite).map(([name, args]) => [name, resolveApiKey({ ...args, configPath: cfgPath })]),
      );
      for (const r of Object.values(results)) {
        expect(r).toEqual({ value: "gsk_sharedCfgFixture2", source: "config", prefix: "gsk_sharedCf" });
      }
    });

    test("none tier: identical result for every site's extracted args", () => {
      const perSite = callArgsPerSite();
      const results = Object.fromEntries(
        Object.entries(perSite).map(([name, args]) => [
          name,
          resolveApiKey({ ...args, configPath: join(tmp, "does-not-exist.json") }),
        ]),
      );
      for (const r of Object.values(results)) {
        expect(r).toEqual({ value: "", source: null, prefix: null });
      }
    });
  });
});
