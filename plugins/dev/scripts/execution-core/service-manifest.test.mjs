import { describe, it, expect } from "bun:test";
import { agentsForClass, shipsLogs, MANIFEST, LABELS } from "./service-manifest.mjs";

describe("service-manifest", () => {
  it("worker gets the full stack incl. shipper + thoughts-sync, never updater", () => {
    const a = agentsForClass("worker");
    expect(a).toContain(LABELS.stack);
    expect(a).toContain(LABELS.shipper);
    expect(a).toContain(LABELS.thoughtsSync);
    expect(a).not.toContain(LABELS.updater);
  });

  it("developer gets updater + thoughts-sync, NOT the stack keep-alive or shipper", () => {
    const a = agentsForClass("developer");
    expect(a).toContain(LABELS.updater);
    expect(a).toContain(LABELS.thoughtsSync);
    expect(a).not.toContain(LABELS.stack);
    expect(a).not.toContain(LABELS.shipper);
  });

  it("declares which classes ship daemon logs (drives checkLogShipper scope)", () => {
    expect(MANIFEST.worker.shipsLogs).toBe(true);
    expect(MANIFEST.developer.shipsLogs).toBe(false);
  });

  it("monitor is developer-shaped", () => {
    expect(agentsForClass("monitor")).toEqual(agentsForClass("developer"));
    expect(shipsLogs("monitor")).toBe(false);
  });

  it("unknown class falls back to developer-shaped", () => {
    expect(agentsForClass("unknown-class")).toEqual(agentsForClass("developer"));
  });

  it("worker shipsLogs is true, developer/monitor false", () => {
    expect(shipsLogs("worker")).toBe(true);
    expect(shipsLogs("developer")).toBe(false);
  });
});
