// catalyst-agent.test.mjs — CTL-812. Entrypoint wiring: runDomain's graceful
// skip when a sampler module is missing / malformed, and runOnce honoring the
// per-domain enable flags. All importers are injected so no real sampler files
// (which do not exist at the scaffold stage) are touched.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test catalyst-agent.test.mjs

import { describe, test, expect } from "bun:test";
import { runDomain, runOnce } from "./catalyst-agent.mjs";

const ALL_ON = {
  usageEnabled: true,
  hostEnabled: true,
  processEnabled: true,
  emit: "eventlog",
  intervalMs: 300000,
  topN: 10,
};

describe("runDomain", () => {
  test("invokes runOnce(config) and returns true when the module is present", async () => {
    let seen = null;
    const importer = async () => ({ runOnce: (cfg) => { seen = cfg; } });
    const ok = await runDomain({ name: "usage", importer, config: { tag: "cfg" } });
    expect(ok).toBe(true);
    expect(seen).toEqual({ tag: "cfg" });
  });

  test("returns false (no throw) when the import rejects — the scaffold case", async () => {
    const importer = async () => {
      throw new Error("Cannot find module './usage-sampler.mjs'");
    };
    await expect(runDomain({ name: "usage", importer, config: {} })).resolves.toBe(false);
  });

  test("returns false when the module lacks a runOnce export", async () => {
    const importer = async () => ({ notRunOnce: () => {} });
    await expect(runDomain({ name: "host", importer, config: {} })).resolves.toBe(false);
  });

  test("returns false (no throw) when the sampler tick throws", async () => {
    const importer = async () => ({ runOnce: () => { throw new Error("boom"); } });
    await expect(runDomain({ name: "process", importer, config: {} })).resolves.toBe(false);
  });
});

describe("runOnce", () => {
  test("runs every enabled domain once", async () => {
    const ran = [];
    const importers = {
      usage: async () => ({ runOnce: () => ran.push("usage") }),
      host: async () => ({ runOnce: () => ran.push("host") }),
      process: async () => ({ runOnce: () => ran.push("process") }),
    };
    const results = await runOnce({ config: ALL_ON, importers });
    expect(ran.sort()).toEqual(["host", "process", "usage"]);
    expect(results).toEqual({ usage: true, host: true, process: true });
  });

  test("skips disabled domains", async () => {
    const ran = [];
    const importers = {
      usage: async () => ({ runOnce: () => ran.push("usage") }),
      host: async () => ({ runOnce: () => ran.push("host") }),
      process: async () => ({ runOnce: () => ran.push("process") }),
    };
    const config = { ...ALL_ON, hostEnabled: false, processEnabled: false };
    const results = await runOnce({ config, importers });
    expect(ran).toEqual(["usage"]);
    expect(results).toEqual({ usage: true });
  });

  test("a missing sampler module does not abort sibling domains", async () => {
    const ran = [];
    const importers = {
      usage: async () => { throw new Error("missing"); },
      host: async () => ({ runOnce: () => ran.push("host") }),
      process: async () => ({ runOnce: () => ran.push("process") }),
    };
    const results = await runOnce({ config: ALL_ON, importers });
    expect(ran.sort()).toEqual(["host", "process"]);
    expect(results).toEqual({ usage: false, host: true, process: true });
  });
});
