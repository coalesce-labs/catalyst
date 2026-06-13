// host-alias.test.mjs — CTL-1092. Host alias resolution for pre-pin OS names.
//
// Run: cd plugins/dev/scripts/execution-core && bun test host-alias.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostAlias, loadHostAliases } from "./host-alias.mjs";

describe("resolveHostAlias (CTL-1092)", () => {
  test("maps a pre-pin OS name to the pinned roster name", () => {
    const aliases = { "Ryans-Mac-mini-250233": "mini", "RyansMini250233.rozich": "laptop" };
    expect(resolveHostAlias("Ryans-Mac-mini-250233", aliases)).toBe("mini");
    expect(resolveHostAlias("RyansMini250233.rozich", aliases)).toBe("laptop");
  });

  test("passes through a name with no alias", () => {
    expect(resolveHostAlias("mini", {})).toBe("mini");
    expect(resolveHostAlias("mini", { "other": "something" })).toBe("mini");
  });

  test("handles null/undefined aliases gracefully", () => {
    expect(resolveHostAlias("mini", null)).toBe("mini");
    expect(resolveHostAlias("mini", undefined)).toBe("mini");
  });
});

describe("loadHostAliases (CTL-1092)", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "host-alias-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns {} when no config path is given", () => {
    expect(loadHostAliases({ configPath: null })).toEqual({});
  });

  test("returns {} when config file is missing", () => {
    expect(loadHostAliases({ configPath: "/nonexistent/path/config.json" })).toEqual({});
  });

  test("returns the alias map from catalyst.host.aliases", () => {
    const config = { catalyst: { host: { aliases: { "Ryans-Mac-mini-250233": "mini" } } } };
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    expect(loadHostAliases({ configPath })).toEqual({ "Ryans-Mac-mini-250233": "mini" });
  });

  test("returns {} when catalyst.host.aliases is absent", () => {
    const config = { catalyst: { orchestration: {} } };
    const configPath = join(tmp, "config.json");
    writeFileSync(configPath, JSON.stringify(config));
    expect(loadHostAliases({ configPath })).toEqual({});
  });
});
