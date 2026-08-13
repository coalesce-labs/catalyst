// version.test.mjs (CTL-1235) — Domain 4: the build-identity sampler.
//
// sampleVersion is exercised through injected seams (serviceVersion /
// vcsRevision / commitsBehindByRoot / emitMetricsFn) so there is no real git or
// network. Covers: the build_info gauge shape + commit label, the commits_behind
// gauge value, null-degradation (drift unresolvable → metric dropped, no false
// 0), and emit-failure resilience. A light real-resolver check confirms
// build-info.mjs reads the actual plugin.json + git.
//
// CTL-1825 changed the drift seam from `commitsBehindMain` (ONE number, measured
// against the agent's own module directory) to `commitsBehindByRoot` (one
// measurement per executing root). The assertions below are the same ones, now
// stated per-root, plus the two the ticket added: a stale root is visible as its
// own series, and the single aggregate is the MAXIMUM across roots. The
// per-root cases live in build-info.test.mjs; this file covers what is EMITTED.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test version.test.mjs

import { describe, test, expect } from "bun:test";
import { sampleVersion } from "./version.mjs";
import { serviceVersion, vcsRevision } from "./build-info.mjs";

// Pull one data point's attributes into a plain {key:value} map.
function attrMap(metric, i = 0) {
  const out = {};
  for (const a of metric?.gauge?.dataPoints?.[i]?.attributes ?? []) {
    out[a.key] = a.value?.stringValue ?? a.value?.asDouble ?? a.value?.asInt;
  }
  return out;
}
const byName = (metrics, name) => metrics.find((m) => m?.name === name);
// {root -> value} for a per-root gauge, so a test asserts the whole series set at once.
function seriesByRoot(metric) {
  const out = {};
  (metric?.gauge?.dataPoints ?? []).forEach((p, i) => {
    out[attrMap(metric, i)["catalyst.checkout.root"]] = p.asDouble;
  });
  return out;
}

describe("sampleVersion — build-identity metric set", () => {
  const stubs = {
    serviceVersion: () => "9.9.9",
    vcsRevision: () => "abc1234",
    commitsBehindByRoot: () => [{ root: "/repos/catalyst", behind: 0 }],
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
    await sampleVersion({
      ...stubs,
      commitsBehindByRoot: () => [{ root: "/repos/catalyst", behind: 7 }],
      emitMetricsFn: async (m) => (captured = m.filter(Boolean)),
    });
    const behind = byName(captured, "catalyst.vcs.commits_behind");
    expect(behind).toBeTruthy();
    expect(behind.gauge.dataPoints[0].asDouble).toBe(7);
    // …and the point says WHICH tree it measured (CTL-1825).
    expect(attrMap(behind)["catalyst.checkout.root"]).toBe("/repos/catalyst");
  });

  test("timeUnixNano is ms→nanos", async () => {
    let captured = [];
    await sampleVersion({ ...stubs, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    expect(byName(captured, "catalyst.build.info").gauge.dataPoints[0].timeUnixNano).toBe("1000000000");
  });

  test("commits_behind unresolvable (null) → metric dropped, no false 0", async () => {
    let captured = [];
    await sampleVersion({
      ...stubs,
      commitsBehindByRoot: () => [{ root: "/repos/catalyst", behind: null }],
      emitMetricsFn: async (m) => (captured = m.filter(Boolean)),
    });
    expect(byName(captured, "catalyst.vcs.commits_behind")).toBeUndefined();
    // The aggregate goes with it — an unmeasurable fleet must not report a healthy max.
    expect(byName(captured, "catalyst.vcs.commits_behind.max")).toBeUndefined();
    // build_info still emits — the build identity is independent of drift.
    expect(byName(captured, "catalyst.build.info")).toBeTruthy();
  });

  test("no executing roots at all → both drift metrics dropped", async () => {
    let captured = [];
    await sampleVersion({ ...stubs, commitsBehindByRoot: () => [], emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    expect(byName(captured, "catalyst.vcs.commits_behind")).toBeUndefined();
    expect(byName(captured, "catalyst.vcs.commits_behind.max")).toBeUndefined();
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
    const r = await sampleVersion({
      ...stubs,
      commitsBehindByRoot: () => [{ root: "/repos/catalyst", behind: 2 }],
      emitMetricsFn: async () => {},
    });
    expect(r).toEqual({
      version: "9.9.9",
      revision: "abc1234",
      commitsBehind: 2,
      checkouts: [{ root: "/repos/catalyst", behind: 2 }],
    });
  });
});

// ─── CTL-1825 — the gauge measures where code actually runs ────────────────────
//
// The laptop fixture from the ticket: the agent's own checkout current, the tree
// the daemons run (`~/catalyst/plugin-source`) 24 commits behind.
describe("sampleVersion — code currency is measured where code actually runs", () => {
  const AGENT_CHECKOUT = "/Users/ryan/code-repos/github/coalesce-labs/catalyst";
  const PLUGIN_SOURCE = "/Users/ryan/catalyst/plugin-source";
  const laptop = {
    serviceVersion: () => "9.9.9",
    vcsRevision: () => "abc1234",
    commitsBehindByRoot: () => [
      { root: AGENT_CHECKOUT, behind: 0 },
      { root: PLUGIN_SOURCE, behind: 24 },
    ],
    nowMs: () => 1000,
  };

  test("one series per executing root, labelled by that root's path", async () => {
    let captured = [];
    await sampleVersion({ ...laptop, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    const behind = byName(captured, "catalyst.vcs.commits_behind");
    expect(behind.gauge.dataPoints).toHaveLength(2);
    expect(seriesByRoot(behind)).toEqual({ [AGENT_CHECKOUT]: 0, [PLUGIN_SOURCE]: 24 });
  });

  test("a stale root cannot be hidden by a current one", async () => {
    let captured = [];
    await sampleVersion({ ...laptop, emitMetricsFn: async (m) => (captured = m.filter(Boolean)) });
    // The stale root is its own non-zero series…
    expect(seriesByRoot(byName(captured, "catalyst.vcs.commits_behind"))[PLUGIN_SOURCE]).toBe(24);
    // …and the single aggregate is the MAXIMUM across roots, never the agent's own.
    const max = byName(captured, "catalyst.vcs.commits_behind.max");
    expect(max).toBeTruthy();
    expect(max.unit).toBe("");
    expect(max.gauge.dataPoints).toHaveLength(1);
    expect(max.gauge.dataPoints[0].asDouble).toBe(24);
    // The aggregate carries no root label — it is the whole host's answer.
    expect(attrMap(max)["catalyst.checkout.root"]).toBeUndefined();
  });

  test("the --once result map reports the MAX, plus the per-root breakdown", async () => {
    const r = await sampleVersion({ ...laptop, emitMetricsFn: async () => {} });
    expect(r.commitsBehind).toBe(24);
    expect(r.checkouts).toEqual([
      { root: AGENT_CHECKOUT, behind: 0 },
      { root: PLUGIN_SOURCE, behind: 24 },
    ]);
  });

  test("an enumeration that THROWS drops the drift metrics but never the tick", async () => {
    let captured = [];
    await expect(
      sampleVersion({
        ...laptop,
        commitsBehindByRoot: () => { throw new Error("registry unreadable"); },
        emitMetricsFn: async (m) => (captured = m.filter(Boolean)),
      }),
    ).resolves.toBeTruthy();
    expect(byName(captured, "catalyst.vcs.commits_behind")).toBeUndefined();
    expect(byName(captured, "catalyst.vcs.commits_behind.max")).toBeUndefined();
    // build_info does not depend on the enumeration, so it still emits.
    expect(byName(captured, "catalyst.build.info")).toBeTruthy();
  });

  test("an entry with no root is discarded, not emitted as an unlabelled point", async () => {
    let captured = [];
    await sampleVersion({
      ...laptop,
      commitsBehindByRoot: () => [{ root: null, behind: 99 }, { root: PLUGIN_SOURCE, behind: 24 }],
      emitMetricsFn: async (m) => (captured = m.filter(Boolean)),
    });
    const behind = byName(captured, "catalyst.vcs.commits_behind");
    // An unlabelled point would collide with every labelled one — last write wins,
    // which is the original defect with a label bolted on.
    expect(behind.gauge.dataPoints).toHaveLength(1);
    expect(seriesByRoot(behind)).toEqual({ [PLUGIN_SOURCE]: 24 });
    // …and the discarded entry does not reach the aggregate either.
    expect(byName(captured, "catalyst.vcs.commits_behind.max").gauge.dataPoints[0].asDouble).toBe(24);
  });

  test("an unmeasurable root drops only its own point, not the whole gauge", async () => {
    let captured = [];
    await sampleVersion({
      ...laptop,
      commitsBehindByRoot: () => [
        { root: AGENT_CHECKOUT, behind: null },
        { root: PLUGIN_SOURCE, behind: 24 },
      ],
      emitMetricsFn: async (m) => (captured = m.filter(Boolean)),
    });
    const behind = byName(captured, "catalyst.vcs.commits_behind");
    expect(behind.gauge.dataPoints).toHaveLength(1);
    expect(seriesByRoot(behind)).toEqual({ [PLUGIN_SOURCE]: 24 });
    expect(byName(captured, "catalyst.vcs.commits_behind.max").gauge.dataPoints[0].asDouble).toBe(24);
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
