// CTL-920 / HUD2 + CTL-1346: the HUD resolves the orch-monitor read-model SSE URL
// the same way the server binds its port (MONITOR_PORT env, else 7400), now
// node-class + Layer-2 aware. Pure + injectable so we never touch process.env, the
// filesystem, or node class here — those are passed in.
import { describe, it, expect } from "bun:test";
import {
  resolveReadModelBase,
  resolveReadModelStreamUrl,
  DEFAULT_MONITOR_PORT,
} from "./read-model-url";

const STREAM = "/api/board/stream";

describe("resolveReadModelStreamUrl — port/default resolution (CTL-920)", () => {
  it("defaults to the loopback host on the server's default port (no class ⇒ worker-like)", () => {
    const r = resolveReadModelStreamUrl({ env: {} });
    expect(r).toEqual({
      ok: true,
      base: `http://127.0.0.1:${DEFAULT_MONITOR_PORT}`,
      url: `http://127.0.0.1:${DEFAULT_MONITOR_PORT}${STREAM}`,
    });
  });

  it("honours MONITOR_PORT exactly as server.ts does", () => {
    const r = resolveReadModelStreamUrl({ env: { MONITOR_PORT: "8123" } });
    expect(r.ok && r.url).toBe(`http://127.0.0.1:8123${STREAM}`);
  });

  it("falls back to the default port when MONITOR_PORT is empty or non-numeric", () => {
    for (const port of ["", "not-a-port", "-5", "0"]) {
      const r = resolveReadModelStreamUrl({ env: { MONITOR_PORT: port } });
      expect(r.ok && r.url).toBe(`http://127.0.0.1:${DEFAULT_MONITOR_PORT}${STREAM}`);
    }
  });

  it("an explicit CATALYST_MONITOR_URL base wins over the port (remote/proxied server)", () => {
    const r = resolveReadModelStreamUrl({ env: { CATALYST_MONITOR_URL: "http://mac-mini.local:9000" } });
    expect(r.ok && r.url).toBe(`http://mac-mini.local:9000${STREAM}`);
  });

  it("trims a trailing slash on the base URL so the path is not doubled", () => {
    const r = resolveReadModelStreamUrl({ env: { CATALYST_MONITOR_URL: "http://host:9000/" } });
    expect(r.ok && r.url).toBe(`http://host:9000${STREAM}`);
  });
});

describe("resolveReadModelBase — Layer-2 binding + class-aware fallback (CTL-1346)", () => {
  it("binds catalyst.readReplica.baseUrl (Layer-2) when no env override is set", () => {
    expect(resolveReadModelBase({ env: {}, layer2BaseUrl: "http://mini:7400" })).toEqual({
      ok: true,
      base: "http://mini:7400",
    });
  });

  it("CATALYST_MONITOR_URL env still wins over the Layer-2 baseUrl", () => {
    const r = resolveReadModelBase({
      env: { CATALYST_MONITOR_URL: "http://from-env:7400" },
      layer2BaseUrl: "http://from-layer2:7400",
    });
    expect(r).toEqual({ ok: true, base: "http://from-env:7400" });
  });

  it("trims a trailing slash on a Layer-2 baseUrl", () => {
    expect(resolveReadModelBase({ env: {}, layer2BaseUrl: "http://mini:7400/" })).toEqual({
      ok: true,
      base: "http://mini:7400",
    });
  });

  it("a developer node with NO endpoint configured returns ok:false (no silent localhost)", () => {
    const r = resolveReadModelBase({ env: {}, nodeClass: "developer" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("developer node");
    // the whole point: it must NOT produce a localhost base
    expect(JSON.stringify(r)).not.toContain("127.0.0.1");
  });

  it("a developer node WITH a configured endpoint resolves normally (env or Layer-2)", () => {
    expect(resolveReadModelBase({ env: { CATALYST_MONITOR_URL: "http://mini:7400" }, nodeClass: "developer" })).toEqual({
      ok: true,
      base: "http://mini:7400",
    });
    expect(resolveReadModelBase({ env: {}, layer2BaseUrl: "http://mini:7400", nodeClass: "developer" })).toEqual({
      ok: true,
      base: "http://mini:7400",
    });
  });

  it("worker / monitor / unknown class with no endpoint keeps the localhost default", () => {
    for (const nodeClass of ["worker", "monitor", undefined] as const) {
      expect(resolveReadModelBase({ env: {}, nodeClass })).toEqual({
        ok: true,
        base: `http://127.0.0.1:${DEFAULT_MONITOR_PORT}`,
      });
    }
  });

  it("resolveReadModelStreamUrl propagates the developer ok:false unchanged", () => {
    const r = resolveReadModelStreamUrl({ env: {}, nodeClass: "developer" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("developer node");
  });
});
