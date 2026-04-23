import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSummarizeConfig } from "../lib/summarize/config";

describe("loadSummarizeConfig", () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "summarize-config-"));
    mkdirSync(join(tmp, ".catalyst"), { recursive: true });
    configPath = join(tmp, ".catalyst", "config.json");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns disabled when config file is missing", () => {
    const cfg = loadSummarizeConfig(join(tmp, "nonexistent.json"), {});
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when catalyst.ai block is missing", () => {
    writeFileSync(configPath, JSON.stringify({ catalyst: {} }));
    const cfg = loadSummarizeConfig(configPath, {});
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when providers block is missing or empty", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ catalyst: { ai: { providers: {} } } }),
    );
    const cfg = loadSummarizeConfig(configPath, {
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when all declared api keys are missing from env", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          ai: {
            providers: {
              anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
            },
          },
        },
      }),
    );
    const cfg = loadSummarizeConfig(configPath, {});
    expect(cfg.enabled).toBe(false);
  });

  it("returns enabled when at least one provider has its env var set", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          ai: {
            providers: {
              anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
              openai: { apiKeyEnv: "OPENAI_API_KEY" },
            },
          },
        },
      }),
    );
    const cfg = loadSummarizeConfig(configPath, {
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.providers.anthropic?.apiKey).toBe("sk-ant-xxx");
    expect(cfg.providers.openai?.apiKey).toBeFalsy();
  });

  it("applies default provider and model when absent", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          ai: {
            providers: { anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" } },
          },
        },
      }),
    );
    const cfg = loadSummarizeConfig(configPath, {
      ANTHROPIC_API_KEY: "sk",
    });
    expect(cfg.defaultProvider).toBe("anthropic");
    expect(cfg.defaultModel).toBe("claude-sonnet-4-6");
  });

  it("respects explicit defaultProvider and defaultModel", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          ai: {
            defaultProvider: "openai",
            defaultModel: "gpt-4o-mini",
            providers: { openai: { apiKeyEnv: "OPENAI_API_KEY" } },
          },
        },
      }),
    );
    const cfg = loadSummarizeConfig(configPath, { OPENAI_API_KEY: "sk" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.defaultProvider).toBe("openai");
    expect(cfg.defaultModel).toBe("gpt-4o-mini");
  });

  it("returns disabled on malformed JSON", () => {
    writeFileSync(configPath, "{ not json");
    const cfg = loadSummarizeConfig(configPath, {
      ANTHROPIC_API_KEY: "sk",
    });
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled when ai.enabled is explicitly false", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          ai: {
            enabled: false,
            providers: {
              anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
            },
          },
        },
      }),
    );
    const cfg = loadSummarizeConfig(configPath, {
      ANTHROPIC_API_KEY: "sk",
    });
    expect(cfg.enabled).toBe(false);
  });

  it("ignores unknown provider names in config", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          ai: {
            providers: {
              anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
              unknown: { apiKeyEnv: "UNKNOWN_KEY" },
            },
          },
        },
      }),
    );
    const cfg = loadSummarizeConfig(configPath, {
      ANTHROPIC_API_KEY: "sk",
      UNKNOWN_KEY: "x",
    });
    expect(cfg.enabled).toBe(true);
    expect(Object.keys(cfg.providers)).toEqual(["anthropic"]);
  });
});
