// version.test.mjs (CTL-1235) — Domain 4: the build-identity sampler.
//
// sampleVersion is exercised through injected seams (serviceVersion /
// vcsRevision / commitsBehindMain / emitMetricsFn) so there is no real git or
// network. Covers: the build_info gauge shape + commit label, the commits_behind
// gauge value, null-degradation (drift unresolvable → metric dropped, no false
// 0), and emit-failure resilience. A light real-resolver check confirms
// build-info.mjs reads the actual plugin.json + git.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test version.test.mjs

import { describe, test, expect } from "bun:test";
import { sampleVersion } from "./version.mjs";
import { serviceVersion, vcsRevision } from "./build-info.mjs";

// Pull the single data point's attributes into a plain {key:value} map.
function attrMap(metric) {
  const out = {};
  for (const a of metric?.gauge?.dataPoints?.[0]?.attributes ?? []) {
    out[a.key] = a.value?.stringValue ?? a.value?.asDouble ?? a.value?.asInt;
  }
  return out;
}
const byName = (metrics, name) => metrics.find((m) => m?.name === name);

describe("sampleVersion — build-identity metric set", () => {
  const stubs = {
    serviceVersion: () => "9.9.9",
    vcsRevision: () => "abc1234",
    commitsBehindMain: () => 0,
    nowMs: () => 1000,
  };

  test("emits catalyst.build.info = 1 with the commit as vcs.ref.head.revision", async () => {
    let captured = [];
    await sampleVersion({ ...stubs, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    const info = byName(captured, "catalyst.build.info");
    expect(info).toBeTruthy();
    expect(info.gauge.dataPoints[0].asDouble).toBe(1);
    // Unit MUST be empty so Prometheus does NOT append "_ratio" (CTL-1235): the
    // metric must land as `catalyst_build_info`, not `catalyst_build_info_ratio`.
    expect(info.unit).toBe("");
    expect(attrMap(info)["vcs.ref.head.revision"]).toBe("abc1234");
    // service.version is NOT a build_info label — it rides the shared resource.
    expect(attrMap(info)["service.version"]).toBeUndefined();
  });

  test("emits catalyst.vcs.commits_behind with the drift count", async () => {
    let captured = [];
    await sampleVersion({ ...stubs, commitsBehindMain: () => 7, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    const behind = byName(captured, "catalyst.vcs.commits_behind");
    expect(behind).toBeTruthy();
    expect(behind.gauge.dataPoints[0].asDouble).toBe(7);
  });

  test("timeUnixNano is ms→nanos", async () => {
    let captured = [];
    await sampleVersion({ ...stubs, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    expect(byName(captured, "catalyst.build.info").gauge.dataPoints[0].timeUnixNano).toBe("1000000000");
  });

  test("commits_behind unresolvable (null) → metric dropped, no false 0", async () => {
    let captured = [];
    await sampleVersion({ ...stubs, commitsBehindMain: () => null, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    expect(byName(captured, "catalyst.vcs.commits_behind")).toBeUndefined();
    // build_info still emits — the build identity is independent of drift.
    expect(byName(captured, "catalyst.build.info")).toBeTruthy();
  });

  test("a null commit still emits build_info (revision label simply omitted)", async () => {
    let captured = [];
    await sampleVersion({ ...stubs, vcsRevision: () => null, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    const info = byName(captured, "catalyst.build.info");
    expect(info).toBeTruthy();
    expect(attrMap(info)["vcs.ref.head.revision"]).toBeUndefined();
  });

  test("an emit failure does not throw (telemetry never crashes the agent)", async () => {
    await expect(
      sampleVersion({ ...stubs, emitMetricsFn: async () => { throw new Error("boom"); } }),
    ).resolves.toBeTruthy();
  });

  test("returns the resolved identity for the --once result map", async () => {
    const r = await sampleVersion({ ...stubs, commitsBehindMain: () => 2, emitMetricsFn: async () => {} });
    expect(r).toEqual({ version: "9.9.9", revision: "abc1234", commitsBehind: 2 });
  });
});

describe("build-info.mjs — real resolvers (no injection)", () => {
  test("serviceVersion reads a semver-shaped string from plugin.json", () => {
    expect(serviceVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
  test("vcsRevision returns a short git sha (or null off a git checkout)", () => {
    const r = vcsRevision();
    expect(r === null || /^[0-9a-f]{7,}$/.test(r)).toBe(true);
  });
});
