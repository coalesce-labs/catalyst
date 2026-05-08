import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildEventLogEnvelope } from "../lib/webhook-handler";
import type { CanonicalEvent } from "../lib/canonical-event";

/**
 * Validates the canonical "Reactive PR lifecycle" disjunctive jq filter
 * documented in `plugins/dev/skills/monitor-events/SKILL.md` against canonical
 * envelopes produced by `buildEventLogEnvelope`. Predicate paths use
 * `.attributes."<key>"` per the OTel-shaped canonical schema (CTL-300).
 *
 * Skips silently if `jq` is not on PATH.
 */

const JQ_PATH = (() => {
  const r = spawnSync("jq", ["--version"], { stdio: "ignore" });
  return r.status === 0 ? "jq" : null;
})();

function jqSelect(filter: string, envelope: CanonicalEvent): string {
  if (JQ_PATH === null) throw new Error("jq not available");
  const r = spawnSync(JQ_PATH, ["-c", `select(${filter})`], {
    input: JSON.stringify(envelope) + "\n",
    encoding: "utf8",
  });
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`jq exited ${r.status}: ${r.stderr ?? ""}`);
  }
  return (r.stdout ?? "").trim();
}

function expectMatch(filter: string, envelope: CanonicalEvent): void {
  const out = jqSelect(filter, envelope);
  expect(out.length).toBeGreaterThan(0);
}

function expectNoMatch(filter: string, envelope: CanonicalEvent): void {
  const out = jqSelect(filter, envelope);
  expect(out).toBe("");
}

const PR = 42;
const BASE = "main";

const REACTIVE_FILTER = `
  (.attributes."event.name" == "github.pr.merged" and .attributes."vcs.pr.number" == ${PR}) or
  (.attributes."event.name" == "github.pr.closed" and .attributes."vcs.pr.number" == ${PR}) or
  (.attributes."event.name" == "github.check_suite.completed"
     and (.body.payload.prNumbers // [] | index(${PR}) != null)
     and (.attributes."cicd.pipeline.run.conclusion" == "failure"
          or .attributes."cicd.pipeline.run.conclusion" == "timed_out")) or
  (.attributes."event.name" == "github.pr_review.submitted"
     and .attributes."vcs.pr.number" == ${PR}
     and .body.payload.state == "changes_requested") or
  (.attributes."event.name" == "github.push" and .attributes."vcs.ref.name" == "refs/heads/${BASE}")
`;

describe.skipIf(JQ_PATH === null)("reactive PR lifecycle filter", () => {
  it("matches github.pr.merged for the target PR", () => {
    const env = buildEventLogEnvelope({
      kind: "pull_request",
      repo: "o/r",
      number: PR,
      action: "closed",
      merged: true,
      mergedAt: "2026-05-04T00:00:00Z",
      mergeCommitSha: null,
      draft: false,
      mergeable: true,
      headRef: "",
    })!;
    expect(env.attributes["event.name"]).toBe("github.pr.merged");
    expectMatch(REACTIVE_FILTER, env);
  });

  it("does NOT match github.pr.merged for a different PR", () => {
    const env = buildEventLogEnvelope({
      kind: "pull_request",
      repo: "o/r",
      number: 99,
      action: "closed",
      merged: true,
      mergedAt: "2026-05-04T00:00:00Z",
      mergeCommitSha: null,
      draft: false,
      mergeable: true,
      headRef: "",
    })!;
    expectNoMatch(REACTIVE_FILTER, env);
  });

  it("matches check_suite.completed with conclusion=failure on target PR", () => {
    const env = buildEventLogEnvelope({
      kind: "check_suite",
      repo: "o/r",
      prNumbers: [PR, 43],
      conclusion: "failure",
      status: "completed",
      headRef: "",
    })!;
    expectMatch(REACTIVE_FILTER, env);
  });

  it("does NOT match check_suite.completed with conclusion=success", () => {
    const env = buildEventLogEnvelope({
      kind: "check_suite",
      repo: "o/r",
      prNumbers: [PR],
      conclusion: "success",
      status: "completed",
      headRef: "",
    })!;
    expectNoMatch(REACTIVE_FILTER, env);
  });

  it("does NOT match check_suite.completed when target PR is not in prNumbers", () => {
    const env = buildEventLogEnvelope({
      kind: "check_suite",
      repo: "o/r",
      prNumbers: [99, 100],
      conclusion: "failure",
      status: "completed",
      headRef: "",
    })!;
    expectNoMatch(REACTIVE_FILTER, env);
  });

  it("matches pr_review.submitted with state=changes_requested", () => {
    const env = buildEventLogEnvelope({
      kind: "pull_request_review",
      repo: "o/r",
      number: PR,
      action: "submitted",
      reviewState: "changes_requested",
      reviewer: "alice",
      body: "fix",
      author: { login: "alice", type: "User" },
      headRef: "",
    })!;
    expectMatch(REACTIVE_FILTER, env);
  });

  it("does NOT match pr_review.submitted with state=approved", () => {
    const env = buildEventLogEnvelope({
      kind: "pull_request_review",
      repo: "o/r",
      number: PR,
      action: "submitted",
      reviewState: "approved",
      reviewer: "alice",
      body: "lgtm",
      author: { login: "alice", type: "User" },
      headRef: "",
    })!;
    expectNoMatch(REACTIVE_FILTER, env);
  });

  it("matches push to the configured base branch", () => {
    const env = buildEventLogEnvelope({
      kind: "push",
      repo: "o/r",
      ref: `refs/heads/${BASE}`,
      baseSha: "aaa",
      headSha: "bbb",
      commits: [],
    })!;
    expectMatch(REACTIVE_FILTER, env);
  });

  it("does NOT match push to a feature branch", () => {
    const env = buildEventLogEnvelope({
      kind: "push",
      repo: "o/r",
      ref: "refs/heads/feat/x",
      baseSha: "aaa",
      headSha: "bbb",
      commits: [],
    })!;
    expectNoMatch(REACTIVE_FILTER, env);
  });

  describe("bot vs human author heuristic", () => {
    const BOT_FILTER =
      '.attributes."event.name" == "github.pr_review.submitted" and .body.payload.author.type == "Bot"';

    it("matches a bot-authored review", () => {
      const env = buildEventLogEnvelope({
        kind: "pull_request_review",
        repo: "o/r",
        number: PR,
        action: "submitted",
        reviewState: "changes_requested",
        reviewer: "codex[bot]",
        body: "fix",
        author: { login: "codex[bot]", type: "Bot" },
        headRef: "",
      })!;
      expectMatch(BOT_FILTER, env);
    });

    it("does NOT match a human-authored review", () => {
      const env = buildEventLogEnvelope({
        kind: "pull_request_review",
        repo: "o/r",
        number: PR,
        action: "submitted",
        reviewState: "changes_requested",
        reviewer: "alice",
        body: "fix",
        author: { login: "alice", type: "User" },
        headRef: "",
      })!;
      expectNoMatch(BOT_FILTER, env);
    });
  });
});
