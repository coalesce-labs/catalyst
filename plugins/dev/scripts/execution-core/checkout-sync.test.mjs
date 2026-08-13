// checkout-sync.test.mjs — CTL-1808.
//
// Every seam is injected, so these run with no git binary, no network, and no real checkout.
// The cases are the refusal table from the design, plus the three that adversarial review
// said the design would otherwise have shipped broken.
import { describe, test, expect } from "bun:test";
import {
  ACTION,
  REFUSAL,
  slugForRoot,
  parseSymrefDefault,
  classifyGitState,
  resolveAllowlist,
  summarize,
  syncRepo,
  runPass,
} from "./checkout-sync.mjs";

// A repo whose every observation is healthy and 2 commits behind. Individual tests override
// exactly the one field under test, so a failure names the state that broke it.
const healthy = (over = {}) => ({
  lsRemoteDefault: async () => ({ ok: true, branch: "main" }),
  offlineDefault: () => null,
  fetchRef: async () => ({ ok: true, stderr: "" }),
  observe: async () => ({
    isLinkedWorktree: false,
    brokenPointer: false,
    operationInProgress: false,
    detached: false,
    currentBranch: "main",
    hasUpstreamRef: true,
    aheadBy: 0,
  }),
  mergeFf: async () => ({ ok: true, stderr: "" }),
  headSha: (() => {
    let calls = 0;
    return async () => (calls++ === 0 ? "old-sha" : "new-sha");
  })(),
  remoteSha: async () => "new-sha",
  behindCount: async () => 2,
  unreachableCount: async () => 0,
  ...over,
});

describe("parseSymrefDefault — the default branch comes from the REMOTE, every pass", () => {
  test("reads the symref line", () => {
    expect(parseSymrefDefault("ref: refs/heads/main\tHEAD\nabc123\tHEAD")).toBe("main");
  });
  test("handles a non-main default", () => {
    expect(parseSymrefDefault("ref: refs/heads/trunk\tHEAD")).toBe("trunk");
  });
  test("returns null when there is no symref (so the caller can refuse rather than guess)", () => {
    expect(parseSymrefDefault("abc123\tHEAD")).toBeNull();
    expect(parseSymrefDefault("")).toBeNull();
    expect(parseSymrefDefault(null)).toBeNull();
  });
});

describe("classifyGitState — the guards", () => {
  const ok = {
    isLinkedWorktree: false, brokenPointer: false, operationInProgress: false,
    detached: false, currentBranch: "main", defaultBranch: "main", hasUpstreamRef: true, aheadBy: 0,
  };
  test("all guards holding → no refusal", () => {
    expect(classifyGitState(ok)).toBeNull();
  });
  test("a linked worktree is never touched — phase-agent-dispatch owns those", () => {
    expect(classifyGitState({ ...ok, isLinkedWorktree: true })).toBe(REFUSAL.LINKED_WORKTREE);
  });
  test("an interrupted git operation refuses — the commits may exist only in the reflog", () => {
    expect(classifyGitState({ ...ok, operationInProgress: true })).toBe(REFUSAL.OP_IN_PROGRESS);
  });
  test("detached HEAD refuses", () => {
    expect(classifyGitState({ ...ok, detached: true })).toBe(REFUSAL.DETACHED);
  });
  test("a primary repurposed as a working branch refuses (measured live on mini-2)", () => {
    expect(classifyGitState({ ...ok, currentBranch: "my-wip" })).toBe(REFUSAL.WRONG_BRANCH);
  });
  test("unpushed local commits refuse", () => {
    expect(classifyGitState({ ...ok, aheadBy: 3 })).toBe(REFUSAL.LOCAL_COMMITS);
  });
  test("no upstream refuses", () => {
    expect(classifyGitState({ ...ok, hasUpstreamRef: false })).toBe(REFUSAL.NO_UPSTREAM);
  });
  test("a malformed observation refuses rather than throwing", () => {
    expect(classifyGitState(null)).toBe(REFUSAL.BROKEN_POINTER);
  });

  // A dirty tree is deliberately NOT a guard: `merge --ff-only` aborts exactly when it would
  // clobber and otherwise preserves local edits. Pre-refusing would be this automation making
  // a judgement call, which rule 3 forbids.
  test("a dirty tree is NOT pre-refused — git owns that invariant", () => {
    expect(classifyGitState({ ...ok, dirty: true, dirtyPaths: 4 })).toBeNull();
  });
});

describe("syncRepo — outcomes", () => {
  test("clean and behind → advanced, with both shas", async () => {
    const r = await syncRepo("/r", healthy());
    expect(r.action).toBe(ACTION.ADVANCED);
    expect(r.old_sha).toBe("old-sha");
    expect(r.new_sha).toBe("new-sha");
    expect(r.behind_by).toBe(2);
  });

  test("already at origin → current, and no merge is attempted", async () => {
    let merged = false;
    const r = await syncRepo("/r", healthy({
      behindCount: async () => 0,
      mergeFf: async () => { merged = true; return { ok: true, stderr: "" }; },
    }));
    expect(r.action).toBe(ACTION.CURRENT);
    expect(merged).toBe(false);
  });

  test("a fetch failure is transient — NOT a refusal, and never needs-human", async () => {
    const r = await syncRepo("/r", healthy({
      fetchRef: async () => ({ ok: false, stderr: "ssh: connect to host forge port 22: No route to host" }),
    }));
    expect(r.action).toBe(ACTION.FETCH_FAILED);
    expect(r.refused_reason).toBeNull();
    expect(r.error).toContain("No route to host");
  });

  test("the remote unreachable AND no cached default → refuses, does not guess", async () => {
    const r = await syncRepo("/r", healthy({
      lsRemoteDefault: async () => ({ ok: false }),
      offlineDefault: () => null,
    }));
    expect(r.action).toBe(ACTION.REFUSED);
    expect(r.refused_reason).toBe(REFUSAL.DEFAULT_UNRESOLVED);
  });

  // The cached origin/HEAD is a clone-time artefact no fetch updates. It may inform a REPORT
  // and must never authorise a WRITE — trusting it would be the same stale-fact-as-current
  // defect this whole ticket is about.
  test("a cache-derived default branch downgrades the pass to diagnostic — it never merges", async () => {
    let merged = false;
    const r = await syncRepo("/r", healthy({
      lsRemoteDefault: async () => ({ ok: false }),
      offlineDefault: () => "main",
      mergeFf: async () => { merged = true; return { ok: true, stderr: "" }; },
    }));
    expect(r.action).toBe(ACTION.DIAGNOSTIC);
    expect(merged).toBe(false);
  });

  test("a refusal carries git's verbatim stderr, not a paraphrase", async () => {
    const r = await syncRepo("/r", healthy({
      mergeFf: async () => ({ ok: false, stderr: "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts" }),
      headSha: async () => "old-sha",
      remoteSha: async () => "new-sha",
    }));
    expect(r.action).toBe(ACTION.REFUSED);
    expect(r.refused_reason).toBe(REFUSAL.FF_BLOCKED);
    expect(r.detail).toContain("src/a.ts");
  });
});

// ── The three cases adversarial review said would otherwise ship broken ─────────

describe("CTL-1808 — the review catches", () => {
  // 1. FETCH BEFORE GUARDS. `aheadBy` is measured against origin/<default>; before the fetch
  //    that ref is stale or absent, so asking first errors on exactly the repos that are
  //    behind — the main path. Assert the ORDER, not just the outcome.
  test("the fetch happens BEFORE any guard is evaluated", async () => {
    const order = [];
    await syncRepo("/r", healthy({
      fetchRef: async () => { order.push("fetch"); return { ok: true, stderr: "" }; },
      observe: async () => {
        order.push("observe");
        return { isLinkedWorktree: false, brokenPointer: false, operationInProgress: false, detached: false, currentBranch: "main", hasUpstreamRef: true, aheadBy: 0 };
      },
      behindCount: async () => { order.push("behind"); return 2; },
    }));
    expect(order[0]).toBe("fetch");
    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("observe"));
    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("behind"));
  });

  // 2. THE ORACLE BEATS THE EXIT CODE. `git pull --ff-only` on a non-default branch exits 0
  //    with "Already up to date." while N behind. A verdict taken from the exit code reports
  //    success it did not achieve — the exact thing rule 4 prohibits. Here: merge claims
  //    success, but HEAD did not move to the target.
  test("a merge that exits 0 without moving HEAD is REFUSED, not reported as advanced", async () => {
    const r = await syncRepo("/r", healthy({
      mergeFf: async () => ({ ok: true, stderr: "Already up to date." }), // claims success
      headSha: async () => "stuck-sha",                                   // …but HEAD never moved
      remoteSha: async () => "target-sha",
    }));
    expect(r.action).not.toBe(ACTION.ADVANCED);
    expect(r.action).toBe(ACTION.REFUSED);
  });

  // 3. SILENCE IS A DEFECT / a dead scanner never refuses. Every pass must produce a record
  //    even when nothing happened, or "it stopped running" is indistinguishable from "all well".
  test("a pass over zero repos still produces a heartbeat record", async () => {
    const out = await runPass({ roots: [], deps: healthy(), now: () => "2026-08-13T00:00:00Z", host: "h" });
    expect(out.ts).toBe("2026-08-13T00:00:00Z");
    expect(out.host).toBe("h");
    expect(out.summary.total).toBe(0);
  });

  test("a pass where every repo is current still produces a record with counts", async () => {
    const out = await runPass({ roots: ["/a", "/b"], deps: healthy({ behindCount: async () => 0 }) });
    expect(out.summary).toMatchObject({ total: 2, current: 2, advanced: 0, refused: 0 });
  });

  // 4. One bad repo must not stop the scanner protecting the others.
  test("a throwing repo is recorded and the pass continues", async () => {
    const deps = healthy({
      lsRemoteDefault: async (root) => {
        if (root === "/bad") throw new Error("boom");
        return { ok: true, branch: "main" };
      },
    });
    const out = await runPass({ roots: ["/bad", "/good"], deps });
    expect(out.repos).toHaveLength(2);
    expect(out.repos[0].error).toContain("boom");
    expect(out.repos[1].action).toBe(ACTION.ADVANCED);
  });
});

describe("resolveAllowlist — declared sources only, never a filesystem walk", () => {
  test("merges registry, self, and configured roots, de-duplicated and order-stable", () => {
    expect(resolveAllowlist({
      registryRoots: ["/a", "/b"], selfRoot: "/b", configuredRoots: ["/c", "/a"],
    })).toEqual(["/a", "/b", "/c"]);
  });
  test("normalises trailing slashes so one repo cannot enrol twice", () => {
    expect(resolveAllowlist({ registryRoots: ["/a/"], selfRoot: "/a" })).toEqual(["/a"]);
  });
  test("ignores blanks and non-strings rather than producing a bogus root", () => {
    expect(resolveAllowlist({ registryRoots: ["", "  ", null, 7, "/a"] })).toEqual(["/a"]);
  });
  // Tonight's ADR incident was a SIBLING repo, not this one. A catalyst-only allowlist would
  // have caught none of the four measured incidents.
  test("a sibling repo enrols through the configured source", () => {
    const roots = resolveAllowlist({ selfRoot: "/x/catalyst", configuredRoots: ["/x/catalyst-cloud"] });
    expect(roots).toContain("/x/catalyst-cloud");
  });
});

describe("slugForRoot — lock identity", () => {
  test("is stable and path-safe", () => {
    expect(slugForRoot("/a/b")).toBe(slugForRoot("/a/b"));
    expect(slugForRoot("/a/b")).toMatch(/^[0-9a-f]{16}$/);
  });
  // A sanitiser that folded '/' and '-' would collide these onto one lock; a hash cannot.
  test("distinct roots that a path-sanitiser would fold do NOT collide", () => {
    expect(slugForRoot("/a/b")).not.toBe(slugForRoot("/a-b"));
  });
});

describe("summarize", () => {
  test("counts every action class and totals unreachable commits", () => {
    const s = summarize([
      { action: ACTION.CURRENT }, { action: ACTION.ADVANCED },
      { action: ACTION.REFUSED, unreachable_commits: 3 },
      { action: ACTION.FETCH_FAILED }, { action: ACTION.SKIPPED }, { action: ACTION.DIAGNOSTIC },
    ]);
    expect(s).toEqual({ total: 6, current: 1, advanced: 1, refused: 1, fetchFailed: 1, skipped: 1, diagnostic: 1, unreachableCommits: 3 });
  });
});
