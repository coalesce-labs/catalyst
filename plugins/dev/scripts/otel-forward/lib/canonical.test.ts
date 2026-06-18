import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

import { buildCanonicalEnvelope, nodeName } from "./canonical.ts";
import { buildOtlpPayload } from "./destinations/otlp.ts";

// CTL-1262: node-name resource tag on the otel-forward event path.
//
// nodeName() / hostName() resolution precedence (must match
// execution-core/config.mjs getHostName()):
//   1. CATALYST_HOST_NAME env
//   2. catalyst.host.name in the Layer-2 config (CATALYST_LAYER2_CONFIG_FILE)
//   3. os.hostname() reduced to its first DNS label
//
// hostName() reads the Layer-2 file via CATALYST_LAYER2_CONFIG_FILE, so the
// tests point it at a temp file rather than touching the real machine config.

const ENV_KEYS = ["CATALYST_HOST_NAME", "CATALYST_LAYER2_CONFIG_FILE"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function osLabel(): string {
  const base = hostname();
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

describe("nodeName() resolution (mirrors getHostName())", () => {
  test("precedence 1: CATALYST_HOST_NAME env wins", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    expect(nodeName()).toBe("mini");
  });

  test("precedence 2: catalyst.host.name from Layer-2 config when env unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1262-"));
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { host: { name: "mini-2" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    try {
      expect(nodeName()).toBe("mini-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("precedence 3: falls back to os.hostname() first DNS label", () => {
    // env unset (beforeEach) and Layer-2 file points nowhere
    process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmpdir(), "ctl1262-missing-xyz.json");
    expect(nodeName()).toBe(osLabel());
  });

  test("node name is NOT a Tailscale device name (no embedded device suffix)", () => {
    // Tailscale device names look like "RyansMini250233"; the env override is the
    // stable coordination name, which is what we must use.
    process.env.CATALYST_HOST_NAME = "mini";
    expect(nodeName()).toBe("mini");
    expect(nodeName()).not.toMatch(/\d{4,}$/);
  });

  test("resolution never throws on a malformed Layer-2 config", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1262-bad-"));
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, "{ not valid json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    try {
      expect(() => nodeName()).not.toThrow();
      expect(nodeName()).toBe(osLabel());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCanonicalEnvelope carries catalyst.node.name distinctly", () => {
  test("resource has a distinct catalyst.node.name attribute", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const ev = buildCanonicalEnvelope({
      serviceName: "catalyst.otel-forward",
      eventName: "test.event",
    });
    expect(ev.resource["catalyst.node.name"]).toBe("mini");
  });

  test("catalyst.node.name is keyed distinctly from host.name (separate keys)", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const ev = buildCanonicalEnvelope({
      serviceName: "catalyst.otel-forward",
      eventName: "test.event",
    });
    const resourceKeys = Object.keys(ev.resource);
    expect(resourceKeys).toContain("host.name");
    expect(resourceKeys).toContain("catalyst.node.name");
    // host.name resolves via hostName() too, but the two are SEPARATE keys.
    expect(ev.resource["catalyst.node.name"]).toBe(ev.resource["host.name"]);
  });

  test("node name resolves from Layer-2 config on the envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1262-env-"));
    const cfg = join(dir, "config.json");
    writeFileSync(cfg, JSON.stringify({ catalyst: { host: { name: "laptop" } } }));
    process.env.CATALYST_LAYER2_CONFIG_FILE = cfg;
    try {
      const ev = buildCanonicalEnvelope({
        serviceName: "catalyst.otel-forward",
        eventName: "test.event",
      });
      expect(ev.resource["catalyst.node.name"]).toBe("laptop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("catalyst.node.name is exported on the OTLP wire (no otlp.ts change)", () => {
  test("appears in resourceLogs[].resource.attributes", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const ev = buildCanonicalEnvelope({
      serviceName: "catalyst.otel-forward",
      eventName: "test.event",
    });
    const payload = buildOtlpPayload([ev]) as {
      resourceLogs: { resource: { attributes: { key: string; value: { stringValue?: string } }[] } }[];
    };
    const attrs = payload.resourceLogs[0].resource.attributes;
    const nodeAttr = attrs.find((a) => a.key === "catalyst.node.name");
    expect(nodeAttr).toBeDefined();
    expect(nodeAttr?.value.stringValue).toBe("mini");
    // host.name remains its own attribute on the wire — distinct from node name.
    expect(attrs.find((a) => a.key === "host.name")).toBeDefined();
  });
});
