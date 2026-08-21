import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Repo root relative to this test file (…/plugins/dev/scripts/execution-core/__tests__).
const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const EXPECTED = "0.3.237";
const SDK = "@anthropic-ai/claude-agent-sdk";

describe("SDK pin lockstep (CTL-2085)", () => {
  test("root package.json overrides pin the expected SDK version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.overrides[SDK]).toBe(EXPECTED);
  });

  test("execution-core package.json optionalDependencies match the root override", () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "plugins/dev/scripts/execution-core/package.json"), "utf8"),
    );
    expect(pkg.optionalDependencies[SDK]).toBe(EXPECTED);
  });

  test("bun.lock carries no residual 0.3.195 SDK entry", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    // every claude-agent-sdk line (base + platform binaries) must be the expected version
    const sdkLines = lock.split("\n").filter((l) => l.includes("claude-agent-sdk"));
    expect(sdkLines.length).toBeGreaterThan(0);
    for (const l of sdkLines) expect(l).not.toContain("0.3.195");
  });
});
