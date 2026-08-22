import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePublishPreflightMode } from "./config.mjs";

test("publish preflight defaults to shadow", () => {
  expect(resolvePublishPreflightMode({ env: {}, logger: null })).toBe("shadow");
});

test("environment wins over Layer-1 mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-mode-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ catalyst: { orchestration: { publishPreflight: { mode: "enforce" } } } }));
  expect(resolvePublishPreflightMode({ env: { CATALYST_PUBLISH_PREFLIGHT: "off" }, configPath: file, logger: null })).toBe("off");
  expect(resolvePublishPreflightMode({ env: {}, configPath: file, logger: null })).toBe("enforce");
});

test("invalid mode degrades to shadow and warns", () => {
  const warnings = [];
  expect(resolvePublishPreflightMode({ env: { CATALYST_PUBLISH_PREFLIGHT: "maybe" }, logger: { warn: (...args) => warnings.push(args) } })).toBe("shadow");
  expect(warnings).toHaveLength(1);
});
