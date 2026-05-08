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
});
