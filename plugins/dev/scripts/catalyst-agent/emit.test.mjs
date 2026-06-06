// emit.test.mjs — CTL-812. catalyst-agent envelope builder + the two emit
// transports. buildAgentEnvelope is asserted against the telemetry contract
// without touching the FS; emitEventLog appends to a temp log; sendOtlp is
// exercised with an injected fetch (URL, headers, body structure, value types,
// never-throw on network error).
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test emit.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { buildAgentEnvelope, emitEventLog, sendOtlp } from "./emit.mjs";

// A representative host.metrics spec exercising int + float + string attrs.
function hostSpec() {
  return {
    entity: "host",
    label: hostname(),
    attrs: {
      "host.cpu_pct": 12.5, // float → doubleValue
      "host.cpu_count": 10, // int → intValue
      "host.load1": 2.0, // integer-valued float → intValue (Number.isInteger(2.0))
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
    expect(env.resource.hostname).toBe(hostname());
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
    // body is the JSON-stringified payload.
    expect(JSON.parse(rec.body.stringValue)).toEqual({ sampledFrom: "test" });
  });

  test("attribute value types: int → intValue, float → doubleValue, string → stringValue", async () => {
    const { calls, fetchImpl } = captureFetch(200);
    const env = buildAgentEnvelope("host.process.sampled", {
      entity: "host",
      label: "h",
      attrs: {
        "process.command": "node", // string
        "process.cpu_pct": 12.5, // float → doubleValue
        "process.rss_mb": 512, // int → intValue
      },
    });
    await sendOtlp([env], { endpoint: "http://x:4318", fetchImpl });
    const rec = JSON.parse(calls[0].init.body).resourceLogs[0].scopeLogs[0].logRecords[0];
    const attrs = Object.fromEntries(rec.attributes.map((kv) => [kv.key, kv.value]));
    expect(attrs["process.command"]).toEqual({ stringValue: "node" });
    expect(attrs["process.cpu_pct"]).toEqual({ doubleValue: 12.5 });
    expect(attrs["process.rss_mb"]).toEqual({ intValue: 512 });
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
