// config-liveness-source.test.mjs — CTL-1420 (#17). getLivenessReadSource +
// getLokiQueryUrl resolution (env-driven; safe-rollout default; port swap).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getLivenessReadSource, getLokiQueryUrl } from "../config.mjs";

const ENVS = ["CATALYST_LIVENESS_READ_SOURCE", "CATALYST_LOKI_QUERY_URL", "OTEL_EXPORTER_OTLP_ENDPOINT"];
let saved = {};
beforeEach(() => { for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } saved = {}; });

describe("getLivenessReadSource (CTL-1420 #17)", () => {
  test("defaults to 'linear' (safe rollout — opt-in loki)", () => {
    expect(getLivenessReadSource()).toBe("linear");
  });
  test("'loki' (any case / whitespace) selects loki; anything else → linear", () => {
    process.env.CATALYST_LIVENESS_READ_SOURCE = "  LOKI ";
    expect(getLivenessReadSource()).toBe("loki");
    process.env.CATALYST_LIVENESS_READ_SOURCE = "linear";
    expect(getLivenessReadSource()).toBe("linear");
    process.env.CATALYST_LIVENESS_READ_SOURCE = "garbage";
    expect(getLivenessReadSource()).toBe("linear");
  });
});

describe("getLokiQueryUrl (CTL-1420 #17)", () => {
  test("explicit CATALYST_LOKI_QUERY_URL wins (trailing slash stripped)", () => {
    process.env.CATALYST_LOKI_QUERY_URL = "http://loki.example:3100/";
    expect(getLokiQueryUrl()).toBe("http://loki.example:3100");
  });
  test("derives :3100 from the OTLP :4318 endpoint (same host)", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://100.65.193.30:4318";
    expect(getLokiQueryUrl()).toBe("http://100.65.193.30:3100");
  });
  test("strips any OTLP path when deriving", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/v1/logs";
    expect(getLokiQueryUrl()).toBe("http://collector:3100");
  });
  test("no env → null (caller fails open)", () => {
    expect(getLokiQueryUrl()).toBe(null);
  });
});
