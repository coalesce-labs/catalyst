import { describe, it, expect } from "bun:test";
import { SERVICE_HEALTH_POLL_MS, SERVICE_HEALTH_DEFAULT } from "./use-service-health";

const REGISTRY_INTERVAL_MS = 30_000;

describe("SERVICE_HEALTH_POLL_MS", () => {
  it("polls at the server registry cadence (30s), not the legacy 15s fleetops REFRESH_MS", () => {
    expect(SERVICE_HEALTH_POLL_MS).toBe(30_000);
    expect(SERVICE_HEALTH_POLL_MS).toBe(REGISTRY_INTERVAL_MS);
  });
});

describe("SERVICE_HEALTH_DEFAULT (fail-open default)", () => {
  it("is { services: null, unavailable: false } — pre-first-fetch / no-provider (Q2)", () => {
    expect(SERVICE_HEALTH_DEFAULT).toEqual({ services: null, unavailable: false });
  });
  it("does NOT fabricate an empty up-list (services is null, not [])", () => {
    expect(SERVICE_HEALTH_DEFAULT.services).toBeNull();
    expect(SERVICE_HEALTH_DEFAULT.unavailable).toBe(false);
  });
});
