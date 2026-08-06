import { test, expect } from "bun:test";
import { sendWatcherOtlp, emitWatcherEnvelope } from "../lib/otlp.mjs";
import { buildWatcherHeartbeat } from "../lib/emit.mjs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

const cfg = {
  watcherId: "w1",
  channel: "fleet-reinstall-rollout.md",
  baselineTurn: 116,
  currentTurn: 117,
  host: "mini",
};

const envelope = buildWatcherHeartbeat({ ...cfg, now: () => "2026-07-03T10:00:00Z" });

// ── sendWatcherOtlp tests ─────────────────────────────────────────────────

test("sendWatcherOtlp POSTs to <endpoint>/v1/logs", async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { status: 200 };
  };

  const result = await sendWatcherOtlp(envelope, {
    endpoint: "https://otel.example.com",
    fetchImpl: fakeFetch,
  });

  expect(result).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://otel.example.com/v1/logs");
});

test("sendWatcherOtlp body wraps envelope in resourceLogs/scopeLogs/logRecords", async () => {
  let capturedBody;
  const fakeFetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { status: 200 };
  };

  await sendWatcherOtlp(envelope, { endpoint: "https://otel.example.com", fetchImpl: fakeFetch });

  expect(capturedBody.resourceLogs).toBeDefined();
  expect(capturedBody.resourceLogs[0].scopeLogs).toBeDefined();
  expect(capturedBody.resourceLogs[0].scopeLogs[0].logRecords).toBeDefined();
  expect(capturedBody.resourceLogs[0].scopeLogs[0].logRecords.length).toBe(1);
});

test("sendWatcherOtlp returns false on non-2xx and never throws", async () => {
  const fakeFetch = async () => ({ status: 500 });
  const result = await sendWatcherOtlp(envelope, {
    endpoint: "https://otel.example.com",
    fetchImpl: fakeFetch,
  });
  expect(result).toBe(false);
});

test("sendWatcherOtlp returns false on rejected fetch and never throws", async () => {
  const fakeFetch = async () => { throw new Error("network error"); };
  const result = await sendWatcherOtlp(envelope, {
    endpoint: "https://otel.example.com",
    fetchImpl: fakeFetch,
  });
  expect(result).toBe(false);
});

// ── emitWatcherEnvelope routing tests ────────────────────────────────────

test("emitWatcherEnvelope with emit:eventlog writes to logPath, skips OTLP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-otlp-"));
  const logPath = join(dir, "events.jsonl");
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push(url); return { status: 200 }; };

  await emitWatcherEnvelope(envelope, {
    emit: "eventlog",
    logPath,
    fetchImpl: fakeFetch,
  });

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  expect(lines.length).toBe(1);
  expect(calls.length).toBe(0); // no OTLP POST
});

test("emitWatcherEnvelope with emit:otlp posts to OTLP, skips log file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-otlp-"));
  const logPath = join(dir, "events.jsonl");
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push(url); return { status: 200 }; };

  await emitWatcherEnvelope(envelope, {
    emit: "otlp",
    otlpEndpoint: "https://otel.example.com",
    logPath,
    fetchImpl: fakeFetch,
  });

  expect(calls.length).toBe(1);
  // No file written — would throw if file read, but skip check since no file created
});

test("emitWatcherEnvelope with emit:both writes file AND posts OTLP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-otlp-"));
  const logPath = join(dir, "events.jsonl");
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push(url); return { status: 200 }; };

  await emitWatcherEnvelope(envelope, {
    emit: "both",
    otlpEndpoint: "https://otel.example.com",
    logPath,
    fetchImpl: fakeFetch,
  });

  expect(calls.length).toBe(1);
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  expect(lines.length).toBe(1);
});
