import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ownerForTicket } from "../execution-core/hrw.mjs";
import {
  CI_STATE,
  VerificationError,
  classifyCheckRollup,
  countEventsByName,
  hrwOwner,
  mustBeConclusive,
  ownershipPreflight,
  prMergeBlockers,
  resolveOwnership,
  verifyAll,
} from "./verified-checks.mjs";

// Each test dir is its own tmp, so parallel runs never collide.
let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "verified-checks-test-"));
  _tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
});

// A GitHub event whose BODY carries a commit message mentioning the event name.
// This is the real shape that made `grep -c` report 4 events that did not exist.
const GITHUB_EVENT_MENTIONING_THE_NAME = JSON.stringify({
  ts: "2026-08-12T03:00:00.000Z",
  attributes: { "event.name": "github.push" },
  body: {
    message: "github.push",
    payload: { commits: [{ message: "feat: emit phase.advance.applied on every advance" }] },
  },
});

const REAL_ADVANCE_EVENT = JSON.stringify({
  ts: "2026-08-12T05:51:30.000Z",
  attributes: { "event.name": "phase.advance.applied.PROJ-56" },
  body: { payload: { evidence: "fabricated", asserted_by: "sdk-success-flip" } },
});

const UNRELATED_EVENT = JSON.stringify({
  ts: "2026-08-12T05:00:00.000Z",
  attributes: { "event.name": "linear.issue.updated" },
  body: { message: "linear.issue.updated PROJ-1801" },
});

describe("(1) countEventsByName — prose that mentions a name is not an occurrence", () => {
  test("Scenario: counting events by name ignores prose that merely mentions the name", async () => {
    const lines = [GITHUB_EVENT_MENTIONING_THE_NAME, UNRELATED_EVENT];

    // The defect being fixed: a substring scan sees the commit message and lies.
    const naiveSubstringCount = lines.filter((l) => l.includes("phase.advance.applied")).length;
    expect(naiveSubstringCount).toBeGreaterThan(0);

    const verdict = await countEventsByName("phase.advance.applied", { lines });
    expect(verdict.conclusive).toBe(true);
    expect(verdict.value).toBe(0);
    // ...and the zero is licensed by having actually read events.
    expect(verdict.evidence.parsedEvents).toBe(2);
  });

  test("counts real events, including the per-ticket dotted suffix", async () => {
    const verdict = await countEventsByName("phase.advance.applied", {
      lines: [GITHUB_EVENT_MENTIONING_THE_NAME, REAL_ADVANCE_EVENT, UNRELATED_EVENT],
    });
    expect(mustBeConclusive(verdict)).toBe(1);
  });

  test("an exact-name event matches without a suffix", async () => {
    const verdict = await countEventsByName("session.heartbeat", {
      lines: [JSON.stringify({ attributes: { "event.name": "session.heartbeat" } })],
    });
    expect(mustBeConclusive(verdict)).toBe(1);
  });

  test("a sibling name sharing a prefix does NOT match", async () => {
    // "phase.advance.applied" must not match "phase.advance.applied_shadow".
    const verdict = await countEventsByName("phase.advance.applied", {
      lines: [JSON.stringify({ attributes: { "event.name": "phase.advance.applied_shadow" } })],
    });
    expect(mustBeConclusive(verdict)).toBe(0);
  });

  test("reads a real file from disk", async () => {
    const dir = fixtureDir();
    const path = resolve(dir, "events.jsonl");
    writeFileSync(path, [GITHUB_EVENT_MENTIONING_THE_NAME, REAL_ADVANCE_EVENT].join("\n") + "\n");
    const verdict = await countEventsByName("phase.advance.applied", { logPath: path });
    expect(mustBeConclusive(verdict)).toBe(1);
  });

  // POSITIVE CONTROL. These are the tests that fail if the control is removed:
  // without `parsedEvents > 0`, each of these would return a CONCLUSIVE zero and
  // an agent would report "the instrument works and found nothing".
  test("POSITIVE CONTROL: an empty corpus is inconclusive, not zero", async () => {
    const verdict = await countEventsByName("phase.advance.applied", { lines: [] });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.value).toBeNull();
    expect(verdict.reason).toContain("could not look");
    expect(() => mustBeConclusive(verdict)).toThrow(VerificationError);
  });

  test("POSITIVE CONTROL: an all-unparseable corpus is inconclusive, not zero", async () => {
    const verdict = await countEventsByName("phase.advance.applied", {
      lines: ["}{ not json", "also not json"],
    });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.evidence.parseFailures).toBe(2);
  });

  test("POSITIVE CONTROL: a missing log file is inconclusive, not zero", async () => {
    const verdict = await countEventsByName("phase.advance.applied", {
      logPath: resolve(fixtureDir(), "never-written.jsonl"),
    });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.reason).toContain("log not found");
  });

  test("malformed input throws rather than returning a falsy sentinel", async () => {
    await expect(countEventsByName("")).rejects.toThrow(VerificationError);
    await expect(countEventsByName("x")).rejects.toThrow(VerificationError);
    await expect(countEventsByName("x", { lines: "not-an-array" })).rejects.toThrow(VerificationError);
  });
});

describe("(2) resolveOwnership — an ownership check refuses rather than answering falsely", () => {
  const ROSTER = ["mini", "mini-2"];

  test("Scenario: a wrong-order call fails loudly with the expected signature", () => {
    // The exact transposition that reported 11 tickets as unowned: the roster and
    // the host name swapped. Positionally this was silent; by name it is impossible,
    // and the shape check throws.
    expect(() => resolveOwnership({ ticketId: "PROJ-56", roster: "mini", hostName: ROSTER })).toThrow(
      VerificationError,
    );
    expect(() => resolveOwnership({ ticketId: "PROJ-56", roster: "mini", hostName: ROSTER })).toThrow(
      /must be an array of host names/,
    );
  });

  test("no ticket is reported unowned on the strength of a malformed call", () => {
    // The old failure mode returned `false` for all 11. Now every one throws.
    const tickets = ["PROJ-56", "PROJ-1790", "PROJ-1801"];
    for (const ticketId of tickets) {
      expect(() => resolveOwnership({ ticketId, roster: undefined, hostName: "mini" })).toThrow(
        VerificationError,
      );
    }
  });

  test("a well-formed call answers, and names the owner as evidence", () => {
    const owner = hrwOwner("PROJ-1790", ROSTER);
    const verdict = resolveOwnership({ ticketId: "PROJ-1790", roster: ROSTER, hostName: owner });
    expect(mustBeConclusive(verdict)).toBe(true);
    expect(verdict.evidence.owner).toBe(owner);

    const other = ROSTER.find((h) => h !== owner);
    expect(mustBeConclusive(resolveOwnership({ ticketId: "PROJ-1790", roster: ROSTER, hostName: other }))).toBe(
      false,
    );
  });

  test("an empty roster throws instead of silently owning nothing", () => {
    expect(() => resolveOwnership({ ticketId: "PROJ-1", roster: [], hostName: "mini" })).toThrow(
      VerificationError,
    );
  });

  test("DRIFT PIN: hrwOwner agrees with execution-core/hrw.mjs ownerForTicket", () => {
    // This leaf re-implements the hash to stay dependency-free; if either side
    // drifts, ownership answers would silently diverge from the daemon's.
    for (let i = 1; i < 250; i += 1) {
      const ticketId = `CTL-${i}`;
      expect(hrwOwner(ticketId, ROSTER)).toBe(ownerForTicket(ticketId, ROSTER));
      expect(hrwOwner(ticketId, ["mini", "mini-2", "laptop"])).toBe(
        ownerForTicket(ticketId, ["mini", "mini-2", "laptop"]),
      );
    }
  });

  test("ownershipPreflight requires every roster to agree", () => {
    const live = ["mini"];
    const full = ["mini", "mini-2"];
    // Find a ticket mini owns under the degraded roster but not the full one —
    // exactly the false negative that strands work when a host is down.
    let divergent = null;
    for (let i = 1; i < 500 && divergent === null; i += 1) {
      const t = `CTL-${i}`;
      if (hrwOwner(t, live) === "mini" && hrwOwner(t, full) !== "mini") divergent = t;
    }
    expect(divergent).not.toBeNull();

    const verdict = ownershipPreflight({ ticketId: divergent, rosters: [live, full], hostName: "mini" });
    expect(mustBeConclusive(verdict)).toBe(false);
    expect(verdict.evidence.owners).toHaveLength(2);
    expect(verdict.evidence.owners[0].owner).toBe("mini");
    expect(verdict.evidence.owners[1].owner).not.toBe("mini");
  });

  test("ownershipPreflight is true only when all rosters agree", () => {
    let agreed = null;
    for (let i = 1; i < 500 && agreed === null; i += 1) {
      const t = `CTL-${i}`;
      if (hrwOwner(t, ["mini"]) === "mini" && hrwOwner(t, ["mini", "mini-2"]) === "mini") agreed = t;
    }
    expect(agreed).not.toBeNull();
    expect(
      mustBeConclusive(
        ownershipPreflight({ ticketId: agreed, rosters: [["mini"], ["mini", "mini-2"]], hostName: "mini" }),
      ),
    ).toBe(true);
  });
});

describe("(3) verifyAll — a loop over an empty candidate set cannot print a verdict", () => {
  test("Scenario: an empty input set reports inconclusive, NOT verified-clean", () => {
    // `[].every(p) === true` is the vacuous truth this guard exists to refuse.
    expect([].every(() => false)).toBe(true);

    const verdict = verifyAll([], () => true, { label: "candidate files" });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.value).toBeNull();
    expect(verdict.reason).toContain("no candidate files found");
    expect(verdict.reason).toContain("inconclusive");
    expect(() => mustBeConclusive(verdict)).toThrow(VerificationError);
  });

  test("a non-empty set is actually checked", () => {
    expect(mustBeConclusive(verifyAll(["a", "b"], (x) => x.length === 1))).toBe(true);
    const failing = verifyAll(["a", "bb"], (x) => x.length === 1);
    expect(mustBeConclusive(failing)).toBe(false);
    expect(failing.evidence.failed).toEqual(["bb"]);
    expect(failing.evidence.checked).toBe(2);
  });

  test("a predicate that throws is a failure to look, not a pass", () => {
    const verdict = verifyAll(["a"], () => {
      throw new Error("grep exploded");
    });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.reason).toContain("grep exploded");
  });

  test("malformed input throws", () => {
    expect(() => verifyAll("not-an-array", () => true)).toThrow(VerificationError);
    expect(() => verifyAll([], "not-a-function")).toThrow(VerificationError);
  });
});

describe("(4) prMergeBlockers — consult every surface that can block a merge", () => {
  // A PR with zero bot issue-comments but one unresolved review thread: the exact
  // shape that was reported as review-clean.
  const fakeGh = (overrides = {}) => {
    return async (args) => {
      if (args[0] === "pr") {
        return {
          isDraft: false,
          mergeStateStatus: "BLOCKED",
          statusCheckRollup: [{ name: "validate", conclusion: "SUCCESS" }],
          reviews: [],
          reviewDecision: null,
          ...(overrides.pr ?? {}),
        };
      }
      if (args[0] === "__reviewThreads__") {
        return overrides.threads ?? [{ id: "T_1", isResolved: false, path: "src/a.ts" }];
      }
      if (args[0] === "__issueComments__") return overrides.comments ?? [];
      if (args[0] === "__reactions__") return overrides.reactions ?? [];
      throw new Error(`unexpected args ${args.join(" ")}`);
    };
  };
  // A PR that is genuinely clean AND has been reviewed: green checks, resolved
  // threads, a CLEAN merge state, and a reviewer signal.
  const cleanGh = (over = {}) =>
    fakeGh({
      pr: { mergeStateStatus: "CLEAN", statusCheckRollup: [{ name: "ok", conclusion: "SUCCESS" }], ...(over.pr ?? {}) },
      threads: over.threads ?? [{ id: "T_1", isResolved: true }],
      comments: over.comments ?? [{ user: { login: "chatgpt-codex-connector" }, body: "no major issues" }],
      reactions: over.reactions ?? [],
    });

  test("Scenario: zero bot issue-comments but one unresolved thread reports the thread", async () => {
    const verdict = await prMergeBlockers({ prNumber: 3276, runJson: fakeGh() });
    const blockers = mustBeConclusive(verdict);
    expect(verdict.evidence.commentsSeen).toBe(0);
    const threadBlockers = blockers.filter((b) => b.kind === "unresolved-thread");
    expect(threadBlockers).toHaveLength(1);
    expect(threadBlockers[0].path).toBe("src/a.ts");
  });

  test("a genuinely clean, reviewed PR reports no blockers", async () => {
    const verdict = await prMergeBlockers({ prNumber: 1, runJson: cleanGh() });
    expect(mustBeConclusive(verdict)).toEqual([]);
  });

  // Codex P1 #1 — green checks with NO reviewer response is not "clean", it is
  // "unreviewed". Reporting no blockers there reads an absence as approval.
  test("green checks but no automated review yet is a BLOCKER, not clean", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: cleanGh({ comments: [], reactions: [], threads: [] }),
    });
    const blockers = mustBeConclusive(verdict);
    expect(blockers.map((b) => b.kind)).toContain("awaiting-automated-review");
  });

  test("a REACTION-only clean pass counts as a response (it lives on no other surface)", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: cleanGh({
        comments: [],
        threads: [],
        reactions: [{ content: "+1", user: { login: "chatgpt-codex-connector" } }],
      }),
    });
    expect(mustBeConclusive(verdict)).toEqual([]);
  });

  // Codex P1 #3 — never contradict GitHub's own aggregate.
  test("clean enumeration but a NOT-READY mergeStateStatus is INCONCLUSIVE", async () => {
    for (const state of ["DIRTY", "BLOCKED", "UNKNOWN"]) {
      const verdict = await prMergeBlockers({
        prNumber: 1,
        runJson: cleanGh({ pr: { mergeStateStatus: state } }),
      });
      expect(verdict.conclusive).toBe(false);
      expect(verdict.reason).toContain(state);
      expect(() => mustBeConclusive(verdict)).toThrow(VerificationError);
    }
  });

  test("an UNCLASSIFIED check conclusion is INCONCLUSIVE, never assumed passing", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: cleanGh({ pr: { statusCheckRollup: [{ name: "weird", conclusion: "SOMETHING_NEW" }] } }),
    });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.reason).toContain("does not classify");
  });

  test("ACTION_REQUIRED and STARTUP_FAILURE are failing checks", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: cleanGh({
        pr: {
          statusCheckRollup: [
            { name: "a", conclusion: "ACTION_REQUIRED" },
            { name: "b", conclusion: "STARTUP_FAILURE" },
          ],
        },
      }),
    });
    expect(mustBeConclusive(verdict).filter((b) => b.kind === "failing").map((b) => b.name)).toEqual(["a", "b"]);
  });

  // Codex P2 — the aggregate decision, not stale history.
  test("a SUPERSEDED CHANGES_REQUESTED does not block forever", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: cleanGh({
        pr: {
          // history still carries the old rejection...
          reviews: [{ state: "CHANGES_REQUESTED", author: { login: "ryan" } }],
          // ...but the effective decision is APPROVED.
          reviewDecision: "APPROVED",
        },
      }),
    });
    expect(mustBeConclusive(verdict)).toEqual([]);
  });

  test("an EFFECTIVE CHANGES_REQUESTED still blocks", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: cleanGh({ pr: { reviewDecision: "CHANGES_REQUESTED" } }),
    });
    expect(mustBeConclusive(verdict).some((b) => b.kind === "changes-requested")).toBe(true);
  });

  test("a failing REACTIONS surface makes the verdict inconclusive", async () => {
    const base = cleanGh();
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: async (args) => {
        if (args[0] === "__reactions__") throw new Error("403 rate limited");
        return base(args);
      },
    });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.reason).toContain("403 rate limited");
  });

  test("failing and pending checks are both blockers", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: fakeGh({
        pr: {
          statusCheckRollup: [
            { name: "validate", conclusion: "FAILURE" },
            { name: "pages", conclusion: null },
            { name: "ok", conclusion: "SUCCESS" },
          ],
        },
        threads: [],
      }),
    });
    const blockers = mustBeConclusive(verdict);
    expect(blockers.filter((b) => b.kind === "failing").map((b) => b.name)).toEqual(["validate"]);
    expect(blockers.filter((b) => b.kind === "pending").map((b) => b.name)).toEqual(["pages"]);
  });

  // NOTE: the raw-`reviews`-history version of this test was removed deliberately.
  // Reading history kept a superseded CHANGES_REQUESTED as a blocker forever;
  // the aggregate `reviewDecision` is now the source, covered by the
  // superseded/effective pair below.

  // POSITIVE CONTROL: this is the test that fails if the partial-read guard is
  // removed — without it, a broken thread query yields "no blockers found".
  test("POSITIVE CONTROL: a failing surface makes the whole verdict inconclusive", async () => {
    const verdict = await prMergeBlockers({
      prNumber: 1,
      runJson: async (args) => {
        if (args[0] === "__reviewThreads__") throw new Error("GraphQL 502");
        return args[0] === "pr" ? { isDraft: false, statusCheckRollup: [], reviews: [] } : [];
      },
    });
    expect(verdict.conclusive).toBe(false);
    expect(verdict.reason).toContain("cannot report 'nothing is blocking'");
    expect(verdict.evidence.failures[0]).toContain("GraphQL 502");
    expect(() => mustBeConclusive(verdict)).toThrow(VerificationError);
  });

  test("malformed input throws", async () => {
    await expect(prMergeBlockers({ prNumber: 0, runJson: async () => ({}) })).rejects.toThrow(
      VerificationError,
    );
    await expect(prMergeBlockers({ prNumber: 1 })).rejects.toThrow(VerificationError);
  });
});

describe("mustBeConclusive", () => {
  test("rejects a non-verdict rather than passing it through", () => {
    expect(() => mustBeConclusive(0)).toThrow(VerificationError);
    expect(() => mustBeConclusive(null)).toThrow(VerificationError);
    expect(() => mustBeConclusive({ value: 3 })).toThrow(VerificationError);
  });
});

// ---------------------------------------------------------------------------
// classifyCheckRollup (CTL-2181) — the ROLLUP verdict over a statusCheckRollup.
//
// THE trap this whole ticket turns on: pr-block-probe.mjs's isFailingState
// returns false for a PENDING conclusion AND for an absent one alike, so a
// !isFailingState test reads "no CI run at all" as "CI passed". A finished-draft
// classifier built on that boolean has an unsatisfiable negative control, since
// the negative control IS a draft with no CI run. Four-valued, not boolean.
// ---------------------------------------------------------------------------
describe("classifyCheckRollup — four-valued CI rollup state (CTL-2181)", () => {
  test("empty rollup → none, never passing", () => {
    expect(classifyCheckRollup([])).toBe(CI_STATE.NONE);
    expect(classifyCheckRollup(null)).toBe(CI_STATE.NONE);
    expect(classifyCheckRollup(undefined)).toBe(CI_STATE.NONE);
    // The distinction that matters: NONE is not PASSING.
    expect(CI_STATE.NONE).not.toBe(CI_STATE.PASSING);
  });

  test("a null/absent conclusion is PENDING, not passing", () => {
    // PENDING_CHECK_STATES contains "" deliberately.
    expect(classifyCheckRollup([{ name: "a", conclusion: null }])).toBe(CI_STATE.PENDING);
    expect(classifyCheckRollup([{ name: "a", state: "" }])).toBe(CI_STATE.PENDING);
    expect(classifyCheckRollup([{ name: "a" }])).toBe(CI_STATE.PENDING);
  });

  test("precedence: any failing beats pending beats passing", () => {
    expect(
      classifyCheckRollup([
        { conclusion: "SUCCESS" },
        { conclusion: "PENDING" },
        { conclusion: "FAILURE" },
      ]),
    ).toBe(CI_STATE.FAILING);
    expect(classifyCheckRollup([{ conclusion: "SUCCESS" }, { conclusion: "QUEUED" }])).toBe(
      CI_STATE.PENDING,
    );
    expect(classifyCheckRollup([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }])).toBe(
      CI_STATE.PASSING,
    );
  });

  test("an unrecognised conclusion is UNKNOWN, never silently passing", () => {
    expect(classifyCheckRollup([{ conclusion: "WAT" }])).toBe(CI_STATE.UNKNOWN);
    // and it does not get masked by a passing sibling
    expect(classifyCheckRollup([{ conclusion: "SUCCESS" }, { conclusion: "WAT" }])).toBe(
      CI_STATE.UNKNOWN,
    );
    // UNKNOWN dominates even a genuine failure — "could not classify" is the
    // louder verdict, matching prMergeBlockers's unclassifiedChecks discipline.
    expect(classifyCheckRollup([{ conclusion: "FAILURE" }, { conclusion: "WAT" }])).toBe(
      CI_STATE.UNKNOWN,
    );
  });

  test("StatusContext entries (state, no conclusion) classify off `state`", () => {
    expect(classifyCheckRollup([{ context: "legacy", state: "SUCCESS" }])).toBe(CI_STATE.PASSING);
    expect(classifyCheckRollup([{ context: "legacy", state: "FAILURE" }])).toBe(CI_STATE.FAILING);
  });

  test("conclusion is case-insensitive and wins over state", () => {
    expect(classifyCheckRollup([{ conclusion: "success" }])).toBe(CI_STATE.PASSING);
    expect(classifyCheckRollup([{ conclusion: "FAILURE", state: "SUCCESS" }])).toBe(
      CI_STATE.FAILING,
    );
  });

  test("every FAILING_CHECK_STATES member classifies as failing (no enumerate-the-bad-ones gap)", () => {
    for (const s of [
      "FAILURE",
      "TIMED_OUT",
      "CANCELLED",
      "ERROR",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
      "STALE",
    ]) {
      expect(classifyCheckRollup([{ conclusion: s }])).toBe(CI_STATE.FAILING);
    }
  });

  test("CI_STATE is frozen and has exactly the five documented values", () => {
    expect(Object.isFrozen(CI_STATE)).toBe(true);
    expect(Object.values(CI_STATE).sort()).toEqual([
      "failing",
      "none",
      "passing",
      "pending",
      "unknown",
    ]);
  });

  test("a non-array rollup (object, string, number) is NONE, never a throw", () => {
    for (const bad of [{}, "x", 42, true]) {
      expect(classifyCheckRollup(bad)).toBe(CI_STATE.NONE);
    }
  });
});
