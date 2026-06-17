// version.mjs (CTL-1235) — Domain 4: the build-identity sampler. Emits OTLP
// gauges so dashboards can (a) group ANY metric by the running version
// (service.version rides the shared metric resource — see emit.mjs), (b) audit
// what code (version+commit) ran on which host and when, and (c) see how far
// each host is behind origin/main.
//
// Metrics emitted (custom catalyst.* namespace; "commits behind main" has no
// OTel-semconv equivalent):
//   catalyst.build.info        gauge=1, labels: vcs.ref.head.revision (commit)
//                              — the classic *_build_info anchor; service.version
//                                + host.name come from the shared resource.
//   catalyst.vcs.commits_behind gauge=N — commits HEAD is behind origin/main
//                              (0 = on the latest main). Omitted when unresolvable.
import { otlpMetric, emitMetrics } from "./emit.mjs";
import { readAgentConfig, log } from "./config.mjs";
import {
  serviceVersion as defaultServiceVersion,
  vcsRevision as defaultVcsRevision,
  commitsBehindMain as defaultCommitsBehindMain,
} from "./build-info.mjs";

// defaultEmitMetrics — config-aware OTLP metric emit (mirrors host.mjs). A no-op
// when no metrics endpoint is resolvable (eventlog-only hosts).
async function defaultEmitMetrics(metrics) {
  return await emitMetrics(metrics, readAgentConfig());
}

/**
 * sampleVersion — emit the build-identity metric set for one tick. All inputs
 * are injectable for tests; production defaults resolve from build-info.mjs and
 * the config-aware metric emit.
 */
export async function sampleVersion({
  serviceVersion = defaultServiceVersion,
  vcsRevision = defaultVcsRevision,
  commitsBehindMain = defaultCommitsBehindMain,
  emitMetricsFn = defaultEmitMetrics,
  nowMs = () => Date.now(),
} = {}) {
  const t = String(nowMs() * 1_000_000); // ms → unix-nanos
  const revision = vcsRevision();
  const behind = commitsBehindMain();

  const metrics = [
    // build_info: a constant 1 whose labels carry the build identity. The commit
    // is the only label not already on the shared resource (service.version is).
    otlpMetric({
      name: "catalyst.build.info",
      unit: "1",
      description: "Running Catalyst build identity (value always 1); labels carry the commit revision.",
      kind: "gauge",
      points: [{ value: 1, attrs: { "vcs.ref.head.revision": revision }, timeUnixNano: t }],
    }),
    // commits-behind drift. otlpMetric drops the point when behind is null, so
    // the metric is simply absent on a host that can't resolve it (no false 0).
    otlpMetric({
      name: "catalyst.vcs.commits_behind",
      unit: "1",
      description: "Commits HEAD is behind origin/main (0 = up to date with main).",
      kind: "gauge",
      points: [{ value: behind, timeUnixNano: t }],
    }),
  ];

  try {
    await emitMetricsFn(metrics);
  } catch (err) {
    log.warn({ err: err?.message }, "catalyst-agent: version domain metric emit failed");
  }

  // Returned for tests / the --once result map; not used in production.
  return { version: serviceVersion(), revision, commitsBehind: behind };
}
