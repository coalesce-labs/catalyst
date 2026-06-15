import { describe, it, expect } from "bun:test";
const SRC = await Bun.file(new URL("./app-shell.tsx", import.meta.url)).text();

describe("AppShell provides ServiceHealthContext (5th provider, CTL-945)", () => {
  it("imports the hook + context", () => {
    expect(SRC).toMatch(
      /import \{[^}]*useServiceHealth[^}]*ServiceHealthContext[^}]*\} from "@\/hooks\/use-service-health"/s,
    );
  });
  it("calls useServiceHealth() once at the provider site", () => {
    expect(SRC).toMatch(/const serviceHealth = useServiceHealth\(\)/);
  });
  it("mounts <ServiceHealthContext.Provider value={serviceHealth}>", () => {
    expect(SRC).toContain("<ServiceHealthContext.Provider value={serviceHealth}>");
    expect(SRC).toContain("</ServiceHealthContext.Provider>");
  });
});
