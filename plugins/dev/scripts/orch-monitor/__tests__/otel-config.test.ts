import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadOtelConfig } from "../lib/otel-config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "otel-config-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OTEL_ENABLED;
  delete process.env.PROMETHEUS_URL;
  delete process.env.LOKI_URL;
});

describe("loadOtelConfig", () => {
  it("returns disabled config when no config file exists", () => {
    const cfg = loadOtelConfig(join(tmpDir, "nonexistent"));
    expect(cfg.enabled).toBe(false);
    expect(cfg.prometheusUrl).toBeNull();
    expect(cfg.lokiUrl).toBeNull();
  });

  it("reads otel config from config.json", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          enabled: true,
          prometheus: "http://localhost:9098",
          loki: "http://localhost:3100",
        },
      }),
    );
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.prometheusUrl).toBe("http://localhost:9098");
    expect(cfg.lokiUrl).toBe("http://localhost:3100");
  });

  it("defaults enabled to false when otel key exists but enabled is missing", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          prometheus: "http://localhost:9098",
        },
      }),
    );
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.prometheusUrl).toBe("http://localhost:9098");
  });

  it("returns disabled config when config.json has no otel key", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ someOther: "value" }),
    );
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.prometheusUrl).toBeNull();
    expect(cfg.lokiUrl).toBeNull();
  });

  it("handles malformed JSON gracefully", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "config.json"), "not json{{{");
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(false);
  });

  it("env vars override config file values", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          enabled: false,
          prometheus: "http://file-prom:9098",
          loki: "http://file-loki:3100",
        },
      }),
    );
    process.env.OTEL_ENABLED = "true";
    process.env.PROMETHEUS_URL = "http://env-prom:9098";
    process.env.LOKI_URL = "http://env-loki:3100";

    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.prometheusUrl).toBe("http://env-prom:9098");
    expect(cfg.lokiUrl).toBe("http://env-loki:3100");
  });

  it("env var OTEL_ENABLED=false overrides config file enabled=true", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ otel: { enabled: true } }),
    );
    process.env.OTEL_ENABLED = "false";
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(false);
  });

  it("strips trailing slashes from URLs", () => {
    process.env.PROMETHEUS_URL = "http://localhost:9098/";
    process.env.LOKI_URL = "http://localhost:3100///";
    const cfg = loadOtelConfig(join(tmpDir, "nonexistent"));
    expect(cfg.prometheusUrl).toBe("http://localhost:9098");
    expect(cfg.lokiUrl).toBe("http://localhost:3100");
  });
});
