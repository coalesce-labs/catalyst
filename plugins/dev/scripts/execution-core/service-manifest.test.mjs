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

  it("worker declares the account-rotation agent; developer/monitor do not (CTL-2145)", () => {
    // D5: rotation is gated on a provisioned claude-accounts.env and installed via the
    // install-services delegate, which only worker-class nodes run. This list is
    // documentation-level (see the module header) — it states intent, it enforces nothing.
    expect(agentsForClass("worker")).toContain(LABELS.accountRotation);
    expect(agentsForClass("developer")).not.toContain(LABELS.accountRotation);
    expect(agentsForClass("monitor")).not.toContain(LABELS.accountRotation);
  });

  it("every LABELS value is a distinct, ai.coalesce/com.catalyst-prefixed launchd label", () => {
    // `catalyst uninstall`'s verify-clean probes the plist dir with a prefix regex, so a
    // label that does not match the family is one teardown cannot clean up. A duplicate
    // value would silently make two services the same agent.
    const values = Object.values(LABELS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toMatch(/^(ai\.coalesce\.catalyst-|com\.catalyst\.)/);
    }
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
