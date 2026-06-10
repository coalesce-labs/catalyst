import { describe, it, expect } from "bun:test";
import { monitorUrlForHost, livenessColor, livenessLabel } from "../ui/src/board/cluster-helpers";

describe("monitorUrlForHost", () => {
  it("builds the Tailnet monitor URL with ticket query", () => {
    expect(monitorUrlForHost("studio", "CTL-900")).toBe("http://studio:7400/?ticket=CTL-900");
  });
  it("omits the ticket query when no ticket", () => {
    expect(monitorUrlForHost("studio")).toBe("http://studio:7400/");
  });
});

describe("livenessColor / livenessLabel", () => {
  it("maps live→green hex, degraded→yellow hex, offline→red hex", () => {
    expect(livenessColor("live")).toMatch(/^#/);
    expect(livenessColor("degraded")).not.toBe(livenessColor("live"));
    expect(livenessColor("offline")).not.toBe(livenessColor("live"));
  });
  it("maps live/degraded/offline to readable labels", () => {
    expect(livenessLabel("live")).toMatch(/live/i);
    expect(livenessLabel("degraded")).toMatch(/degraded/i);
    expect(livenessLabel("offline")).toMatch(/offline/i);
  });
});
