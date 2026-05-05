import { describe, it, expect } from "bun:test";
import { parseWebhookEvent, type WebhookEvent } from "../lib/webhook-events";

const REPO = { repository: { full_name: "owner/repo" } };

describe("parseWebhookEvent", () => {
  it("returns ignored for non-object payload", () => {
    expect(parseWebhookEvent("pull_request", null).kind).toBe("ignored");
    expect(parseWebhookEvent("pull_request", "string").kind).toBe("ignored");
    expect(parseWebhookEvent("pull_request", 42).kind).toBe("ignored");
  });

  it("returns ignored for unknown event names", () => {
    const got = parseWebhookEvent("unrecognized_event", REPO);
    expect(got.kind).toBe("ignored");
    if (got.kind === "ignored")
      expect(got.reason).toContain("unhandled event");
  });

  it("returns ignored when repository.full_name is missing", () => {
    const got = parseWebhookEvent("pull_request", { pull_request: { number: 1 } });
    expect(got.kind).toBe("ignored");
  });

  describe("pull_request", () => {
    it("parses a closed-merged event", () => {
      const got = parseWebhookEvent("pull_request", {
        ...REPO,
        action: "closed",
        pull_request: {
          number: 322,
          merged: true,
          merged_at: "2026-05-03T12:00:00Z",
          draft: false,
          mergeable: true,
          head: { ref: "orch-foo-CTL-1" },
        },
      });
      expect(got.kind).toBe("pull_request");
      if (got.kind !== "pull_request") return;
      expect(got.repo).toBe("owner/repo");
      expect(got.number).toBe(322);
      expect(got.action).toBe("closed");
      expect(got.merged).toBe(true);
      expect(got.mergedAt).toBe("2026-05-03T12:00:00Z");
      expect(got.draft).toBe(false);
      expect(got.mergeable).toBe(true);
      expect(got.headRef).toBe("orch-foo-CTL-1");
    });

    it("falls back to empty headRef when payload omits head", () => {
      const got = parseWebhookEvent("pull_request", {
        ...REPO,
        action: "closed",
        pull_request: { number: 1, merged: false },
      });
      expect(got.kind).toBe("pull_request");
      if (got.kind !== "pull_request") return;
      expect(got.headRef).toBe("");
    });

    it("parses a closed-not-merged event", () => {
      const got = parseWebhookEvent("pull_request", {
        ...REPO,
        action: "closed",
        pull_request: {
          number: 1,
          merged: false,
          merged_at: null,
          draft: false,
        },
      });
      expect(got.kind).toBe("pull_request");
      if (got.kind !== "pull_request") return;
      expect(got.merged).toBe(false);
      expect(got.mergedAt).toBeNull();
    });

    it("returns ignored when pull_request is missing", () => {
      const got = parseWebhookEvent("pull_request", { ...REPO, action: "closed" });
      expect(got.kind).toBe("ignored");
    });

    it("returns ignored when number is missing", () => {
      const got = parseWebhookEvent("pull_request", {
        ...REPO,
        action: "closed",
        pull_request: { merged: true },
      });
      expect(got.kind).toBe("ignored");
    });
  });

  describe("pull_request_review", () => {
    it("parses a review submission", () => {
      const got = parseWebhookEvent("pull_request_review", {
        ...REPO,
        action: "submitted",
        pull_request: { number: 50 },
        review: {
          state: "approved",
          body: "lgtm",
          user: { login: "alice", type: "User" },
        },
      });
      expect(got.kind).toBe("pull_request_review");
      if (got.kind !== "pull_request_review") return;
      expect(got.number).toBe(50);
      expect(got.reviewState).toBe("approved");
      expect(got.reviewer).toBe("alice");
      expect(got.body).toBe("lgtm");
      expect(got.author).toEqual({ login: "alice", type: "User" });
    });

    it("captures author.type for bot reviewers", () => {
      const got = parseWebhookEvent("pull_request_review", {
        ...REPO,
        action: "submitted",
        pull_request: { number: 51 },
        review: {
          state: "changes_requested",
          body: "fix this",
          user: { login: "codex[bot]", type: "Bot" },
        },
      });
      expect(got.kind).toBe("pull_request_review");
      if (got.kind !== "pull_request_review") return;
      expect(got.author).toEqual({ login: "codex[bot]", type: "Bot" });
    });

    it("falls back to empty author when user is missing", () => {
      const got = parseWebhookEvent("pull_request_review", {
        ...REPO,
        action: "submitted",
        pull_request: { number: 52 },
        review: { state: "commented", body: "" },
      });
      expect(got.kind).toBe("pull_request_review");
      if (got.kind !== "pull_request_review") return;
      expect(got.author).toEqual({ login: "", type: "" });
    });
  });

  describe("pull_request_review_thread", () => {
    it("parses a thread resolved event", () => {
      const got = parseWebhookEvent("pull_request_review_thread", {
        ...REPO,
        action: "resolved",
        pull_request: { number: 60 },
        thread: { id: 12345 },
      });
      expect(got.kind).toBe("pull_request_review_thread");
      if (got.kind !== "pull_request_review_thread") return;
      expect(got.number).toBe(60);
      expect(got.threadId).toBe(12345);
      expect(got.action).toBe("resolved");
    });
  });

  describe("check_suite", () => {
    it("extracts pr numbers, conclusion, and head_branch", () => {
      const got = parseWebhookEvent("check_suite", {
        ...REPO,
        check_suite: {
          status: "completed",
          conclusion: "success",
          head_branch: "orch-foo-CTL-99",
          pull_requests: [{ number: 70 }, { number: 71 }],
        },
      });
      expect(got.kind).toBe("check_suite");
      if (got.kind !== "check_suite") return;
      expect(got.prNumbers).toEqual([70, 71]);
      expect(got.conclusion).toBe("success");
      expect(got.status).toBe("completed");
      expect(got.headRef).toBe("orch-foo-CTL-99");
    });

    it("handles empty pr list", () => {
      const got = parseWebhookEvent("check_suite", {
        ...REPO,
        check_suite: { status: "in_progress", pull_requests: [] },
      });
      expect(got.kind).toBe("check_suite");
      if (got.kind !== "check_suite") return;
      expect(got.prNumbers).toEqual([]);
      expect(got.conclusion).toBeNull();
      expect(got.headRef).toBe("");
    });
  });

  describe("status", () => {
    it("parses a sha-state pair", () => {
      const got = parseWebhookEvent("status", {
        ...REPO,
        sha: "abc123",
        state: "success",
      });
      expect(got.kind).toBe("status");
      if (got.kind !== "status") return;
      expect(got.sha).toBe("abc123");
      expect(got.state).toBe("success");
    });

    it("returns ignored when sha is missing", () => {
      const got = parseWebhookEvent("status", { ...REPO, state: "success" });
      expect(got.kind).toBe("ignored");
    });
  });

  describe("push", () => {
    it("parses a push to main", () => {
      const got = parseWebhookEvent("push", {
        ...REPO,
        ref: "refs/heads/main",
        before: "aaa",
        after: "bbb",
        commits: [{ id: "bbb", message: "feat: x" }],
      });
      expect(got.kind).toBe("push");
      if (got.kind !== "push") return;
      expect(got.ref).toBe("refs/heads/main");
      expect(got.baseSha).toBe("aaa");
      expect(got.headSha).toBe("bbb");
      expect(got.commits).toEqual([{ id: "bbb", message: "feat: x" }]);
    });
  });

  describe("issue_comment", () => {
    it("parses a PR comment", () => {
      const got = parseWebhookEvent("issue_comment", {
        ...REPO,
        action: "created",
        issue: {
          number: 80,
          pull_request: { url: "https://api.github.com/.../pulls/80" },
        },
        comment: {
          id: 999,
          body: "Preview: https://preview.example.com/x",
          html_url: "https://github.com/owner/repo/issues/80#issuecomment-999",
          user: { login: "alice", type: "User" },
        },
      });
      expect(got.kind).toBe("issue_comment");
      if (got.kind !== "issue_comment") return;
      expect(got.number).toBe(80);
      expect(got.commentId).toBe(999);
      expect(got.body).toContain("Preview");
      expect(got.author).toEqual({ login: "alice", type: "User" });
    });

    it("captures author.type for bot PR comments", () => {
      const got = parseWebhookEvent("issue_comment", {
        ...REPO,
        action: "created",
        issue: {
          number: 81,
          pull_request: { url: "https://api.github.com/.../pulls/81" },
        },
        comment: {
          id: 1000,
          body: "🤖 Codex review",
          html_url: "https://github.com/owner/repo/issues/81#issuecomment-1000",
          user: { login: "claude-code-review[bot]", type: "Bot" },
        },
      });
      expect(got.kind).toBe("issue_comment");
      if (got.kind !== "issue_comment") return;
      expect(got.author).toEqual({
        login: "claude-code-review[bot]",
        type: "Bot",
      });
    });

    it("returns ignored for non-PR issue comments", () => {
      const got = parseWebhookEvent("issue_comment", {
        ...REPO,
        action: "created",
        issue: { number: 80 },
        comment: { id: 1, body: "" },
      });
      expect(got.kind).toBe("ignored");
    });
  });

  describe("pull_request_review_comment", () => {
    it("parses an inline review comment", () => {
      const got = parseWebhookEvent("pull_request_review_comment", {
        ...REPO,
        action: "created",
        pull_request: { number: 90 },
        comment: {
          id: 7,
          body: "nit",
          html_url: "https://github.com/owner/repo/pull/90#discussion_r7",
          user: { login: "bob", type: "User" },
        },
      });
      expect(got.kind).toBe("pull_request_review_comment");
      if (got.kind !== "pull_request_review_comment") return;
      expect(got.number).toBe(90);
      expect(got.commentId).toBe(7);
      expect(got.author).toEqual({ login: "bob", type: "User" });
    });

    it("captures author.type for bot inline comments", () => {
      const got = parseWebhookEvent("pull_request_review_comment", {
        ...REPO,
        action: "created",
        pull_request: { number: 91 },
        comment: {
          id: 8,
          body: "Suggested change",
          html_url: "https://github.com/owner/repo/pull/91#discussion_r8",
          user: { login: "dependabot[bot]", type: "Bot" },
        },
      });
      expect(got.kind).toBe("pull_request_review_comment");
      if (got.kind !== "pull_request_review_comment") return;
      expect(got.author).toEqual({ login: "dependabot[bot]", type: "Bot" });
    });
  });

  describe("deployment", () => {
    it("parses a deployment created", () => {
      const got = parseWebhookEvent("deployment", {
        ...REPO,
        deployment: {
          id: 100,
          environment: "preview",
          sha: "abc",
          ref: "feat/x",
          payload_url: null,
        },
      });
      expect(got.kind).toBe("deployment");
      if (got.kind !== "deployment") return;
      expect(got.environment).toBe("preview");
      expect(got.sha).toBe("abc");
      expect(got.refName).toBe("feat/x");
      expect(got.payloadUrl).toBeNull();
    });
  });

  describe("deployment_status", () => {
    it("parses a deployment_status with target URL", () => {
      const got = parseWebhookEvent("deployment_status", {
        ...REPO,
        deployment: { id: 100, environment: "preview" },
        deployment_status: {
          state: "success",
          target_url: "https://preview.example.com/x",
          environment_url: null,
        },
      });
      expect(got.kind).toBe("deployment_status");
      if (got.kind !== "deployment_status") return;
      expect(got.state).toBe("success");
      expect(got.targetUrl).toBe("https://preview.example.com/x");
      expect(got.environmentUrl).toBeNull();
    });
  });

  it("does not throw on a malformed-but-not-pathological payload", () => {
    // Spread of edge cases; verify each returns a discriminated union value.
    const cases: Array<[string, unknown]> = [
      ["pull_request", { ...REPO, pull_request: {} }],
      ["check_suite", { ...REPO }],
      ["status", { ...REPO }],
    ];
    for (const [name, payload] of cases) {
      const got: WebhookEvent = parseWebhookEvent(name, payload);
      expect(typeof got.kind).toBe("string");
    }
  });

  // CTL-226: GitHub release events. Used by release-please flows so consumers
  // can wait-for `github.release.published` instead of polling.
  describe("release", () => {
    it("parses a release.published event", () => {
      const got = parseWebhookEvent("release", {
        ...REPO,
        action: "published",
        release: {
          id: 4242,
          tag_name: "catalyst-dev-v8.0.0",
          name: "catalyst-dev v8.0.0",
          draft: false,
          prerelease: false,
          html_url: "https://github.com/owner/repo/releases/tag/catalyst-dev-v8.0.0",
        },
      });
      expect(got.kind).toBe("release");
      if (got.kind !== "release") return;
      expect(got.repo).toBe("owner/repo");
      expect(got.action).toBe("published");
      expect(got.releaseId).toBe(4242);
      expect(got.tag).toBe("catalyst-dev-v8.0.0");
      expect(got.name).toBe("catalyst-dev v8.0.0");
      expect(got.draft).toBe(false);
      expect(got.prerelease).toBe(false);
      expect(got.htmlUrl).toBe(
        "https://github.com/owner/repo/releases/tag/catalyst-dev-v8.0.0",
      );
    });

    it("returns ignored when release field is missing", () => {
      const got = parseWebhookEvent("release", {
        ...REPO,
        action: "published",
      });
      expect(got.kind).toBe("ignored");
      if (got.kind !== "ignored") return;
      expect(got.reason).toContain("missing release");
    });
  });

  // CTL-226: workflow_run events let consumers observe CI completion at the
  // workflow level (CTL-211 deploy lifecycle dependency).
  describe("workflow_run", () => {
    it("parses a workflow_run.completed event", () => {
      const got = parseWebhookEvent("workflow_run", {
        ...REPO,
        action: "completed",
        workflow_run: {
          id: 555,
          workflow_id: 99,
          name: "CI",
          head_sha: "abc123def",
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          run_number: 42,
          html_url: "https://github.com/owner/repo/actions/runs/555",
          pull_requests: [{ number: 326 }, { number: 327 }],
        },
      });
      expect(got.kind).toBe("workflow_run");
      if (got.kind !== "workflow_run") return;
      expect(got.repo).toBe("owner/repo");
      expect(got.action).toBe("completed");
      expect(got.runId).toBe(555);
      expect(got.workflowId).toBe(99);
      expect(got.headSha).toBe("abc123def");
      expect(got.headBranch).toBe("main");
      expect(got.status).toBe("completed");
      expect(got.conclusion).toBe("success");
      expect(got.runNumber).toBe(42);
      expect(got.prNumbers).toEqual([326, 327]);
    });

    it("parses workflow_run with null conclusion (still in progress)", () => {
      const got = parseWebhookEvent("workflow_run", {
        ...REPO,
        action: "in_progress",
        workflow_run: {
          id: 1,
          workflow_id: 1,
          name: "CI",
          head_sha: "x",
          head_branch: "main",
          status: "in_progress",
          conclusion: null,
          run_number: 1,
          html_url: "...",
        },
      });
      expect(got.kind).toBe("workflow_run");
      if (got.kind !== "workflow_run") return;
      expect(got.conclusion).toBeNull();
      expect(got.prNumbers).toEqual([]);
    });

    it("returns ignored when workflow_run field is missing", () => {
      const got = parseWebhookEvent("workflow_run", {
        ...REPO,
        action: "completed",
      });
      expect(got.kind).toBe("ignored");
      if (got.kind !== "ignored") return;
      expect(got.reason).toContain("missing workflow_run");
    });
  });
});
