// test-setup.test.mjs — CTL-1086 broker suite hermeticity tripwire.
//
// The preload (test-setup.mjs, wired via bunfig [test].preload) must pin
// CATALYST_DIR to a fresh per-run temp dir BEFORE any test module loads, so
// no broker test (or code-under-test reaching a default appendEvent seam
// during the afterEach-delete window) can append to the real
// ~/catalyst/events/YYYY-MM.jsonl.
//
// Mirrors execution-core/test-setup.test.mjs (CTL-810).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

import { getEventLogPath } from "./config.mjs";
import { appendEvent } from "./router.mjs";

const realCatalystDir = resolve(homedir(), "catalyst");

describe("CTL-1086: hermetic CATALYST_DIR preload (broker)", () => {
  test("preload pinned CATALYST_DIR to a per-run temp dir and recorded it", () => {
    const pinned = process.env.CATALYST_HERMETIC_DIR;
    expect(pinned).toBeDefined();
    expect(pinned).toContain("catalyst-broker-hermetic-");
    expect(resolve(pinned).startsWith(realCatalystDir + sep)).toBe(false);
    expect(resolve(pinned)).not.toBe(realCatalystDir);
    expect(existsSync(pinned)).toBe(true);
  });

  test("getEventLogPath() resolves outside the real ~/catalyst", () => {
    expect(resolve(getEventLogPath()).startsWith(realCatalystDir + sep)).toBe(false);
  });

  test("functional: appendEvent lands under the hermetic dir, never ~/catalyst", () => {
    const pinned = process.env.CATALYST_HERMETIC_DIR;
    const prev = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = pinned;
    try {
      appendEvent({ name: "phase.test.tripwire.CTL-1086", orchestrator: "orch-test-tripwire-CTL-1086" });
      const p = resolve(getEventLogPath());
      expect(p.startsWith(resolve(pinned))).toBe(true);
      const lines = readdirSync(resolve(pinned, "events"))
        .map((f) => readFileSync(resolve(pinned, "events", f), "utf8"))
        .join("");
      expect(lines).toContain("CTL-1086");
    } finally {
      process.env.CATALYST_DIR = prev;
    }
  });
});
