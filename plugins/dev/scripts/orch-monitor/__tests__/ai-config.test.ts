import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAiConfig } from "../lib/ai-config";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ai-config-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadAiConfig", () => {
  it("returns disabled config when no files exist", () => {
    const cfg = loadAiConfig(
      join(tmpRoot, "missing-project.json"),
      join(tmpRoot, "missing-secrets.json"),
    );
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled config when ai.enabled is false", () => {
    const projectPath = join(tmpRoot, "project.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ catalyst: { ai: { enabled: false } } }),
    );
    const cfg = loadAiConfig(projectPath, join(tmpRoot, "missing.json"));
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled config when ai section is missing from project config", () => {
    const projectPath = join(tmpRoot, "project.json");
    writeFileSync(projectPath, JSON.stringify({ catalyst: {} }));
    const cfg = loadAiConfig(projectPath, join(tmpRoot, "missing.json"));
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled config when secrets file is missing but enabled=true", () => {
    const projectPath = join(tmpRoot, "project.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ catalyst: { ai: { enabled: true } } }),
    );
    const cfg = loadAiConfig(projectPath, join(tmpRoot, "missing.json"));
    expect(cfg.enabled).toBe(false);
  });

  it("returns full config when both files are valid", () => {
    const projectPath = join(tmpRoot, "project.json");
    const secretsPath = join(tmpRoot, "secrets.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ catalyst: { ai: { enabled: true } } }),
    );
    writeFileSync(
      secretsPath,
      JSON.stringify({
        ai: {
          gateway: "https://gateway.ai.cloudflare.com/v1/acct/gw",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          apiKey: "sk-test-key",
        },
      }),
    );

    const cfg = loadAiConfig(projectPath, secretsPath);
    expect(cfg.enabled).toBe(true);
    expect(cfg.gateway).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-haiku-4-5-20251001");
    expect(cfg.apiKey).toBe("sk-test-key");
  });

  it("returns disabled if secrets missing required gateway field", () => {
    const projectPath = join(tmpRoot, "project.json");
    const secretsPath = join(tmpRoot, "secrets.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ catalyst: { ai: { enabled: true } } }),
    );
    writeFileSync(
      secretsPath,
      JSON.stringify({
        ai: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      }),
    );

    const cfg = loadAiConfig(projectPath, secretsPath);
    expect(cfg.enabled).toBe(false);
  });

  it("returns disabled if secrets missing required apiKey field", () => {
    const projectPath = join(tmpRoot, "project.json");
    const secretsPath = join(tmpRoot, "secrets.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ catalyst: { ai: { enabled: true } } }),
    );
    writeFileSync(
      secretsPath,
      JSON.stringify({
        ai: {
          gateway: "https://gateway.ai.cloudflare.com/v1/acct/gw",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
      }),
    );

    const cfg = loadAiConfig(projectPath, secretsPath);
    expect(cfg.enabled).toBe(false);
  });

  it("uses default model when model not specified in secrets", () => {
    const projectPath = join(tmpRoot, "project.json");
    const secretsPath = join(tmpRoot, "secrets.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ catalyst: { ai: { enabled: true } } }),
    );
    writeFileSync(
      secretsPath,
      JSON.stringify({
        ai: {
          gateway: "https://gateway.ai.cloudflare.com/v1/acct/gw",
          provider: "anthropic",
          apiKey: "sk-test-key",
        },
      }),
    );

    const cfg = loadAiConfig(projectPath, secretsPath);
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe("claude-haiku-4-5-20251001");
  });

  it("uses default provider when provider not specified in secrets", () => {
    const projectPath = join(tmpRoot, "project.json");
    const secretsPath = join(tmpRoot, "secrets.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ catalyst: { ai: { enabled: true } } }),
    );
    writeFileSync(
      secretsPath,
      JSON.stringify({
        ai: {
          gateway: "https://gateway.ai.cloudflare.com/v1/acct/gw",
          apiKey: "sk-test-key",
        },
      }),
    );

    const cfg = loadAiConfig(projectPath, secretsPath);
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe("anthropic");
  });

  it("handles malformed JSON gracefully", () => {
    const projectPath = join(tmpRoot, "project.json");
    writeFileSync(projectPath, "not json{{{");
    const cfg = loadAiConfig(projectPath, join(tmpRoot, "missing.json"));
    expect(cfg.enabled).toBe(false);
  });
});
