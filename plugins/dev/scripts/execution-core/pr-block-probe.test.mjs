// pr-block-probe.test.mjs — Unit tests for CTL-1496 PR-block probe.
//
// Run: cd plugins/dev/scripts/execution-core && bun test pr-block-probe.test.mjs

import { describe, test, expect } from "bun:test";
import { defaultProbePrBlock, isFailingState } from "./pr-block-probe.mjs";

// fakeGh routes by longest matching pattern first so specific patterns
// (e.g. "pr view 42 --json reviews") win over generic ones ("pr list").
// The PR is resolved via `gh pr list` (head branch or ticket-in-title search) —
// never a bare `gh pr view` on the daemon's current branch (CTL-1496).
function makeGh(routes) {
  const sorted = [...routes].sort((a, b) => b[0].length - a[0].length);
  return (args) => {
    const key = args.join(" ");
    for (const [pat, out] of sorted) {
      if (key.includes(pat)) {
        if (out instanceof Error) throw out;
        return typeof out === "string" ? out : JSON.stringify(out);
      }
    }
    throw new Error(`unrouted gh: ${key}`);
  };
}

const EMPTY_THREADS = {
  data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
};

describe("defaultProbePrBlock — PR resolution contract (CTL-1496)", () => {
  test("resolves by ticket-in-title search when no branch is threaded", () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args.join(" "));
      const key = args.join(" ");
      if (key.startsWith("pr list"))
        return JSON.stringify([
          { number: 42, state: "OPEN", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", statusCheckRollup: [] },
        ]);
      if (key.includes("api graphql")) return JSON.stringify(EMPTY_THREADS);
      if (key.includes("pr view 42 --json reviews")) return JSON.stringify({ reviews: [] });
      throw new Error(`unrouted gh: ${key}`);
    };
    const r = defaultProbePrBlock("CTL-99", { gh, repo: "o/r" });
    expect(r.prNumber).toBe(42);
    // The resolution call must NOT be a bare `pr view` (daemon current branch);
    // it must select by the ticket id in the PR title.
    const resolveCall = calls.find((c) => c.startsWith("pr list"));
    expect(resolveCall).toContain("--search");
    expect(resolveCall).toContain("CTL-99 in:title");
    expect(resolveCall).not.toMatch(/^pr view/);
  });

  test("resolves by --head <branch> when the branch is threaded", () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args.join(" "));
      const key = args.join(" ");
      if (key.startsWith("pr list"))
        return JSON.stringify([
          { number: 7, state: "OPEN", mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", statusCheckRollup: [] },
        ]);
      if (key.includes("api graphql")) return JSON.stringify(EMPTY_THREADS);
      if (key.includes("pr view 7 --json reviews")) return JSON.stringify({ reviews: [] });
      throw new Error(`unrouted gh: ${key}`);
    };
    const r = defaultProbePrBlock("CTL-99", { gh, repo: "o/r", branch: "ryan/ctl-99-slug" });
    expect(r.prNumber).toBe(7);
    const resolveCall = calls.find((c) => c.startsWith("pr list"));
    expect(resolveCall).toContain("--head ryan/ctl-99-slug");
    expect(resolveCall).not.toContain("--search");
  });
});

describe("defaultProbePrBlock", () => {
  test("no PR for ticket → { prNumber: null }", () => {
    const gh = makeGh([["pr list", []]]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.prNumber).toBeNull();
  });

  test("BLOCKED PR with one failing required check → failingChecks length 1", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 42,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [
              { name: "quality", state: "FAILURE", detailsUrl: "u" },
              { name: "unit", state: "SUCCESS" },
            ],
          },
        ],
      ],
      ["api graphql", EMPTY_THREADS],
      ["pr view 42 --json reviews", { reviews: [] }],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.prNumber).toBe(42);
    expect(r.failingChecks.map((c) => c.name)).toEqual(["quality"]);
    expect(r.unresolvedBotThreads).toHaveLength(0);
    expect(r.hasChangesRequested).toBe(false);
  });

  test("green PR with one unresolved bot thread → unresolvedBotThreads length 1", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 43,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [{ name: "quality", state: "SUCCESS" }],
          },
        ],
      ],
      [
        "api graphql",
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "T1",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            body: "[P2] tighten this",
                            path: "a.ts",
                            line: 3,
                            author: {
                              login: "chatgpt-codex-connector[bot]",
                              __typename: "Bot",
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      ["pr view 43 --json reviews", { reviews: [] }],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.unresolvedBotThreads).toHaveLength(1);
    expect(r.unresolvedBotThreads[0].id).toBe("T1");
    expect(r.unresolvedHumanThreads).toHaveLength(0);
  });

  test("human CHANGES_REQUESTED → hasChangesRequested true + human thread captured", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 44,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [],
            reviewDecision: "CHANGES_REQUESTED",
          },
        ],
      ],
      [
        "api graphql",
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "H1",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            body: "please redesign",
                            path: "b.ts",
                            line: 9,
                            author: { login: "ryan", __typename: "User" },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      [
        "pr view 44 --json reviews",
        {
          reviews: [{ author: { login: "ryan" }, state: "CHANGES_REQUESTED" }],
        },
      ],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.hasChangesRequested).toBe(true);
    expect(r.unresolvedHumanThreads).toHaveLength(1);
  });

  test("already merged / clean → mergeStateStatus reflects it, no blockers", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 45,
            state: "OPEN",
            mergeStateStatus: "CLEAN",
            mergeable: "MERGEABLE",
            statusCheckRollup: [{ name: "quality", state: "SUCCESS" }],
          },
        ],
      ],
      ["api graphql", EMPTY_THREADS],
      ["pr view 45 --json reviews", { reviews: [] }],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.mergeStateStatus).toBe("CLEAN");
    expect(r.failingChecks).toHaveLength(0);
    expect(r.unresolvedBotThreads).toHaveLength(0);
  });

  test("gh failure → throws (caller treats as transient)", () => {
    const gh = makeGh([["pr list", new Error("gh: network")]]);
    expect(() => defaultProbePrBlock("CTL-1", { gh, repo: "o/r" })).toThrow();
  });

  test("bot author detected by [bot] suffix (not just __typename)", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 46,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [],
          },
        ],
      ],
      [
        "api graphql",
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "B1",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            body: "fix this",
                            path: "c.ts",
                            line: 5,
                            author: { login: "some-bot[bot]", __typename: "User" },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      ["pr view 46 --json reviews", { reviews: [] }],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.unresolvedBotThreads).toHaveLength(1);
    expect(r.unresolvedHumanThreads).toHaveLength(0);
  });

  test("already-resolved threads are excluded", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 47,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [],
          },
        ],
      ],
      [
        "api graphql",
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "R1",
                      isResolved: true,
                      comments: {
                        nodes: [
                          {
                            body: "already resolved",
                            path: "d.ts",
                            line: 1,
                            author: {
                              login: "chatgpt-codex-connector[bot]",
                              __typename: "Bot",
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      ["pr view 47 --json reviews", { reviews: [] }],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.unresolvedBotThreads).toHaveLength(0);
    expect(r.unresolvedHumanThreads).toHaveLength(0);
  });

  test("re-APPROVED PR (reviewDecision APPROVED) → hasChangesRequested false despite past CHANGES_REQUESTED", () => {
    // CTL-1496 high finding: the aggregate reviewDecision, not raw review
    // history, drives hasChangesRequested — so a fixed-then-re-approved PR is
    // not stale-flagged and false-escalated to a human.
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 48,
            state: "OPEN",
            mergeStateStatus: "CLEAN",
            mergeable: "MERGEABLE",
            statusCheckRollup: [],
            reviewDecision: "APPROVED",
          },
        ],
      ],
      ["api graphql", EMPTY_THREADS],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.hasChangesRequested).toBe(false);
  });

  test("partial/errored review-threads GraphQL (pullRequest null) → throws (caller defers)", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 49,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [],
          },
        ],
      ],
      // HTTP-200 body with a field-level error: data present but pullRequest null.
      ["api graphql", { data: { repository: { pullRequest: null } }, errors: [{ message: "x" }] }],
    ]);
    expect(() => defaultProbePrBlock("CTL-1", { gh, repo: "o/r" })).toThrow();
  });

  test("unresolved thread with no first comment → counted as neither bot nor human", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 50,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [],
          },
        ],
      ],
      [
        "api graphql",
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [{ id: "X1", isResolved: false, comments: { nodes: [] } }],
                },
              },
            },
          },
        },
      ],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.unresolvedBotThreads).toHaveLength(0);
    expect(r.unresolvedHumanThreads).toHaveLength(0);
  });
});

describe("CTL-1496 remediation — probe hardening (Codex review)", () => {
  // P1: the PR lookup must be scoped to the ticket's repo (-R owner/name), not
  // resolved against the daemon's cwd/current branch.
  test("gh pr list is scoped with -R <owner>/<name>", () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args.join(" "));
      const key = args.join(" ");
      if (key.startsWith("pr list"))
        return JSON.stringify([
          { number: 61, state: "OPEN", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", statusCheckRollup: [] },
        ]);
      if (key.includes("api graphql")) return JSON.stringify(EMPTY_THREADS);
      throw new Error(`unrouted gh: ${key}`);
    };
    const r = defaultProbePrBlock("CTL-9", { gh, repo: "acme/widgets" });
    expect(r.prNumber).toBe(61);
    const resolveCall = calls.find((c) => c.startsWith("pr list"));
    expect(resolveCall).toContain("-R acme/widgets");
  });

  // P2: ACTION_REQUIRED and STARTUP_FAILURE are genuine CI failure states.
  test("isFailingState treats ACTION_REQUIRED and STARTUP_FAILURE as failing", () => {
    expect(isFailingState("ACTION_REQUIRED")).toBe(true);
    expect(isFailingState("STARTUP_FAILURE")).toBe(true);
    // sanity: still passes the previously-covered states and excludes success
    expect(isFailingState("FAILURE")).toBe(true);
    expect(isFailingState("SUCCESS")).toBe(false);
    expect(isFailingState("PENDING")).toBe(false);
  });

  test("ACTION_REQUIRED check surfaces in failingChecks", () => {
    const gh = makeGh([
      [
        "pr list",
        [
          {
            number: 62,
            state: "OPEN",
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            statusCheckRollup: [
              { name: "deploy-gate", state: "ACTION_REQUIRED", detailsUrl: "u" },
              { name: "unit", state: "SUCCESS" },
            ],
          },
        ],
      ],
      ["api graphql", EMPTY_THREADS],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.failingChecks.map((c) => c.name)).toEqual(["deploy-gate"]);
  });

  // P2: walk every review-thread page — a thread beyond the first page is not
  // silently dropped. Here page 2 carries an unresolved HUMAN thread.
  test("paginates review threads across pages (page-2 human thread captured)", () => {
    const gh = (args) => {
      const key = args.join(" ");
      if (key.startsWith("pr list"))
        return JSON.stringify([
          { number: 63, state: "OPEN", mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", statusCheckRollup: [] },
        ]);
      if (key.includes("api graphql")) {
        const onPage2 = key.includes("after=CURSOR1");
        if (!onPage2) {
          return JSON.stringify({
            data: { repository: { pullRequest: { reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "CURSOR1" },
              nodes: [
                { id: "BOT1", isResolved: false, comments: { nodes: [
                  { body: "[P3] nit", path: "a.ts", line: 1, author: { login: "codex[bot]", __typename: "Bot" } },
                ] } },
              ],
            } } } },
          });
        }
        return JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { id: "HUMAN1", isResolved: false, comments: { nodes: [
                { body: "please rethink", path: "z.ts", line: 9, author: { login: "ryan", __typename: "User" } },
              ] } },
            ],
          } } } },
        });
      }
      throw new Error(`unrouted gh: ${key}`);
    };
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.unresolvedBotThreads.map((t) => t.id)).toEqual(["BOT1"]);
    expect(r.unresolvedHumanThreads.map((t) => t.id)).toEqual(["HUMAN1"]);
  });

  // P2: an endlessly-paging response is refused rather than yielding a partial
  // (possibly human-thread-omitting) set.
  test("refuses when review threads exceed the page cap", () => {
    const gh = (args) => {
      const key = args.join(" ");
      if (key.startsWith("pr list"))
        return JSON.stringify([
          { number: 64, state: "OPEN", mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", statusCheckRollup: [] },
        ]);
      if (key.includes("api graphql"))
        // Always claims another page → drives the cap.
        return JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "C" },
            nodes: [],
          } } } },
        });
      throw new Error(`unrouted gh: ${key}`);
    };
    expect(() => defaultProbePrBlock("CTL-1", { gh, repo: "o/r" })).toThrow(/page/);
  });
});
