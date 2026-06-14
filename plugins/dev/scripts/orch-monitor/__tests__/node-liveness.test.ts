// CTL-884 (BFF2): node liveness overlay — classify each host live/degraded/offline
// from the heartbeat last-seen timestamps that recovery.readClusterHeartbeats
// yields ({ host: lastSeenISO }). The classifier is pure so the thresholds are
// unit-testable without a real event log; assembleClusterView wires the real
// readClusterHeartbeats reader in.

import { describe, it, expect } from "bun:test";
import {
  classifyHostLiveness,
  overlayClusterLiveness,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LIVENESS_GRACE_MS,
} from "../lib/node-liveness.mjs";

describe("classifyHostLiveness (CTL-884 — live/degraded/offline thresholds)", () => {
  const now = Date.parse("2026-06-08T12:00:00.000Z");
  const interval = 30_000; // ~30s heartbeat cadence
  const grace = 5 * 60_000; // 5 min grace floor

  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("a heartbeat within the interval is live", () => {
    expect(classifyHostLiveness(at(10_000), now, { intervalMs: interval, graceMs: grace })).toBe(
      "live",
    );
  });

  it("a heartbeat exactly at the interval boundary is still live (inclusive)", () => {
    expect(classifyHostLiveness(at(interval), now, { intervalMs: interval, graceMs: grace })).toBe(
      "live",
    );
  });

  it("past the interval but inside the grace window is degraded", () => {
    expect(
      classifyHostLiveness(at(interval + 1_000), now, { intervalMs: interval, graceMs: grace }),
    ).toBe("degraded");
    expect(classifyHostLiveness(at(2 * 60_000), now, { intervalMs: interval, graceMs: grace })).toBe(
      "degraded",
    );
  });

  it("a heartbeat exactly at the grace boundary is still degraded (inclusive)", () => {
    expect(classifyHostLiveness(at(grace), now, { intervalMs: interval, graceMs: grace })).toBe(
      "degraded",
    );
  });

  it("past the grace window is offline", () => {
    expect(
      classifyHostLiveness(at(grace + 1_000), now, { intervalMs: interval, graceMs: grace }),
    ).toBe("offline");
    expect(classifyHostLiveness(at(20 * 60_000), now, { intervalMs: interval, graceMs: grace })).toBe(
      "offline",
    );
  });

  it("an absent/never-seen heartbeat is offline (no fabricated liveness)", () => {
    expect(classifyHostLiveness(null, now, { intervalMs: interval, graceMs: grace })).toBe("offline");
    expect(classifyHostLiveness(undefined, now, { intervalMs: interval, graceMs: grace })).toBe(
      "offline",
    );
    expect(classifyHostLiveness("", now, { intervalMs: interval, graceMs: grace })).toBe("offline");
  });

  it("an unparseable timestamp is offline, never thrown", () => {
    expect(classifyHostLiveness("not-a-date", now, { intervalMs: interval, graceMs: grace })).toBe(
      "offline",
    );
  });

  it("a future heartbeat (clock skew) is treated as live, never negative-age garbage", () => {
    expect(classifyHostLiveness(at(-5_000), now, { intervalMs: interval, graceMs: grace })).toBe(
      "live",
    );
  });

  it("uses the design-doc 5-10min grace + 30s interval defaults when omitted", () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_LIVENESS_GRACE_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(DEFAULT_LIVENESS_GRACE_MS).toBeLessThanOrEqual(10 * 60_000);
    // within interval → live with defaults
    expect(classifyHostLiveness(at(5_000), now)).toBe("live");
    // 3 min ago is inside the default 5-min grace but well past the 30s interval → degraded
    expect(classifyHostLiveness(at(3 * 60_000), now)).toBe("degraded");
    // 6 min ago is past the default 5-min grace floor → offline
    expect(classifyHostLiveness(at(6 * 60_000), now)).toBe("offline");
  });
});

describe("overlayClusterLiveness (CTL-884 — per-host overlay from lastSeen map)", () => {
  const now = Date.parse("2026-06-08T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("maps every roster host to its liveness + lastSeen, offline when unheard", () => {
    const hosts = ["mini", "studio", "laptop"];
    const lastSeen = {
      mini: at(5_000), // live
      studio: at(3 * 60_000), // degraded (inside default grace, past interval)
      // laptop: never seen → offline
    };
    const out = overlayClusterLiveness(hosts, lastSeen, { now });
    expect(out).toEqual([
      { host: "mini", status: "live", lastSeen: lastSeen.mini },
      { host: "studio", status: "degraded", lastSeen: lastSeen.studio },
      { host: "laptop", status: "offline", lastSeen: null },
    ]);
  });

  it("single-host roster yields exactly one node entry", () => {
    const out = overlayClusterLiveness(["mini"], { mini: at(1_000) }, { now });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ host: "mini", status: "live", lastSeen: out[0].lastSeen });
  });
});
