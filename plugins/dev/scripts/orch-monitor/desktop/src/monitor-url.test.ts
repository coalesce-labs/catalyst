import { describe, it, expect } from "bun:test";
import { resolveMonitorUrl, DEFAULT_MONITOR_URL } from "./monitor-url";

describe("resolveMonitorUrl (CTL-1112)", () => {
  it("defaults to the remote mini host when nothing is set", () => {
    expect(resolveMonitorUrl({})).toBe(DEFAULT_MONITOR_URL); // "http://mini.rozich.com:7400/"
  });

  it("honours an explicit CATALYST_MONITOR_URL override", () => {
    expect(resolveMonitorUrl({ CATALYST_MONITOR_URL: "http://localhost:7400" })).toBe(
      "http://localhost:7400/",
    );
  });

  it("normalizes the trailing slash (no doubling, always exactly one)", () => {
    expect(resolveMonitorUrl({ CATALYST_MONITOR_URL: "http://host:9000/" })).toBe(
      "http://host:9000/",
    );
    expect(resolveMonitorUrl({ CATALYST_MONITOR_URL: "http://host:9000" })).toBe(
      "http://host:9000/",
    );
  });

  it("falls back to the default when CATALYST_MONITOR_URL is empty/whitespace", () => {
    expect(resolveMonitorUrl({ CATALYST_MONITOR_URL: "" })).toBe(DEFAULT_MONITOR_URL);
    expect(resolveMonitorUrl({ CATALYST_MONITOR_URL: "   " })).toBe(DEFAULT_MONITOR_URL);
  });

  it("throws a value-naming error on a non-empty malformed override", () => {
    // Reported at the TS layer rather than displaced into the Rust
    // url.parse().expect() panic (CTL-1112 verify finding).
    expect(() => resolveMonitorUrl({ CATALYST_MONITOR_URL: "garbage" })).toThrow(/garbage/);
  });
});
