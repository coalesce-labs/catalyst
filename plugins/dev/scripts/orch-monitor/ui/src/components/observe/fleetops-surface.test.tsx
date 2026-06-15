import { describe, it, expect } from "bun:test";
const SRC = await Bun.file(new URL("./fleetops-surface.tsx", import.meta.url)).text();

describe("FleetOpsSurface delegates service health to the shared context", () => {
  it("no longer owns the /api/health/services fetch", () => {
    expect(SRC).not.toContain("/api/health/services");
    expect(SRC).not.toContain("loadServices");
    expect(SRC).not.toMatch(/setServices\b/);
    expect(SRC).not.toMatch(/setServicesUnavailable\b/);
  });
  it("reads service health from the shared context and still feeds the strip", () => {
    expect(SRC).toContain("useServiceHealthContext");
    expect(SRC).toMatch(/const \{ services, unavailable \} = useServiceHealthContext\(\)/);
    expect(SRC).toContain("<ServiceHealthStrip");
  });
  it("keeps the shared interval for cluster/board/governance", () => {
    expect(SRC).toContain("loadCluster");
    expect(SRC).toContain("loadBoard");
    expect(SRC).toContain("loadGovernance");
    expect(SRC).toContain("REFRESH_MS");
  });
});
