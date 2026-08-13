// build-info.test.mjs (CTL-1825) — the code-currency gauge measures the roots
// the fleet's daemons actually execute from, not the tree this file happens to
// live in.
//
// The defect this suite exists to prevent: `commitsBehindMain` ran
// `git -C MODULE_DIR rev-list --count HEAD..origin/main`, so it answered "is the
// tree containing build-info.mjs current?". On this fleet that is a DIFFERENT
// tree from the one the daemons run: worker nodes execute from
// `~/catalyst/plugin-source`, and the laptop's `com.catalyst.agent` plist runs
// the agent out of the dev working checkout. Measured 2026-08-13 on the laptop:
// the agent's checkout 0 behind, `~/catalyst/plugin-source` 24 behind, gauge 0.
//
// Every git call is injected, so these run with no git binary, no network, and
// no real checkout.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test build-info.test.mjs

import { describe, test, expect } from "bun:test";
import { commitsBehindByRoot, commitsBehindMain, executingRoots } from "./build-info.mjs";

// THE LAPTOP, 2026-08-13 — the exact fixture the ticket measured. The agent's own
// checkout is current; the tree that actually runs health-responder / orphan-sweep /
// log-shipper is 24 commits behind.
const AGENT_CHECKOUT = "/Users/ryan/code-repos/github/coalesce-labs/catalyst";
const PLUGIN_SOURCE = "/Users/ryan/catalyst/plugin-source";
const LAPTOP = { [AGENT_CHECKOUT]: 0, [PLUGIN_SOURCE]: 24 };

// A git seam that answers `rev-list --count` from a {root: n} table. A root absent
// from the table behaves like a root git cannot read: null, never a silent 0.
function gitFor(table, { onFetch = () => {} } = {}) {
  return (root, args) => {
    if (args[0] === "fetch") {
      onFetch(root);
      return "";
    }
    if (args[0] === "rev-list") {
      const n = table[root];
      return n === undefined ? null : String(n);
    }
    return null;
  };
}

describe("commitsBehindByRoot — one measurement per executing root", () => {
  test("returns a series per root, each labelled by the root it measured", () => {
    const series = commitsBehindByRoot({
      fetch: false,
      roots: [AGENT_CHECKOUT, PLUGIN_SOURCE],
      gitIn: gitFor(LAPTOP),
    });
    expect(series).toEqual([
      { root: AGENT_CHECKOUT, behind: 0 },
      { root: PLUGIN_SOURCE, behind: 24 },
    ]);
  });

  test("a root git cannot read reports null, never a false 0", () => {
    const series = commitsBehindByRoot({
      fetch: false,
      roots: [AGENT_CHECKOUT, "/repos/no-remote"],
      gitIn: gitFor(LAPTOP),
    });
    expect(series).toEqual([
      { root: AGENT_CHECKOUT, behind: 0 },
      { root: "/repos/no-remote", behind: null },
    ]);
  });

  test("a negative or non-numeric rev-list answer degrades to null", () => {
    const series = commitsBehindByRoot({
      fetch: false,
      roots: ["/a", "/b"],
      gitIn: (root) => (root === "/a" ? "-3" : "not-a-number"),
    });
    expect(series).toEqual([{ root: "/a", behind: null }, { root: "/b", behind: null }]);
  });

  test("fetches every root when asked, and none when told not to", () => {
    const fetched = [];
    commitsBehindByRoot({
      fetch: true,
      roots: [AGENT_CHECKOUT, PLUGIN_SOURCE],
      gitIn: gitFor(LAPTOP, { onFetch: (r) => fetched.push(r) }),
    });
    expect(fetched).toEqual([AGENT_CHECKOUT, PLUGIN_SOURCE]);

    const skipped = [];
    commitsBehindByRoot({
      fetch: false,
      roots: [AGENT_CHECKOUT],
      gitIn: gitFor(LAPTOP, { onFetch: (r) => skipped.push(r) }),
    });
    expect(skipped).toEqual([]);
  });

  test("no resolvable roots at all → an empty series (the caller emits nothing)", () => {
    expect(commitsBehindByRoot({ fetch: false, roots: [], gitIn: gitFor(LAPTOP) })).toEqual([]);
  });
});

describe("commitsBehindMain — the single aggregate is the MAXIMUM across roots", () => {
  test("a stale root sets the aggregate; the current one cannot hide it", () => {
    const max = commitsBehindMain({ fetch: false, roots: [AGENT_CHECKOUT, PLUGIN_SOURCE], gitIn: gitFor(LAPTOP) });
    expect(max).toBe(24);
  });

  test("root ORDER cannot change the answer (it is a max, not a first or a last)", () => {
    const forward = commitsBehindMain({ fetch: false, roots: [AGENT_CHECKOUT, PLUGIN_SOURCE], gitIn: gitFor(LAPTOP) });
    const reverse = commitsBehindMain({ fetch: false, roots: [PLUGIN_SOURCE, AGENT_CHECKOUT], gitIn: gitFor(LAPTOP) });
    expect(forward).toBe(24);
    expect(reverse).toBe(24);
  });

  test("an unreadable root does not suppress a readable stale one", () => {
    const max = commitsBehindMain({
      fetch: false,
      roots: ["/repos/unreadable", PLUGIN_SOURCE],
      gitIn: gitFor(LAPTOP),
    });
    expect(max).toBe(24);
  });

  test("every root unresolvable → null, so the gauge is omitted rather than reported as 0", () => {
    expect(commitsBehindMain({ fetch: false, roots: ["/x", "/y"], gitIn: () => null })).toBeNull();
    expect(commitsBehindMain({ fetch: false, roots: [], gitIn: () => null })).toBeNull();
  });
});

// ─── POSITIVE CONTROL (ticket-mandated) ────────────────────────────────────────
//
// This is the scenario the ticket requires to FAIL if the fix is reverted. It runs
// the SAME instrument twice over the SAME laptop fixture — once restricted to the
// agent's own checkout (exactly what `git -C MODULE_DIR` measured before this
// change), once over the full executing set — and asserts the two disagree.
//
// If `commitsBehindMain` goes back to measuring the module directory alone, the
// second call collapses onto the first and returns 0, and the inequality below
// fails. That is what makes the passing scenarios above non-vacuous: the fixture
// is demonstrably capable of producing a wrong answer.
describe("positive control — the gauge can observe the defect", () => {
  test("MODULE_DIR-only measurement reports 0 on a host whose OTHER root is 24 behind", () => {
    const preFix = commitsBehindMain({ fetch: false, roots: [AGENT_CHECKOUT], gitIn: gitFor(LAPTOP) });
    const fixed = commitsBehindMain({ fetch: false, roots: [AGENT_CHECKOUT, PLUGIN_SOURCE], gitIn: gitFor(LAPTOP) });

    // The pre-fix answer — affirmative evidence of currency where none exists.
    expect(preFix).toBe(0);
    // The fixed answer — the tree the daemons actually run.
    expect(fixed).toBe(24);
    // …and they MUST differ, or neither assertion above is measuring anything.
    expect(fixed).not.toBe(preFix);
  });
});

describe("executingRoots — the agent reads CTL-1808's enumeration, it does not invent one", () => {
  test("registry ∪ self ∪ Layer-2 checkouts[] ∪ plugin-source, de-duplicated", () => {
    const roots = executingRoots({
      env: { CATALYST_DIR: "/cat", HOME: "/home/u" },
      readJson: (path) => {
        if (path === "/cat/execution-core/registry.json") return { projects: [{ team: "CTL", repoRoot: "/repos/catalyst" }] };
        if (path === "/home/u/.config/catalyst/config.json") return { catalyst: { checkouts: ["/repos/extra"] } };
        return null;
      },
      selfRoot: "/dev/checkout",
      exists: () => true,
    });
    expect(roots).toEqual(["/repos/catalyst", "/dev/checkout", "/repos/extra", "/cat/plugin-source"]);
  });

  // The real resolver on a real box: whatever it returns, the tree this test file
  // lives in must be in it — the agent always measures at least itself.
  test("the real resolver includes this checkout", () => {
    const roots = executingRoots();
    expect(Array.isArray(roots)).toBe(true);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.some((r) => import.meta.dir.startsWith(r))).toBe(true);
  });
});
