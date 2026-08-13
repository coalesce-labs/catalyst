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
//   catalyst.vcs.commits_behind gauge=N — commits HEAD is behind origin/main,
//                              ONE SERIES PER EXECUTING CHECKOUT, labelled
//                              catalyst.checkout.root. Omitted when unresolvable.
//   catalyst.vcs.commits_behind.max gauge=N — the host's single currency number:
//                              the MAXIMUM across those roots.
//
// CTL-1825 — why per-root and why a max. The drift gauge used to be one
// unlabelled number measured against the agent's own module directory, so on a
// host whose agent runs from a different tree than its daemons (every node on
// this fleet) it reported the currency of a tree nobody executes. It read 0 on
// the laptop while `~/catalyst/plugin-source` — the tree running
// health-responder, orphan-sweep and log-shipper — was 24 commits behind.
//
// Two consequences for what is EMITTED. (a) Every executing root gets its own
// series, labelled by its path, so a stale root is visible rather than averaged
// away or overwritten. (b) Where a single number is unavoidable, it is the
// MAXIMUM across roots — a host is only as current as its stalest checkout, and
// any aggregate a current root can pull down reintroduces the false zero. It is
// a SEPARATE metric name, not an unlabelled point on the per-root gauge, because
// a point with and without `catalyst.checkout.root` on one metric is two
// conflicting series in Prometheus, and the sum of a gauge over roots is
// meaningless anyway.
import { otlpMetric, emitMetrics } from "./emit.mjs";
import { readAgentConfig, log } from "./config.mjs";
import {
  serviceVersion as defaultServiceVersion,
  vcsRevision as defaultVcsRevision,
  commitsBehindByRoot as defaultCommitsBehindByRoot,
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
  commitsBehindByRoot = defaultCommitsBehindByRoot,
  emitMetricsFn = defaultEmitMetrics,
  nowMs = () => Date.now(),
} = {}) {
  const t = String(nowMs() * 1_000_000); // ms → unix-nanos
  const revision = vcsRevision();

  // One measurement per executing checkout. A root whose drift is null keeps its
  // entry here (so the --once result map reports what could not be measured) but
  // contributes no data point — otlpMetric drops a non-numeric value, which is
  // what keeps an unreadable checkout from emitting a 0 that reads as current.
  //
  // Guarded: the enumeration now reads a registry and a config file, and this
  // module's standing rule is that telemetry never crashes the agent. Degrading to
  // an empty series set drops BOTH drift metrics (never a false 0) while build_info
  // — which does not depend on the enumeration at all — still emits.
  let checkouts = [];
  try {
    // An entry without a string root is discarded rather than emitted: an unlabelled
    // point on a per-root gauge collides with every other one, and last-write-wins on
    // a collision is the original defect wearing a label's clothes.
    checkouts = (commitsBehindByRoot() ?? []).filter((c) => typeof c?.root === "string" && c.root);
  } catch (err) {
    log.warn({ err: err?.message }, "catalyst-agent: executing-checkout enumeration failed");
  }
  const measured = checkouts.map((c) => c.behind).filter((n) => typeof n === "number" && Number.isFinite(n));
  // The host's single currency number. `null` when NOTHING measured, so the gauge
  // is absent rather than falsely 0 — the same degradation rule as each series.
  const behind = measured.length === 0 ? null : Math.max(...measured);

  const metrics = [
    // build_info: a constant 1 whose labels carry the build identity. The commit
    // is the only label not already on the shared resource (service.version is).
    otlpMetric({
      // Unit MUST be empty: the OTel→Prometheus mapping appends a unit suffix
      // (unit "1" → "_ratio"), which would yield the wrong name
      // `catalyst_build_info_ratio`. Empty unit → the conventional
      // `catalyst_build_info`.
      name: "catalyst.build.info",
      unit: "",
      description: "Running Catalyst build identity (value always 1); labels carry the commit revision.",
      kind: "gauge",
      points: [{ value: 1, attrs: { "vcs.ref.head.revision": revision }, timeUnixNano: t }],
    }),
    // commits-behind drift, one point per executing checkout. otlpMetric drops a
    // point whose value is null, so an unreadable root disappears from the series
    // set (no false 0) while the roots that DID measure still emit; when no root
    // resolves at all, otlpMetric returns null and the metric is absent entirely.
    otlpMetric({
      // Empty unit (a plain count): unit "1" would append "_ratio" →
      // `catalyst_vcs_commits_behind_ratio`. Empty → `catalyst_vcs_commits_behind`.
      name: "catalyst.vcs.commits_behind",
      unit: "",
      description:
        "Commits HEAD is behind origin/main for one executing checkout (0 = up to date with main); labelled by that checkout's path.",
      kind: "gauge",
      points: checkouts.map((c) => ({
        value: c.behind,
        // The path is the identity of the series. Without it the points collide
        // and whichever arrives last wins — which is a per-root gauge that still
        // cannot show a stale root, i.e. the defect with extra steps.
        attrs: { "catalyst.checkout.root": c.root },
        timeUnixNano: t,
      })),
    }),
    // The one aggregate: the STALEST root, never the agent's own and never a mean.
    otlpMetric({
      name: "catalyst.vcs.commits_behind.max",
      unit: "",
      description:
        "Commits behind origin/main of the STALEST executing checkout on this host (the host's single code-currency number).",
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
  // `commitsBehind` is the MAX (the host's answer); `checkouts` is the per-root
  // breakdown, so `--once` shows an operator WHICH tree is stale, not just that
  // one is.
  return { version: serviceVersion(), revision, commitsBehind: behind, checkouts };
}
