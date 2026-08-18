// linear-write-proxy-wiring.test.mjs — CTL-1889 increment 1.
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write-proxy-wiring.test.mjs
//
// linear-write-proxy.test.mjs proves the TRANSPORT. This file proves the WIRING — that
// the enforcement point can actually fire, and that `off` is genuinely a no-op rather
// than a claim. A bound whose enforcement point cannot fire is the failure class this
// file exists to rule out, so every assertion here is about which seam was REACHED,
// not about a value the transport already returned.
import { afterEach, describe, expect, test } from "bun:test";
import {
  applyLabel,
  applyPhaseStatus,
  applyTerminalDone,
  getLinearWriteProxy,
  removeLabel,
  setLinearWriteProxy,
  setLinearWriteProxyResolver,
} from "./linear-write.mjs";

/**
 * A fake replica resolver. Enforce mode cannot build a payload without one, so every
 * enforce test installs it — which is itself the point: a host whose replica cannot
 * resolve the ids REFUSES the write rather than falling back to a direct one.
 */
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const STATE_ID = "22222222-2222-4222-8222-222222222222";
const LABEL_ID = "33333333-3333-4333-8333-333333333333";
function fakeResolver(overrides = {}) {
  return {
    issue: () => ({ ok: true, issueId: ISSUE_ID, teamId: "team-1" }),
    stateId: () => ({ ok: true, stateId: STATE_ID }),
    labelIds: (names) => ({ ok: true, labelIds: names.map(() => LABEL_ID) }),
    ...overrides,
  };
}

/** A fake transport in one mode, recording every send. */
function fakeProxy(mode, result) {
  const sends = [];
  return {
    mode,
    sends,
    send(req) {
      sends.push(req);
      if (mode === "shadow") return { handled: false, applied: false, reason: "shadow" };
      return result ?? { handled: true, applied: true, reason: null, status: 200 };
    },
  };
}

/** A recording exec that reports a clean transition / clean linearis exit. */
function recordingExec(calls, { code = 0, stdout = JSON.stringify({ action: "transitioned", currentState: "Research", targetState: "PR" }) } = {}) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    // The enforce state path spawns linear-transition.sh in --resolve-only mode, which
    // WRITES NOTHING and answers with the resolved target state. Modelled here so the
    // "did the direct write happen" assertions below stay about the WRITE, not about
    // whether the script was executed at all.
    if (Array.isArray(args) && args.includes("--resolve-only")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          action: "resolve-only",
          currentState: "Research",
          targetState: "PR",
          targetStateId: "44444444-4444-4444-8444-444444444444",
        }),
        stderr: "",
      };
    }
    return { code, stdout, stderr: "" };
  };
}

/** Did this exec call actually WRITE, i.e. spawn the script in anything but resolve-only? */
const isWritingTransition = (c) =>
  c.cmd.endsWith("linear-transition.sh") && !c.args.includes("--resolve-only");

afterEach(() => {
  setLinearWriteProxy(null);
  setLinearWriteProxyResolver(null);
});

describe("off — the module-level install is null and nothing changes", () => {
  test("no proxy is installed by merely importing the module", () => {
    expect(getLinearWriteProxy()).toBeNull();
  });

  test("applyLabel still shells linearis, exactly as before", () => {
    const calls = [];
    const r = applyLabel({
      ticket: "CTL-1",
      label: "needs-human",
      exec: recordingExec(calls),
      readLabels: () => ["needs-human"],
    });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls[0].cmd).toBe("linearis");
    expect(calls[0].args).toEqual(["issues", "update", "CTL-1", "--labels", "needs-human", "--label-mode", "add"]);
  });

  test("applyPhaseStatus still shells linear-transition.sh", () => {
    const calls = [];
    applyPhaseStatus({ ticket: "CTL-1", phase: "pr", resolveRepoRoot: () => "/repo", exec: recordingExec(calls) });
    expect(calls.some((c) => c.cmd.endsWith("linear-transition.sh"))).toBe(true);
  });
});

describe("shadow — the direct write STILL happens, and the observation is recorded", () => {
  test("applyLabel: proxy sees the write AND linearis is still called", () => {
    const proxy = fakeProxy("shadow");
    const calls = [];
    const r = applyLabel({
      ticket: "CTL-2",
      label: "needs-human",
      exec: recordingExec(calls),
      readLabels: () => ["needs-human"],
      proxy,
    });
    expect(r).toEqual({ applied: true, reason: null });
    // ⛔ SHADOW SENDS AN EMPTY PAYLOAD, ON PURPOSE. Building one costs a
    // --resolve-only subprocess and up to three replica reads, and shadow makes no
    // cloud call at all — so a shadow run would tax every Linear write on the host to
    // construct a body nobody sends. The observation is that the write HAPPENED and on
    // which route; the contents are proven by the enforce cases below.
    expect(proxy.sends).toEqual([{ routeId: "label", ticket: "CTL-2", payload: {} }]);
    expect(calls.map((c) => c.cmd)).toContain("linearis");
  });

  test("applyTerminalDone: proxy sees the write AND the shell still runs", () => {
    const proxy = fakeProxy("shadow");
    const calls = [];
    applyTerminalDone({ ticket: "CTL-2", resolveRepoRoot: () => "/repo", exec: recordingExec(calls), proxy });
    expect(proxy.sends).toEqual([{ routeId: "issue-state", ticket: "CTL-2", payload: {} }]);
    expect(calls.some((c) => c.cmd.endsWith("linear-transition.sh"))).toBe(true);
  });
});

describe("enforce — the proxy IS the write and the direct path is NOT taken", () => {
  test("applyLabel: linearis is never spawned", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const calls = [];
    const r = applyLabel({ ticket: "CTL-3", label: "needs-human", exec: recordingExec(calls), proxy });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls).toHaveLength(0);
    // The CTC-509 contract, measured off catalyst-cloud origin/main: UUIDs, and a
    // `mode` of add|remove. Asserted here because the earlier cut of this file locked
    // in `{ticket, mode, labels}`, which the cloud would have rejected with a 400.
    expect(proxy.sends).toEqual([
      { routeId: "label", ticket: "CTL-3", payload: { issueId: ISSUE_ID, labelIds: [LABEL_ID], mode: "add" } },
    ]);
  });

  test("⛔ enforce with NO resolver installed REFUSES — it does not fall back to linearis", () => {
    const proxy = fakeProxy("enforce");
    const calls = [];
    const r = applyLabel({ ticket: "CTL-3", label: "needs-human", exec: recordingExec(calls), proxy });
    expect(r).toEqual({ applied: false, reason: "resolve:no-resolver" });
    expect(calls).toHaveLength(0);
    expect(proxy.sends).toHaveLength(0);
  });

  test("⛔ an UNRESOLVABLE ticket REFUSES rather than writing directly (the fail-closed rule)", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver({ issue: () => ({ ok: false, reason: "issue-not-in-replica" }) }));
    const calls = [];
    const r = applyLabel({ ticket: "CTL-3", label: "needs-human", exec: recordingExec(calls), proxy });
    expect(r).toEqual({ applied: false, reason: "resolve:issue-not-in-replica" });
    expect(calls).toHaveLength(0);
    expect(proxy.sends).toHaveLength(0);
  });

  test("⛔ an AMBIGUOUS label name REFUSES — it is never resolved to a first hit", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver({ labelIds: () => ({ ok: false, reason: "label-ambiguous" }) }));
    const r = applyLabel({ ticket: "CTL-3", label: "schema", exec: () => { throw new Error("must not exec"); }, proxy });
    expect(r).toEqual({ applied: false, reason: "resolve:label-ambiguous" });
    expect(proxy.sends).toHaveLength(0);
  });

  test("applyLabel: the CTL-587 read-back seam is not reached either (it is a host-credential read)", () => {
    let readBacks = 0;
    const r = applyLabel({
      ticket: "CTL-3",
      label: "x",
      exec: () => { throw new Error("must not exec"); },
      readLabels: () => { readBacks += 1; return ["x"]; },
      proxy: (setLinearWriteProxyResolver(fakeResolver()), fakeProxy("enforce")),
    });
    expect(r.applied).toBe(true);
    expect(readBacks).toBe(0);
  });

  test("applyPhaseStatus: linear-transition.sh runs ONLY to resolve, and never to write", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const calls = [];
    const r = applyPhaseStatus({
      ticket: "CTL-3",
      phase: "pr",
      resolveRepoRoot: () => "/repo",
      exec: recordingExec(calls),
      proxy,
    });
    expect(r.applied).toBe(true);
    expect(r.via).toBe("cloud-proxy");
    // ⚠️ THE DISTINCTION THAT MATTERS. The script IS spawned — it owns the four-rung
    // state-name precedence chain and duplicating that in JS would make this file a
    // second source of truth. What must never happen is the WRITING invocation, which
    // is the one that reaches Linear under this host's own app-actor.
    expect(calls.filter(isWritingTransition)).toHaveLength(0);
    expect(calls.filter((c) => c.args.includes("--resolve-only"))).toHaveLength(1);
    expect(proxy.sends).toEqual([
      { routeId: "issue-state", ticket: "CTL-3", payload: { issueId: ISSUE_ID, stateId: STATE_ID } },
    ]);
  });

  test("from_state/to_state carry what --resolve-only actually read — measured, not fabricated", () => {
    setLinearWriteProxyResolver(fakeResolver());
    const r = applyTerminalDone({
      ticket: "CTL-3",
      resolveRepoRoot: () => "/repo",
      exec: recordingExec([]),
      proxy: fakeProxy("enforce"),
    });
    expect(r.from_state).toBe("Research");
    expect(r.to_state).toBe("PR");
  });

  test("an idempotent 'skipped' resolve applies WITHOUT spending a cloud write", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const r = applyPhaseStatus({
      ticket: "CTL-3",
      phase: "pr",
      resolveRepoRoot: () => "/repo",
      exec: (cmd, args) =>
        args.includes("--resolve-only")
          ? { code: 0, stdout: JSON.stringify({ action: "skipped", currentState: "PR", targetState: "PR" }), stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      proxy,
    });
    expect(r.applied).toBe(true);
    // Same vocabulary the DIRECT path uses for this outcome — the shadow window compares
    // the two, so the idempotent no-op must not be spelled differently on each side.
    expect(r.action).toBe("skipped");
    expect(r.skipped).toBe("already-in-target-state");
    expect(proxy.sends).toHaveLength(0);
  });

  test("⛔ a FAILING --resolve-only refuses; it does not fall through to the writing shell", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const calls = [];
    const r = applyPhaseStatus({
      ticket: "CTL-3",
      phase: "pr",
      resolveRepoRoot: () => "/repo",
      exec: (cmd, args) => {
        calls.push({ cmd, args });
        return args.includes("--resolve-only") ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" };
      },
      proxy,
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("resolve:resolve-only-failed");
    expect(calls.filter(isWritingTransition)).toHaveLength(0);
  });

  test("⛔ a proxy FAILURE does not fall back to a direct Linear write", () => {
    const proxy = fakeProxy("enforce", { handled: true, applied: false, reason: "no-cloud-token" });
    setLinearWriteProxyResolver(fakeResolver());
    const calls = [];
    const r = applyLabel({ ticket: "CTL-4", label: "needs-human", exec: recordingExec(calls), proxy });
    expect(r).toEqual({ applied: false, reason: "no-cloud-token" });
    expect(calls).toHaveLength(0);
    // NEGATIVE CONTROL: with no proxy the SAME exec IS reached, so the zero above is
    // a refusal and not a dead recorder.
    applyLabel({ ticket: "CTL-4", label: "needs-human", exec: recordingExec(calls), readLabels: () => ["needs-human"] });
    expect(calls).toHaveLength(1);
  });

  test("a THROWING transport is a named failure, not a silent direct write", () => {
    const calls = [];
    const r = applyLabel({
      ticket: "CTL-5",
      label: "x",
      exec: recordingExec(calls),
      proxy: (setLinearWriteProxyResolver(fakeResolver()), { mode: "enforce", send() { throw new Error("boom"); } }),
    });
    expect(r).toEqual({ applied: false, reason: "proxy-threw" });
    expect(calls).toHaveLength(0);
  });

  test("a throwing transport in SHADOW falls through to the direct write (observation lost, write unaffected)", () => {
    const calls = [];
    const r = applyLabel({
      ticket: "CTL-5",
      label: "x",
      exec: recordingExec(calls),
      readLabels: () => ["x"],
      proxy: { mode: "shadow", send() { throw new Error("boom"); } },
    });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls).toHaveLength(1);
  });
});

describe("⛔ the CTL-758 backward-write guard still runs, and runs BEFORE the proxy", () => {
  test("a ticket already at Done is not written to the proxy at all", () => {
    const proxy = fakeProxy("enforce");
    const r = applyPhaseStatus({
      ticket: "CTL-6",
      phase: "pr", // non-terminal key → the guard applies
      resolveRepoRoot: () => "/repo",
      exec: () => ({ code: 0, stdout: "", stderr: "" }),
      // fetchTicketState reads through exec; short-circuit it with a cache hit instead.
      cache: { get: () => "Done", set: () => {}, invalidate: () => {} },
      proxy,
    });
    expect(r.skipped).toBe("terminal-no-backward");
    expect(proxy.sends).toHaveLength(0);
  });

  test("NEGATIVE CONTROL: the same call on a non-terminal ticket DOES reach the proxy", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const calls = [];
    applyPhaseStatus({
      ticket: "CTL-6",
      phase: "pr",
      resolveRepoRoot: () => "/repo",
      exec: recordingExec(calls),
      cache: { get: () => "Research", set: () => {}, invalidate: () => {} },
      proxy,
    });
    expect(proxy.sends).toHaveLength(1);
  });

  test("⭐ P1 (Codex #3489): the guard is RE-APPLIED to the state --resolve-only read", () => {
    // The guard above is fail-OPEN — when its own read cannot answer it returns null and
    // falls through. `--resolve-only` then reads the real state off the fresh replica. If
    // that says Done, a backward write must still be refused, or the proxy path reopens a
    // terminal ticket in exactly the configuration this feature targets: an enforce host
    // with no linearis, where the first read is MOST likely to fail and the second MOST
    // likely to succeed.
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const r = applyPhaseStatus({
      ticket: "CTL-6",
      phase: "pr", // non-terminal key → the guard applies
      resolveRepoRoot: () => "/repo",
      // The guard's own read cannot answer — this is the fall-through it is built to allow.
      cache: { get: () => null, set: () => {}, invalidate: () => {} },
      exec: (cmd, args) =>
        args.includes("--resolve-only")
          ? { code: 0, stdout: JSON.stringify({ action: "resolve-only", currentState: "Done", targetState: "PR" }), stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      proxy,
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("resolve:terminal-no-backward");
    expect(proxy.sends).toHaveLength(0);
  });

  test("NEGATIVE CONTROL: the same fall-through with a NON-terminal resolved state DOES write", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const r = applyPhaseStatus({
      ticket: "CTL-6",
      phase: "pr",
      resolveRepoRoot: () => "/repo",
      cache: { get: () => null, set: () => {}, invalidate: () => {} },
      exec: (cmd, args) =>
        args.includes("--resolve-only")
          ? { code: 0, stdout: JSON.stringify({ action: "resolve-only", currentState: "Research", targetState: "PR" }), stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      proxy,
    });
    expect(r.applied).toBe(true);
    expect(proxy.sends).toHaveLength(1);
  });

  test("the FORWARD terminal write is exempt — Done must remain settable", () => {
    // Mirrors the guard above: `key === TERMINAL_LINEAR_KEY` is how Done gets written at
    // all. A re-applied guard that forgot this exemption would deadlock every ticket one
    // step short of Done.
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const r = applyTerminalDone({
      ticket: "CTL-6",
      resolveRepoRoot: () => "/repo",
      cache: { get: () => null, set: () => {}, invalidate: () => {} },
      exec: (cmd, args) =>
        args.includes("--resolve-only")
          ? { code: 0, stdout: JSON.stringify({ action: "resolve-only", currentState: "Canceled", targetState: "Done" }), stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      proxy,
    });
    expect(r.applied).toBe(true);
    expect(proxy.sends).toHaveLength(1);
  });

  test("a missing repoRoot short-circuits before the proxy (unchanged precondition)", () => {
    const proxy = fakeProxy("enforce");
    const r = applyPhaseStatus({ ticket: "CTL-6", phase: "pr", resolveRepoRoot: () => null, exec: () => ({ code: 0 }), proxy });
    expect(r.reason).toBe("no-repo-root");
    expect(proxy.sends).toHaveLength(0);
  });
});

describe("removeLabel — the proxied removal runs BEFORE the credentialed read", () => {
  test("⭐ enforce: a NATIVE remove of the one label — not an overwrite of the remaining set", async () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const calls = [];
    const r = await removeLabel("CTL-7", "needs-human", {
      exec: recordingExec(calls),
      readLabels: () => ({ ok: true, labels: ["needs-human", "bug", "p1"] }),
      proxy,
    });
    expect(r).toEqual({ removed: true, wrote: true });
    // ⛔ The earlier cut sent {mode:"overwrite", labels:["bug","p1"]}. The cloud accepts
    // add|remove ONLY and would have 400'd it. Native remove is also strictly safer:
    // an overwrite races any label another actor adds between the read and the write
    // and silently drops it, which a remove cannot do.
    expect(proxy.sends).toEqual([
      { routeId: "label", ticket: "CTL-7", payload: { issueId: ISSUE_ID, labelIds: [LABEL_ID], mode: "remove" } },
    ]);
    expect(calls).toHaveLength(0);
  });

  test("enforce: removing the LAST label is the same native remove — no --clear-labels shell", async () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    await removeLabel("CTL-7", "only", {
      exec: () => { throw new Error("must not exec"); },
      readLabels: () => ({ ok: true, labels: ["only"] }),
      proxy,
    });
    expect(proxy.sends[0].payload).toEqual({ issueId: ISSUE_ID, labelIds: [LABEL_ID], mode: "remove" });
  });

  test("enforce: a proxy failure is a named non-removal, with no direct-write fall-back", async () => {
    const calls = [];
    const r = await removeLabel("CTL-7", "needs-human", {
      exec: recordingExec(calls),
      readLabels: () => ({ ok: true, labels: ["needs-human", "bug"] }),
      proxy: (setLinearWriteProxyResolver(fakeResolver()),
        fakeProxy("enforce", { handled: true, applied: false, reason: "unauthorized" })),
    });
    expect(r).toEqual({ removed: false, wrote: false, reason: "unauthorized" });
    expect(calls).toHaveLength(0);
  });

  // ⛔ THE REGRESSION THIS BLOCK EXISTS FOR (Codex #3489 round 2, P1). Both tests below
  // replace earlier ones that PINNED THE DEFECT — they asserted the read short-circuits
  // ahead of the proxy, which is exactly what strands an enforce host. A test can hold a
  // bug in place as firmly as it holds a fix, so they are inverted here, not deleted.
  test("⭐ enforce: a read that fails the way a MISSING linearis fails still removes via the proxy", async () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const calls = [];
    const r = await removeLabel("CTL-7", "needs-human", {
      exec: recordingExec(calls),
      // 127 = spawn failure, the shape rawExec reports for an absent binary. This is the
      // target deployment of enforce mode: a host with NO linearis and no host Linear
      // credential. Before the fix this returned {removed:false, reason:"transient"} and
      // never sent, so the daemon's comment-wake clear could never remove needs-input /
      // needs-human — the worker stayed parked after the user had already answered.
      readLabels: () => ({ ok: false, labels: null, code: 127, stderr: "spawn linearis ENOENT" }),
      proxy,
    });
    expect(r).toEqual({ removed: true, wrote: true });
    expect(proxy.sends).toEqual([
      { routeId: "label", ticket: "CTL-7", payload: { issueId: ISSUE_ID, labelIds: [LABEL_ID], mode: "remove" } },
    ]);
    expect(calls).toHaveLength(0);
  });

  test("an AUTH read failure is equally no longer fatal under enforce", async () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const r = await removeLabel("CTL-7", "needs-human", {
      exec: () => { throw new Error("must not exec"); },
      readLabels: () => ({ ok: false, labels: null, code: 1, stderr: "401 Unauthorized" }),
      proxy,
    });
    expect(r).toEqual({ removed: true, wrote: true });
    expect(proxy.sends).toHaveLength(1);
  });

  // ⚠️ NEGATIVE CONTROL — without the proxy the read is still load-bearing and still
  // fatal. Without this, the two tests above would also pass if the read had simply been
  // deleted outright, which would silently drop the direct path's label-preserving
  // read-modify-write.
  test("no proxy: a failed read is STILL a named non-removal (direct path unchanged)", async () => {
    const r = await removeLabel("CTL-7", "x", {
      exec: () => ({ code: 0 }),
      readLabels: () => ({ ok: false, labels: null, code: 1, stderr: "nope" }),
    });
    expect(r).toMatchObject({ removed: false, wrote: false, reason: "transient" });
  });

  test("shadow: a failed read is still fatal, because shadow performs the DIRECT write", async () => {
    const proxy = fakeProxy("shadow");
    const r = await removeLabel("CTL-7", "x", {
      exec: () => ({ code: 0 }),
      readLabels: () => ({ ok: false, labels: null, code: 1, stderr: "401 Unauthorized" }),
      proxy,
    });
    expect(r).toMatchObject({ removed: false, wrote: false, reason: "auth-error" });
  });

  // ⚠️ THE NAMED NARROWING, pinned so it is a decision and not a drift. Under enforce the
  // already-absent case can no longer be detected (detecting it costs the very credential
  // being retired), so it sends an idempotent cloud remove and reports wrote:true. The
  // direct path below still reports wrote:false for the same case — the asymmetry is
  // deliberate: a spurious `worker.transition` clear on a duplicate wake is recoverable,
  // a permanently MISSING clear on every enforce host is not.
  test("enforce: an already-absent label is sent anyway and reports wrote:true", async () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxyResolver(fakeResolver());
    const r = await removeLabel("CTL-7", "gone", {
      exec: () => { throw new Error("must not exec"); },
      readLabels: () => ({ ok: true, labels: ["bug"] }),
      proxy,
    });
    expect(r).toEqual({ removed: true, wrote: true });
    expect(proxy.sends).toHaveLength(1);
  });

  test("no proxy: the already-absent label is still a no-op write (wrote:false)", async () => {
    const calls = [];
    const r = await removeLabel("CTL-7", "gone", {
      exec: recordingExec(calls),
      readLabels: () => ({ ok: true, labels: ["bug"] }),
    });
    expect(r).toEqual({ removed: true, wrote: false });
    expect(calls).toHaveLength(0);
  });

  test("shadow: the proxy observes AND linearis still performs the overwrite", async () => {
    const proxy = fakeProxy("shadow");
    const calls = [];
    const r = await removeLabel("CTL-8", "needs-human", {
      exec: recordingExec(calls),
      readLabels: () => ({ ok: true, labels: ["needs-human", "bug"] }),
      readLabelNodes: () => ({ ok: false }),
      proxy,
    });
    expect(r).toEqual({ removed: true, wrote: true });
    expect(proxy.sends).toEqual([{ routeId: "label", ticket: "CTL-8", payload: {} }]);
    expect(calls[0].args).toEqual(["issues", "update", "CTL-8", "--labels", "bug", "--label-mode", "overwrite"]);
  });
});

describe("setLinearWriteProxy — the module-level install", () => {
  test("an installed transport is used when no per-call proxy is passed", () => {
    const proxy = fakeProxy("enforce");
    setLinearWriteProxy(proxy);
    setLinearWriteProxyResolver(fakeResolver());
    expect(getLinearWriteProxy()).toBe(proxy);
    const calls = [];
    applyLabel({ ticket: "CTL-9", label: "x", exec: recordingExec(calls) });
    expect(proxy.sends).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test("clearing it restores the direct path", () => {
    setLinearWriteProxy(fakeProxy("enforce"));
    setLinearWriteProxy(null);
    const calls = [];
    applyLabel({ ticket: "CTL-9", label: "x", exec: recordingExec(calls), readLabels: () => ["x"] });
    expect(calls).toHaveLength(1);
  });
});
