// config.test.mjs — CTL-812. catalyst-agent config: readAgentConfig() defaults +
// overrides (emit mode, OTLP endpoint/headers, interval floor, topN floor, per-
// domain toggles) and getEventLogPath() with the CATALYST_DIR override.
// All env is saved/restored so the suite is order-independent.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test config.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readAgentConfig, getEventLogPath } from "./config.mjs";

const ENVS = [
  "CATALYST_AGENT_EMIT",
  "CATALYST_AGENT_OTLP_ENDPOINT",
  "CATALYST_AGENT_OTLP_HEADERS",
  "CATALYST_AGENT_INTERVAL_MS",
  "CATALYST_AGENT_TOP_N",
  "CATALYST_AGENT_USAGE",
  "CATALYST_AGENT_HOST",
  "CATALYST_AGENT_PROCESS",
  "CATALYST_DIR",
];
let saved = {};

beforeEach(() => {
  for (const k of ENVS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  saved = {};
});

describe("readAgentConfig — defaults", () => {
  test("returns the documented defaults when env is unset", () => {
    const cfg = readAgentConfig();
    expect(cfg.emit).toBe("eventlog");
    expect(cfg.otlpEndpoint).toBe(null);
    expect(cfg.otlpHeaders).toEqual({});
    expect(cfg.intervalMs).toBe(300000);
    expect(cfg.topN).toBe(10);
    expect(cfg.usageEnabled).toBe(true);
    expect(cfg.hostEnabled).toBe(true);
    expect(cfg.processEnabled).toBe(true);
  });
});

describe("readAgentConfig — emit mode", () => {
  test("otlp and both are honored (case-insensitive)", () => {
    process.env.CATALYST_AGENT_EMIT = "otlp";
    expect(readAgentConfig().emit).toBe("otlp");
    process.env.CATALYST_AGENT_EMIT = "BOTH";
    expect(readAgentConfig().emit).toBe("both");
  });

  test("an unrecognized mode falls back to eventlog", () => {
    process.env.CATALYST_AGENT_EMIT = "carrier-pigeon";
    expect(readAgentConfig().emit).toBe("eventlog");
  });
});

describe("readAgentConfig — interval floor", () => {
  test("a value above the floor is honored", () => {
    process.env.CATALYST_AGENT_INTERVAL_MS = "600000";
    expect(readAgentConfig().intervalMs).toBe(600000);
  });

  test("a value below the 180000 floor is clamped up", () => {
    process.env.CATALYST_AGENT_INTERVAL_MS = "1000";
    expect(readAgentConfig().intervalMs).toBe(180000);
  });

  test("a non-numeric interval falls back to the 300000 default", () => {
    process.env.CATALYST_AGENT_INTERVAL_MS = "soon";
    expect(readAgentConfig().intervalMs).toBe(300000);
  });

  test("zero falls back to the default (then is above the floor)", () => {
    process.env.CATALYST_AGENT_INTERVAL_MS = "0";
    expect(readAgentConfig().intervalMs).toBe(300000);
  });
});

describe("readAgentConfig — topN floor", () => {
  test("a positive value is honored (floored to an integer)", () => {
    process.env.CATALYST_AGENT_TOP_N = "25";
    expect(readAgentConfig().topN).toBe(25);
    process.env.CATALYST_AGENT_TOP_N = "7.9";
    expect(readAgentConfig().topN).toBe(7);
  });

  test("zero / negative / non-numeric clamp to at least 1", () => {
    process.env.CATALYST_AGENT_TOP_N = "0";
    expect(readAgentConfig().topN).toBe(10); // 0 → default 10
    process.env.CATALYST_AGENT_TOP_N = "-5";
    expect(readAgentConfig().topN).toBe(10); // negative → default 10
    process.env.CATALYST_AGENT_TOP_N = "lots";
    expect(readAgentConfig().topN).toBe(10); // non-numeric → default 10
  });
});

describe("readAgentConfig — OTLP endpoint + headers", () => {
  test("endpoint passes through; empty string is null", () => {
    process.env.CATALYST_AGENT_OTLP_ENDPOINT = "http://localhost:4318";
    expect(readAgentConfig().otlpEndpoint).toBe("http://localhost:4318");
    process.env.CATALYST_AGENT_OTLP_ENDPOINT = "";
    expect(readAgentConfig().otlpEndpoint).toBe(null);
  });

  test("headers parse from a k=v,k=v list (whitespace-tolerant)", () => {
    process.env.CATALYST_AGENT_OTLP_HEADERS = "x-api-key=abc, x-tenant = t1 ";
    expect(readAgentConfig().otlpHeaders).toEqual({ "x-api-key": "abc", "x-tenant": "t1" });
  });

  test("a value containing '=' keeps everything after the first '='", () => {
    process.env.CATALYST_AGENT_OTLP_HEADERS = "authorization=Basic dXNlcjpwYXNz==";
    expect(readAgentConfig().otlpHeaders).toEqual({ authorization: "Basic dXNlcjpwYXNz==" });
  });

  test("a malformed pair (no '=') is skipped", () => {
    process.env.CATALYST_AGENT_OTLP_HEADERS = "good=1,broken,also=2";
    expect(readAgentConfig().otlpHeaders).toEqual({ good: "1", also: "2" });
  });
});

describe("readAgentConfig — domain toggles", () => {
  test("CATALYST_AGENT_USAGE=0 disables usage only", () => {
    process.env.CATALYST_AGENT_USAGE = "0";
    const cfg = readAgentConfig();
    expect(cfg.usageEnabled).toBe(false);
    expect(cfg.hostEnabled).toBe(true);
    expect(cfg.processEnabled).toBe(true);
  });

  test("CATALYST_AGENT_HOST=0 disables host only", () => {
    process.env.CATALYST_AGENT_HOST = "0";
    const cfg = readAgentConfig();
    expect(cfg.hostEnabled).toBe(false);
    expect(cfg.usageEnabled).toBe(true);
    expect(cfg.processEnabled).toBe(true);
  });

  test("CATALYST_AGENT_PROCESS=0 disables process only", () => {
    process.env.CATALYST_AGENT_PROCESS = "0";
    const cfg = readAgentConfig();
    expect(cfg.processEnabled).toBe(false);
    expect(cfg.usageEnabled).toBe(true);
    expect(cfg.hostEnabled).toBe(true);
  });

  test("any non-zero value keeps a domain enabled", () => {
    process.env.CATALYST_AGENT_USAGE = "1";
    process.env.CATALYST_AGENT_HOST = "true";
    expect(readAgentConfig().usageEnabled).toBe(true);
    expect(readAgentConfig().hostEnabled).toBe(true);
  });
});

describe("getEventLogPath", () => {
  test("defaults under ~/catalyst/events with a UTC YYYY-MM file", () => {
    const p = getEventLogPath();
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(p).toBe(resolve(homedir(), "catalyst", "events", `${ym}.jsonl`));
  });

  test("CATALYST_DIR overrides the root", () => {
    process.env.CATALYST_DIR = "/tmp/ctl812-fake-catalyst";
    const p = getEventLogPath();
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(p).toBe(resolve("/tmp/ctl812-fake-catalyst", "events", `${ym}.jsonl`));
  });
});
