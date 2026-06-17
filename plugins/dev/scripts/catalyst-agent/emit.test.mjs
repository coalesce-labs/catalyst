// emit.test.mjs — CTL-812. catalyst-agent envelope builder + the two emit
// transports. buildAgentEnvelope is asserted against the telemetry contract
// without touching the FS; emitEventLog appends to a temp log; sendOtlp is
// exercised with an injected fetch (URL, headers, body structure, value types,
// never-throw on network error).
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test emit.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  buildAgentEnvelope,
  emitEventLog,
  sendOtlp,
  emitEnvelope,
  makeBuilderEmit,
  drainPending,
} from "./emit.mjs";

// A representative host.metrics spec exercising number + string attrs. Every
// number maps to doubleValue (CTL-812 review: one OTLP type per attribute key,
// no int/double oscillation when a metric happens to round to a whole number).
function hostSpec() {
  return {
    entity: "host",
    label: hostname(),
    attrs: {
      "host.cpu_pct": 12.5, // fractional → doubleValue
      "host.cpu_count": 10, // whole number → STILL doubleValue (pinned type)
      "host.load1": 2.0, // integer-valued → doubleValue
      "host.mem_used_mb": 8192,
    },
    payload: { sampledFrom: "test" },
  };
}

describe("buildAgentEnvelope — resource + severity (contract)", () => {
  test("resource carries catalyst.agent / catalyst / hostname", () => {
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    expect(env.resource["service.name"]).toBe("catalyst.agent");
    expect(env.resource["service.namespace"]).toBe("catalyst");
    expect(env.resource.hostname).toBe(hostname().replace(/\.local$/, ""));
  });

  test("severity is INFO / 9", () => {
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
  });

  test("id / traceId / spanId are random hex of the expected widths", () => {
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    expect(env.id).toMatch(/^[0-9a-f]{16}$/);
    expect(env.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(env.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("ts is Z-suffixed with no millisecond fraction; injectable now() overrides", () => {
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const fixed = "2026-06-06T12:00:00Z";
    const env2 = buildAgentEnvelope("host.metrics.sampled", hostSpec(), { now: () => fixed });
    expect(env2.ts).toBe(fixed);
    expect(env2.observedTs).toBe(fixed);
  });
});

describe("buildAgentEnvelope — event.* identity (contract)", () => {
  test("event.name / entity / action / label are always present", () => {
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    const a = env.attributes;
    expect(a["event.name"]).toBe("host.metrics.sampled");
    expect(a["event.entity"]).toBe("host");
    expect(a["event.action"]).toBe("metrics.sampled"); // entity prefix stripped
    expect(a["event.label"]).toBe(hostname());
  });

  test("action strips only the leading <entity>. segment", () => {
    const env = buildAgentEnvelope("account.ratelimit.sampled", { entity: "account", label: "x" });
    expect(env.attributes["event.action"]).toBe("ratelimit.sampled");
  });

  test("event.label falls back to 'unknown' when label absent", () => {
    const env = buildAgentEnvelope("host.process.sampled", { entity: "host" });
    expect(env.attributes["event.label"]).toBe("unknown");
  });
});

describe("buildAgentEnvelope — attrs only when non-null (put pattern)", () => {
  test("null and undefined attrs are dropped; zero is preserved", () => {
    const env = buildAgentEnvelope("host.metrics.sampled", {
      entity: "host",
      label: "h",
      attrs: {
        "host.cpu_pct": 0, // preserved (not dropped as falsy)
        "host.load1": null, // dropped
        "host.mem_used_mb": undefined, // dropped
        "host.disk_used_pct": 51.2, // kept
      },
    });
    const a = env.attributes;
    expect(a["host.cpu_pct"]).toBe(0);
    expect("host.load1" in a).toBe(false);
    expect("host.mem_used_mb" in a).toBe(false);
    expect(a["host.disk_used_pct"]).toBe(51.2);
  });

  test("body.payload is mirrored verbatim", () => {
    const env = buildAgentEnvelope("host.process.sampled", {
      entity: "host",
      label: "h",
      attrs: { "process.command": "node" },
      payload: { pid: 1234, ppid: 1, args: "node x.mjs --once" },
    });
    expect(env.body.payload).toEqual({ pid: 1234, ppid: 1, args: "node x.mjs --once" });
  });
});

describe("emitEventLog", () => {
  test("appends exactly one valid JSON line and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl812-el-"));
    const logPath = join(dir, "2026-06.jsonl");
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    expect(emitEventLog(env, { logPath })).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.attributes["event.name"]).toBe("host.metrics.sampled");
    expect(parsed.resource["service.name"]).toBe("catalyst.agent");
  });

  test("creates the parent directory when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl812-el-"));
    const logPath = join(dir, "nested", "deep", "2026-06.jsonl");
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    expect(emitEventLog(env, { logPath })).toBe(true);
    expect(readFileSync(logPath, "utf8").trim().split("\n").length).toBe(1);
  });

  test("returns false and does not throw for an unwritable logPath", () => {
    // Passing a directory as the logPath makes appendFileSync throw EISDIR.
    const dir = mkdtempSync(join(tmpdir(), "ctl812-el-bad-"));
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    let result;
    expect(() => {
      result = emitEventLog(env, { logPath: dir });
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

describe("sendOtlp — mapping correctness with injected fetch", () => {
  function captureFetch(status = 200) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status };
    };
    return { calls, fetchImpl };
  }

  test("POSTs to <endpoint>/v1/logs with merged headers and a JSON body", async () => {
    const { calls, fetchImpl } = captureFetch(200);
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    const ok = await sendOtlp([env], {
      endpoint: "http://localhost:4318/",
      headers: { "x-api-key": "k" },
      fetchImpl,
    });
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    // Trailing slash on endpoint is collapsed to a single /v1/logs.
    expect(calls[0].url).toBe("http://localhost:4318/v1/logs");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(calls[0].init.headers["x-api-key"]).toBe("k");
  });

  test("body maps the envelope to OTLP resourceLogs/scopeLogs/logRecords", async () => {
    const { calls, fetchImpl } = captureFetch(200);
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec(), {
      now: () => "2026-06-06T12:00:00Z",
    });
    await sendOtlp([env], { endpoint: "http://x:4318", fetchImpl });
    const body = JSON.parse(calls[0].init.body);

    const rl = body.resourceLogs[0];
    // resource attributes carry through as KeyValue[].
    const resKeys = Object.fromEntries(rl.resource.attributes.map((kv) => [kv.key, kv.value]));
    expect(resKeys["service.name"]).toEqual({ stringValue: "catalyst.agent" });
    expect(resKeys["service.namespace"]).toEqual({ stringValue: "catalyst" });

    const rec = rl.scopeLogs[0].logRecords[0];
    expect(rec.severityNumber).toBe(9);
    expect(rec.severityText).toBe("INFO");
    // timeUnixNano = ms-since-epoch * 1e6, as a string.
    expect(rec.timeUnixNano).toBe(String(Date.parse("2026-06-06T12:00:00Z") * 1_000_000));
    // body is the bare event name — the otel-forward convention, so the
    // dashboards' LogQL line filters (|= "host.metrics.sampled") match the
    // direct-OTLP path exactly like the event-log path (CTL-812).
    expect(rec.body.stringValue).toBe("host.metrics.sampled");
  });

  test("every number → doubleValue (one type per key); strings → stringValue", async () => {
    // CTL-812 review: a metric that rounds to a whole number (process.rss_mb 512)
    // must NOT switch to intValue — the same attribute key would then carry
    // intValue on one tick and doubleValue on another, an int/double oscillation
    // that strict OTLP consumers reject. doubleValue is valid for every number.
    const { calls, fetchImpl } = captureFetch(200);
    const env = buildAgentEnvelope("host.process.sampled", {
      entity: "host",
      label: "h",
      attrs: {
        "process.command": "node", // string
        "process.cpu_pct": 12.5, // fractional → doubleValue
        "process.rss_mb": 512, // whole number → STILL doubleValue
      },
    });
    await sendOtlp([env], { endpoint: "http://x:4318", fetchImpl });
    const rec = JSON.parse(calls[0].init.body).resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = Object.fromEntries(rec.attributes.map((kv) => [kv.key, kv.value]));
    expect(attrs["process.command"]).toEqual({ stringValue: "node" });
    expect(attrs["process.cpu_pct"]).toEqual({ doubleValue: 12.5 });
    expect(attrs["process.rss_mb"]).toEqual({ doubleValue: 512 });
    expect(attrs["event.name"]).toEqual({ stringValue: "host.process.sampled" });
  });

  test("batches multiple envelopes into one resourceLogs entry", async () => {
    const { calls, fetchImpl } = captureFetch(200);
    const a = buildAgentEnvelope("host.process.sampled", { entity: "host", label: "h", attrs: { "process.command": "node" } });
    const b = buildAgentEnvelope("host.process.sampled", { entity: "host", label: "h", attrs: { "process.command": "bun" } });
    await sendOtlp([a, b], { endpoint: "http://x:4318", fetchImpl });
    const records = JSON.parse(calls[0].init.body).resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.length).toBe(2);
  });

  test("a non-2xx status returns false (never throws)", async () => {
    const { fetchImpl } = captureFetch(500);
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    await expect(sendOtlp([env], { endpoint: "http://x:4318", fetchImpl })).resolves.toBe(false);
  });

  test("a throwing fetch returns false (never throws)", async () => {
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(sendOtlp([env], { endpoint: "http://x:4318", fetchImpl })).resolves.toBe(false);
  });

  test("no endpoint or empty batch returns false without calling fetch", async () => {
    const { calls, fetchImpl } = captureFetch(200);
    const env = buildAgentEnvelope("host.metrics.sampled", hostSpec());
    expect(await sendOtlp([env], { endpoint: "", fetchImpl })).toBe(false);
    expect(await sendOtlp([], { endpoint: "http://x:4318", fetchImpl })).toBe(false);
    expect(calls.length).toBe(0);
  });
});

// ─── emitEnvelope — the mode router (CTL-812 review: was never exercised) ──────

describe("emitEnvelope — eventlog | otlp | both router", () => {
  // emitEnvelope routes by config.emit through the REAL transports: emitEventLog
  // (CATALYST_DIR-relative monthly log) and sendOtlp (globalThis.fetch). We point
  // CATALYST_DIR at a temp dir and monkeypatch fetch so both transports are real
  // but isolated. Env + fetch are saved/restored so the suite is order-independent.
  let dir;
  let realFetch;
  let posts;
  const savedCatalystDir = { v: undefined };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl812-router-"));
    savedCatalystDir.v = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = dir;
    realFetch = globalThis.fetch;
    posts = [];
    globalThis.fetch = async (url, init) => {
      posts.push({ url, init });
      return { status: 200 };
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedCatalystDir.v === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = savedCatalystDir.v;
  });

  function monthlyLog() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(dir, "events", `${ym}.jsonl`);
  }
  function env() {
    return buildAgentEnvelope("host.metrics.sampled", hostSpec());
  }
  const cfg = (emit) => ({ emit, otlpEndpoint: "http://127.0.0.1:4318", otlpHeaders: {} });

  test("eventlog mode writes the log and issues NO POST; returns null", async () => {
    const ret = emitEnvelope(env(), cfg("eventlog"));
    expect(ret).toBeNull(); // no OTLP promise to await
    expect(existsSync(monthlyLog())).toBe(true);
    expect(readFileSync(monthlyLog(), "utf8").trim().split("\n").length).toBe(1);
    expect(posts.length).toBe(0);
  });

  test("otlp mode POSTs and does NOT write the log; returns an awaitable promise", async () => {
    const ret = emitEnvelope(env(), cfg("otlp"));
    expect(ret).not.toBeNull();
    expect(typeof ret.then).toBe("function");
    await ret; // drain the POST
    expect(posts.length).toBe(1);
    expect(posts[0].url).toBe("http://127.0.0.1:4318/v1/logs");
    expect(existsSync(monthlyLog())).toBe(false);
  });

  test("both mode writes the log AND POSTs (returns the POST promise)", async () => {
    const ret = emitEnvelope(env(), cfg("both"));
    expect(ret).not.toBeNull();
    await ret;
    expect(existsSync(monthlyLog())).toBe(true);
    expect(posts.length).toBe(1);
  });

  test("an unrecognized / missing emit mode does nothing (no log, no POST)", async () => {
    expect(emitEnvelope(env(), { emit: "carrier-pigeon" })).toBeNull();
    expect(emitEnvelope(env(), undefined)).toBeNull();
    expect(existsSync(monthlyLog())).toBe(false);
    expect(posts.length).toBe(0);
  });

  test("otlp mode never throws even when fetch rejects (returns false)", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const ret = emitEnvelope(env(), cfg("otlp"));
    await expect(ret).resolves.toBe(false);
  });
});

// ─── makeBuilderEmit — adapter + pending collection (was never referenced) ────

describe("makeBuilderEmit", () => {
  let realFetch;
  let posts;
  let savedDir;
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl812-builder-"));
    savedDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = dir;
    realFetch = globalThis.fetch;
    posts = [];
    globalThis.fetch = async (url, init) => {
      posts.push({ url, init });
      return { status: 200 };
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = savedDir;
  });

  const cfg = (emit) => ({ emit, otlpEndpoint: "http://127.0.0.1:4318", otlpHeaders: {} });

  test("builds the envelope from (name, spec, opts) and returns it", () => {
    const emit = makeBuilderEmit(cfg("eventlog"));
    const fixed = "2026-06-06T12:00:00Z";
    const e = emit(
      "host.metrics.sampled",
      { entity: "host", label: "h", attrs: { "host.cpu_pct": 12.5 } },
      { now: () => fixed },
    );
    expect(e.attributes["event.name"]).toBe("host.metrics.sampled");
    expect(e.attributes["host.cpu_pct"]).toBe(12.5);
    expect(e.ts).toBe(fixed); // opts.now forwarded into the envelope
  });

  test("collects the OTLP POST promise into `pending` so the caller can drain it", async () => {
    const pending = [];
    const emit = makeBuilderEmit(cfg("otlp"), { pending });
    emit("host.metrics.sampled", { entity: "host", label: "h", attrs: { "host.cpu_pct": 1 } });
    expect(pending.length).toBe(1);
    expect(typeof pending[0].then).toBe("function");
    await drainPending(pending);
    expect(posts.length).toBe(1);
  });

  test("eventlog mode pushes nothing into `pending` (synchronous transport)", () => {
    const pending = [];
    const emit = makeBuilderEmit(cfg("eventlog"), { pending });
    emit("host.metrics.sampled", { entity: "host", label: "h", attrs: { "host.cpu_pct": 1 } });
    expect(pending.length).toBe(0);
  });
});

// ─── drainPending — best-effort await of collected OTLP POSTs ─────────────────

describe("drainPending", () => {
  test("awaits every pending promise before resolving", async () => {
    let settled = 0;
    const pending = [0, 0, 0].map(
      () => new Promise((r) => setTimeout(() => { settled++; r(true); }, 5)),
    );
    await drainPending(pending);
    expect(settled).toBe(3);
  });

  test("a rejected pending promise does not make drainPending throw", async () => {
    const pending = [Promise.reject(new Error("boom")), Promise.resolve(true)];
    await expect(drainPending(pending)).resolves.toBeUndefined();
  });

  test("an empty / non-array argument is a no-op (never throws)", async () => {
    await expect(drainPending([])).resolves.toBeUndefined();
    await expect(drainPending(undefined)).resolves.toBeUndefined();
  });
});

// ─── shortHostname (CTL-812 multi-host) ──────────────────────────────────────
import { shortHostname } from "./emit.mjs";
import { hostname as osHostname } from "node:os";

describe("shortHostname", () => {
  test("never carries the macOS .local suffix (matches Claude Code's native hostname)", () => {
    expect(shortHostname().endsWith(".local")).toBe(false);
    expect(shortHostname()).toBe(osHostname().replace(/\.local$/, ""));
  });

  test("envelope resource hostname uses the normalized form", () => {
    const env = buildAgentEnvelope("host.metrics.sampled", { entity: "host", label: "x", attrs: {}, payload: {} });
    expect(env.resource.hostname).toBe(shortHostname());
    expect(env.resource.hostname.endsWith(".local")).toBe(false);
  });
});

// ─── OTLP metrics transport (CTL-1227) ───────────────────────────────────────
import { otlpMetric, sendOtlpMetrics, emitMetrics, metricResource } from "./emit.mjs";

describe("otlpMetric — semconv metric shape", () => {
  test("gauge wraps points under .gauge with asDouble + dropped-null attrs", () => {
    const m = otlpMetric({
      name: "system.cpu.utilization",
      unit: "1",
      kind: "gauge",
      points: [{ value: 0.5, attrs: { "system.cpu.state": "used", absent: null }, timeUnixNano: "1000" }],
    });
    expect(m.name).toBe("system.cpu.utilization");
    expect(m.unit).toBe("1");
    expect(m.gauge.dataPoints[0].asDouble).toBe(0.5);
    expect(m.gauge.dataPoints[0].timeUnixNano).toBe("1000");
    // null attr dropped; non-null kept
    const keys = m.gauge.dataPoints[0].attributes.map((a) => a.key);
    expect(keys).toContain("system.cpu.state");
    expect(keys).not.toContain("absent");
  });

  test("sum is non-monotonic cumulative by default", () => {
    const m = otlpMetric({ name: "system.filesystem.usage", unit: "By", kind: "sum", points: [{ value: 10, timeUnixNano: "1" }] });
    expect(m.sum.isMonotonic).toBe(false);
    expect(m.sum.aggregationTemporality).toBe(2);
  });

  test("points with null / non-finite values are dropped; a metric with no points returns null", () => {
    const m = otlpMetric({
      name: "system.memory.usage",
      unit: "By",
      kind: "sum",
      points: [
        { value: 100, attrs: { "system.memory.state": "used" }, timeUnixNano: "1" },
        { value: null, attrs: { "system.memory.state": "free" }, timeUnixNano: "1" },
      ],
    });
    expect(m.sum.dataPoints.length).toBe(1);
    expect(otlpMetric({ name: "x", kind: "gauge", points: [{ value: null, timeUnixNano: "1" }] })).toBe(null);
    expect(otlpMetric({ name: "x", kind: "gauge", points: [] })).toBe(null);
  });
});

describe("sendOtlpMetrics — OTLP /v1/metrics POST", () => {
  const metric = otlpMetric({ name: "system.cpu.utilization", unit: "1", kind: "gauge", points: [{ value: 0.25, timeUnixNano: "5" }] });

  test("POSTs resourceMetrics → scopeMetrics → metrics to <endpoint>/v1/metrics", async () => {
    let captured;
    const fetchImpl = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
      return { status: 200 };
    };
    const ok = await sendOtlpMetrics([metric], { endpoint: "http://collector:4318/", fetchImpl });
    expect(ok).toBe(true);
    expect(captured.url).toBe("http://collector:4318/v1/metrics"); // trailing slash collapsed
    const rm = captured.body.resourceMetrics[0];
    expect(rm.scopeMetrics[0].scope.name).toBe("catalyst-agent");
    expect(rm.scopeMetrics[0].metrics[0].name).toBe("system.cpu.utilization");
    expect(rm.resource.attributes.some((a) => a.key === "service.name")).toBe(true);
  });

  test("no endpoint / empty metrics / null-filtered → false (no POST)", async () => {
    const fetchImpl = async () => ({ status: 200 });
    expect(await sendOtlpMetrics([metric], { endpoint: "", fetchImpl })).toBe(false);
    expect(await sendOtlpMetrics([], { endpoint: "http://c/", fetchImpl })).toBe(false);
    expect(await sendOtlpMetrics([null, null], { endpoint: "http://c/", fetchImpl })).toBe(false);
  });

  test("non-2xx → false; a throwing fetch is swallowed → false (never throws)", async () => {
    expect(await sendOtlpMetrics([metric], { endpoint: "http://c", fetchImpl: async () => ({ status: 500 }) })).toBe(false);
    expect(await sendOtlpMetrics([metric], { endpoint: "http://c", fetchImpl: async () => { throw new Error("down"); } })).toBe(false);
  });

  test("metricResource carries the service + host identity", () => {
    const r = metricResource();
    expect(r["service.name"]).toBe("catalyst.agent");
    expect(r["service.namespace"]).toBe("catalyst");
    expect(typeof r.hostname).toBe("string");
    // CTL-1235: the running semver rides the shared metric resource (semconv
    // service.version) when resolvable, so any metric can be grouped by version.
    expect(r["service.version"]).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("emitMetrics — endpoint gating (decoupled from event emit mode)", () => {
  const metric = otlpMetric({ name: "m", unit: "1", kind: "gauge", points: [{ value: 1, timeUnixNano: "1" }] });
  test("no metrics endpoint → null (even in otlp/both event mode)", () => {
    expect(emitMetrics([metric], { emit: "eventlog" })).toBe(null);
    expect(emitMetrics([metric], { emit: "otlp", otlpEndpoint: null, metricsEndpoint: null })).toBe(null);
    expect(emitMetrics([metric], { emit: "both", metricsEndpoint: null })).toBe(null);
  });
  test("metricsEndpoint set → emits, EVEN when the event mode is eventlog-only (the CTL-1227 fix)", () => {
    expect(emitMetrics([metric], { emit: "eventlog", metricsEndpoint: "http://c:4318" })).not.toBe(null);
  });
  test("falls back to otlpEndpoint when metricsEndpoint is unset", () => {
    expect(emitMetrics([metric], { emit: "eventlog", otlpEndpoint: "http://c:4318" })).not.toBe(null);
  });
});
