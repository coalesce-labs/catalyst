// catalyst-resource.test.mjs — CTL-1368. The shared MJS resource builder: every catalyst
// signal's resource block comes from here, so this pins the shape — service.namespace,
// short host.name/host.id, and the new core dimension catalyst.node.class (LAST), with
// service.version conditional and host override honored.
import { describe, test, expect, afterEach } from "bun:test";
import { buildCatalystResource } from "./catalyst-resource.mjs";

const saved = {};
function setEnv(k, v) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const k of Object.keys(saved)) delete saved[k];
});

describe("buildCatalystResource (CTL-1368 single source of truth)", () => {
  test("stamps the canonical block with catalyst.node.class LAST", () => {
    setEnv("CATALYST_NODE_CLASS", "developer");
    setEnv("CATALYST_HOST_NAME", "mini");
    const r = buildCatalystResource({ serviceName: "catalyst.execution-core" });
    expect(r["service.name"]).toBe("catalyst.execution-core");
    expect(r["service.namespace"]).toBe("catalyst");
    expect(r["host.name"]).toBe("mini");
    expect(r["host.id"]).toMatch(/^[0-9a-f]{16}$/);
    expect(r["catalyst.node.class"]).toBe("developer");
    expect(Object.keys(r)[Object.keys(r).length - 1]).toBe("catalyst.node.class"); // LAST
    expect(r).not.toHaveProperty("service.version"); // omitted when not provided
  });

  test("node.class reflects the resolver (worker default when unset)", () => {
    setEnv("CATALYST_NODE_CLASS", undefined);
    setEnv("CATALYST_LAYER2_CONFIG_FILE", "/nonexistent/config.json");
    setEnv("CATALYST_HOST_NAME", "mini");
    expect(buildCatalystResource({ serviceName: "catalyst.broker" })["catalyst.node.class"]).toBe("worker");
  });

  test("monitor for an unrecognized explicit class (most-restrictive)", () => {
    setEnv("CATALYST_NODE_CLASS", "developr"); // typo
    setEnv("CATALYST_HOST_NAME", "mini");
    expect(buildCatalystResource({ serviceName: "catalyst.execution-core" })["catalyst.node.class"]).toBe("monitor");
  });

  test("service.version included only when provided", () => {
    setEnv("CATALYST_HOST_NAME", "mini");
    const r = buildCatalystResource({ serviceName: "catalyst.broker", serviceVersion: "1.2.3" });
    expect(r["service.version"]).toBe("1.2.3");
  });

  test("host override is honored (short host.name + matching id)", () => {
    setEnv("CATALYST_NODE_CLASS", "worker");
    setEnv("CATALYST_HOST_NAME", undefined);
    const r = buildCatalystResource({ serviceName: "catalyst.execution-core", host: "mini-2" });
    expect(r["host.name"]).toBe("mini-2");
    const r2 = buildCatalystResource({ serviceName: "catalyst.execution-core", host: "mini-2" });
    expect(r.host?.id ?? r["host.id"]).toBe(r2["host.id"]); // deterministic
  });
});
