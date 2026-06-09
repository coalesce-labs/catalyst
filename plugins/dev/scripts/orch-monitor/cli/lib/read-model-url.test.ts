// CTL-920 / HUD2: the HUD resolves the local orch-monitor server's read-model
// SSE URL the same way the server binds its port — MONITOR_PORT env, else the
// 7400 default — so the HUD's new client path points at the exact stream the
// web/iPad consume. Pure + env-injectable so we never touch process.env in tests.
import { describe, it, expect } from "bun:test";
import { resolveReadModelUrl, DEFAULT_MONITOR_PORT } from "./read-model-url";

describe("resolveReadModelUrl (CTL-920)", () => {
  it("defaults to the loopback host on the server's default port", () => {
    expect(resolveReadModelUrl({})).toBe(
      `http://127.0.0.1:${DEFAULT_MONITOR_PORT}/api/board/stream`,
    );
  });

  it("honours MONITOR_PORT exactly as server.ts does", () => {
    expect(resolveReadModelUrl({ MONITOR_PORT: "8123" })).toBe(
      "http://127.0.0.1:8123/api/board/stream",
    );
  });

  it("falls back to the default port when MONITOR_PORT is empty or non-numeric", () => {
    expect(resolveReadModelUrl({ MONITOR_PORT: "" })).toBe(
      `http://127.0.0.1:${DEFAULT_MONITOR_PORT}/api/board/stream`,
    );
    expect(resolveReadModelUrl({ MONITOR_PORT: "not-a-port" })).toBe(
      `http://127.0.0.1:${DEFAULT_MONITOR_PORT}/api/board/stream`,
    );
  });

  it("an explicit CATALYST_MONITOR_URL base wins over the port (remote/proxied server)", () => {
    expect(resolveReadModelUrl({ CATALYST_MONITOR_URL: "http://mac-mini.local:9000" })).toBe(
      "http://mac-mini.local:9000/api/board/stream",
    );
  });

  it("trims a trailing slash on the base URL so the path is not doubled", () => {
    expect(resolveReadModelUrl({ CATALYST_MONITOR_URL: "http://host:9000/" })).toBe(
      "http://host:9000/api/board/stream",
    );
  });
});
