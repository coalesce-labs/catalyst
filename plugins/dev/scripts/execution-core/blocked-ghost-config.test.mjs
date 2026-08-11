import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBlockedGhostConfig } from "./config.mjs";

describe("readBlockedGhostConfig (CAT-171)", () => {
  let saved;
  let tempDir;

  beforeEach(() => {
    saved = {
      CATALYST_BLOCKED_GHOST: process.env.CATALYST_BLOCKED_GHOST,
      CATALYST_LAYER2_CONFIG_FILE: process.env.CATALYST_LAYER2_CONFIG_FILE,
    };
    delete process.env.CATALYST_BLOCKED_GHOST;
    tempDir = mkdtempSync(join(tmpdir(), "cat171-blocked-ghost-"));
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tempDir, "absent.json");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("default is shadow when env and Layer-2 are silent", () => {
    expect(readBlockedGhostConfig().mode).toBe("shadow");
  });

  test("env wins over Layer-2", () => {
    writeFileSync(
      process.env.CATALYST_LAYER2_CONFIG_FILE,
      JSON.stringify({ catalyst: { blockedGhost: { mode: "off" } } }),
    );
    process.env.CATALYST_BLOCKED_GHOST = "enforce";
    expect(readBlockedGhostConfig().mode).toBe("enforce");
  });

  test('"0" is the kill switch', () => {
    process.env.CATALYST_BLOCKED_GHOST = "0";
    expect(readBlockedGhostConfig().mode).toBe("off");
  });

  test("Layer-2 mode is used when env is silent", () => {
    writeFileSync(
      process.env.CATALYST_LAYER2_CONFIG_FILE,
      JSON.stringify({ catalyst: { blockedGhost: { mode: "enforce" } } }),
    );
    expect(readBlockedGhostConfig().mode).toBe("enforce");
  });

  test("an unrecognized env value falls through to shadow", () => {
    process.env.CATALYST_BLOCKED_GHOST = "yes-please";
    expect(readBlockedGhostConfig().mode).toBe("shadow");
  });
});
