import { describe, expect, test } from "bun:test";
import { decideReseed, requestReplicaReseed } from "./replica-reseed.mjs";
const NOW = 1_786_000_000_000; const empty = { state: "empty", issueRows: 0 };
const ctx = (over = {}) => ({ agentInstalled: true, tokenPresent: true, lastAttemptMs: null, now: NOW, ...over });
describe("replica reseed", () => {
  test("off and skip paths have zero side effects", () => {
    const calls = []; const deps = { kickstart: () => calls.push("kick"), emit: () => calls.push("emit"), writeMarker: () => calls.push("marker"), log: { info: () => calls.push("log") } };
    expect(requestReplicaReseed({ mode: "off", completeness: empty, ctx: ctx(), ...deps }).outcome).toBe("off"); expect(calls).toEqual([]);
    expect(requestReplicaReseed({ mode: "enforce", completeness: empty, ctx: ctx({ tokenPresent: false }), ...deps }).outcome).toBe("skipped"); expect(calls).toEqual(["log"]);
  });
  test("only absent or empty replicas request reseed", () => {
    expect(decideReseed(empty, ctx()).action).toBe("request"); expect(decideReseed({ state: "absent" }, ctx()).action).toBe("request");
    for (const state of ["ok", "partial", "stale"]) expect(decideReseed({ state, issueRows: 3 }, ctx())).toMatchObject({ action: "skip", reason: "already-populated" });
  });
  test("names provisioning and cooldown skips", () => {
    expect(decideReseed(empty, ctx({ tokenPresent: false })).reason).toBe("no-token");
    expect(decideReseed(empty, ctx({ agentInstalled: false })).reason).toBe("no-writer-agent");
    expect(decideReseed(empty, ctx({ lastAttemptMs: NOW - 60_000 })).reason).toBe("cooldown");
  });
  test("shadow emits without actuating; enforce actuates and stamps", () => {
    let calls = 0; const events = [];
    expect(requestReplicaReseed({ mode: "shadow", completeness: empty, ctx: ctx(), kickstart: () => { calls++; return true; }, emit: (e) => events.push(e), log: { info() {} } }).outcome).toBe("would-request");
    expect(calls).toBe(0); expect(events[0]["event.name"]).toBe("catalyst.replica.reseed_requested");
    let marker; expect(requestReplicaReseed({ mode: "enforce", completeness: empty, ctx: ctx(), kickstart: () => true, writeMarker: (m) => { marker = m; }, emit: () => {}, log: { info() {} } }).outcome).toBe("requested"); expect(marker.lastAttemptMs).toBe(NOW);
  });
  test("kickstart failures are contained and cooled down", () => {
    let marker; expect(requestReplicaReseed({ mode: "enforce", completeness: empty, ctx: ctx(), kickstart: () => { throw new Error("gone"); }, writeMarker: (m) => { marker = m; }, emit: () => {}, log: { warn() {} } }).outcome).toBe("failed"); expect(marker.lastAttemptMs).toBe(NOW);
  });
});
