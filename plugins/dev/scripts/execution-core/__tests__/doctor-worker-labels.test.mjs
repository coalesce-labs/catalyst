// doctor-worker-labels.test.mjs — CTL-1481. Tests for checkWorkerLabels() in doctor.mjs.
// All deps are injected so the test touches no network. The load-bearing invariants:
// NEVER emit a FAIL record (it would block the catalyst-join activation gate), and
// NEVER leak a token VALUE. Run:
//   cd plugins/dev/scripts/execution-core && bun test doctor-worker-labels
import { describe, test, expect } from "bun:test";
import { checkWorkerLabels, checksForClass } from "../doctor.mjs";

const ROSTER = ["mini", "mini-2"];
const GROUP = { id: "grp-1", name: "worker", parent: null };
const CHILD = (host) => ({ id: `child-${host}`, name: `worker:${host}`, parent: { id: GROUP.id } });

function healthyNodes() {
  return [GROUP, ...ROSTER.map(CHILD)];
}

// "healthy" defaults; override per test.
function deps(over = {}) {
  return {
    getRoster: () => ROSTER,
    linearToken: () => "lin_api_test_token",
    post: async () => ({ data: { issueLabels: { nodes: healthyNodes() } } }),
    ...over,
  };
}

const byName = (recs) => Object.fromEntries(recs.map((r) => [r.name, r]));
const noFail = (recs) => recs.every((r) => r.status !== "fail");

describe("checkWorkerLabels", () => {
  test("single-host roster → single INFO, never queries Linear", async () => {
    let called = false;
    const recs = await checkWorkerLabels(
      deps({
        getRoster: () => ["mini"],
        post: async () => {
          called = true;
          return { data: { issueLabels: { nodes: [] } } };
        },
      }),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe("worker-labels");
    expect(recs[0].status).toBe("info");
    expect(recs[0].detail).toMatch(/single-host/i);
    expect(called).toBe(false);
  });

  test("empty roster → single INFO too", async () => {
    const recs = await checkWorkerLabels(deps({ getRoster: () => [] }));
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe("info");
  });

  test("no token → single INFO (skip, not warn)", async () => {
    const recs = await checkWorkerLabels(deps({ linearToken: () => "" }));
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe("worker-labels");
    expect(recs[0].status).toBe("info");
    expect(recs[0].detail).toMatch(/token/i);
  });

  test("healthy fleet: group + every host child present → all PASS", async () => {
    const recs = await checkWorkerLabels(deps());
    expect(recs).toHaveLength(ROSTER.length);
    const m = byName(recs);
    for (const host of ROSTER) {
      expect(m[`worker-label:${host}`].status).toBe("pass");
    }
  });

  test("missing group → single WARN naming the setup-script remediation", async () => {
    const recs = await checkWorkerLabels(deps({ post: async () => ({ data: { issueLabels: { nodes: [] } } }) }));
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe("worker-labels");
    expect(recs[0].status).toBe("warn");
    expect(recs[0].detail).toContain("setup-execution-core-states.sh");
  });

  test("group present, one host child missing → that host WARNs, other PASSes", async () => {
    const nodes = [GROUP, CHILD(ROSTER[0])]; // ROSTER[1]'s child is missing
    const recs = await checkWorkerLabels(deps({ post: async () => ({ data: { issueLabels: { nodes } } }) }));
    const m = byName(recs);
    expect(m[`worker-label:${ROSTER[0]}`].status).toBe("pass");
    expect(m[`worker-label:${ROSTER[1]}`].status).toBe("warn");
    expect(m[`worker-label:${ROSTER[1]}`].detail).toContain("setup-execution-core-states.sh");
  });

  test("GraphQL error response → single WARN, never throws", async () => {
    const recs = await checkWorkerLabels(deps({ post: async () => ({ errors: [{ message: "boom" }] }) }));
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe("worker-labels");
    expect(recs[0].status).toBe("warn");
  });

  test("post() rejects (network unreachable) → single WARN, never throws", async () => {
    const recs = await checkWorkerLabels(
      deps({
        post: async () => {
          throw new Error("fetch failed");
        },
      }),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe("warn");
    expect(recs[0].detail).toMatch(/unreachable|fetch failed/i);
  });

  test("unexpected response shape (no nodes array) → single WARN", async () => {
    const recs = await checkWorkerLabels(deps({ post: async () => ({ data: {} }) }));
    expect(recs).toHaveLength(1);
    expect(recs[0].status).toBe("warn");
  });

  test("secret token value never leaks into check output", async () => {
    const SECRET = "lin_api_should_never_appear_in_output";
    const recs = await checkWorkerLabels(
      deps({ linearToken: () => SECRET, post: async () => ({ errors: [{ message: "boom" }] }) }),
    );
    expect(JSON.stringify(recs)).not.toContain(SECRET);
  });

  test("INVARIANT: no permutation of roster-size/token/response ever yields a FAIL record", async () => {
    const rosterFns = [() => [], () => ["mini"], () => ["mini", "mini-2"]];
    const tokenFns = [() => "", () => "lin_api_x"];
    const postFns = [
      async () => ({ data: { issueLabels: { nodes: healthyNodes() } } }),
      async () => ({ data: { issueLabels: { nodes: [] } } }),
      async () => ({ errors: [{ message: "boom" }] }),
      async () => {
        throw new Error("network down");
      },
      async () => ({ data: {} }),
    ];
    for (const getRoster of rosterFns)
      for (const linearToken of tokenFns)
        for (const post of postFns) {
          const recs = await checkWorkerLabels(deps({ getRoster, linearToken, post }));
          expect(noFail(recs)).toBe(true);
        }
  });
});

describe("checksForClass — checkWorkerLabels registration (CTL-1481)", () => {
  const src = (nc, opts = {}) => checksForClass(nc, opts).map((f) => f.toString()).join("\n");

  for (const cls of ["worker", "developer"]) {
    test(`wires checkWorkerLabels into the ${cls} suite`, () => {
      expect(src({ recognized: true, class: cls })).toContain("checkWorkerLabels");
    });
  }

  test("does NOT wire checkWorkerLabels into the monitor suite (rubric unimplemented)", () => {
    expect(src({ recognized: true, class: "monitor" })).not.toContain("checkWorkerLabels");
  });
});
