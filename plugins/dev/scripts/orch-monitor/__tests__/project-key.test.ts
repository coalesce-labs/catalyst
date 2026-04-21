import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectProjectKey } from "../lib/project-key";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "project-key-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectProjectKey", () => {
  it("returns null when .catalyst/config.json does not exist", () => {
    expect(detectProjectKey(tmpDir)).toBeNull();
  });

  it("returns null when .catalyst/config.json is malformed", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(join(tmpDir, ".catalyst", "config.json"), "not json{{{");
    expect(detectProjectKey(tmpDir)).toBeNull();
  });

  it("returns null when catalyst key is absent", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".catalyst", "config.json"),
      JSON.stringify({ other: "value" }),
    );
    expect(detectProjectKey(tmpDir)).toBeNull();
  });

  it("returns null when projectKey is missing", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { project: { ticketPrefix: "ABC" } } }),
    );
    expect(detectProjectKey(tmpDir)).toBeNull();
  });

  it("returns null when projectKey is empty string", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { projectKey: "" } }),
    );
    expect(detectProjectKey(tmpDir)).toBeNull();
  });

  it("returns the projectKey when present", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { projectKey: "my-project" } }),
    );
    expect(detectProjectKey(tmpDir)).toBe("my-project");
  });

  it("returns null when projectKey is not a string", () => {
    mkdirSync(join(tmpDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { projectKey: 42 } }),
    );
    expect(detectProjectKey(tmpDir)).toBeNull();
  });
});
