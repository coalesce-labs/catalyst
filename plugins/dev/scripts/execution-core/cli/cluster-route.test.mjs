//bin/true 2>/dev/null; exec 1>&2; echo "REFUSING: a SHELL is executing this JavaScript module — see CTL-1937."; exit 97
// cluster-route.test.mjs — CTL-2116 Phase 3. Unit tests for the pure verb logic
// in cli/cluster-route.mjs (`catalyst cluster route <verb>`). Every guard-ordering
// assertion is driven through injected deps — no real git, no real cluster clone.
// Run: cd plugins/dev/scripts/execution-core && bun test cli/cluster-route.test.mjs
import { describe, test, expect, mock } from "bun:test";
import { routeCommand } from "./cluster-route.mjs";

function deps(overrides = {}) {
  return {
    clusterDir: "/fake",
    hasClusterRepo: () => true,
    isDirty: () => false,
    pull: () => ({ ok: true }),
    readPolicy: () => ({ routes: { triage: "codex-exec" }, history: [] }),
    writePolicy: mock(() => {}),
    commitAndPush: mock(() => ({ committed: true, pushed: true })),
    checkBudget: () => ({ verdict: "allow" }),
    by: "ryan",
    host: "mini-2",
    at: "2026-08-24T00:00:00Z",
    emitEvent: mock(() => true),
    ...overrides,
  };
}

describe("routeCommand (CTL-2116)", () => {
  test("set <phase> <executor> writes, commits, pushes, and emits", async () => {
    const d = deps();
    const r = await routeCommand(["set", "implement", "codex-exec"], d);
    expect(r.code).toBe(0);
    expect(d.writePolicy).toHaveBeenCalled();
    expect(d.commitAndPush.mock.calls[0][2]).toContain("implement");
    expect(d.emitEvent.mock.calls[0][0]["event.name"]).toBe(
      "execution-core.executor.policy-changed",
    );
  });

  test("REFUSES an unknown phase before any write", async () => {
    const d = deps();
    const r = await routeCommand(["set", "nonsense", "bg"], d);
    expect(r.code).toBe(2);
    expect(d.writePolicy).not.toHaveBeenCalled();
  });

  test("REFUSES an invalid executor before any write, naming the valid set", async () => {
    const d = deps();
    const r = await routeCommand(["set", "implement", "bogus"], d);
    expect(r.code).toBe(2);
    expect(r.msg).toContain("codex-exec");
    expect(d.writePolicy).not.toHaveBeenCalled();
  });

  test("accepts an alias (claude-sdk) and stores it verbatim", async () => {
    const d = deps();
    const r = await routeCommand(["set", "implement", "claude-sdk"], d);
    expect(r.code).toBe(0);
    const written = d.writePolicy.mock.calls[0][1];
    // stored VERBATIM — resolveExecutorForPhase canonicalizes at read, not here.
    expect(written.routes.implement).toBe("claude-sdk");
  });

  test("REFUSES on a dirty cluster clone (a bystander change would be pushed fleet-wide)", async () => {
    const d = deps({ isDirty: () => true });
    const r = await routeCommand(["set", "implement", "bg"], d);
    expect(r.code).not.toBe(0);
    expect(d.writePolicy).not.toHaveBeenCalled();
  });

  test("REFUSES when git pull --ff-only fails (a stale prior value corrupts the audit diff)", async () => {
    const d = deps({ pull: () => ({ ok: false, err: "diverged" }) });
    const r = await routeCommand(["set", "implement", "bg"], d);
    expect(r.code).not.toBe(0);
    expect(d.writePolicy).not.toHaveBeenCalled();
  });

  test("derives the prior value from the POST-PULL policy, not a pre-pull read", async () => {
    const order = [];
    const d = deps({
      pull: () => {
        order.push("pull");
        return { ok: true };
      },
      readPolicy: () => {
        order.push("readPolicy");
        return { routes: { triage: "codex-exec" }, history: [] };
      },
    });
    await routeCommand(["set", "implement", "bg"], d);
    expect(order).toEqual(["pull", "readPolicy"]);
  });

  test("REFUSES `all` without --yes (fleet-wide blast radius)", async () => {
    expect((await routeCommand(["all", "bg"], deps())).code).toBe(2);
    expect((await routeCommand(["all", "bg", "--yes"], deps())).code).toBe(0);
  });

  test("`all` maps every known phase and does not consult the budget gate for a codex-removing change", async () => {
    const d = deps({
      readPolicy: () => ({ routes: { triage: "codex-exec" }, history: [] }),
      checkBudget: () => {
        throw new Error("must not be called for a codex-removing change");
      },
    });
    const r = await routeCommand(["all", "bg", "--yes"], d);
    expect(r.code).toBe(0);
  });

  test("reports 'already routed' with exit 0 and does NOT commit a no-op", async () => {
    const d = deps();
    const r = await routeCommand(["set", "triage", "codex-exec"], d);
    expect(r.code).toBe(0);
    expect(d.commitAndPush).not.toHaveBeenCalled();
    expect(d.writePolicy).not.toHaveBeenCalled();
  });

  test("surfaces a committed-but-unpushed result as a WARNING, not a success", async () => {
    const d = deps({
      commitAndPush: () => ({ committed: true, pushed: false, error: "rejected" }),
    });
    const r = await routeCommand(["set", "implement", "bg"], d);
    expect(r.code).not.toBe(0);
    expect(r.msg).toMatch(/push/i);
  });

  test("clear <phase> unroutes a phase (falls back to the node default)", async () => {
    const d = deps();
    const r = await routeCommand(["clear", "triage"], d);
    expect(r.code).toBe(0);
    const written = d.writePolicy.mock.calls[0][1];
    expect(written.routes).toEqual({});
  });

  test("rollback restores the prior routes and commits with a rollback message", async () => {
    const priorEntry = {
      id: "abc123",
      change: { phase: "implement", from: null, to: "codex-exec" },
      priorRoutes: { triage: "codex-exec" },
    };
    const d = deps({
      readPolicy: () => ({
        routes: { triage: "codex-exec", implement: "codex-exec" },
        history: [priorEntry],
      }),
    });
    const r = await routeCommand(["rollback"], d);
    expect(r.code).toBe(0);
    const written = d.writePolicy.mock.calls[0][1];
    expect(written.routes).toEqual({ triage: "codex-exec" });
    expect(d.commitAndPush.mock.calls[0][2]).toMatch(/rollback/i);
  });

  test("rollback with empty history exits non-zero naming 'no-history'", async () => {
    const d = deps({ readPolicy: () => ({ routes: {}, history: [] }) });
    const r = await routeCommand(["rollback"], d);
    expect(r.code).not.toBe(0);
    expect(r.msg).toContain("no-history");
  });

  test("show --json returns routes + updatedBy + updatedAt", async () => {
    const d = deps({
      readPolicy: () => ({
        routes: { triage: "codex-exec" },
        updatedBy: "ryan",
        updatedAt: "2026-08-24T00:00:00Z",
        history: [],
      }),
    });
    const r = await routeCommand(["show", "--json"], d);
    expect(r.code).toBe(0);
    expect(r.json.routes).toEqual({ triage: "codex-exec" });
    expect(r.json.updatedBy).toBe("ryan");
    expect(r.json.updatedAt).toBe("2026-08-24T00:00:00Z");
  });

  test("show reports an empty policy cleanly (no cluster policy set)", async () => {
    const d = deps({ readPolicy: () => null });
    const r = await routeCommand(["show", "--json"], d);
    expect(r.code).toBe(0);
    expect(r.json.routes).toEqual({});
  });

  test("history --json prints newest-first with priorRoutes", async () => {
    const entries = [
      { id: "b2", change: { phase: "implement", from: null, to: "bg" }, priorRoutes: { triage: "codex-exec" } },
      { id: "a1", change: { phase: "triage", from: null, to: "codex-exec" }, priorRoutes: {} },
    ];
    const d = deps({ readPolicy: () => ({ routes: {}, history: entries }) });
    const r = await routeCommand(["history", "--json"], d);
    expect(r.code).toBe(0);
    expect(r.json.history).toEqual(entries);
    expect(r.json.history[0].id).toBe("b2"); // newest-first, unchanged ordering
    expect(r.json.history[0].priorRoutes).toEqual({ triage: "codex-exec" });
  });

  test("exits non-zero with an actionable message when no cluster clone is present", async () => {
    const d = deps({ hasClusterRepo: () => false });
    const r = await routeCommand(["set", "triage", "bg"], d);
    expect(r.code).not.toBe(0);
    expect(r.msg).toMatch(/cluster/i);
  });

  test("unknown verb refuses with an actionable message", async () => {
    const r = await routeCommand(["bogus-verb"], deps());
    expect(r.code).toBe(2);
  });
});

// ── CTL-2116 Phase 5: the budget gate wired into `set`/`all` ─────────────────
describe("routeCommand — budget gate (CTL-2116 Phase 5, Scenario 3)", () => {
  // deps()'s default readPolicy routes only `triage`, so `set implement codex-exec`
  // is a codex-ADDING change in every test below.

  test("REFUSES a codex-adding change on verdict 'refuse', printing the figures, writing nothing", async () => {
    const d = deps({
      checkBudget: () => ({
        verdict: "refuse",
        message: "no account has the 20% headroom reserved for Codex-routed work:\n  acct1  5h  95% used  5% headroom",
      }),
    });
    const r = await routeCommand(["set", "implement", "codex-exec"], d);
    expect(r.code).not.toBe(0);
    expect(r.msg).toMatch(/headroom/i);
    expect(d.writePolicy).not.toHaveBeenCalled();
    expect(d.commitAndPush).not.toHaveBeenCalled();
  });

  test("REFUSES on verdict 'inconclusive' — 'I could not look' is not 'the quota is fine'", async () => {
    const d = deps({
      checkBudget: () => ({ verdict: "inconclusive", reason: "no-accounts-discoverable" }),
    });
    const r = await routeCommand(["set", "implement", "codex-exec"], d);
    expect(r.code).not.toBe(0);
    expect(d.writePolicy).not.toHaveBeenCalled();
  });

  test("--force overrides refuse/inconclusive and records forcedBudget:true in the history entry", async () => {
    const d = deps({
      checkBudget: () => ({ verdict: "refuse", message: "no headroom" }),
    });
    const r = await routeCommand(["set", "implement", "codex-exec", "--force"], d);
    expect(r.code).toBe(0);
    expect(d.writePolicy).toHaveBeenCalled();
    const written = d.writePolicy.mock.calls[0][1];
    expect(written.history[0].forcedBudget).toBe(true);
  });

  test("does NOT consult the gate for a codex-REMOVING change", async () => {
    const d = deps({
      readPolicy: () => ({ routes: { triage: "codex-exec" }, history: [] }),
      checkBudget: () => {
        throw new Error("must not be called for a codex-removing change");
      },
    });
    const r = await routeCommand(["clear", "triage"], d);
    expect(r.code).toBe(0);
  });

  test("does NOT consult the gate for a codex→codex no-new-load change", async () => {
    const d = deps({
      readPolicy: () => ({ routes: { triage: "codex-exec" }, history: [] }),
      checkBudget: () => {
        throw new Error("must not be called — no NEW codex load");
      },
    });
    const r = await routeCommand(["set", "triage", "codex-exec"], d);
    expect(r.code).toBe(0); // no-op: already routed
  });

  test("leaves the current policy in effect on refusal (Scenario 3's second Then)", async () => {
    const d = deps({
      checkBudget: () => ({ verdict: "refuse", message: "no headroom" }),
    });
    await routeCommand(["set", "implement", "codex-exec"], d);
    expect(d.writePolicy).not.toHaveBeenCalled();
    expect(d.commitAndPush).not.toHaveBeenCalled();
    expect(d.emitEvent).not.toHaveBeenCalled();
  });
});
