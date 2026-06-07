// linear-write.test.mjs — execution-core Linear status write-back (CTL-558).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write.test.mjs
import { describe, test, expect } from "bun:test";
import {
  applyPhaseStatus,
  applyTerminalDone,
  applyLabel,
  applyTriageStatus,
  removeLabel,
  applyBlockedByRelation,
  applyEstimate,
  applyAssignee,
  teamOf,
} from "./linear-write.mjs";
import { createTicketStateCache } from "./linear-cache.mjs";

const okExec = (calls) => (cmd, args) => {
  calls.push({ cmd, args });
  return { code: 0, stdout: JSON.stringify({ action: "transitioned" }), stderr: "" };
};

describe("teamOf", () => {
  test("extracts the identifier prefix", () => {
    expect(teamOf("CTL-558")).toBe("CTL");
    expect(teamOf("ENG-1")).toBe("ENG");
  });
  test("returns null for a malformed identifier", () => {
    expect(teamOf("nonsense")).toBeNull();
    expect(teamOf("")).toBeNull();
    expect(teamOf(null)).toBeNull();
  });
});

describe("applyPhaseStatus", () => {
  test("skips triage — no status key, no exec call", () => {
    const calls = [];
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "triage",
      resolveRepoRoot: () => "/repo",
      exec: okExec(calls),
    });
    expect(r.skipped).toBe("no-status-key");
    expect(calls).toHaveLength(0);
  });
  test("shells linear-transition.sh with the phase's mapped --transition key", () => {
    const calls = [];
    applyPhaseStatus({
      ticket: "CTL-1",
      phase: "verify",
      resolveRepoRoot: () => "/repo",
      exec: okExec(calls),
    });
    // CTL-758: the backward-write guard pre-reads current state via
    // `linearis issues read` for non-terminal keys, so the transition shell call
    // is no longer necessarily calls[0]. Locate it explicitly by its --transition
    // arg (the guard read has no --transition).
    const transitionCall = calls.find((c) => c.args.includes("--transition"));
    expect(transitionCall).toBeDefined();
    const args = transitionCall.args;
    expect(args).toContain("--transition");
    expect(args[args.indexOf("--transition") + 1]).toBe("verifying");
    expect(args).toContain("--ticket");
    expect(args).toContain("CTL-1");
    expect(args.join(" ")).toContain("/repo/.catalyst/config.json");
  });
  test("returns applied:false when the repo root cannot be resolved", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot: () => null,
      exec: okExec([]),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("no-repo-root");
  });
  test("returns applied:false on a non-zero linear-transition exit", () => {
    const exec = () => ({ code: 2, stdout: "", stderr: "update-failed" });
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot: () => "/repo",
      exec,
    });
    expect(r.applied).toBe(false);
  });
  test("never throws — a thrown exec is caught and reported", () => {
    const exec = () => {
      throw new Error("spawn boom");
    };
    expect(() =>
      applyPhaseStatus({
        ticket: "CTL-1",
        phase: "plan",
        resolveRepoRoot: () => "/repo",
        exec,
      })
    ).not.toThrow();
  });
});

describe("applyTerminalDone", () => {
  test("shells linear-transition.sh with --transition done", () => {
    const calls = [];
    applyTerminalDone({ ticket: "CTL-1", resolveRepoRoot: () => "/repo", exec: okExec(calls) });
    const args = calls[0].args;
    expect(args[args.indexOf("--transition") + 1]).toBe("done");
  });
});

// CTL-758: the backward-write guard in runTransition refuses to drag a ticket
// already at a terminal Linear state (Done/Canceled) BACK to a non-terminal
// state — EXCEPT the forward terminal write (key === "done"), which must always
// proceed (the CRITICAL SAFETY case: a bug here strands every monitor-deploy at PR).
describe("CTL-758: backward-write guard", () => {
  const resolveRepoRoot = () => "/repo";

  // exec that records calls AND returns the transition shell JSON. The guard's
  // pre-read uses a SEPARATE injected fetchState, so any --transition call in
  // `calls` proves the shell ran.
  function recordingExec(calls) {
    return (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ action: "transitioned", currentState: "PR", targetState: "Done" }), stderr: "" };
    };
  }
  const ranShell = (calls) => calls.some((c) => c.args.includes("--transition"));

  test("terminal current + NON-terminal key (verifying) ⇒ skips the shell (exec 0 --transition calls)", () => {
    const calls = [];
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "verify", // → key "verifying", a non-terminal key
      resolveRepoRoot,
      exec: recordingExec(calls),
      // shared cache reader proves the ticket is already Done
      cache: { get: () => "Done", set: () => {} },
      // when a cache hit exists fetchTicketState returns it without exec; but be
      // explicit — the guard reads via fetchState(ticket,{exec,cache}).
    });
    expect(r.applied).toBe(false);
    expect(r.skipped).toBe("terminal-no-backward");
    expect(r.reason).toBe("skipped-terminal-no-backward");
    expect(r.from_state).toBe("Done");
    expect(ranShell(calls)).toBe(false); // CRITICAL: the shell never ran
  });

  test("Canceled current + non-terminal key ⇒ skips the shell", () => {
    const calls = [];
    const r = applyPhaseStatus({
      ticket: "CTL-2",
      phase: "plan",
      resolveRepoRoot,
      exec: recordingExec(calls),
      cache: { get: () => "Canceled", set: () => {} },
    });
    expect(r.skipped).toBe("terminal-no-backward");
    expect(ranShell(calls)).toBe(false);
  });

  test("NON-terminal current + non-terminal key ⇒ shell PROCEEDS (no false block)", () => {
    const calls = [];
    const r = applyPhaseStatus({
      ticket: "CTL-3",
      phase: "verify",
      resolveRepoRoot,
      exec: recordingExec(calls),
      cache: { get: () => "PR", set: () => {} }, // non-terminal
    });
    expect(r.applied).toBe(true);
    expect(ranShell(calls)).toBe(true);
  });

  // ── THE CRITICAL SAFETY TEST ──────────────────────────────────────────────
  test("forward terminal write (key='done') PROCEEDS even when current state is terminal", () => {
    // A ticket already at Done re-confirming Done via applyTerminalDone must NOT
    // be blocked by the guard — key === TERMINAL_LINEAR_KEY is exempt, so the
    // guard never even reads, and the idempotent shell runs.
    const calls = [];
    const cacheReads = [];
    const r = applyTerminalDone({
      ticket: "CTL-4",
      resolveRepoRoot,
      exec: recordingExec(calls),
      cache: { get: (k) => { cacheReads.push(k); return "Done"; }, set: () => {} },
    });
    expect(r.applied).toBe(true);
    expect(ranShell(calls)).toBe(true); // the forward Done write proceeded
    // the guard is exempt for the terminal key → it never read the cache
    expect(cacheReads.length).toBe(0);
  });

  test("non-terminal current + key='done' ⇒ proceeds (normal monitor-deploy Done)", () => {
    const calls = [];
    const r = applyTerminalDone({
      ticket: "CTL-5",
      resolveRepoRoot,
      exec: recordingExec(calls),
      cache: { get: () => "PR", set: () => {} },
    });
    expect(r.applied).toBe(true);
    expect(ranShell(calls)).toBe(true);
  });

  // ── API-STORM REGRESSION (plan Top-Risk: "Cache not threaded = single most
  // likely regression"). Wire the REAL fetchTicketState through the guard with a
  // shared TTL cache (the scheduler's threading) and assert the guard issues
  // ≤1 underlying `linearis issues read` across TWO guarded writes within TTL.
  // The guard read MUST flow through the injected `cache`, not re-exec per write.
  test("guard read goes through the shared cache — ≤1 `issues read` exec per ticket per TTL", () => {
    const cache = createTicketStateCache({ now: () => 0 }); // TTL never expires within the test
    let reads = 0;
    // One exec serves BOTH the guard's cached `linearis issues read` AND any
    // `linear-transition.sh --transition` shell. Only the read path increments
    // `reads`; a non-terminal state means the guard proceeds to the shell.
    const exec = (_cmd, args) => {
      if (args[0] === "issues" && args[1] === "read") {
        reads += 1;
        return { code: 0, stdout: JSON.stringify({ state: { name: "PR" } }), stderr: "" };
      }
      // the transition shell
      return { code: 0, stdout: JSON.stringify({ action: "transitioned", currentState: "PR", targetState: "Validate" }), stderr: "" };
    };
    // Two successive guarded writes (non-terminal key) for the SAME ticket.
    applyPhaseStatus({ ticket: "CTL-9", phase: "verify", resolveRepoRoot, exec, cache });
    applyPhaseStatus({ ticket: "CTL-9", phase: "verify", resolveRepoRoot, exec, cache });
    expect(reads).toBe(1); // second guard read was a cache hit — no API storm
  });

  test("WITHOUT a shared cache the guard re-reads each write (proves the cache is what dedups)", () => {
    let reads = 0;
    const exec = (_cmd, args) => {
      if (args[0] === "issues" && args[1] === "read") {
        reads += 1;
        return { code: 0, stdout: JSON.stringify({ state: { name: "PR" } }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ action: "transitioned", currentState: "PR", targetState: "Validate" }), stderr: "" };
    };
    applyPhaseStatus({ ticket: "CTL-9", phase: "verify", resolveRepoRoot, exec }); // no cache
    applyPhaseStatus({ ticket: "CTL-9", phase: "verify", resolveRepoRoot, exec });
    expect(reads).toBe(2); // no cache → one read per write (contrast to the dedup above)
  });
});

// CTL-757: runTransition (via applyPhaseStatus/applyTerminalDone) returns
// from_state/to_state parsed from linear-transition.sh's --json currentState/
// targetState — FREE (no extra read), feeds the caller-emitted state.write event.
describe("CTL-757: runTransition from_state/to_state propagation", () => {
  const resolveRepoRoot = () => "/repo";

  // A transition exec that mirrors linear-transition.sh's emit() JSON shape.
  function transitionExec({ action = "transitioned", currentState = "", targetState = "", code = 0 } = {}) {
    return () => ({
      code,
      stdout: JSON.stringify({ ticket: "CTL-1", currentState, targetState, action }),
      stderr: "",
    });
  }

  test("applyPhaseStatus surfaces from_state/to_state from the shell JSON", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot,
      exec: transitionExec({ currentState: "Research", targetState: "Plan" }),
    });
    expect(r.applied).toBe(true);
    expect(r.from_state).toBe("Research");
    expect(r.to_state).toBe("Plan");
  });

  test("applyTerminalDone surfaces from_state/to_state", () => {
    const r = applyTerminalDone({
      ticket: "CTL-1",
      resolveRepoRoot,
      exec: transitionExec({ currentState: "PR", targetState: "Done" }),
    });
    expect(r.from_state).toBe("PR");
    expect(r.to_state).toBe("Done");
  });

  test("idempotent skip (from==to, action:skipped) — applied:true, from_state==to_state", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "verify",
      resolveRepoRoot,
      exec: transitionExec({ action: "skipped", currentState: "Validate", targetState: "Validate" }),
    });
    expect(r.applied).toBe(true);
    expect(r.from_state).toBe("Validate");
    expect(r.to_state).toBe("Validate");
    expect(r.from_state).toBe(r.to_state);
  });

  test("failure path (exit non-zero, update-failed) still returns from_state + reason", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot,
      exec: transitionExec({ action: "update-failed", currentState: "Research", targetState: "Plan", code: 1 }),
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("exit-1");
    expect(r.from_state).toBe("Research");
    expect(r.to_state).toBe("Plan");
  });

  test("empty currentState/targetState normalise to null (not empty string)", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot,
      exec: transitionExec({ currentState: "", targetState: "" }),
    });
    expect(r.from_state).toBeNull();
    expect(r.to_state).toBeNull();
  });

  test("non-JSON stdout (no-linearis / spawn) → from_state/to_state null, applied stays false", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot,
      exec: () => ({ code: 1, stdout: "not json", stderr: "boom" }),
    });
    expect(r.from_state).toBeNull();
    expect(r.to_state).toBeNull();
    expect(r.applied).toBe(false);
  });

  test("no-repo-root path returns from_state/to_state null", () => {
    const r = applyPhaseStatus({
      ticket: "CTL-1",
      phase: "plan",
      resolveRepoRoot: () => null,
      exec: transitionExec(),
    });
    expect(r.reason).toBe("no-repo-root");
    expect(r.from_state).toBeNull();
    expect(r.to_state).toBeNull();
  });
});

describe("applyLabel", () => {
  // okExec returns exit-0 for BOTH the update call AND the CTL-587 read-back —
  // the read-back returns labels.nodes containing the requested label so the
  // existing pre-CTL-587 tests still see `applied: true`.
  function makeOkExec(calls, { readbackLabels } = {}) {
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "issues" && args[1] === "update") {
        return { code: 0, stdout: JSON.stringify({ action: "transitioned" }), stderr: "" };
      }
      if (args[0] === "issues" && args[1] === "read") {
        const label = args[2] === "CTL-1" ? "needs-human" : "needs-human";
        const labels = readbackLabels ?? [{ name: label }];
        return { code: 0, stdout: JSON.stringify({ labels: { nodes: labels } }), stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unexpected" };
    };
  }

  test("shells linearis issues update --labels <l> --label-mode add", () => {
    const calls = [];
    applyLabel({ ticket: "CTL-1", label: "needs-human", exec: makeOkExec(calls) });
    const args = calls[0].args;
    expect(args.slice(0, 3)).toEqual(["issues", "update", "CTL-1"]);
    expect(args).toContain("--labels");
    expect(args[args.indexOf("--labels") + 1]).toBe("needs-human");
    expect(args[args.indexOf("--label-mode") + 1]).toBe("add");
  });

  test("never throws on a failed label exec", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "no such label" });
    expect(() => applyLabel({ ticket: "CTL-1", label: "needs-human", exec })).not.toThrow();
  });

  // CTL-587: verify-write-landed. Closes the silent-success gap in linearis
  // label writes (memory project_linear_transition_silent_success): the
  // update exits 0 but the label never lands. The read-back makes applied:true
  // mean the label is actually on the ticket.
  test("CTL-587: write succeeds AND read-back confirms label present → applied:true", () => {
    const calls = [];
    const exec = makeOkExec(calls); // read-back returns the label
    const r = applyLabel({ ticket: "CTL-1", label: "needs-human", exec });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls[0].args.slice(0, 2)).toEqual(["issues", "update"]);
    expect(calls[1].args.slice(0, 2)).toEqual(["issues", "read"]);
  });

  test("CTL-587: write succeeds BUT read-back missing label → applied:false, verify-failed", () => {
    const calls = [];
    const exec = makeOkExec(calls, { readbackLabels: [] }); // empty labels
    const r = applyLabel({ ticket: "CTL-1", label: "needs-human", exec });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("verify-failed");
  });

  test("CTL-587: read-back returns null (linearis read failure) → applied:false, verify-failed", () => {
    const exec = (_cmd, args) => {
      if (args[1] === "update") return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "read") return { code: 1, stdout: "", stderr: "" };
      return { code: 127 };
    };
    const r = applyLabel({ ticket: "CTL-1", label: "needs-human", exec });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe("verify-failed");
  });

  test("CTL-587: throw in exec is swallowed → applied:false (existing behaviour preserved)", () => {
    const exec = () => {
      throw new Error("exec died");
    };
    expect(applyLabel({ ticket: "CTL-1", label: "needs-human", exec }).applied).toBe(false);
  });

  // CTL-585: tagged-reason return contract on the write-failure path. A
  // non-zero exit is classified so callers can short-circuit the one
  // unrecoverable case (missing-label) instead of storming the Linear API.
  // The success path still flows through the CTL-587 read-back above.
  test("CTL-585: zero exit + read-back confirms → applied:true, reason:null", () => {
    const calls = [];
    const exec = makeOkExec(calls, { readbackLabels: [{ name: "triaged" }] });
    const r = applyLabel({ ticket: "CTL-1", label: "triaged", exec });
    expect(r).toEqual({ applied: true, reason: null });
  });
  test("CTL-585: classifies a missing-label stderr as reason:'missing-label' (no read-back)", () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 1, stdout: "", stderr: 'Label "triaged" not found' };
    };
    const r = applyLabel({ ticket: "CTL-1", label: "triaged", exec });
    expect(r).toEqual({ applied: false, reason: "missing-label" });
    expect(calls).toHaveLength(1); // write failed → no read-back attempted
  });
  test("CTL-585: classifies a rate-limit stderr as reason:'rate-limited'", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "Rate limit exceeded" });
    const r = applyLabel({ ticket: "CTL-1", label: "triaged", exec });
    expect(r).toEqual({ applied: false, reason: "rate-limited" });
  });
  test("classifies a cross-team label-UUID stderr as reason:'missing-label' (no per-tick retry storm)", () => {
    // Linear's labels are team-scoped: same name, different UUID per team. When
    // linearis resolves the label in the wrong team's workspace context and
    // sends the cross-team UUID, Linear returns this exact error. It is
    // permanently unrecoverable inside one daemon lifetime (the resolver is
    // global), so it must classify as missing-label to short-circuit retries.
    const exec = () => ({
      code: 1,
      stdout: "",
      stderr:
        'GraphQL request failed: LabelIds for incorrect team - The label \'needs-human\' is not associated with the same team as the issue.',
    });
    const r = applyLabel({ ticket: "ADV-1213", label: "needs-human", exec });
    expect(r).toEqual({ applied: false, reason: "missing-label" });
  });
  test("CTL-585: any other non-zero exit is reason:'transient'", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "boom" });
    const r = applyLabel({ ticket: "CTL-1", label: "triaged", exec });
    expect(r).toEqual({ applied: false, reason: "transient" });
  });
  test("CTL-585: a spawn-error (code 127) is reason:'transient'", () => {
    const exec = () => ({ code: 127, stdout: "", stderr: "ENOENT" });
    const r = applyLabel({ ticket: "CTL-1", label: "triaged", exec });
    expect(r).toEqual({ applied: false, reason: "transient" });
  });
  test("CTL-585: a thrown exec is reason:'transient' and never throws", () => {
    const exec = () => {
      throw new Error("spawn boom");
    };
    const r = applyLabel({ ticket: "CTL-1", label: "triaged", exec });
    expect(r).toEqual({ applied: false, reason: "transient" });
  });
});

// CTL-704: applyTriageStatus — verified Todo→Triage write-back with pre/post state reads.
// Uses injectable `fetchState` seam for the reads and `exec` seam for the transition.
describe("applyTriageStatus", () => {
  const resolveRepoRoot = () => "/repo";

  // Builds a fake exec that returns a successful transition response (code 0, action: transitioned).
  function makeTransitionExec(calls = []) {
    return (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: JSON.stringify({ action: "transitioned" }), stderr: "" };
    };
  }

  test("happy path — state lands → verified:true, from_state captured", () => {
    const calls = [];
    const exec = makeTransitionExec(calls);
    let readCount = 0;
    const fetchState = (_ticket, _opts) => (++readCount === 1 ? "Todo" : "Triage");
    const r = applyTriageStatus({ ticket: "CTL-704", resolveRepoRoot, exec, fetchState });
    expect(r).toEqual({ applied: true, verified: true, from_state: "Todo", to_state: "Triage", reason: null });
    // transition was called with --transition triage
    const args = calls[0].args;
    expect(args).toContain("--transition");
    expect(args[args.indexOf("--transition") + 1]).toBe("triage");
  });

  test("false-success — exit 0 but stale state → verified:false", () => {
    const exec = makeTransitionExec();
    // Both reads return "Todo" — the write exited 0 but state never changed
    const fetchState = () => "Todo";
    const r = applyTriageStatus({ ticket: "CTL-704", resolveRepoRoot, exec, fetchState });
    expect(r.applied).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.to_state).toBe("Todo");
    expect(r.reason).toBe("verify-failed");
  });

  test("transition fails (exit non-zero) — applied:false, no re-read attempted", () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 1, stdout: JSON.stringify({ action: "update-failed" }), stderr: "" };
    };
    let readCount = 0;
    const fetchState = (_ticket, _opts) => { readCount++; return "Todo"; };
    const r = applyTriageStatus({ ticket: "CTL-704", resolveRepoRoot, exec, fetchState });
    expect(r.applied).toBe(false);
    expect(r.verified).toBe(false);
    // fetchState called once for from_state, NOT a second time for post-transition verify
    expect(readCount).toBe(1);
  });

  test("re-read fails (fetchTicketState returns null) → applied:true, verified:false, verify-unreadable", () => {
    const exec = makeTransitionExec();
    let readCount = 0;
    const fetchState = () => (++readCount === 1 ? "Todo" : null);
    const r = applyTriageStatus({ ticket: "CTL-704", resolveRepoRoot, exec, fetchState });
    expect(r.applied).toBe(true);
    expect(r.verified).toBe(false);
    expect(r.to_state).toBeNull();
    expect(r.reason).toBe("verify-unreadable");
  });

  test("never throws — a thrown exec still yields a result object", () => {
    const exec = () => { throw new Error("spawn boom"); };
    const fetchState = () => { throw new Error("read boom"); };
    expect(() =>
      applyTriageStatus({ ticket: "CTL-704", resolveRepoRoot, exec, fetchState })
    ).not.toThrow();
    const r = applyTriageStatus({ ticket: "CTL-704", resolveRepoRoot, exec, fetchState });
    expect(r.applied).toBe(false);
    expect(r.verified).toBe(false);
  });
});

// CTL-549: removeLabel — remove a single label without clobbering the others.
// linearis 2026.4.9 has no single-label-remove primitive (`--label-mode` only
// accepts add|overwrite; `remove` is REJECTED), so removeLabel read-modify-writes:
// fetch the current label set, filter out the target, overwrite with the
// remainder (or --clear-labels when the remainder is empty).
describe("removeLabel (CTL-549)", () => {
  test("reads current labels then overwrites with the remainder (preserves others)", async () => {
    const cmds = [];
    const exec = (cmd, args) => { cmds.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    // ticket has ['blocked','orchestrator']; remove 'blocked' → overwrite with 'orchestrator'
    const fetchLabels = () => ["blocked", "orchestrator"];
    const result = await removeLabel("CTL-1", "blocked", { exec, fetchLabels });
    expect(result.removed).toBe(true);
    expect(cmds).toHaveLength(1);
    const args = cmds[0].args;
    expect(args.slice(0, 3)).toEqual(["issues", "update", "CTL-1"]);
    expect(args).toContain("--labels");
    expect(args[args.indexOf("--labels") + 1]).toBe("orchestrator");
    expect(args).toContain("--label-mode");
    expect(args[args.indexOf("--label-mode") + 1]).toBe("overwrite");
    // the rejected `remove` value must never be emitted anymore
    expect(args).not.toContain("remove");
  });

  test("multiple remaining labels are joined into a single --labels arg", async () => {
    const cmds = [];
    const exec = (cmd, args) => { cmds.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const fetchLabels = () => ["needs-human/question", "orchestrator", "bug"];
    const result = await removeLabel("CTL-1", "needs-human/question", { exec, fetchLabels });
    expect(result.removed).toBe(true);
    const args = cmds[0].args;
    expect(args[args.indexOf("--labels") + 1]).toBe("orchestrator,bug");
    expect(args[args.indexOf("--label-mode") + 1]).toBe("overwrite");
  });

  test("idempotent — label already absent: returns removed:true with NO write", async () => {
    const cmds = [];
    const exec = (cmd, args) => { cmds.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const fetchLabels = () => ["orchestrator", "bug"]; // target 'blocked' not present
    const result = await removeLabel("CTL-1", "blocked", { exec, fetchLabels });
    expect(result.removed).toBe(true);
    expect(cmds).toHaveLength(0); // no overwrite issued
  });

  test("empty remaining set → --clear-labels (not an empty --labels overwrite)", async () => {
    const cmds = [];
    const exec = (cmd, args) => { cmds.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const fetchLabels = () => ["needs-human/question"]; // the only label is the one removed
    const result = await removeLabel("CTL-1", "needs-human/question", { exec, fetchLabels });
    expect(result.removed).toBe(true);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args).toEqual(["issues", "update", "CTL-1", "--clear-labels"]);
    expect(cmds[0].args).not.toContain("--labels");
  });

  test("read failure (fetchLabels returns null) → removed:false, reason:transient, no write", async () => {
    const cmds = [];
    const exec = (cmd, args) => { cmds.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const fetchLabels = () => null; // linearis read failed
    const result = await removeLabel("CTL-1", "needs-human/question", { exec, fetchLabels });
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("transient");
    expect(cmds).toHaveLength(0);
  });

  test("returns { removed: false, reason } on non-zero overwrite exit", async () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "not found" });
    const fetchLabels = () => ["needs-human/question", "orchestrator"];
    const result = await removeLabel("CTL-1", "needs-human/question", { exec, fetchLabels });
    expect(result.removed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  test("returns { removed: false, reason: 'transient' } on thrown exec", async () => {
    const exec = () => { throw new Error("spawn failed"); };
    const fetchLabels = () => ["needs-human/question", "orchestrator"];
    const result = await removeLabel("CTL-1", "needs-human/question", { exec, fetchLabels });
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("transient");
  });
});

// CTL-537: applyBlockedByRelation — durable blocked-by edge write.
describe("applyBlockedByRelation", () => {
  test("success — exec returns code 0 → applied:true, reason:null", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec });
    expect(r).toEqual({ applied: true, reason: null });
  });

  test("arg order — exact argv: issues update CTL-1 --blocked-by CTL-2", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec });
    expect(calls[0].cmd).toBe("linearis");
    expect(calls[0].args).toEqual(["issues", "update", "CTL-1", "--blocked-by", "CTL-2"]);
  });

  test("non-zero exit → applied:false, reason:transient, never throws", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "some error" });
    expect(() => applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec })).not.toThrow();
    const r = applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec });
    expect(r).toEqual({ applied: false, reason: "transient" });
  });

  test("exec throws → applied:false, reason:transient, never throws", () => {
    const exec = () => { throw new Error("spawn boom"); };
    expect(() => applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec })).not.toThrow();
    const r = applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec });
    expect(r).toEqual({ applied: false, reason: "transient" });
  });

  test("idempotent re-apply — two successive calls both return applied:true, two update calls recorded", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r1 = applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec });
    const r2 = applyBlockedByRelation({ ticket: "CTL-1", blockedBy: "CTL-2", exec });
    expect(r1.applied).toBe(true);
    expect(r2.applied).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("applyEstimate", () => {
  // CTL-813: fetchLabels is injected in call-counting tests so the
  // estimate-source:human pre-read doesn't go through the counted exec.
  test("valid estimate, exec returns code:0 → applied:true, correct args", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({ ticket: "CTL-1", estimate: 5, exec, fetchLabels: () => [] });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("linearis");
    expect(calls[0].args).toEqual(["issues", "update", "CTL-1", "--estimate", "5"]);
  });

  test("exec returns code:1 → applied:false with non-null reason, does not throw", () => {
    const exec = () => ({ code: 1, stdout: "", stderr: "some error" });
    expect(() => applyEstimate({ ticket: "CTL-1", estimate: 5, exec })).not.toThrow();
    const r = applyEstimate({ ticket: "CTL-1", estimate: 5, exec });
    expect(r.applied).toBe(false);
    expect(r.reason).not.toBeNull();
  });

  test("exec throws → applied:false, reason non-null, swallowed", () => {
    const exec = () => { throw new Error("spawn boom"); };
    expect(() => applyEstimate({ ticket: "CTL-1", estimate: 5, exec })).not.toThrow();
    const r = applyEstimate({ ticket: "CTL-1", estimate: 5, exec });
    expect(r.applied).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  test("invalid estimate 4 → applied:false, reason:invalid-estimate, exec not called", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({ ticket: "CTL-1", estimate: 4, exec });
    expect(r).toEqual({ applied: false, reason: "invalid-estimate" });
    expect(calls).toHaveLength(0);
  });

  test("null estimate → applied:false, reason:invalid-estimate, exec not called", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({ ticket: "CTL-1", estimate: null, exec });
    expect(r).toEqual({ applied: false, reason: "invalid-estimate" });
    expect(calls).toHaveLength(0);
  });

  test("string estimate 'x' → applied:false, reason:invalid-estimate, exec not called", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({ ticket: "CTL-1", estimate: "x", exec });
    expect(r).toEqual({ applied: false, reason: "invalid-estimate" });
    expect(calls).toHaveLength(0);
  });

  test("all valid estimate values (1,3,5,8,13) are accepted", () => {
    for (const est of [1, 3, 5, 8, 13]) {
      const calls = [];
      const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
      const r = applyEstimate({ ticket: "CTL-1", estimate: est, exec, fetchLabels: () => [] });
      expect(r.applied).toBe(true);
      expect(calls[0].args).toContain(String(est));
    }
  });

  // ── CTL-813: estimate-source:human guard ─────────────────────────────────
  // estimation-methodology.md §6b promises human estimates are never clobbered
  // (the contract score-tickets --check-labels already honors). applyEstimate
  // pre-reads the label set and skips the write when the label is present.

  test("ticket labeled estimate-source:human → skipped, update never called", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({
      ticket: "CTL-1",
      estimate: 5,
      exec,
      fetchLabels: () => ["feature", "estimate-source:human"],
    });
    expect(r.applied).toBe(false);
    expect(r.skipped).toBe("human-estimate");
    expect(r.reason).toBe("skipped-human-estimate");
    expect(calls).toHaveLength(0);
  });

  test("ticket with other labels but not the human label → write proceeds", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({
      ticket: "CTL-1",
      estimate: 5,
      exec,
      fetchLabels: () => ["feature", "estimation"],
    });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["issues", "update", "CTL-1", "--estimate", "5"]);
  });

  test("label pre-read fails (null) → FAIL-OPEN: write proceeds", () => {
    // Matches the score-tickets --check-labels precedent: a failed label check
    // warns and proceeds without the filter. The scheduler's estimate write is
    // one-shot (triage→research advance) — failing closed would silently drop
    // it forever on any transient read hiccup.
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({ ticket: "CTL-1", estimate: 5, exec, fetchLabels: () => null });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls).toHaveLength(1);
  });

  test("label pre-read throws → FAIL-OPEN: write proceeds, nothing thrown", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; };
    const r = applyEstimate({
      ticket: "CTL-1",
      estimate: 5,
      exec,
      fetchLabels: () => { throw new Error("label boom"); },
    });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls).toHaveLength(1);
  });

  test("default fetchLabels wiring: linearis read returns human label via exec → skipped", () => {
    // No injected fetchLabels — the real fetchTicketLabels path runs through
    // the injected exec: first call is the `issues read`, and on seeing the
    // human label no update call follows.
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "issues" && args[1] === "read") {
        return {
          code: 0,
          stdout: JSON.stringify({ labels: { nodes: [{ name: "estimate-source:human" }] } }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = applyEstimate({ ticket: "CTL-1", estimate: 5, exec });
    expect(r.applied).toBe(false);
    expect(r.skipped).toBe("human-estimate");
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(["issues", "read"]);
  });
});

describe("applyAssignee (CTL-781)", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";

  function makeOkExec(calls) {
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "issues" && args[1] === "update") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "issues" && args[1] === "read") {
        return { code: 0, stdout: JSON.stringify({ assignee: { id: BOT } }), stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unexpected" };
    };
  }

  test("shells linearis issues update --assignee <uuid>", () => {
    const calls = [];
    applyAssignee({ ticket: "CTL-1", userId: BOT, exec: makeOkExec(calls) });
    expect(calls[0].args.slice(0, 3)).toEqual(["issues", "update", "CTL-1"]);
    expect(calls[0].args).toContain("--assignee");
    expect(calls[0].args[calls[0].args.indexOf("--assignee") + 1]).toBe(BOT);
  });

  test("write exit-0 AND read-back assignee.id matches → applied:true, reason:null", () => {
    const calls = [];
    const r = applyAssignee({ ticket: "CTL-1", userId: BOT, exec: makeOkExec(calls) });
    expect(r).toEqual({ applied: true, reason: null });
    expect(calls[0].args.slice(0, 2)).toEqual(["issues", "update"]);
    expect(calls[1].args.slice(0, 2)).toEqual(["issues", "read"]);
  });

  test("write exits non-zero → applied:false, reason:'transient', no read-back exec", () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 1, stdout: "", stderr: "update-failed" };
    };
    const r = applyAssignee({ ticket: "CTL-1", userId: BOT, exec });
    expect(r).toEqual({ applied: false, reason: "transient" });
    expect(calls).toHaveLength(1);
  });

  test("write exit-0 BUT read-back assignee null → applied:false, reason:'verify-failed'", () => {
    const exec = (_cmd, args) => {
      if (args[1] === "update") return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "read") return { code: 0, stdout: JSON.stringify({ assignee: null }), stderr: "" };
      return { code: 127 };
    };
    const r = applyAssignee({ ticket: "CTL-1", userId: BOT, exec });
    expect(r).toEqual({ applied: false, reason: "verify-failed" });
  });

  test("write exit-0 BUT read-back assignee.id differs → applied:false, reason:'verify-failed'", () => {
    const exec = (_cmd, args) => {
      if (args[1] === "update") return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "read") return { code: 0, stdout: JSON.stringify({ assignee: { id: "other-uuid" } }), stderr: "" };
      return { code: 127 };
    };
    const r = applyAssignee({ ticket: "CTL-1", userId: BOT, exec });
    expect(r).toEqual({ applied: false, reason: "verify-failed" });
  });

  test("read-back unparseable stdout → applied:false, reason:'verify-failed'", () => {
    const exec = (_cmd, args) => {
      if (args[1] === "update") return { code: 0, stdout: "", stderr: "" };
      if (args[1] === "read") return { code: 0, stdout: "not-json", stderr: "" };
      return { code: 127 };
    };
    const r = applyAssignee({ ticket: "CTL-1", userId: BOT, exec });
    expect(r).toEqual({ applied: false, reason: "verify-failed" });
  });

  test("never throws — a thrown exec is caught, applied:false reason:'transient'", () => {
    const exec = () => { throw new Error("exec died"); };
    expect(() => applyAssignee({ ticket: "CTL-1", userId: BOT, exec })).not.toThrow();
    const r = applyAssignee({ ticket: "CTL-1", userId: BOT, exec });
    expect(r).toEqual({ applied: false, reason: "transient" });
  });

  test("missing userId → applied:false, reason:'invalid-user', zero exec calls", () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push({ cmd, args }); return { code: 0 }; };
    expect(applyAssignee({ ticket: "CTL-1", userId: "", exec })).toEqual({ applied: false, reason: "invalid-user" });
    expect(applyAssignee({ ticket: "CTL-1", userId: null, exec })).toEqual({ applied: false, reason: "invalid-user" });
    expect(applyAssignee({ ticket: "CTL-1", exec })).toEqual({ applied: false, reason: "invalid-user" });
    expect(calls).toHaveLength(0);
  });
});
