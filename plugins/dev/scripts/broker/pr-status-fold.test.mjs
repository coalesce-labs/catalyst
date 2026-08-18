// pr-status-fold.test.mjs — CTL-2008. The pure classifier.
//
// Run: cd plugins/dev/scripts/broker && bun test pr-status-fold.test.mjs
//
// The WIRING (that router.mjs folds this ABOVE the interests gate) is asserted
// separately in pr-status-fold-wiring.test.mjs — a correct classifier called below
// that gate is a silent no-op on every execution-core host, so proving the value is
// not proving the fix.

import { describe, test, expect } from "bun:test";
import {
  classifyPrStatusEvent,
  PR_LIFECYCLE_EVENT_NAMES,
  PR_STATUSES,
} from "./pr-status-fold.mjs";

const scope = { repo: "coalesce-labs/catalyst", pr: 3585 };

describe("classifyPrStatusEvent — the three lifecycle edges", () => {
  test("github.pr.opened on an unmerged PR is `open`", () => {
    expect(classifyPrStatusEvent("github.pr.opened", { merged: false }, scope)).toEqual({
      repo: "coalesce-labs/catalyst",
      prNumber: 3585,
      status: "open",
    });
  });

  test("github.pr.closed WITHOUT a merge is `closed`", () => {
    expect(classifyPrStatusEvent("github.pr.closed", { merged: false }, scope)?.status).toBe(
      "closed",
    );
  });

  test("github.pr.merged is `merged`", () => {
    // The real payload shape the cloud feed emits (measured on mini-2, 19:00:10Z).
    const detail = {
      action: "closed",
      merged: true,
      mergedAt: "2026-08-18T18:59:40Z",
      mergeCommitSha: "c7c255ccd200febc935c76ef32d22368ece14c81",
      source: "cloud-feed",
      feedAuthority: true,
    };
    expect(classifyPrStatusEvent("github.pr.merged", detail, scope)?.status).toBe("merged");
  });
});

describe("⛔ a merged PR can never be walked back to `open`", () => {
  test("github.pr.closed with merged:true is `merged`, not `closed`", () => {
    // GitHub delivers a merge AS a `closed` action. Reading the name alone would
    // record `closed`, and board-health's PR_MERGED_RE would stop matching it —
    // phantom-merged goes blind on every merge.
    expect(classifyPrStatusEvent("github.pr.closed", { merged: true }, scope)?.status).toBe(
      "merged",
    );
  });

  test("github.pr.merged with the `merged` field MISSING is still `merged`", () => {
    // State-only derivation returns `open` here — a literal walk-back emitted by the
    // event whose whole purpose is to record the merge. The union with the name is
    // what stops it, so this asserts the union rather than the happy path.
    expect(classifyPrStatusEvent("github.pr.merged", {}, scope)?.status).toBe("merged");
    expect(classifyPrStatusEvent("github.pr.merged", { merged: false }, scope)?.status).toBe(
      "merged",
    );
  });

  test("`open` is reachable ONLY from github.pr.opened on an unmerged PR", () => {
    // Exhaustive over the closed name set x the merged tri-state, so a future edit
    // that adds an `open` route fails here rather than in production.
    const opens = [];
    for (const name of PR_LIFECYCLE_EVENT_NAMES) {
      for (const merged of [true, false, undefined]) {
        if (classifyPrStatusEvent(name, { merged }, scope)?.status === "open") {
          opens.push(`${name}|merged=${String(merged)}`);
        }
      }
    }
    expect(opens.sort()).toEqual([
      "github.pr.opened|merged=false",
      "github.pr.opened|merged=undefined",
    ]);
  });
});

describe("⛔ identity is (repo, pr_number) and both are required", () => {
  // A repo-less row is bucketed under the "" repoKey by getAllPrStatuses, which
  // lookupPrStatus treats as the legacy "single UNATTRIBUTED row" case and will hand
  // to a ticket in ANY repo. That is not less data — it is a wrong repo's status
  // attached to a ticket, so declining is the only safe answer.
  test("a missing or empty repo declines", () => {
    expect(classifyPrStatusEvent("github.pr.merged", { merged: true }, { pr: 1 })).toBeNull();
    expect(
      classifyPrStatusEvent("github.pr.merged", { merged: true }, { repo: "", pr: 1 }),
    ).toBeNull();
  });

  test("a missing, zero, negative or non-numeric PR number declines", () => {
    for (const pr of [undefined, null, 0, -3, "abc", NaN, 1.5, {}]) {
      expect(
        classifyPrStatusEvent("github.pr.merged", { merged: true }, { repo: "o/r", pr }),
      ).toBeNull();
    }
  });

  test("a NUMERIC-STRING pr number is accepted — the legacy envelope carries one", () => {
    // Dropping it would make the smee rollback path lossy for no reason.
    expect(
      classifyPrStatusEvent("github.pr.merged", { merged: true }, { repo: "o/r", pr: "3585" })
        ?.prNumber,
    ).toBe(3585);
  });
});

describe("declines everything that is not a PR-lifecycle edge", () => {
  test("other github.* names, phase names, junk and non-strings all decline", () => {
    for (const name of [
      "github.check_suite.completed",
      "github.push",
      "github.pr_review.submitted",
      "phase.implement.complete.CTL-1",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(classifyPrStatusEvent(name, { merged: true }, scope)).toBeNull();
    }
  });

  test("a null/absent detail does not throw — it classifies from the name", () => {
    expect(classifyPrStatusEvent("github.pr.merged", null, scope)?.status).toBe("merged");
    expect(classifyPrStatusEvent("github.pr.opened", undefined, scope)?.status).toBe("open");
  });

  test("a null/absent scope declines rather than throwing", () => {
    expect(classifyPrStatusEvent("github.pr.merged", { merged: true }, null)).toBeNull();
    expect(classifyPrStatusEvent("github.pr.merged", { merged: true }, undefined)).toBeNull();
  });
});

describe("the exported vocabularies are the ones the classifier can produce", () => {
  // PR_STATUSES is load-bearing: putPrStatus rejects anything outside it, so a typo
  // here would be written to a column board-health's PR_MERGED_RE silently declines
  // to match. Assert the classifier's whole range is inside the declared set.
  test("every status the classifier can emit is in PR_STATUSES", () => {
    const produced = new Set();
    for (const name of PR_LIFECYCLE_EVENT_NAMES) {
      for (const merged of [true, false, undefined]) {
        const r = classifyPrStatusEvent(name, { merged }, scope);
        if (r) produced.add(r.status);
      }
    }
    expect([...produced].sort()).toEqual(["closed", "merged", "open"]);
    for (const s of produced) expect(PR_STATUSES).toContain(s);
  });
});
