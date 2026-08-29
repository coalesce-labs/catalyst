// scripts/__tests__/merge-queue-watchdog.test.mjs — offline coverage for
// scripts/merge-queue-watchdog.mjs (CTL-2285, ported from catalyst-cloud's CTC-1218 suite).
// Every fetch is a fake; no network, no secret. Run via `node --test` (registered as a step in
// .github/workflows/execution-core-tests.yml — there is no glob test runner in this repo, so a
// suite merely present here would otherwise never execute in CI).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CONFIG,
  NUDGE_MARKER,
  PATH_EXCLUDED_MARKER,
  QUEUE_STATUS_HEADING,
  MERGIFY_BOT_LOGIN,
  parsePathExclusionPatterns,
  isPathExcluded,
  latestLabelAddedAt,
  latestNudgeAt,
  isAlreadyQueued,
  hasPathExcludedAlert,
  findUnsurfacedRefusal,
  checkStateForContext,
  requiredChecksConclusion,
  countUnresolvedThreads,
  decideAction,
  gatherPrInput,
  runOnce,
  main,
  makeGithubClient,
} from "../merge-queue-watchdog.mjs";

const NOW = new Date("2026-08-29T04:30:00Z");
const config = DEFAULT_CONFIG;

// ── parsePathExclusionPatterns / isPathExcluded ──────────────────────────────────────────────

describe("parsePathExclusionPatterns", () => {
  const MERGIFY_YAML = `
queue_rules:
  - name: default
    queue_conditions:
      - base=main
      - label=queue:ready
      - -files~=^\\.github/workflows/publish-
      - -files~=^plugins/dev/scripts/db-migrations/
      - -files~=^\\.mergify\\.yml$
      - -head~=^release-please--
      - -draft
`;

  it("extracts every -files~= condition as a RegExp, ignoring -head~=", () => {
    const patterns = parsePathExclusionPatterns(MERGIFY_YAML);
    assert.equal(patterns.length, 3);
    assert.equal(patterns[0].test(".github/workflows/publish-desktop.yml"), true);
    assert.equal(patterns[0].test("scripts/merge-queue-watchdog.mjs"), false);
    assert.equal(patterns[1].test("plugins/dev/scripts/db-migrations/0001.sql"), true);
    assert.equal(patterns[2].test(".mergify.yml"), true);
  });

  it("returns an empty array when the file has no path exclusions", () => {
    assert.deepEqual(parsePathExclusionPatterns("queue_rules:\n  - name: default\n"), []);
  });
});

describe("isPathExcluded", () => {
  const patterns = parsePathExclusionPatterns(
    "      - -files~=^\\.mergify\\.yml$\n      - -files~=^plugins/dev/scripts/db-migrations/\n"
  );

  it("matches a file under an excluded prefix", () => {
    assert.equal(isPathExcluded(["plugins/dev/scripts/db-migrations/0001.sql"], patterns), true);
  });

  it("matches the exact excluded file", () => {
    assert.equal(isPathExcluded([".mergify.yml"], patterns), true);
  });

  it("does not match an unrelated file", () => {
    assert.equal(isPathExcluded(["scripts/merge-queue-watchdog.mjs"], patterns), false);
  });

  it("never excludes anything when there are no patterns", () => {
    assert.equal(isPathExcluded([".mergify.yml"], []), false);
  });
});

// ── latestLabelAddedAt ────────────────────────────────────────────────────────────────────────

describe("latestLabelAddedAt", () => {
  it("returns the labeled timestamp when it is the only event", () => {
    const at = latestLabelAddedAt(
      [{ event: "labeled", label: { name: "queue:ready" }, created_at: "2026-08-29T04:00:00Z" }],
      "queue:ready"
    );
    assert.deepEqual(at, new Date("2026-08-29T04:00:00Z"));
  });

  it("returns null when the most recent event is unlabeled", () => {
    const at = latestLabelAddedAt(
      [
        { event: "labeled", label: { name: "queue:ready" }, created_at: "2026-08-29T03:00:00Z" },
        { event: "unlabeled", label: { name: "queue:ready" }, created_at: "2026-08-29T04:00:00Z" },
      ],
      "queue:ready"
    );
    assert.equal(at, null);
  });

  it("picks the latest re-label after an unlabel/relabel cycle", () => {
    const at = latestLabelAddedAt(
      [
        { event: "labeled", label: { name: "queue:ready" }, created_at: "2026-08-29T02:00:00Z" },
        { event: "unlabeled", label: { name: "queue:ready" }, created_at: "2026-08-29T03:00:00Z" },
        { event: "labeled", label: { name: "queue:ready" }, created_at: "2026-08-29T04:00:00Z" },
      ],
      "queue:ready"
    );
    assert.deepEqual(at, new Date("2026-08-29T04:00:00Z"));
  });

  it("ignores events for a different label", () => {
    const at = latestLabelAddedAt(
      [
        {
          event: "labeled",
          label: { name: "hold:hand-steps" },
          created_at: "2026-08-29T04:00:00Z",
        },
      ],
      "queue:ready"
    );
    assert.equal(at, null);
  });

  it("returns null when never labeled", () => {
    assert.equal(latestLabelAddedAt([], "queue:ready"), null);
  });
});

// ── comment scanning: nudge / queue-status / path-excluded-alert / refusal ──────────────────

function comment(overrides) {
  return {
    id: 1,
    user: { login: "github-actions[bot]" },
    body: "",
    created_at: "2026-08-29T04:00:00Z",
    ...overrides,
  };
}

describe("latestNudgeAt", () => {
  it("finds the marker and returns its timestamp", () => {
    const at = latestNudgeAt([comment({ body: `@Mergifyio queue\n\n${NUDGE_MARKER}` })]);
    assert.deepEqual(at, new Date("2026-08-29T04:00:00Z"));
  });

  it("returns the latest of multiple nudges", () => {
    const at = latestNudgeAt([
      comment({ body: NUDGE_MARKER, created_at: "2026-08-29T02:00:00Z" }),
      comment({ body: NUDGE_MARKER, created_at: "2026-08-29T04:00:00Z" }),
    ]);
    assert.deepEqual(at, new Date("2026-08-29T04:00:00Z"));
  });

  it("returns null when there is no nudge marker", () => {
    assert.equal(latestNudgeAt([comment({ body: "unrelated comment" })]), null);
  });
});

describe("isAlreadyQueued", () => {
  it("true for a mergify[bot] Merge Queue Status comment", () => {
    assert.equal(
      isAlreadyQueued([
        comment({ user: { login: MERGIFY_BOT_LOGIN }, body: `# ${QUEUE_STATUS_HEADING}\n...` }),
      ]),
      true
    );
  });

  it("false when the heading comes from a different author", () => {
    assert.equal(
      isAlreadyQueued([
        comment({ user: { login: "someone-else" }, body: `# ${QUEUE_STATUS_HEADING}` }),
      ]),
      false
    );
  });

  it("false when mergify[bot] posts something else entirely", () => {
    assert.equal(
      isAlreadyQueued([comment({ user: { login: MERGIFY_BOT_LOGIN }, body: "unrelated" })]),
      false
    );
  });
});

describe("hasPathExcludedAlert", () => {
  it("true when the marker is present", () => {
    assert.equal(
      hasPathExcludedAlert([comment({ body: `alert\n\n${PATH_EXCLUDED_MARKER}` })]),
      true
    );
  });

  it("false otherwise", () => {
    assert.equal(hasPathExcludedAlert([comment({ body: "unrelated" })]), false);
  });
});

describe("findUnsurfacedRefusal", () => {
  it("returns null when there was no nudge yet", () => {
    assert.equal(
      findUnsurfacedRefusal([comment({ user: { login: MERGIFY_BOT_LOGIN }, body: "no" })], null),
      null
    );
  });

  it("finds a mergify[bot] reply after the nudge that is not the queue-status heading", () => {
    const nudgeAt = new Date("2026-08-29T04:00:00Z");
    const refusal = findUnsurfacedRefusal(
      [
        comment({
          id: 42,
          user: { login: MERGIFY_BOT_LOGIN },
          body: "This pull request cannot be embarked: unmet condition",
          created_at: "2026-08-29T04:05:00Z",
        }),
      ],
      nudgeAt
    );
    assert.deepEqual(refusal, {
      commentId: 42,
      body: "This pull request cannot be embarked: unmet condition",
      createdAt: new Date("2026-08-29T04:05:00Z"),
    });
  });

  it("ignores a mergify[bot] reply BEFORE the nudge", () => {
    const nudgeAt = new Date("2026-08-29T04:00:00Z");
    const refusal = findUnsurfacedRefusal(
      [
        comment({
          user: { login: MERGIFY_BOT_LOGIN },
          body: "old reply",
          created_at: "2026-08-29T03:00:00Z",
        }),
      ],
      nudgeAt
    );
    assert.equal(refusal, null);
  });

  it("treats a Merge Queue Status reply as success, not a refusal", () => {
    const nudgeAt = new Date("2026-08-29T04:00:00Z");
    const refusal = findUnsurfacedRefusal(
      [
        comment({
          user: { login: MERGIFY_BOT_LOGIN },
          body: `# ${QUEUE_STATUS_HEADING}`,
          created_at: "2026-08-29T04:05:00Z",
        }),
      ],
      nudgeAt
    );
    assert.equal(refusal, null);
  });

  it("ignores a reply from a non-mergify author", () => {
    const nudgeAt = new Date("2026-08-29T04:00:00Z");
    const refusal = findUnsurfacedRefusal(
      [
        comment({
          user: { login: "someone" },
          body: "refused",
          created_at: "2026-08-29T04:05:00Z",
        }),
      ],
      nudgeAt
    );
    assert.equal(refusal, null);
  });

  it("excludes a refusal already surfaced (marker names its comment id)", () => {
    const nudgeAt = new Date("2026-08-29T04:00:00Z");
    const refusal = findUnsurfacedRefusal(
      [
        comment({
          id: 42,
          user: { login: MERGIFY_BOT_LOGIN },
          body: "cannot be embarked",
          created_at: "2026-08-29T04:05:00Z",
        }),
        comment({
          user: { login: "github-actions[bot]" },
          body: "surfaced already\n\n<!-- catalyst:merge-queue-watchdog:refusal-surfaced:42 -->",
          created_at: "2026-08-29T04:06:00Z",
        }),
      ],
      nudgeAt
    );
    assert.equal(refusal, null);
  });

  it("picks the earliest unsurfaced refusal when several exist", () => {
    const nudgeAt = new Date("2026-08-29T04:00:00Z");
    const refusal = findUnsurfacedRefusal(
      [
        comment({
          id: 2,
          user: { login: MERGIFY_BOT_LOGIN },
          body: "second",
          created_at: "2026-08-29T04:10:00Z",
        }),
        comment({
          id: 1,
          user: { login: MERGIFY_BOT_LOGIN },
          body: "first",
          created_at: "2026-08-29T04:05:00Z",
        }),
      ],
      nudgeAt
    );
    assert.equal(refusal.commentId, 1);
  });
});

// ── checkStateForContext / requiredChecksConclusion / countUnresolvedThreads ────────────────

describe("checkStateForContext", () => {
  it("success when the named run completed with a satisfying conclusion", () => {
    assert.equal(
      checkStateForContext(
        [{ name: "docs-gate", status: "completed", conclusion: "success" }],
        "docs-gate"
      ),
      "success"
    );
  });

  it("success when the named run completed neutral (skip-tolerant)", () => {
    assert.equal(
      checkStateForContext(
        [{ name: "docs-gate", status: "completed", conclusion: "neutral" }],
        "docs-gate"
      ),
      "success"
    );
  });

  it("success when the named run completed skipped (skip-tolerant)", () => {
    assert.equal(
      checkStateForContext(
        [{ name: "docs-gate", status: "completed", conclusion: "skipped" }],
        "docs-gate"
      ),
      "success"
    );
  });

  it("failure when the named run completed unsuccessfully", () => {
    assert.equal(
      checkStateForContext(
        [{ name: "docs-gate", status: "completed", conclusion: "failure" }],
        "docs-gate"
      ),
      "failure"
    );
  });

  it("pending while the run is still in progress", () => {
    assert.equal(
      checkStateForContext(
        [{ name: "execution-core-unit-tests", status: "in_progress", conclusion: null }],
        "execution-core-unit-tests"
      ),
      "pending"
    );
  });

  it("missing when the named context never ran", () => {
    assert.equal(checkStateForContext([], "docs-gate"), "missing");
  });

  it("ignores runs with a different name", () => {
    assert.equal(
      checkStateForContext(
        [{ name: "lint", status: "completed", conclusion: "success" }],
        "docs-gate"
      ),
      "missing"
    );
  });
});

describe("requiredChecksConclusion — the multi-required-check form (CTL-2285)", () => {
  const ALL_SIX = DEFAULT_CONFIG.requiredCheckContexts;
  const allGreen = (overrides = {}) =>
    ALL_SIX.map((name) => ({
      name,
      status: "completed",
      conclusion: overrides[name] ?? "success",
    }));

  it("success when all six required contexts are success", () => {
    const result = requiredChecksConclusion(allGreen(), ALL_SIX);
    assert.deepEqual(result, { conclusion: "success", detail: "" });
  });

  it("success when one context is neutral and the rest are success", () => {
    const result = requiredChecksConclusion(allGreen({ "docs-gate": "neutral" }), ALL_SIX);
    assert.deepEqual(result, { conclusion: "success", detail: "" });
  });

  it("success when one context is skipped and the rest are success", () => {
    const result = requiredChecksConclusion(allGreen({ gitleaks: "skipped" }), ALL_SIX);
    assert.deepEqual(result, { conclusion: "success", detail: "" });
  });

  it("⭐ pending when one context is still in_progress — the measured CTL-2285 incident shape", () => {
    const runs = ALL_SIX.map((name) =>
      name === "execution-core-unit-tests"
        ? { name, status: "in_progress", conclusion: null }
        : { name, status: "completed", conclusion: "success" }
    );
    const result = requiredChecksConclusion(runs, ALL_SIX);
    assert.equal(result.conclusion, "pending");
    assert.equal(result.detail, "execution-core-unit-tests");
  });

  it("failure takes priority over a simultaneously-pending context", () => {
    const runs = ALL_SIX.map((name) => {
      if (name === "gitleaks") return { name, status: "completed", conclusion: "failure" };
      if (name === "check-versions") return { name, status: "in_progress", conclusion: null };
      return { name, status: "completed", conclusion: "success" };
    });
    const result = requiredChecksConclusion(runs, ALL_SIX);
    assert.equal(result.conclusion, "failure");
    assert.equal(result.detail, "gitleaks");
  });

  it("missing when a required context never ran at all", () => {
    const runs = allGreen().filter((r) => r.name !== "audit-references");
    const result = requiredChecksConclusion(runs, ALL_SIX);
    assert.equal(result.conclusion, "missing");
    assert.equal(result.detail, "audit-references");
  });

  it("names every outstanding context, not just the first, when several are pending", () => {
    const runs = ALL_SIX.map((name) =>
      name === "docs-gate" || name === "gitleaks"
        ? { name, status: "in_progress", conclusion: null }
        : { name, status: "completed", conclusion: "success" }
    );
    const result = requiredChecksConclusion(runs, ALL_SIX);
    assert.equal(result.conclusion, "pending");
    assert.equal(result.detail, "docs-gate, gitleaks");
  });
});

describe("countUnresolvedThreads", () => {
  it("counts only the unresolved ones", () => {
    assert.equal(
      countUnresolvedThreads([{ isResolved: true }, { isResolved: false }, { isResolved: false }]),
      2
    );
  });

  it("zero when empty", () => {
    assert.equal(countUnresolvedThreads([]), 0);
  });
});

// ── decideAction — the whole state machine, table-driven ────────────────────────────────────

function baseInput(overrides = {}) {
  return {
    number: 100,
    baseRef: "main",
    isDraft: false,
    labels: ["queue:ready"],
    changedFiles: ["scripts/merge-queue-watchdog.mjs"],
    checkConclusion: "success",
    checkDetail: "",
    unresolvedThreadCount: 0,
    labeledAt: new Date("2026-08-29T04:15:00Z"), // 15m before NOW — past the 10m threshold
    alreadyQueued: false,
    lastNudgeAt: null,
    pathExcludedAlertAlreadyPosted: false,
    refusal: null,
    ...overrides,
  };
}

describe("decideAction", () => {
  it("none when base is not main", () => {
    const action = decideAction(baseInput({ baseRef: "release" }), config, [], NOW);
    assert.equal(action.type, "none");
  });

  it("none when the PR is a draft", () => {
    const action = decideAction(baseInput({ isDraft: true }), config, [], NOW);
    assert.equal(action.type, "none");
  });

  it("none when queue:ready is missing", () => {
    const action = decideAction(baseInput({ labels: [] }), config, [], NOW);
    assert.equal(action.type, "none");
  });

  it("alert-path-excluded when changed files match an exclusion pattern", () => {
    const patterns = parsePathExclusionPatterns("      - -files~=^\\.mergify\\.yml$\n");
    const action = decideAction(
      baseInput({ changedFiles: [".mergify.yml"] }),
      config,
      patterns,
      NOW
    );
    assert.equal(action.type, "alert-path-excluded");
  });

  it("none (already alerted) when path-excluded and the alert marker is already posted", () => {
    const patterns = parsePathExclusionPatterns("      - -files~=^\\.mergify\\.yml$\n");
    const action = decideAction(
      baseInput({ changedFiles: [".mergify.yml"], pathExcludedAlertAlreadyPosted: true }),
      config,
      patterns,
      NOW
    );
    assert.deepEqual(action, { type: "none", reason: "path-excluded; already alerted" });
  });

  it("none (already alerted) when path-excluded and hold:hand-steps is already on the PR", () => {
    const patterns = parsePathExclusionPatterns("      - -files~=^\\.mergify\\.yml$\n");
    const action = decideAction(
      baseInput({ changedFiles: [".mergify.yml"], labels: ["queue:ready", "hold:hand-steps"] }),
      config,
      patterns,
      NOW
    );
    assert.equal(action.type, "none");
  });

  it("none when hold:hand-steps is present (manual protocol, not path-excluded)", () => {
    const action = decideAction(
      baseInput({ labels: ["queue:ready", "hold:hand-steps"] }),
      config,
      [],
      NOW
    );
    assert.deepEqual(action, { type: "none", reason: "hold:hand-steps present — manual protocol" });
  });

  it("none when already queued", () => {
    const action = decideAction(baseInput({ alreadyQueued: true }), config, [], NOW);
    assert.equal(action.type, "none");
    assert.ok(action.reason.includes("already queued"));
  });

  it("surface-refusal when Mergify replied without queuing", () => {
    const refusal = { commentId: 7, body: "nope", createdAt: new Date("2026-08-29T04:20:00Z") };
    const action = decideAction(baseInput({ refusal }), config, [], NOW);
    assert.deepEqual(action, {
      type: "surface-refusal",
      reason: "Mergify replied to our nudge without queuing",
      refusal,
    });
  });

  it("none when the required checks are failing", () => {
    const action = decideAction(
      baseInput({ checkConclusion: "failure", checkDetail: "gitleaks" }),
      config,
      [],
      NOW
    );
    assert.equal(action.type, "none");
    assert.ok(action.reason.includes("gitleaks"));
  });

  it("⭐ none when the required checks are pending, naming the outstanding context (CTL-2285 incident shape)", () => {
    const action = decideAction(
      baseInput({ checkConclusion: "pending", checkDetail: "execution-core-unit-tests" }),
      config,
      [],
      NOW
    );
    assert.equal(action.type, "none");
    assert.ok(action.reason.includes("execution-core-unit-tests"));
    assert.ok(action.reason.includes("pending"));
  });

  it("none when there are unresolved review threads", () => {
    const action = decideAction(baseInput({ unresolvedThreadCount: 2 }), config, [], NOW);
    assert.equal(action.type, "none");
    assert.ok(action.reason.includes("unresolved"));
  });

  it("none when labeledAt could not be determined", () => {
    const action = decideAction(baseInput({ labeledAt: null }), config, [], NOW);
    assert.equal(action.type, "none");
  });

  it("none when still inside the eligibility window", () => {
    const action = decideAction(
      baseInput({ labeledAt: new Date("2026-08-29T04:25:00Z") }), // 5m before NOW
      config,
      [],
      NOW
    );
    assert.equal(action.type, "none");
    assert.ok(action.reason.includes("waiting"));
  });

  it("none (cooldown) when nudged recently and still not queued", () => {
    const action = decideAction(
      baseInput({ lastNudgeAt: new Date("2026-08-29T04:20:00Z") }), // 10m before NOW; cooldown 20m
      config,
      [],
      NOW
    );
    assert.equal(action.type, "none");
    assert.ok(action.reason.includes("cooldown"));
  });

  it("nudge once the eligibility window has elapsed and no nudge is on record", () => {
    const action = decideAction(baseInput(), config, [], NOW);
    assert.equal(action.type, "nudge");
  });

  it("nudge again once the cooldown has elapsed and the PR is still not queued", () => {
    const action = decideAction(
      baseInput({ lastNudgeAt: new Date("2026-08-29T04:09:00Z") }), // 21m before NOW; cooldown 20m
      config,
      [],
      NOW
    );
    assert.equal(action.type, "nudge");
  });
});

// ── gatherPrInput / runOnce — a fake GithubClient, no fetch ────────────────────────────────

function fakeClient(overrides = {}) {
  return {
    listOpenPrsWithLabel: async () => [],
    listChangedFiles: async () => [],
    listCheckRuns: async () =>
      DEFAULT_CONFIG.requiredCheckContexts.map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
      })),
    listUnresolvedThreadCount: async () => 0,
    listLabelTimeline: async () => [
      { event: "labeled", label: { name: "queue:ready" }, created_at: "2026-08-29T04:15:00Z" },
    ],
    listComments: async () => [],
    postComment: async () => {},
    swapLabels: async () => {},
    ...overrides,
  };
}

describe("gatherPrInput", () => {
  it("combines the client's reads into the decision-core shape", async () => {
    const pr = {
      number: 100,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "abc123",
    };
    const input = await gatherPrInput(fakeClient(), pr, config);
    assert.equal(input.checkConclusion, "success");
    assert.equal(input.checkDetail, "");
    assert.deepEqual(input.labeledAt, new Date("2026-08-29T04:15:00Z"));
    assert.equal(input.alreadyQueued, false);
  });

  it("surfaces the pending context through to checkDetail", async () => {
    const pr = {
      number: 101,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "def456",
    };
    const runs = DEFAULT_CONFIG.requiredCheckContexts.map((name) =>
      name === "execution-core-unit-tests"
        ? { name, status: "in_progress", conclusion: null }
        : { name, status: "completed", conclusion: "success" }
    );
    const input = await gatherPrInput(fakeClient({ listCheckRuns: async () => runs }), pr, config);
    assert.equal(input.checkConclusion, "pending");
    assert.equal(input.checkDetail, "execution-core-unit-tests");
  });
});

describe("runOnce", () => {
  it("posts the nudge comment (with marker) for an eligible PR and counts it", async () => {
    const posted = [];
    const pr = {
      number: 200,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "sha1",
    };
    const client = fakeClient({
      listOpenPrsWithLabel: async () => [pr],
      postComment: async (number, body) => {
        posted.push({ number, body });
      },
    });
    const summary = await runOnce(client, config, "queue_rules: []\n", NOW, () => {});
    assert.deepEqual(summary, {
      processed: 1,
      nudged: 1,
      alertedPathExcluded: 0,
      refusalsSurfaced: 0,
      errors: 0,
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].number, 200);
    assert.ok(posted[0].body.includes("@Mergifyio queue"));
    assert.ok(posted[0].body.includes(NUDGE_MARKER));
  });

  it("does not nudge while a required check is still pending (CTL-2285 incident, reproduced end-to-end)", async () => {
    const posted = [];
    const pr = {
      number: 205,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "sha6",
    };
    const runs = DEFAULT_CONFIG.requiredCheckContexts.map((name) =>
      name === "execution-core-unit-tests"
        ? { name, status: "in_progress", conclusion: null }
        : { name, status: "completed", conclusion: "success" }
    );
    const client = fakeClient({
      listOpenPrsWithLabel: async () => [pr],
      listCheckRuns: async () => runs,
      postComment: async (_n, body) => {
        posted.push(body);
      },
    });
    const summary = await runOnce(client, config, "queue_rules: []\n", NOW, () => {});
    assert.equal(summary.nudged, 0);
    assert.equal(posted.length, 0);
  });

  it("alerts and swaps labels for a path-excluded PR", async () => {
    const posted = [];
    const swapped = [];
    const pr = {
      number: 201,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "sha2",
    };
    const client = fakeClient({
      listOpenPrsWithLabel: async () => [pr],
      listChangedFiles: async () => [".mergify.yml"],
      postComment: async (_n, body) => {
        posted.push(body);
      },
      swapLabels: async (number, removeLabel, addLabel) => {
        swapped.push({ number, remove: removeLabel, add: addLabel });
      },
    });
    const mergifyYaml = "      - -files~=^\\.mergify\\.yml$\n";
    const summary = await runOnce(client, config, mergifyYaml, NOW, () => {});
    assert.equal(summary.alertedPathExcluded, 1);
    assert.ok(posted[0].includes(PATH_EXCLUDED_MARKER));
    assert.deepEqual(swapped, [{ number: 201, remove: "queue:ready", add: "hold:hand-steps" }]);
  });

  it("⭐ a failed label swap leaves the marker unposted, so the PR is retried next run", async () => {
    const posted = [];
    const pr = {
      number: 201,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "sha2",
    };
    const client = fakeClient({
      listOpenPrsWithLabel: async () => [pr],
      listChangedFiles: async () => [".mergify.yml"],
      postComment: async (_n, body) => {
        posted.push(body);
      },
      swapLabels: async () => {
        throw new Error("github 500");
      },
    });
    const mergifyYaml = "      - -files~=^\\.mergify\\.yml$\n";
    const summary = await runOnce(client, config, mergifyYaml, NOW, () => {});
    assert.equal(summary.errors, 1);
    assert.equal(summary.alertedPathExcluded, 0);
    assert.deepEqual(posted, []);
  });

  it("surfaces a refusal without re-nudging", async () => {
    const posted = [];
    const pr = {
      number: 202,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "sha3",
    };
    const client = fakeClient({
      listOpenPrsWithLabel: async () => [pr],
      listComments: async () => [
        comment({
          user: { login: "github-actions[bot]" },
          body: NUDGE_MARKER,
          created_at: "2026-08-29T04:00:00Z",
        }),
        comment({
          id: 55,
          user: { login: MERGIFY_BOT_LOGIN },
          body: "This pull request cannot be embarked",
          created_at: "2026-08-29T04:05:00Z",
        }),
      ],
      postComment: async (_n, body) => {
        posted.push(body);
      },
    });
    const summary = await runOnce(client, config, "queue_rules: []\n", NOW, () => {});
    assert.equal(summary.refusalsSurfaced, 1);
    assert.equal(summary.nudged, 0);
    assert.ok(posted[0].includes("cannot be embarked"));
    assert.ok(posted[0].includes("refusal-surfaced:55"));
  });

  it("one PR's failure does not stop the batch, and is counted as an error", async () => {
    const goodPr = {
      number: 203,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "sha4",
    };
    const badPr = {
      number: 204,
      baseRef: "main",
      isDraft: false,
      labels: ["queue:ready"],
      headSha: "sha5",
    };
    const posted = [];
    let call = 0;
    const client = fakeClient({
      listOpenPrsWithLabel: async () => [badPr, goodPr],
      listChangedFiles: async () => {
        call++;
        if (call === 1) throw new Error("github 500");
        return [];
      },
      postComment: async (number) => {
        posted.push(number);
      },
    });
    const summary = await runOnce(client, config, "queue_rules: []\n", NOW, () => {});
    assert.equal(summary.processed, 2);
    assert.equal(summary.errors, 1);
    assert.equal(summary.nudged, 1);
    assert.deepEqual(posted, [203]);
  });

  it("stays quiet when no PR carries the ready label", async () => {
    const summary = await runOnce(fakeClient(), config, "queue_rules: []\n", NOW, () => {});
    assert.deepEqual(summary, {
      processed: 0,
      nudged: 0,
      alertedPathExcluded: 0,
      refusalsSurfaced: 0,
      errors: 0,
    });
  });
});

// ── makeGithubClient — the real HTTP client, exercised over a fake fetch ─────────────────────

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

describe("makeGithubClient", () => {
  it("⭐ paginates changed files past the first page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `src/file${i}.ts` }));
    const page2 = [{ filename: "plugins/dev/scripts/db-migrations/0002.sql" }];
    const fetchImpl = fakeFetch((url) => {
      const page = new URL(url).searchParams.get("page");
      if (page === "1") return new Response(JSON.stringify(page1), { status: 200 });
      if (page === "2") return new Response(JSON.stringify(page2), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const client = makeGithubClient("token", "coalesce-labs", "catalyst", fetchImpl);
    const files = await client.listChangedFiles(1);
    assert.equal(files.length, 101);
    assert.ok(files.includes("plugins/dev/scripts/db-migrations/0002.sql"));
  });

  it("⭐ paginates issue comments past the first page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      user: { login: "someone" },
      body: `comment ${i}`,
      created_at: "2026-08-29T00:00:00Z",
    }));
    const page2 = [
      {
        id: 999,
        user: { login: MERGIFY_BOT_LOGIN },
        body: QUEUE_STATUS_HEADING,
        created_at: NOW.toISOString(),
      },
    ];
    const fetchImpl = fakeFetch((url) => {
      const page = new URL(url).searchParams.get("page");
      if (page === "1") return new Response(JSON.stringify(page1), { status: 200 });
      if (page === "2") return new Response(JSON.stringify(page2), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const client = makeGithubClient("token", "coalesce-labs", "catalyst", fetchImpl);
    const comments = await client.listComments(1);
    assert.equal(comments.length, 101);
    assert.equal(isAlreadyQueued(comments), true);
  });

  it("⭐ paginates review threads past the first GraphQL page", async () => {
    let call = 0;
    const fetchImpl = fakeFetch((url) => {
      assert.equal(url, "https://api.github.com/graphql");
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: Array.from({ length: 100 }, () => ({ isResolved: true })),
                    pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                  },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ isResolved: false }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
        { status: 200 }
      );
    });
    const client = makeGithubClient("token", "coalesce-labs", "catalyst", fetchImpl);
    const count = await client.listUnresolvedThreadCount(1);
    assert.equal(call, 2);
    assert.equal(count, 1);
  });

  it("⭐ swapLabels adds the new label BEFORE removing the old one", async () => {
    const calls = [];
    const fetchImpl = fakeFetch((url, init) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const client = makeGithubClient("token", "coalesce-labs", "catalyst", fetchImpl);
    await client.swapLabels(1, "queue:ready", "hold:hand-steps");
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0],
      "POST https://api.github.com/repos/coalesce-labs/catalyst/issues/1/labels"
    );
    assert.equal(
      calls[1],
      "DELETE https://api.github.com/repos/coalesce-labs/catalyst/issues/1/labels/queue%3Aready"
    );
  });
});

describe("main", () => {
  it("exits 1 when GITHUB_TOKEN is not set", async () => {
    const result = await main([], { env: {} });
    assert.equal(result.exitCode, 1);
  });

  it("nudges an eligible PR end-to-end over a fake GitHub API and writes a step summary", async () => {
    const logs = [];
    const summaries = [];
    const posted = [];

    const labeledAt = new Date(NOW.getTime() - 15 * 60_000).toISOString();

    const fetchImpl = fakeFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (
        url === "https://api.github.com/repos/coalesce-labs/catalyst/pulls?state=open&per_page=100"
      ) {
        return new Response(
          JSON.stringify([
            {
              number: 300,
              draft: false,
              base: { ref: "main" },
              head: { sha: "deadbeef" },
              labels: [{ name: "queue:ready" }],
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes("/pulls/300/files")) {
        return new Response(JSON.stringify([{ filename: "scripts/merge-queue-watchdog.mjs" }]), {
          status: 200,
        });
      }
      if (url.includes("/commits/deadbeef/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: DEFAULT_CONFIG.requiredCheckContexts.map((name) => ({
              name,
              status: "completed",
              conclusion: "success",
            })),
          }),
          { status: 200 }
        );
      }
      if (url === "https://api.github.com/graphql") {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/issues/300/timeline")) {
        return new Response(
          JSON.stringify([
            { event: "labeled", label: { name: "queue:ready" }, created_at: labeledAt },
          ]),
          { status: 200 }
        );
      }
      if (url.includes("/issues/300/comments") && method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/issues/300/comments") && method === "POST") {
        posted.push({ url, body: JSON.parse(String(init?.body)).body });
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const result = await main([], {
      env: { GITHUB_TOKEN: "test-token", GITHUB_STEP_SUMMARY: "/tmp/does-not-matter" },
      fetchImpl,
      now: NOW,
      log: (l) => logs.push(l),
      readMergifyYaml: () => "queue_rules: []\n",
      writeStepSummary: (text) => summaries.push(text),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(posted.length, 1);
    assert.ok(posted[0].body.includes("@Mergifyio queue"));
    assert.equal(summaries.length, 1);
    assert.ok(summaries[0].includes("Nudged: 1"));
    assert.ok(logs.some((l) => l.includes("nudge")));
  });
});
