import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectProjectKey, detectProjectKeyFromConfig } from "../project-key";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "project-key-from-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectProjectKeyFromConfig", () => {
  it("returns the projectKey when given a valid config path, regardless of cwd", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ catalyst: { projectKey: "my-project" } }));
    expect(detectProjectKeyFromConfig(cfgPath)).toBe("my-project");
  });

  it("returns null for a missing file", () => {
    expect(detectProjectKeyFromConfig(join(tmpDir, "nonexistent.json"))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, "not json{{{");
    expect(detectProjectKeyFromConfig(cfgPath)).toBeNull();
  });

  it("returns null when catalyst key is absent", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ other: "value" }));
    expect(detectProjectKeyFromConfig(cfgPath)).toBeNull();
  });

  it("returns null when projectKey is missing", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ catalyst: { project: { ticketPrefix: "ABC" } } }));
    expect(detectProjectKeyFromConfig(cfgPath)).toBeNull();
  });

  it("returns null when projectKey is empty string", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ catalyst: { projectKey: "" } }));
    expect(detectProjectKeyFromConfig(cfgPath)).toBeNull();
  });

  it("returns null when projectKey is not a string", () => {
    const cfgPath = join(tmpDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ catalyst: { projectKey: 42 } }));
    expect(detectProjectKeyFromConfig(cfgPath)).toBeNull();
  });
});

describe("detectProjectKey regression", () => {
  it("still returns the projectKey via cwd delegation", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { projectKey: "delegated-project" } }),
    );
    expect(detectProjectKey(tmpDir)).toBe("delegated-project");
  });
});
