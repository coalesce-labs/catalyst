import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadOtelConfig, _resetDeprecationWarning } from "../lib/otel-config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "otel-config-test-"));
  _resetDeprecationWarning();
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

  it("reads otel config from config.json using new key names", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          enabled: true,
          prometheusUrl: "http://localhost:9098",
          lokiUrl: "http://localhost:3100",
        },
      }),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.prometheusUrl).toBe("http://localhost:9098");
    expect(cfg.lokiUrl).toBe("http://localhost:3100");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads otel config from config.json using deprecated key names with warning", () => {
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
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.prometheusUrl).toBe("http://localhost:9098");
    expect(cfg.lokiUrl).toBe("http://localhost:3100");
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("otel.prometheus");
    expect(msg).toContain("otel.loki");
    expect(msg).toContain("prometheusUrl");
    expect(msg).toContain("lokiUrl");
    warn.mockRestore();
  });

  it("prefers new keys over deprecated when both are present (no warning)", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          enabled: true,
          prometheus: "http://old-prom:9098",
          prometheusUrl: "http://new-prom:9098",
          loki: "http://old-loki:3100",
          lokiUrl: "http://new-loki:3100",
        },
      }),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadOtelConfig(tmpDir);
    expect(cfg.prometheusUrl).toBe("http://new-prom:9098");
    expect(cfg.lokiUrl).toBe("http://new-loki:3100");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("emits deprecation warning only once per process across multiple loads", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ otel: { enabled: true, prometheus: "http://p:9098" } }),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    loadOtelConfig(tmpDir);
    loadOtelConfig(tmpDir);
    loadOtelConfig(tmpDir);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("reads projectKey-scoped file first when projectKey is provided", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config-myproj.json"),
      JSON.stringify({
        otel: {
          enabled: true,
          prometheusUrl: "http://scoped-prom:9098",
          lokiUrl: "http://scoped-loki:3100",
        },
      }),
    );
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          enabled: true,
          prometheusUrl: "http://global-prom:9098",
          lokiUrl: "http://global-loki:3100",
        },
      }),
    );
    const cfg = loadOtelConfig(tmpDir, "myproj");
    expect(cfg.prometheusUrl).toBe("http://scoped-prom:9098");
    expect(cfg.lokiUrl).toBe("http://scoped-loki:3100");
  });

  it("falls back to global config.json when projectKey-scoped file is missing", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          enabled: true,
          prometheusUrl: "http://global-prom:9098",
          lokiUrl: "http://global-loki:3100",
        },
      }),
    );
    const cfg = loadOtelConfig(tmpDir, "nonexistent-proj");
    expect(cfg.prometheusUrl).toBe("http://global-prom:9098");
    expect(cfg.lokiUrl).toBe("http://global-loki:3100");
  });

  it("reads global file when projectKey is null", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: { enabled: true, prometheusUrl: "http://p:9098" },
      }),
    );
    const cfg = loadOtelConfig(tmpDir, null);
    expect(cfg.prometheusUrl).toBe("http://p:9098");
  });

  it("defaults enabled to false when otel key exists but enabled is missing", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        otel: {
          prometheusUrl: "http://localhost:9098",
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
          prometheusUrl: "http://file-prom:9098",
          lokiUrl: "http://file-loki:3100",
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
