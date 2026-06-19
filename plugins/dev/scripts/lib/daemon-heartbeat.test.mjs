// Unit tests for the shared daemon-liveness heartbeat marker (CTL-1280).
// Run: bun test plugins/dev/scripts/lib/daemon-heartbeat.test.mjs
import { describe, test, expect } from "bun:test";
import { DAEMON_HEARTBEAT_MSG, logDaemonHeartbeat } from "./daemon-heartbeat.mjs";

describe("daemon heartbeat marker (CTL-1280)", () => {
  test("DAEMON_HEARTBEAT_MSG is the exact string the Loki liveness query matches", () => {
    // If this string changes, the Gatus + Grafana liveness queries (|= "daemon
    // heartbeat") must change in lockstep — otherwise every daemon reads as down.
    expect(DAEMON_HEARTBEAT_MSG).toBe("daemon heartbeat");
  });

  test("logDaemonHeartbeat emits info with the marker, component, and hb flag", () => {
    const calls = [];
    const fakeLog = { info: (obj, msg) => calls.push({ obj, msg }) };
    logDaemonHeartbeat(fakeLog, "broker");
    expect(calls).toHaveLength(1);
    expect(calls[0].msg).toBe(DAEMON_HEARTBEAT_MSG);
    expect(calls[0].obj).toEqual({ hb: true, component: "broker" });
  });

  test("component is carried through verbatim for each daemon", () => {
    for (const c of ["broker", "execution-core", "otel-forward"]) {
      const calls = [];
      logDaemonHeartbeat({ info: (obj, msg) => calls.push({ obj, msg }) }, c);
      expect(calls[0].obj.component).toBe(c);
    }
  });
});
