// worktrees.test.mjs — Phase 6 of CTL-649. `catalyst-execution-core worktrees
// {list,prune}`. Classifier + prune-ordering are the tested surface; all I/O
// (git, gh, sessions, fs) is injected.

import { describe, it, expect } from "bun:test";
import {
  parseWorktreeList,
  classify,
  ticketFromBranch,
  buildRows,
  runWorktreesPrune,
  parseWorktreeArgs,
  gitWorktreePorcelain,
} from "./worktrees.mjs";
import { ArgError } from "./args.mjs";

describe("parseWorktreeList (git worktree list --porcelain)", () => {
  const porcelain = [
    "worktree /Users/ryan/catalyst",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /wt/CTL-649",
    "HEAD def456",
    "branch refs/heads/CTL-649",
    "",
    "worktree /wt/detached",
    "HEAD aaa111",
    "detached",
    "",
  ].join("\n");

  it("parses each block into {path, branch, head}", () => {
    const list = parseWorktreeList(porcelain);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ path: "/Users/ryan/catalyst", branch: "main" });
    expect(list[1]).toMatchObject({ path: "/wt/CTL-649", branch: "CTL-649" });
  });

  it("marks detached worktrees with null branch", () => {
    const list = parseWorktreeList(porcelain);
    expect(list[2].path).toBe("/wt/detached");
    expect(list[2].branch).toBeNull();
    expect(list[2].detached).toBe(true);
  });

  it("returns [] for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("ticketFromBranch", () => {
  it("extracts TICKET-NNN from a plain branch", () => {
    expect(ticketFromBranch("CTL-649")).toBe("CTL-649");
  });
  it("extracts from a slug branch", () => {
    expect(ticketFromBranch("ryan/ctl-649-orphan-leak")).toBe("CTL-649");
  });
  it("returns null for main / no ticket", () => {
    expect(ticketFromBranch("main")).toBeNull();
    expect(ticketFromBranch(null)).toBeNull();
  });
});

describe("worktrees classify (priority chain)", () => {
  it("LIVE when any session has cwd under the worktree path", () => {
    expect(classify({ liveSessions: 1 })).toBe("LIVE");
  });
  it("MERGED when PR merged + no live sessions", () => {
    expect(classify({ prState: "merged", liveSessions: 0 })).toBe("MERGED");
  });
  it("ABANDONED when Linear=Done + no open PR + no live", () => {
    expect(classify({ linearState: "Done", prState: "none", liveSessions: 0 })).toBe("ABANDONED");
  });
  it("ABANDONED also for Linear=Cancelled", () => {
    expect(classify({ linearState: "Cancelled", prState: "none", liveSessions: 0 })).toBe(
      "ABANDONED"
    );
  });
  it("CLOSED_NO_MERGE when PR closed without merging", () => {
    expect(classify({ prState: "closed", liveSessions: 0 })).toBe("CLOSED_NO_MERGE");
  });
  it("STALE when ageDays exceeds threshold + no live + no in-flight PR", () => {
    expect(classify({ ageDays: 30, prState: "none", liveSessions: 0, staleDays: 14 })).toBe(
      "STALE"
    );
  });
  it("ACTIVE for an open PR", () => {
    expect(classify({ prState: "open", liveSessions: 0 })).toBe("ACTIVE");
  });
  it("ACTIVE as the safe default (no PR, fresh, no linear state)", () => {
    expect(classify({ prState: "none", liveSessions: 0, ageDays: 1, staleDays: 14 })).toBe(
      "ACTIVE"
    );
  });
  it("LIVE wins even when PR merged", () => {
    expect(classify({ prState: "merged", liveSessions: 2 })).toBe("LIVE");
  });
});

describe("buildRows (join worktrees + prs + live sessions)", () => {
  const porcelain = [
    "worktree /wt/CTL-1",
    "branch refs/heads/CTL-1",
    "",
    "worktree /wt/CTL-2",
    "branch refs/heads/CTL-2",
    "",
  ].join("\n");
  const prs = [
    { number: 10, headRefName: "CTL-1", state: "merged" },
    { number: 11, headRefName: "CTL-2", state: "open" },
  ];
  const liveByWorktree = new Map([["/wt/CTL-2", [{ shortId: "a" }]]]);

  it("classifies each worktree from its joins", async () => {
    const rows = await buildRows({
      porcelain,
      prs,
      liveByWorktree,
      mtimeFor: () => Date.now(),
      now: Date.now(),
      staleDays: 14,
    });
    const ctl1 = rows.find((r) => r.path === "/wt/CTL-1");
    const ctl2 = rows.find((r) => r.path === "/wt/CTL-2");
    expect(ctl1.classification).toBe("MERGED");
    expect(ctl1.prNumber).toBe(10);
    expect(ctl2.classification).toBe("LIVE");
    expect(ctl2.liveSessions).toBe(1);
  });

  it("computes ageDays from mtime", async () => {
    const now = 30 * 86_400_000;
    const rows = await buildRows({
      porcelain: "worktree /wt/CTL-1\nbranch refs/heads/CTL-1\n",
      prs: [],
      liveByWorktree: new Map(),
      mtimeFor: () => 0, // created at epoch
      now,
      staleDays: 14,
    });
    expect(rows[0].ageDays).toBeCloseTo(30, 0);
    expect(rows[0].classification).toBe("STALE");
  });
});

describe("runWorktreesPrune", () => {
  it("emits worktree.presweep.reap-requested before pr.merged.cleanup-requested", async () => {
    const emitted = [];
    await runWorktreesPrune({
      rows: [{ path: "/wt/CTL-1", branch: "CTL-1", ticket: "CTL-1", classification: "MERGED" }],
      emit: (event, fields) => emitted.push({ event, fields }),
      yes: true,
    });
    const presweepIdx = emitted.findIndex((e) => e.event === "worktree.presweep.reap-requested");
    const cleanupIdx = emitted.findIndex((e) => e.event === "pr.merged.cleanup-requested");
    expect(presweepIdx).toBeGreaterThanOrEqual(0);
    expect(cleanupIdx).toBeGreaterThan(presweepIdx);
    expect(emitted[cleanupIdx].fields.branch).toBe("CTL-1");
    // MERGED is squash-safe → force the branch delete.
    expect(emitted[cleanupIdx].fields.force).toBe(true);
  });

  it("sets force=true only for MERGED rows; omits it for closed/abandoned/stale", async () => {
    const emitted = [];
    await runWorktreesPrune({
      rows: [
        { path: "/wt/M", branch: "M", ticket: "M", classification: "MERGED" },
        { path: "/wt/C", branch: "C", ticket: "C", classification: "CLOSED_NO_MERGE" },
        { path: "/wt/A", branch: "A", ticket: "A", classification: "ABANDONED" },
        { path: "/wt/S", branch: "S", ticket: "S", classification: "STALE" },
      ],
      emit: (event, fields) => emitted.push({ event, fields }),
      yes: true,
      includeStale: true,
    });
    const cleanupFor = (branch) =>
      emitted.find((e) => e.event === "pr.merged.cleanup-requested" && e.fields.branch === branch);
    expect(cleanupFor("M").fields.force).toBe(true);
    // Unmerged commits must be preserved → no force flag at all.
    expect(cleanupFor("C").fields.force).toBeUndefined();
    expect(cleanupFor("A").fields.force).toBeUndefined();
    expect(cleanupFor("S").fields.force).toBeUndefined();
  });

  it("dry-run is the default — nothing emitted without --yes", async () => {
    const emitted = [];
    await runWorktreesPrune({
      rows: [{ path: "/wt/CTL-1", classification: "MERGED" }],
      emit: (e, f) => emitted.push({ e, f }),
    });
    expect(emitted.length).toBe(0);
  });

  it("does not prune LIVE or ACTIVE rows", async () => {
    const emitted = [];
    await runWorktreesPrune({
      rows: [
        { path: "/wt/CTL-1", classification: "LIVE" },
        { path: "/wt/CTL-2", classification: "ACTIVE" },
      ],
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
    });
    expect(emitted.length).toBe(0);
  });

  it("requires --include-stale to prune STALE rows", async () => {
    const emitted = [];
    await runWorktreesPrune({
      rows: [{ path: "/wt/CTL-1", classification: "STALE" }],
      emit: (e, f) => emitted.push({ e, f }),
      yes: true,
    });
    expect(emitted.length).toBe(0);

    const emitted2 = [];
    await runWorktreesPrune({
      rows: [{ path: "/wt/CTL-1", branch: "CTL-1", classification: "STALE" }],
      emit: (event, fields) => emitted2.push({ event, fields }),
      yes: true,
      includeStale: true,
    });
    expect(emitted2.some((e) => e.event === "pr.merged.cleanup-requested")).toBe(true);
  });

  it("prunes ABANDONED and CLOSED_NO_MERGE by default", async () => {
    const emitted = [];
    await runWorktreesPrune({
      rows: [
        { path: "/wt/CTL-1", branch: "CTL-1", classification: "ABANDONED" },
        { path: "/wt/CTL-2", branch: "CTL-2", classification: "CLOSED_NO_MERGE" },
      ],
      emit: (event, fields) => emitted.push({ event, fields }),
      yes: true,
    });
    const cleanups = emitted.filter((e) => e.event === "pr.merged.cleanup-requested");
    expect(cleanups.length).toBe(2);
  });

  it("--max caps the number of pruned worktrees", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      path: `/wt/CTL-${i}`,
      branch: `CTL-${i}`,
      classification: "MERGED",
    }));
    const emitted = [];
    await runWorktreesPrune({
      rows,
      emit: (event, fields) => emitted.push({ event, fields }),
      yes: true,
      max: 3,
    });
    expect(emitted.filter((e) => e.event === "pr.merged.cleanup-requested").length).toBe(3);
  });
});

describe("runWorktreesPrune — structured rows for --json (inspectable plan)", () => {
  const mixedRows = () => [
    { path: "/wt/M", branch: "M", ticket: "M", classification: "MERGED" },
    { path: "/wt/L", branch: "L", ticket: "L", classification: "LIVE" },
    { path: "/wt/A", branch: "A", ticket: "A", classification: "ACTIVE" },
    { path: "/wt/S", branch: "S", ticket: "S", classification: "STALE" },
  ];

  it("returns planned rows with path/branch/classification", async () => {
    const { plannedRows } = await runWorktreesPrune({ rows: mixedRows(), emit: () => {} });
    expect(plannedRows).toEqual([{ path: "/wt/M", branch: "M", classification: "MERGED" }]);
  });

  it("records skipped rows with machine reasons", async () => {
    const { skippedRows } = await runWorktreesPrune({ rows: mixedRows(), emit: () => {} });
    expect(skippedRows).toContainEqual({ path: "/wt/L", reason: "not-prunable" });
    expect(skippedRows).toContainEqual({ path: "/wt/A", reason: "not-prunable" });
    expect(skippedRows).toContainEqual({ path: "/wt/S", reason: "stale-not-included" });
  });

  it("reports max-reached as the skip reason once the cap is hit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      path: `/wt/CTL-${i}`,
      branch: `CTL-${i}`,
      classification: "MERGED",
    }));
    const { skippedRows } = await runWorktreesPrune({ rows, emit: () => {}, max: 1 });
    expect(skippedRows).toContainEqual({ path: "/wt/CTL-1", reason: "max-reached" });
    expect(skippedRows).toContainEqual({ path: "/wt/CTL-2", reason: "max-reached" });
  });

  it("emitted is 0 in dry-run even though rows are planned", async () => {
    const { planned, emitted, plannedRows } = await runWorktreesPrune({
      rows: mixedRows(),
      emit: () => {},
    });
    expect(planned).toBe(1);
    expect(emitted).toBe(0);
    expect(plannedRows.length).toBe(1);
  });
});

describe("parseWorktreeArgs (strict shared parser + option mapping)", () => {
  it("maps kebab flags onto option names", () => {
    expect(
      parseWorktreeArgs(["--json", "--yes", "--dry-run", "--include-stale", "--max", "5", "--stale-days", "7"])
    ).toEqual({
      json: true,
      yes: true,
      dryRun: true,
      includeStale: true,
      max: 5,
      staleDays: 7,
    });
  });

  it("THROWS ArgError on an unknown flag (devex finding #1 — no silent exit 0)", () => {
    expect(() => parseWorktreeArgs(["--include-stal"])).toThrow(ArgError);
    expect(() => parseWorktreeArgs(["--bogus"])).toThrow(/unknown flag: --bogus/);
  });

  it("THROWS ArgError on --stale-days abc (devex finding #2 — no silent NaN)", () => {
    expect(() => parseWorktreeArgs(["--stale-days", "abc"])).toThrow(ArgError);
    expect(() => parseWorktreeArgs(["--stale-days", "abc"])).toThrow(/expects a number/);
    expect(() => parseWorktreeArgs(["--max", "abc"])).toThrow(ArgError);
  });

  it("accepts --repo-root <path> (CTL-675)", () => {
    expect(parseWorktreeArgs(["prune", "--repo-root", "/r"]).repoRoot).toBe("/r");
  });
});

// CTL-675: the inventory call now propagates a git failure (anchored to a
// resolved repoRoot) instead of swallowing it to "" — the silent no-op fix.
describe("gitWorktreePorcelain (CTL-675 throw-propagation + cwd anchor)", () => {
  it("propagates a git failure instead of returning empty", () => {
    const run = () => {
      const e = new Error("x");
      e.stderr = "fatal: not a git repository\n";
      throw e;
    };
    expect(() => gitWorktreePorcelain("/r", run)).toThrow(/fatal: not a git repository/);
  });

  it("returns porcelain on success, anchored to repoRoot", () => {
    let seenCwd;
    const run = (_a, opts) => {
      seenCwd = opts.cwd;
      return "worktree /a\nbranch refs/heads/x\n";
    };
    expect(gitWorktreePorcelain("/r", run)).toContain("worktree /a");
    expect(seenCwd).toBe("/r");
  });
});
