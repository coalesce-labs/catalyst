// pr-block-probe.test.mjs — Unit tests for CTL-1496 PR-block probe.
//
// Run: cd plugins/dev/scripts/execution-core && bun test pr-block-probe.test.mjs

import { describe, test, expect } from "bun:test";
import { defaultProbePrBlock } from "./pr-block-probe.mjs";

// fakeGh routes by longest matching pattern first so specific patterns
// (e.g. "pr view 42 --json reviews") win over generic ones ("pr view").
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

describe("defaultProbePrBlock", () => {
  test("no PR for ticket → { prNumber: null }", () => {
    const gh = makeGh([
      ["pr view", {}],
    ]);
    const r = defaultProbePrBlock("CTL-1", { gh, repo: "o/r" });
    expect(r.prNumber).toBeNull();
  });

  test("BLOCKED PR with one failing required check → failingChecks length 1", () => {
    const gh = makeGh([
      [
        "pr view",
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
        "pr view",
        {
          number: 43,
          state: "OPEN",
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ name: "quality", state: "SUCCESS" }],
        },
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
        "pr view",
        {
          number: 44,
          state: "OPEN",
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
        },
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
        "pr view",
        {
          number: 45,
          state: "OPEN",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ name: "quality", state: "SUCCESS" }],
        },
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
    const gh = makeGh([["pr view", new Error("gh: network")]]);
    expect(() => defaultProbePrBlock("CTL-1", { gh, repo: "o/r" })).toThrow();
  });

  test("bot author detected by [bot] suffix (not just __typename)", () => {
    const gh = makeGh([
      [
        "pr view",
        {
          number: 46,
          state: "OPEN",
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
        },
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
        "pr view",
        {
          number: 47,
          state: "OPEN",
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
          statusCheckRollup: [],
        },
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
});
