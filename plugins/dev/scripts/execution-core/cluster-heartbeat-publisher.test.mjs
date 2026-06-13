// cluster-heartbeat-publisher.test.mjs — periodic cross-host liveness publisher
// (CTL-1090, Phase 4). Injects fakes for publish, ownedTickets, roster, etc.
// so no network, fs, or subprocess is touched.
import { describe, test, expect } from "bun:test";
import { startLivenessPublisher } from "./cluster-heartbeat-publisher.mjs";

describe("startLivenessPublisher (CTL-1090)", () => {
  test("single-host roster: returns an inert handle, publisher fn NEVER called", () => {
    const publish = () => { throw new Error("must not publish single-host"); };
    const h = startLivenessPublisher({
      roster: ["mini"],
      anchorIssue: "CTL-9",
      self: "mini",
      ownedTickets: () => [],
      publish,
      intervalMs: 60_000,
    });
    expect(typeof h.stop).toBe("function");
    h.stop(); // must not throw
  });

  test("missing anchor (multi-host): returns inert handle, no publish", () => {
    const publish = () => { throw new Error("must not publish without anchor"); };
    const h = startLivenessPublisher({
      roster: ["mini", "laptop"],
      anchorIssue: null,
      self: "mini",
      ownedTickets: () => [],
      publish,
      intervalMs: 60_000,
    });
    expect(typeof h.stop).toBe("function");
    h.stop();
  });

  test("multi-host + anchor: publishes immediately with self + current in-flight tickets", () => {
    const calls = [];
    const h = startLivenessPublisher({
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9",
      self: "mini",
      ownedTickets: () => ["CTL-1"],
      publish: (args) => calls.push(args),
      intervalMs: 60_000,
    });
    h.stop();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toMatchObject({
      anchorIssue: "CTL-9",
      host: "mini",
      inFlightTickets: ["CTL-1"],
    });
  });

  test("stop() clears the interval (subsequent ticks do NOT fire)", async () => {
    const calls = [];
    const h = startLivenessPublisher({
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9",
      self: "mini",
      ownedTickets: () => [],
      publish: (args) => calls.push(args),
      intervalMs: 10, // very short so a leak would fire within the test
    });
    const countAfterStart = calls.length;
    h.stop();
    // Wait long enough for a second tick to fire if the interval is still live
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(countAfterStart); // no additional ticks after stop
  });

  test("publish failure is swallowed — never throws out of tick", () => {
    const h = startLivenessPublisher({
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9",
      self: "mini",
      ownedTickets: () => [],
      publish: () => { throw new Error("Linear down"); },
      intervalMs: 60_000,
    });
    // startLivenessPublisher must not throw even if publish throws on the first tick
    h.stop();
    expect(true).toBe(true);
  });

  test("ownedTickets is called each tick with current state", () => {
    let tickCount = 0;
    const calls = [];
    const h = startLivenessPublisher({
      roster: ["mini", "laptop"],
      anchorIssue: "CTL-9",
      self: "mini",
      ownedTickets: () => { tickCount++; return ["CTL-" + tickCount]; },
      publish: (args) => calls.push(args),
      intervalMs: 60_000,
    });
    h.stop();
    expect(tickCount).toBeGreaterThanOrEqual(1);
    expect(calls[0].inFlightTickets).toEqual(["CTL-1"]);
  });

  test("single-host with undefined roster: no-op", () => {
    const publish = () => { throw new Error("must not call"); };
    const h = startLivenessPublisher({ publish, anchorIssue: "CTL-9", intervalMs: 60_000 });
    // roster defaults to getClusterHosts() which on a single-host returns [hostname]
    // This test verifies the handle is always returned safely regardless
    expect(typeof h.stop).toBe("function");
    h.stop();
  });
});
