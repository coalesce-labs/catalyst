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
//
// CTL-1616 PR2: resolveSecretContract is a shadow-only dependency (design §7) —
// it must AGREE with `linearToken` here so these pre-existing behavioral tests
// (which predate the shadow pass) don't spuriously grow an extra
// worker-labels-secret-contract-shadow entry. Fixed values, never the real
// registry resolver — the real resolver would make these tests' output depend
// on whatever LINEAR_API_TOKEN/LINEAR_API_KEY happen to be set in the runner's
// ambient environment (present on a dev shell, absent under `bun test`'s
// isolated env), which is exactly the flakiness class this file's existing
// tests were written to avoid via full dependency injection.
function deps(over = {}) {
  return {
    getRoster: () => ROSTER,
    linearToken: () => "lin_api_test_token",
    resolveSecretContract: () => ({ value: "contract_test_token", source: "inherited", provider: "env-alias" }),
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
    const recs = await checkWorkerLabels(
      deps({ linearToken: () => "", resolveSecretContract: () => ({ value: null, source: "none", provider: "env-alias" }) }),
    );
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

// ─── CTL-1616 PR2: secret-contract shadow (the "third value-read site") ────
describe("checkWorkerLabels — secret-contract shadow (CTL-1616 PR2)", () => {
  test("agree (both present) → no shadow row", async () => {
    const recs = await checkWorkerLabels(deps());
    expect(recs.some((r) => r.name.includes("secret-contract-shadow"))).toBe(false);
  });

  test("disagree (hand-rolled present, contract absent) → loud INFO row, primary grade unchanged", async () => {
    const recs = await checkWorkerLabels(
      deps({ resolveSecretContract: () => ({ value: null, source: "none", provider: "env-alias" }) }),
    );
    const shadow = recs.find((r) => r.name === "worker-labels-secret-contract-shadow");
    expect(shadow).toBeDefined();
    expect(shadow.status).toBe("info");
    expect(shadow.detail).toContain('secret="linear-api-token"');
    expect(shadow.detail).toContain("hand-rolled=present");
    expect(shadow.detail).toContain("contract={value:absent");
    // Primary rows (group + per-host children) are untouched by the shadow.
    expect(recs.filter((r) => r.name !== "worker-labels-secret-contract-shadow")).toHaveLength(ROSTER.length);
  });

  test("a shadow disagreement never yields a FAIL record either", async () => {
    const recs = await checkWorkerLabels(
      deps({ resolveSecretContract: () => ({ value: null, source: "none", provider: "env-alias" }) }),
    );
    expect(noFail(recs)).toBe(true);
  });

  // CTL-1616 PR2 (B1): a throwing resolver must never crash this check —
  // runDoctor's Promise.all has no per-check isolation, so an uncaught throw
  // here would take down the whole doctor run.
  test("resolver throws → normal graded rows still returned, plus a loud INFO throw-row, no FAIL", async () => {
    const recs = await checkWorkerLabels(
      deps({
        resolveSecretContract: () => {
          throw new Error("boom: registry lookup exploded");
        },
      }),
    );
    // Primary rows (group + per-host children) are untouched by the throw.
    expect(recs.filter((r) => r.name !== "worker-labels-secret-contract-shadow")).toHaveLength(ROSTER.length);
    const throwRow = recs.find((r) => r.name === "worker-labels-secret-contract-shadow");
    expect(throwRow).toBeDefined();
    expect(throwRow.status).toBe("info");
    expect(throwRow.detail).toContain("SHADOW RESOLVER THREW");
    expect(throwRow.detail).toContain("boom: registry lookup exploded");
    expect(noFail(recs)).toBe(true);
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
