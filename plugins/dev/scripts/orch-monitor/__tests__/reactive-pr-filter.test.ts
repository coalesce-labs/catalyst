import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildEventLogEnvelope } from "../lib/webhook-handler";
import type { AppendableEvent } from "../lib/event-log";

/**
 * Validates that the canonical "Reactive PR lifecycle" disjunctive jq filter
 * documented in `plugins/dev/skills/monitor-events/SKILL.md` (Pattern 3, CTL-228)
 * matches the right events and rejects the wrong ones, against fixture
 * envelopes built from the actual `buildEventLogEnvelope` mapper.
 *
 * Skips silently if `jq` is not on PATH.
 */

const JQ_PATH = (() => {
  const r = spawnSync("jq", ["--version"], { stdio: "ignore" });
  return r.status === 0 ? "jq" : null;
})();

function jqSelect(filter: string, envelope: AppendableEvent): string {
  if (JQ_PATH === null) throw new Error("jq not available");
  const r = spawnSync(JQ_PATH, ["-c", `select(${filter})`], {
    input: JSON.stringify(envelope) + "\n",
    encoding: "utf8",
  });
  if (r.status !== 0 && r.status !== 1) {
    // jq exit 1 with no output is the normal "no match" path; anything
    // else is a real error (e.g. filter parse failure).
    throw new Error(`jq exited ${r.status}: ${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").trim();
}

function expectMatch(filter: string, envelope: AppendableEvent): void {
  const out = jqSelect(filter, envelope);
  expect(out.length).toBeGreaterThan(0);
}

function expectNoMatch(filter: string, envelope: AppendableEvent): void {
  const out = jqSelect(filter, envelope);
  expect(out).toBe("");
}

const PR = 42;
const BASE = "main";

const REACTIVE_FILTER = `
  (.event == "github.pr.merged" and .scope.pr == ${PR}) or
  (.event == "github.pr.closed" and .scope.pr == ${PR}) or
  (.event == "github.check_suite.completed"
     and (.detail.prNumbers // [] | index(${PR}) != null)
     and (.detail.conclusion == "failure" or .detail.conclusion == "timed_out")) or
  (.event == "github.pr_review.submitted"
     and .scope.pr == ${PR}
     and .detail.state == "changes_requested") or
  (.event == "github.push" and .scope.ref == "refs/heads/${BASE}")
`;

describe.skipIf(JQ_PATH === null)(
  "reactive PR lifecycle filter",
  () => {
    it("matches github.pr.merged for the target PR", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "pull_request",
          repo: "o/r",
          number: PR,
          action: "closed",
          merged: true,
          mergedAt: "2026-05-04T00:00:00Z",
          draft: false,
          mergeable: true,
        },
        "del-1",
      )!;
      expect(env.event).toBe("github.pr.merged");
      expectMatch(REACTIVE_FILTER, env);
    });

    it("does NOT match github.pr.merged for a different PR", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "pull_request",
          repo: "o/r",
          number: 99,
          action: "closed",
          merged: true,
          mergedAt: "2026-05-04T00:00:00Z",
          draft: false,
          mergeable: true,
        },
        "del-2",
      )!;
      expectNoMatch(REACTIVE_FILTER, env);
    });

    it("matches check_suite.completed with conclusion=failure on target PR", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "check_suite",
          repo: "o/r",
          prNumbers: [PR, 43],
          conclusion: "failure",
          status: "completed",
        },
        "del-3",
      )!;
      expectMatch(REACTIVE_FILTER, env);
    });

    it("does NOT match check_suite.completed with conclusion=success", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "check_suite",
          repo: "o/r",
          prNumbers: [PR],
          conclusion: "success",
          status: "completed",
        },
        "del-4",
      )!;
      expectNoMatch(REACTIVE_FILTER, env);
    });

    it("does NOT match check_suite.completed when target PR is not in prNumbers", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "check_suite",
          repo: "o/r",
          prNumbers: [99, 100],
          conclusion: "failure",
          status: "completed",
        },
        "del-5",
      )!;
      expectNoMatch(REACTIVE_FILTER, env);
    });

    it("matches pr_review.submitted with state=changes_requested", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "pull_request_review",
          repo: "o/r",
          number: PR,
          action: "submitted",
          reviewState: "changes_requested",
          reviewer: "alice",
          body: "fix",
          author: { login: "alice", type: "User" },
        },
        "del-6",
      )!;
      expectMatch(REACTIVE_FILTER, env);
    });

    it("does NOT match pr_review.submitted with state=approved", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "pull_request_review",
          repo: "o/r",
          number: PR,
          action: "submitted",
          reviewState: "approved",
          reviewer: "alice",
          body: "lgtm",
          author: { login: "alice", type: "User" },
        },
        "del-7",
      )!;
      expectNoMatch(REACTIVE_FILTER, env);
    });

    it("matches push to the configured base branch", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "push",
          repo: "o/r",
          ref: `refs/heads/${BASE}`,
          baseSha: "aaa",
          headSha: "bbb",
          commits: [],
        },
        "del-8",
      )!;
      expectMatch(REACTIVE_FILTER, env);
    });

    it("does NOT match push to a feature branch", () => {
      const env = buildEventLogEnvelope(
        {
          kind: "push",
          repo: "o/r",
          ref: "refs/heads/feat/x",
          baseSha: "aaa",
          headSha: "bbb",
          commits: [],
        },
        "del-9",
      )!;
      expectNoMatch(REACTIVE_FILTER, env);
    });

    describe("bot vs human author heuristic", () => {
      const BOT_FILTER =
        '.event == "github.pr_review.submitted" and .detail.author.type == "Bot"';

      it("matches a bot-authored review", () => {
        const env = buildEventLogEnvelope(
          {
            kind: "pull_request_review",
            repo: "o/r",
            number: PR,
            action: "submitted",
            reviewState: "changes_requested",
            reviewer: "codex[bot]",
            body: "fix",
            author: { login: "codex[bot]", type: "Bot" },
          },
          "del-10",
        )!;
        expectMatch(BOT_FILTER, env);
      });

      it("does NOT match a human-authored review", () => {
        const env = buildEventLogEnvelope(
          {
            kind: "pull_request_review",
            repo: "o/r",
            number: PR,
            action: "submitted",
            reviewState: "changes_requested",
            reviewer: "alice",
            body: "fix",
            author: { login: "alice", type: "User" },
          },
          "del-11",
        )!;
        expectNoMatch(BOT_FILTER, env);
      });
    });
  },
);
