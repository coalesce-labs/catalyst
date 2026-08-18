// linear-comment-write.test.mjs — CTL-1889 increment 2.
//
// ⛔ THE PROPERTY THAT MATTERS MOST IS A NEGATIVE ONE: under `enforce`, the bash helper
// must NEVER run. That helper mints a per-host app-actor token per call, which is the
// credential this ticket exists to retire — so a single fallback to it makes the shadow
// window read "zero host-originated writes" while the host is still writing, and the
// retirement gate passes on a lie. Every enforce test below therefore asserts the helper
// call COUNT is zero, not merely that the proxy was called.

import { describe, expect, test } from "bun:test";
import {
  buildCommentPayload,
  postLinearComment,
  postLinearCommentAsSpawnResult,
} from "./linear-comment-write.mjs";

const okResolver = { issue: () => ({ ok: true, issueId: "11111111-2222-3333-4444-555555555555" }) };

/** A helper spy that records every invocation, so "never ran" is a measured zero. */
function helperSpy(status = 0) {
  const calls = [];
  const fn = (t, b) => { calls.push([t, b]); return { status, stdout: "", stderr: status === 0 ? "" : "boom" }; };
  return { fn, calls };
}

function fakeProxy(mode, sendImpl) {
  const sends = [];
  return {
    mode,
    sends,
    send(args) { sends.push(args); return sendImpl ? sendImpl(args) : { handled: true, applied: true, reason: null }; },
  };
}

describe("mode off — byte-identical to pre-CTL-1889", () => {
  test("with no proxy installed the helper posts, and reports via:helper", () => {
    const h = helperSpy(0);
    expect(postLinearComment("CTL-1", "hello", { proxy: null, runHelper: h.fn }))
      .toEqual({ posted: true, via: "helper", reason: null });
    expect(h.calls).toEqual([["CTL-1", "hello"]]);
  });

  test("a failing helper is reported with its exit status, not swallowed", () => {
    const h = helperSpy(1);
    const r = postLinearComment("CTL-1", "hello", { proxy: null, runHelper: h.fn });
    expect(r).toEqual({ posted: false, via: "helper", reason: "helper-exit-1" });
  });

  test("a throwing helper never escapes — a comment must not wedge a recovery tick", () => {
    const r = postLinearComment("CTL-1", "hi", { proxy: null, runHelper: () => { throw new Error("x"); } });
    expect(r).toEqual({ posted: false, via: "helper", reason: "helper-threw" });
  });
});

describe("mode shadow — observe, then let the existing write proceed", () => {
  test("records the observation AND still posts via the helper (no double-post to Linear)", () => {
    const h = helperSpy(0);
    const p = fakeProxy("shadow");
    const r = postLinearComment("CTL-2", "body", { proxy: p, runHelper: h.fn, caller: "t" });
    expect(r.via).toBe("helper");
    expect(h.calls.length).toBe(1);
    expect(p.sends.length).toBe(1);
    // Deliberately an EMPTY payload: shadow makes no cloud call, so building one would
    // cost a replica read it throws away.
    expect(p.sends[0]).toEqual({ routeId: "comment", ticket: "CTL-2", payload: {}, caller: "t" });
  });

  test("a throwing proxy in shadow does not stop the real post", () => {
    const h = helperSpy(0);
    const p = { mode: "shadow", send() { throw new Error("nope"); } };
    expect(postLinearComment("CTL-2", "b", { proxy: p, runHelper: h.fn }).posted).toBe(true);
    expect(h.calls.length).toBe(1);
  });
});

describe("⛔ mode enforce — the helper must NEVER run", () => {
  test("a successful proxy write posts, and the helper is not invoked", () => {
    const h = helperSpy(0);
    const p = fakeProxy("enforce");
    const r = postLinearComment("CTL-3", "body", { proxy: p, resolver: okResolver, runHelper: h.fn, caller: "c" });
    expect(r).toEqual({ posted: true, via: "proxy", reason: null });
    expect(h.calls.length).toBe(0);
  });

  test("⛔ a FAILED proxy write does NOT fall back to the helper", () => {
    // The whole retirement gate. A fallback here means the host keeps writing under its
    // own app-actor exactly when the proxy is broken.
    const h = helperSpy(0);
    const p = fakeProxy("enforce", () => ({ handled: true, applied: false, reason: "cloud:rejected" }));
    const r = postLinearComment("CTL-3", "body", { proxy: p, resolver: okResolver, runHelper: h.fn });
    expect(r).toEqual({ posted: false, via: "proxy", reason: "cloud:rejected" });
    expect(h.calls.length).toBe(0);
  });

  test("⛔ an UNRESOLVABLE ticket is a named refusal, not a helper post", () => {
    const h = helperSpy(0);
    const p = fakeProxy("enforce");
    const r = postLinearComment("CTL-3", "b", {
      proxy: p, resolver: { issue: () => ({ ok: false, reason: "replica-stale" }) }, runHelper: h.fn,
    });
    expect(r).toEqual({ posted: false, via: "proxy", reason: "resolve:replica-stale" });
    expect(h.calls.length).toBe(0);
    expect(p.sends.length).toBe(0); // refused BEFORE spending a cloud call
  });

  test("⛔ a THROWING proxy is a named refusal, not a helper post", () => {
    const h = helperSpy(0);
    const p = { mode: "enforce", send() { throw new Error("transport"); } };
    const r = postLinearComment("CTL-3", "b", { proxy: p, resolver: okResolver, runHelper: h.fn });
    expect(r).toEqual({ posted: false, via: "proxy", reason: "proxy-threw" });
    expect(h.calls.length).toBe(0);
  });

  test("⛔ a missing resolver refuses rather than posting label-less via the helper", () => {
    const h = helperSpy(0);
    const r = postLinearComment("CTL-3", "b", { proxy: fakeProxy("enforce"), resolver: null, runHelper: h.fn });
    expect(r.reason).toBe("resolve:no-resolver");
    expect(h.calls.length).toBe(0);
  });

  test("⛔ CONTROL: the spy CAN observe a call — otherwise every zero above is vacuous", () => {
    const h = helperSpy(0);
    postLinearComment("CTL-3", "b", { proxy: null, runHelper: h.fn });
    expect(h.calls.length).toBe(1);
  });
});

describe("the payload matches the /agent/issue-comment contract", () => {
  test("issueId + body, and parentId ONLY when supplied", () => {
    const a = buildCommentPayload(okResolver, { ticket: "CTL-4", body: "hi" });
    expect(a.payload).toEqual({ issueId: "11111111-2222-3333-4444-555555555555", body: "hi" });
    const b = buildCommentPayload(okResolver, { ticket: "CTL-4", body: "hi", parentId: "p1" });
    expect(b.payload.parentId).toBe("p1");
  });

  test("an empty or non-string body is refused before any resolution", () => {
    for (const bad of ["", "   ", null, undefined, 7]) {
      expect(buildCommentPayload(okResolver, { ticket: "CTL-4", body: bad })).toEqual({ ok: false, reason: "empty-body" });
    }
  });
});

describe("the spawn-result adapter the five call sites read", () => {
  test("success is status 0; failure is status 1 carrying the NAMED reason", () => {
    const okp = fakeProxy("enforce");
    expect(postLinearCommentAsSpawnResult("CTL-5", "b", { proxy: okp, resolver: okResolver }))
      .toMatchObject({ status: 0, _via: "proxy" });

    const badp = fakeProxy("enforce", () => ({ handled: true, applied: false, reason: "budget:day-exhausted" }));
    const r = postLinearCommentAsSpawnResult("CTL-5", "b", { proxy: badp, resolver: okResolver });
    expect(r.status).toBe(1);
    // The five wrappers surface the LAST LINE of stderr as the diagnosis — so the named
    // reason has to be there, not a bare exit code.
    expect(r.stderr).toContain("budget:day-exhausted");
  });

  test("`via` distinguishes a proxied write from a host-originated one", () => {
    // This is what makes the shadow window auditable: a host still reporting via:helper
    // has NOT stopped writing with its own app-actor, whatever its config claims.
    const h = helperSpy(0);
    expect(postLinearCommentAsSpawnResult("CTL-5", "b", { proxy: null, runHelper: h.fn })._via).toBe("helper");
    expect(postLinearCommentAsSpawnResult("CTL-5", "b", { proxy: fakeProxy("enforce"), resolver: okResolver })._via).toBe("proxy");
  });
});
