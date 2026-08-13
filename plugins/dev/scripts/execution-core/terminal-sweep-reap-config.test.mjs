import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTerminalSweepReapConfig } from "./config.mjs";

describe("readTerminalSweepReapConfig", () => {
  let dir; let saved;
  beforeEach(() => { saved = { ...process.env }; delete process.env.CATALYST_TERMINAL_SWEEP_REAP; dir = mkdtempSync(join(tmpdir(), "cat169-config-")); process.env.CATALYST_LAYER2_CONFIG_FILE = join(dir, "absent.json"); });
  afterEach(() => { process.env = saved; rmSync(dir, { recursive: true, force: true }); });
  test("defaults shadow", () => expect(readTerminalSweepReapConfig()).toEqual({ mode: "shadow" }));
  test.each(["off", "shadow", "enforce"])("accepts %s", (mode) => { process.env.CATALYST_TERMINAL_SWEEP_REAP = mode; expect(readTerminalSweepReapConfig().mode).toBe(mode); });
  test("maps 0 to off and invalid env to shadow", () => { process.env.CATALYST_TERMINAL_SWEEP_REAP = "0"; expect(readTerminalSweepReapConfig().mode).toBe("off"); process.env.CATALYST_TERMINAL_SWEEP_REAP = "bad"; expect(readTerminalSweepReapConfig().mode).toBe("shadow"); });
  test("reads Layer-2 and env wins", () => { const path = join(dir, "config.json"); writeFileSync(path, JSON.stringify({ catalyst: { terminalSweepReap: { mode: "enforce" } } })); process.env.CATALYST_LAYER2_CONFIG_FILE = path; expect(readTerminalSweepReapConfig().mode).toBe("enforce"); process.env.CATALYST_TERMINAL_SWEEP_REAP = "off"; expect(readTerminalSweepReapConfig().mode).toBe("off"); });
  test("malformed file is shadow", () => { const path = join(dir, "config.json"); writeFileSync(path, "{"); process.env.CATALYST_LAYER2_CONFIG_FILE = path; expect(readTerminalSweepReapConfig().mode).toBe("shadow"); });
});
