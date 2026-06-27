import { describe, it, expect } from "bun:test";
import { resolveProjectConfigPath } from "../server";
import { resolveLayer1ConfigPath } from "../lib/config-path";

describe("resolveProjectConfigPath", () => {
  it("--config flag takes highest precedence", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts", "--config", "/a/b.json"],
      { CATALYST_CONFIG_PATH: "/c/d.json" },
      "/some/cwd",
    );
    expect(result).toBe("/a/b.json");
  });

  it("--config flag beats CATALYST_CONFIG_FILE", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts", "--config", "/a/b.json"],
      { CATALYST_CONFIG_FILE: "/env/file.json" },
      "/some/cwd",
    );
    expect(result).toBe("/a/b.json");
  });

  it("CATALYST_CONFIG_FILE used when no --config flag (canonical deploy var)", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts"],
      { CATALYST_CONFIG_FILE: "/env/file.json" },
      "/some/cwd",
    );
    expect(result).toBe("/env/file.json");
  });

  it("CATALYST_CONFIG_FILE wins over CATALYST_CONFIG_PATH", () => {
    const result = resolveProjectConfigPath(
      ["node", "server.ts"],
      { CATALYST_CONFIG_FILE: "/env/file.json", CATALYST_CONFIG_PATH: "/c/d.json" },
      "/some/cwd",
    );
    expect(result).toBe("/env/file.json");
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

// The shared, env-aware resolver that every Layer-1 config default now routes
// through (project-roster.loadProjects, server projectsConfigPath/monitorConfigPath,
// and resolveProjectConfigPath's env fallthrough). Resolution is cwd-INDEPENDENT
// whenever an env var is set — the property the daemon-spawned monitor relies on.
describe("resolveLayer1ConfigPath", () => {
  it("prefers CATALYST_CONFIG_FILE over CATALYST_CONFIG_PATH and cwd", () => {
    expect(
      resolveLayer1ConfigPath(
        { CATALYST_CONFIG_FILE: "/env/file.json", CATALYST_CONFIG_PATH: "/c/d.json" },
        "/some/cwd",
      ),
    ).toBe("/env/file.json");
  });

  it("falls through to CATALYST_CONFIG_PATH when CATALYST_CONFIG_FILE unset", () => {
    expect(
      resolveLayer1ConfigPath({ CATALYST_CONFIG_PATH: "/c/d.json" }, "/some/cwd"),
    ).toBe("/c/d.json");
  });

  it("falls back to the cwd default only when no env pointer is set", () => {
    expect(resolveLayer1ConfigPath({}, "/my/cwd")).toBe("/my/cwd/.catalyst/config.json");
  });

  it("is cwd-independent: a cwd with no .catalyst still resolves the env pointer", () => {
    // Reproduces the live bug: daemon spawns the monitor from .../execution-core
    // (no .catalyst/config.json) but exports CATALYST_CONFIG_FILE. The env wins,
    // so the WRONG cwd is never consulted.
    expect(
      resolveLayer1ConfigPath(
        { CATALYST_CONFIG_FILE: "/home/u/.catalyst/config.json" },
        "/repo/plugins/dev/scripts/execution-core",
      ),
    ).toBe("/home/u/.catalyst/config.json");
  });
});
