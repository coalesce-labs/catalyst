import { describe, it, expect } from "bun:test";
import { resolveProjectConfigPath } from "../server";

describe("resolveProjectConfigPath", () => {
  it("--config flag takes highest precedence", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts", "--config", "/a/b.json"],
      { CATALYST_CONFIG_PATH: "/c/d.json" },
      "/some/cwd",
    );
    expect(result).toBe("/a/b.json");
  });

  it("CATALYST_CONFIG_PATH used when no --config flag", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts"],
      { CATALYST_CONFIG_PATH: "/c/d.json" },
      "/some/cwd",
    );
    expect(result).toBe("/c/d.json");
  });

  it("falls back to cwd default when neither flag nor env set", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts"],
      {},
      "/my/cwd",
    );
    expect(result).toBe("/my/cwd/.catalyst/config.json");
  });

  it("--config with no following argument falls through to env", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts", "--config"],
      { CATALYST_CONFIG_PATH: "/c/d.json" },
      "/some/cwd",
    );
    expect(result).toBe("/c/d.json");
  });

  it("--config with no following argument and no env falls through to cwd default", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts", "--config"],
      {},
      "/my/cwd",
    );
    expect(result).toBe("/my/cwd/.catalyst/config.json");
  });

  it("no-regression: unset produces exact cwd literal", () => {
    const cwd = "/exact/cwd/path";
    const result = resolveProjectConfigPath(["bun", "server.ts"], {}, cwd);
    expect(result).toBe(`${cwd}/.catalyst/config.json`);
  });
});
