// linear-write.test.mjs — execution-core Linear status write-back (CTL-558).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write.test.mjs
import { describe, test, expect } from "bun:test";
import {
  applyPhaseStatus,
  applyTerminalDone,
  applyLabel,
  teamOf,
} from "./linear-write.mjs";

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
    const args = calls[0].args;
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
