// linear-feed-run.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-run.test.mjs

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ACCOUNT, planTenants, runOnce } from "./linear-feed-run.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "lfr-"));
});
afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

const projects = (...teams) => teams.map((team) => ({ team, repoRoot: "/repo" }));

describe("planTenants — per-tenant values, not module constants", () => {
  test("teams come from the registry, not a literal", () => {
    const [p] = planTenants({ orchDir, projects: projects("CTL", "ADV"), exists: () => true });
    expect([...p.teams].sort()).toEqual(["ADV", "CTL"]);
  });

  test("the cursor and shadow paths carry the account, so N tenants need no new scheme", () => {
    const [p] = planTenants({ orchDir, account: "acct-b", projects: projects("CTL"), exists: () => true });
    expect(p.cursorPath).toContain("acct-b");
    expect(p.shadowPath).toContain("acct-b");
    const [q] = planTenants({ orchDir, account: "acct-c", projects: projects("CTL"), exists: () => true });
    expect(q.cursorPath).not.toBe(p.cursorPath); // two tenants cannot share a cursor
  });

  test("the account matches cloud-sync's own default, so the two cannot disagree", () => {
    expect(DEFAULT_ACCOUNT).toBe("tenant-0");
  });

  test("the replica path is resolved PER ACCOUNT through a seam", () => {
    // Today the seam returns one path regardless (CTL-1893); the point is that the
    // call site already asks per-account, so that ticket changes one function.
    const seen = [];
    planTenants({
      orchDir,
      account: "acct-x",
      projects: projects("CTL"),
      replicaPathFor: (a) => {
        seen.push(a);
        return "/replicas/x.db";
      },
      exists: () => true,
    });
    expect(seen).toEqual(["acct-x"]);
  });
});

describe("⭐ a missing replica is a SKIP, not an error", () => {
  test("no replica on this host → named skip, no producer", () => {
    const [p] = planTenants({ orchDir, projects: projects("CTL"), exists: () => false });
    expect(p.skip).toBe("replica-absent");
  });

  test("replica present but no registered teams is a DIFFERENT named skip", () => {
    // "not this host's job" and "misconfigured" must not look alike — an empty team
    // set makes the classifier refuse everything, which would otherwise present as
    // a healthy sweep that emitted nothing.
    const [p] = planTenants({ orchDir, projects: [], exists: () => true });
    expect(p.skip).toBe("no-registered-teams");
  });

  test("a healthy tenant has no skip", () => {
    const [p] = planTenants({ orchDir, projects: projects("CTL"), exists: () => true });
    expect(p.skip).toBeNull();
  });

  test("runOnce reports the skip instead of sweeping", () => {
    let swept = 0;
    const reports = runOnce({
      orchDir,
      plans: [{ account: "t0", skip: "replica-absent" }],
      sweep: () => {
        swept += 1;
        return {};
      },
    });
    expect(swept).toBe(0);
    expect(reports).toEqual([{ account: "t0", skipped: "replica-absent" }]);
  });
});

describe("runOnce — one tenant's failure does not silence the others", () => {
  const plan = (account) => ({
    account,
    skip: null,
    teams: new Set(["CTL"]),
    dbPath: `/db/${account}`,
    cursorPath: join(orchDir, `c-${account}.json`),
    shadowPath: join(orchDir, `s-${account}.jsonl`),
  });

  test("a throwing tenant is reported by name and the next still runs", () => {
    const reports = runOnce({
      orchDir,
      plans: [plan("bad"), plan("good")],
      makeSource: (p) => {
        if (p.account === "bad") throw new Error("replica corrupt");
        return { close() {} };
      },
      makeSink: () => ({ emit: () => {}, path: "/s", stats: () => ({ written: 1, failed: 0, classes: {} }) }),
      sweep: () => ({ edges: { emitted: 1 } }),
    });
    expect(reports[0]).toMatchObject({ account: "bad", error: "replica corrupt" });
    expect(reports[1]).toMatchObject({ account: "good" });
    expect(reports[1].sweep).toBeDefined();
  });

  test("an errored tenant carries no coverage — the exit criterion must not count it", () => {
    // If a failed tenant reported coverage, the shadow window could exit on classes
    // that were never actually emitted anywhere.
    const [r] = runOnce({
      orchDir,
      plans: [plan("bad")],
      makeSource: () => {
        throw new Error("nope");
      },
    });
    expect(r.coverage).toBeUndefined();
    expect(r.error).toBe("nope");
  });

  test("the source is closed even when the sweep throws", () => {
    let closed = 0;
    runOnce({
      orchDir,
      plans: [plan("t")],
      makeSource: () => ({ close: () => { closed += 1; } }),
      makeSink: () => ({ emit: () => {}, path: "/s", stats: () => ({}) }),
      sweep: () => {
        throw new Error("sweep blew up");
      },
    });
    expect(closed).toBe(1);
  });

  test("a healthy run reports sweep result AND coverage together", () => {
    const [r] = runOnce({
      orchDir,
      plans: [plan("t")],
      makeSource: () => ({ close() {} }),
      makeSink: () => ({
        emit: () => {},
        path: "/shadow.jsonl",
        stats: () => ({ written: 3, failed: 0, classes: { "linear.issue.state_changed": 3 } }),
      }),
      sweep: () => ({ mode: "resume", edges: { emitted: 3, declined: 0, failed: 0 } }),
    });
    expect(r.sweep.edges.emitted).toBe(3);
    expect(r.coverage.classes["linear.issue.state_changed"]).toBe(3);
    expect(r.shadowPath).toBe("/shadow.jsonl");
  });

  test("each tenant gets its own cursor and sink — no shared state", () => {
    const cursors = [];
    runOnce({
      orchDir,
      plans: [plan("a"), plan("b")],
      makeSource: () => ({ close() {} }),
      makeSink: () => ({ emit: () => {}, path: "/s", stats: () => ({}) }),
      sweep: ({ cursorPath }) => {
        cursors.push(cursorPath);
        return {};
      },
    });
    expect(cursors).toHaveLength(2);
    expect(cursors[0]).not.toBe(cursors[1]);
  });
});

describe("⭐ coverageGaps — extracted because it already carried a bug", () => {
  // An earlier cut computed this from an empty plan list, so it reported EVERY class
  // missing immediately after a successful sweep. It lived in the script-shaped
  // runner where no test could reach it — the CTL-1659 lesson about extracting the
  // pure part.
  test("merges coverage across tenants", async () => {
    const { coverageGaps } = await import("./linear-feed-run.mjs");
    const { merged } = coverageGaps(
      [
        { coverage: { classes: { "linear.issue.state_changed": 2 } } },
        { coverage: { classes: { "linear.issue.state_changed": 3, "linear.comment.created": 1 } } },
      ],
      ["linear.issue.state_changed"],
    );
    expect(merged["linear.issue.state_changed"]).toBe(5);
    expect(merged["linear.comment.created"]).toBe(1);
  });

  test("⚠️ an EMPTY report list is every class MISSING, never 'complete'", async () => {
    const { coverageGaps, REQUIRED_CLASSES } = await import("./linear-feed-run.mjs");
    const r = coverageGaps([], REQUIRED_CLASSES);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([...REQUIRED_CLASSES]);
    // the `[].every()` shape: an all-clear derived from having looked at nothing
    for (const bad of [null, undefined, "not an array"]) {
      expect(coverageGaps(bad, REQUIRED_CLASSES).complete).toBe(false);
    }
  });

  test("a tenant that ERRORED contributes no coverage", async () => {
    const { coverageGaps } = await import("./linear-feed-run.mjs");
    const r = coverageGaps([{ account: "t", error: "boom" }], ["linear.issue.state_changed"]);
    expect(r.complete).toBe(false);
  });

  test("complete only when every required class meets the floor", async () => {
    const { coverageGaps } = await import("./linear-feed-run.mjs");
    const reports = [{ coverage: { classes: { a: 2, b: 1 } } }];
    expect(coverageGaps(reports, ["a", "b"], 1).complete).toBe(true);
    expect(coverageGaps(reports, ["a", "b"], 2).complete).toBe(false);
    expect(coverageGaps(reports, ["a", "b"], 2).missing).toEqual(["b"]);
  });

  test("REQUIRED_CLASSES covers all three daemon event names plus the updated fan-out", async () => {
    const { REQUIRED_CLASSES } = await import("./linear-feed-run.mjs");
    expect(REQUIRED_CLASSES).toContain("linear.issue.state_changed");
    expect(REQUIRED_CLASSES).toContain("linear.comment.created");
    expect(REQUIRED_CLASSES).toContain("linear.issue.updated:labels"); // the cell that was missing
    expect(REQUIRED_CLASSES.filter((c) => c.startsWith("linear.issue.updated:")).length).toBeGreaterThan(8);
  });
});
