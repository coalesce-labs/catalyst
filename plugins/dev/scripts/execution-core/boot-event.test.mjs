// boot-event.test.mjs — CTL-1084. buildBootEnvelope + readPluginVersion unit tests.
// Run: cd plugins/dev/scripts/execution-core && bun test boot-event.test.mjs

import { describe, test, expect } from "bun:test";
import { buildBootEnvelope, readPluginVersion } from "./boot-event.mjs";

const BASE = {
  now: () => "2026-06-12T18:00:00Z",
  pluginVersionFn: () => "12.6.0",
  governanceFn: () => ({
    beliefsShadow: true, diagnostician: false, intentsEnforce: false,
    advanceShadowSummary: false,
    stallJanitor: { mode: "shadow" }, watchdog: { mode: "shadow" }, unstuckSweep: { mode: "off" },
  }),
  sourcesFn: () => ({
    beliefsShadow: "env-override", diagnostician: "config",
    intentsEnforce: "default", advanceShadowSummary: "default",
  }),
  summary: { adoptedWorkers: 3, zombiesCleared: 5, rewalkPlanned: 4, rewalkDispatched: 2 },
};

describe("buildBootEnvelope (CTL-1084)", () => {
  test("event.name is node.boot and payload carries the full summary", () => {
    const e = buildBootEnvelope(BASE);
    expect(e.attributes["event.name"]).toBe("node.boot");
    const p = e.body.payload;
    expect(p.plugin_version).toBe("12.6.0");
    expect(p.effective_flags.beliefsShadow).toBe(true);
    expect(p.flag_sources.beliefsShadow).toBe("env-override");
    expect(p.adopted_workers).toBe(3);
    expect(p.zombies_cleared).toBe(5);
    expect(p.rewalk_planned).toBe(4);
    expect(p.rewalk_dispatched).toBe(2);
  });

  test("includes ts and host.name and is JSON-serializable", () => {
    const e = buildBootEnvelope(BASE);
    expect(e.ts).toBe("2026-06-12T18:00:00Z");
    expect(typeof e.body.payload["host.name"]).toBe("string");
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });

  test("defaults plugin_version to 'unknown' when manifest unreadable", () => {
    const e = buildBootEnvelope({ ...BASE, pluginVersionFn: () => "unknown" });
    expect(e.body.payload.plugin_version).toBe("unknown");
  });

  test("summary defaults to zeros when not provided", () => {
    const e = buildBootEnvelope({ ...BASE, summary: undefined });
    const p = e.body.payload;
    expect(p.adopted_workers).toBe(0);
    expect(p.zombies_cleared).toBe(0);
    expect(p.rewalk_planned).toBe(0);
    expect(p.rewalk_dispatched).toBe(0);
  });

  test("event.name attribute is exactly 'node.boot'", () => {
    const e = buildBootEnvelope(BASE);
    expect(e.attributes["event.name"]).toBe("node.boot");
  });
});

describe("readPluginVersion (CTL-1084)", () => {
  test("returns a non-empty string from the real plugin.json", () => {
    const v = readPluginVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
    expect(v).not.toBe("unknown");
  });

  test("returns 'unknown' when path does not exist", () => {
    expect(readPluginVersion("/nonexistent/plugin.json")).toBe("unknown");
  });
});
