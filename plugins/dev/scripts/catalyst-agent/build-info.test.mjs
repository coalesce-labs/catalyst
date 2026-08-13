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
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitsBehindByRoot, commitsBehindMain, executingRoots, catalystRoots } from "./build-info.mjs";

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

// ─── NOT the positive control (kept, honestly labelled) ────────────────────────
//
// This block used to be labelled "positive control — the gauge can observe the
// defect". It is not one, and saying so was the same error the ticket is about:
// affirmative evidence of coverage where none exists. Both calls INJECT `roots`,
// so between them they only assert that a Math.max over a list differs from a
// Math.max over a subset of it — arithmetic that holds whatever the production
// enumeration does. PROVEN, not assumed: with the whole per-root API kept and only
// the root enumeration reverted to `[MODULE_DIR]`, every assertion here still
// passed. It is retained because the arithmetic IS worth pinning (the aggregate
// must move when a stale root joins the set); it is simply not the control.
// The real one is the block below it.
describe("aggregate arithmetic over an injected root set (NOT the positive control)", () => {
  test("adding a 24-behind root to a set of current ones moves the aggregate to 24", () => {
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

// ─── POSITIVE CONTROL (ticket-mandated) ────────────────────────────────────────
//
// The ticket's scenario, implemented literally:
//
//   Given the pre-fix implementation measuring MODULE_DIR only
//   When it runs on the laptop (agent checkout current, plugin-source 24 behind)
//   Then it reports 0
//
// The load-bearing difference from the block above: the FIXED call passes NO
// `roots`, so it runs the production default — `catalystRoots()` →
// `classifyExecutingRoots()` → registry read, self-root `.git` walk, Layer-2 read,
// plugin-source, existence filter, role classification. Only the git seam is
// injected, because the ticket is about WHICH trees are asked, not about git.
//
// The laptop is reproduced on disk rather than described: a scratch CATALYST_DIR
// whose `plugin-source` really exists, with HOME pointed at the same scratch tree
// so no real Layer-2 config leaks in. `plugin-source` is deliberately left WITHOUT
// a Catalyst marker file — it is a Catalyst root structurally, and if that rule
// ever regresses this control goes red rather than quietly measuring one tree.
//
// Revert the enumeration to the module directory (the pre-fix shape) and this
// fails twice over: the stale root leaves the enumeration, and the aggregate
// collapses to 0.
describe("positive control — the gauge can observe the defect (production default path)", () => {
  test("pre-fix shape reports 0 where the production enumeration reports 24", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ctl1825-control-"));
    const catalystDir = join(tmp, "catalyst");
    const pluginSource = join(catalystDir, "plugin-source");
    mkdirSync(pluginSource, { recursive: true });

    const saved = { CATALYST_DIR: process.env.CATALYST_DIR, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.CATALYST_DIR = catalystDir;
    process.env.HOME = tmp;
    delete process.env.XDG_CONFIG_HOME;
    try {
      // The laptop, exactly: the tree the daemons run from is 24 behind, every
      // other Catalyst checkout on the host (the agent's own included) is current.
      const gitIn = (root, args) => (args[0] === "rev-list" ? (root === pluginSource ? "24" : "0") : "");

      // NON-VACUITY, asserted before the measurement: the production enumeration
      // must actually contain the stale root AND more than it alone, or the
      // comparison below would be a tautology. This is the assertion that fails
      // first if the enumeration ever collapses back to one directory.
      const roots = catalystRoots();
      expect(roots).toContain(pluginSource);
      expect(roots.length).toBeGreaterThan(1);

      // The pre-fix shape: `git -C <the directory build-info.mjs lives in>` — one
      // root, the agent's own tree, which is exactly what the old code measured.
      const preFix = commitsBehindMain({ fetch: false, roots: [import.meta.dir], gitIn });
      // The fixed shape: no roots argument at all — the production default.
      const fixed = commitsBehindMain({ fetch: false, gitIn });

      expect(preFix).toBe(0); // affirmative evidence of currency where none exists
      expect(fixed).toBe(24); // the tree the daemons actually run
      expect(fixed).not.toBe(preFix);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── SCOPE: whose currency is this? (CTL-1825 round 2) ─────────────────────────
//
// The enumeration deliberately spans every checkout this host runs, including the
// enrolled PRODUCT repos the CTL-1808 sync pass fast-forwards. Measured on the
// laptop 2026-08-13, nine of eleven roots were product repos and the stalest —
// `personal-os`, 58 commits behind its OWN main — was this host's reported maximum,
// so `catalyst.vcs.commits_behind.max` said 58 for a personal repository and the
// pre-existing `max by (host_name)(catalyst_vcs_commits_behind) > 20` alert fires
// on it. These two tests are the pair: the product repo must not drive the gauge,
// and the exclusion must be by what the tree IS — not by "registry roots never
// count", which would drop the Catalyst repo itself (it is enrolled, ADR-028).
describe("scope — a Catalyst currency gauge is not driven by an enrolled product repo", () => {
  // One scratch host: a registry naming `project`, plus a real plugin-source. The
  // caller decides whether `project` carries the Catalyst marker.
  function scratchHost({ markProjectAsCatalyst }) {
    const tmp = mkdtempSync(join(tmpdir(), "ctl1825-scope-"));
    const catalystDir = join(tmp, "catalyst");
    const pluginSource = join(catalystDir, "plugin-source");
    const project = join(tmp, "repos", "personal-os");
    mkdirSync(pluginSource, { recursive: true });
    mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(catalystDir, "execution-core", "registry.json"),
      JSON.stringify({ projects: [{ team: "POS", repoRoot: project }] }),
    );
    if (markProjectAsCatalyst) {
      mkdirSync(join(project, ".claude-plugin"), { recursive: true });
      writeFileSync(join(project, ".claude-plugin", "marketplace.json"), "{}");
    }
    const saved = { CATALYST_DIR: process.env.CATALYST_DIR, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.CATALYST_DIR = catalystDir;
    process.env.HOME = tmp;
    delete process.env.XDG_CONFIG_HOME;
    // 58 behind, exactly as measured; every Catalyst checkout current.
    const gitIn = (root, args) => (args[0] === "rev-list" ? (root === project ? "58" : "0") : "");
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(tmp, { recursive: true, force: true });
    };
    return { tmp, project, pluginSource, gitIn, restore };
  }

  test("a 58-behind enrolled product repo is neither measured nor the aggregate", () => {
    const h = scratchHost({ markProjectAsCatalyst: false });
    try {
      // Non-vacuity: the enumeration DID see the product repo — it is enrolled and
      // it exists — so its absence below is a role decision, not a missing fixture.
      expect(executingRoots()).toContain(h.project);

      const series = commitsBehindByRoot({ fetch: false, gitIn: h.gitIn });
      expect(series.map((c) => c.root)).not.toContain(h.project);
      expect(series.map((c) => c.root)).toContain(h.pluginSource);
      // The alert's number. 58 here would fire `> 20` on a personal repository.
      expect(commitsBehindMain({ fetch: false, gitIn: h.gitIn })).toBe(0);
    } finally {
      h.restore();
    }
  });

  test("…but an enrolled root that IS a Catalyst checkout is measured (ADR-028 enrols this repo)", () => {
    const h = scratchHost({ markProjectAsCatalyst: true });
    try {
      const series = commitsBehindByRoot({ fetch: false, gitIn: h.gitIn });
      expect(series.map((c) => c.root)).toContain(h.project);
      expect(commitsBehindMain({ fetch: false, gitIn: h.gitIn })).toBe(58);
    } finally {
      h.restore();
    }
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
