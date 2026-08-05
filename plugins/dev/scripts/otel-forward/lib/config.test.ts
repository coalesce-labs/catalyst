import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadForwarderConfig } from "./config.ts";

describe("loadForwarderConfig", () => {
  test("returns empty config when file absent", () => {
    const cfg = loadForwarderConfig("/nonexistent/path.json", "myproject");
    expect(cfg.otlp.enabled).toBe(false);
    expect(cfg.posthog.enabled).toBe(false);
    expect(cfg.cloudflareAE.enabled).toBe(false);
  });

  test("reads otlp.endpoint from config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-forward-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      catalyst: { observability: { forwarders: {
        otlp: { enabled: true, endpoint: "http://localhost:4318" }
      }}}
    }));
    const cfg = loadForwarderConfig(path, "myproject");
    expect(cfg.otlp.enabled).toBe(true);
    expect(cfg.otlp.endpoint).toBe("http://localhost:4318");
    rmSync(dir, { recursive: true });
  });

  test("OTEL_EXPORTER_OTLP_ENDPOINT env overrides config endpoint", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://override:4318";
    const cfg = loadForwarderConfig("/nonexistent", "myproject");
    expect(cfg.otlp.endpoint).toBe("http://override:4318");
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  // CTL-1506: new config knobs for status classification + age-partition
  test("lokiAcceptWindowMs defaults to 3_600_000", () => {
    const cfg = loadForwarderConfig("/nonexistent", "myproject");
    expect(cfg.otlp.lokiAcceptWindowMs).toBe(3_600_000);
  });

  test("maxRetryElapsedMs defaults to 60_000", () => {
    const cfg = loadForwarderConfig("/nonexistent", "myproject");
    expect(cfg.otlp.maxRetryElapsedMs).toBe(60_000);
  });

  test("config file lokiAcceptWindowMs overrides default", () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-forward-window-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      catalyst: { observability: { forwarders: {
        otlp: { enabled: true, endpoint: "http://localhost:4318", lokiAcceptWindowMs: 7_200_000 }
      }}}
    }));
    const cfg = loadForwarderConfig(path, "myproject");
    expect(cfg.otlp.lokiAcceptWindowMs).toBe(7_200_000);
    rmSync(dir, { recursive: true });
  });

  test("config file maxRetryElapsedMs overrides default", () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-forward-retry-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      catalyst: { observability: { forwarders: {
        otlp: { enabled: true, endpoint: "http://localhost:4318", maxRetryElapsedMs: 120_000 }
      }}}
    }));
    const cfg = loadForwarderConfig(path, "myproject");
    expect(cfg.otlp.maxRetryElapsedMs).toBe(120_000);
    rmSync(dir, { recursive: true });
  });
});
