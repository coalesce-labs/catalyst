import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWebhookHandler,
  buildEventLogEnvelope,
  type PrFetcherForceLike,
  type PreviewFetcherForceLike,
} from "../lib/webhook-handler";
import type { EventLogWriter, AppendableEvent } from "../lib/event-log";

const SECRET = "test-secret";

function sign(body: string): string {
  return (
    "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex")
  );
}

function makeReq(
  body: unknown,
  headers: Partial<{
    "x-github-event": string;
    "x-github-delivery": string;
    "x-hub-signature-256": string;
  }> = {},
  method = "POST",
): Request {
  const bodyStr = JSON.stringify(body);
  return new Request("http://localhost:7400/api/webhook", {
    method,
    headers: {
      "x-github-event": headers["x-github-event"] ?? "pull_request",
      "x-github-delivery":
        headers["x-github-delivery"] ?? `delivery-${Math.random()}`,
      "x-hub-signature-256":
        headers["x-hub-signature-256"] ?? sign(bodyStr),
      "content-type": "application/json",
    },
    body: bodyStr,
  });
}

class FakeFetcher implements PrFetcherForceLike {
  forces: Array<{ repo: string; number: number }> = [];
  force(ref: { repo: string; number: number }): Promise<void> {
    this.forces.push(ref);
    return Promise.resolve();
  }
}

class FakePreviewFetcher implements PreviewFetcherForceLike {
  forces: Array<{ repo: string; number: number }> = [];
  force(ref: { repo: string; number: number }): Promise<void> {
    this.forces.push(ref);
    return Promise.resolve();
  }
}

class FakeEventLog implements EventLogWriter {
  appends: AppendableEvent[] = [];
  failNext = false;
  append(envelope: AppendableEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("disk full"));
    }
    this.appends.push(envelope);
    return Promise.resolve();
  }
}

const REPO = { repository: { full_name: "owner/repo" } };

describe("createWebhookHandler", () => {
  let fetcher: FakeFetcher;

  beforeEach(() => {
    fetcher = new FakeFetcher();
  });

  it("returns 503 when secret is empty", async () => {
    const handler = createWebhookHandler({ secret: "", prFetcher: fetcher });
    const res = await handler.handle(
      makeReq({ ...REPO, action: "closed", pull_request: { number: 1 } }),
    );
    expect(res.status).toBe(503);
  });

  it("returns 405 for non-POST", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const res = await handler.handle(
      makeReq(
        { ...REPO, action: "closed", pull_request: { number: 1 } },
        {},
        "GET",
      ),
    );
    expect(res.status).toBe(405);
  });

  it("returns 401 for missing signature", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const body = JSON.stringify({
      ...REPO,
      action: "closed",
      pull_request: { number: 1 },
    });
    const req = new Request("http://localhost:7400/api/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "abc",
      },
      body,
    });
    const res = await handler.handle(req);
    expect(res.status).toBe(401);
    expect(fetcher.forces.length).toBe(0);
  });

  it("returns 401 for bad signature", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const res = await handler.handle(
      makeReq(
        { ...REPO, action: "closed", pull_request: { number: 1 } },
        { "x-hub-signature-256": "sha256=deadbeef" },
      ),
    );
    expect(res.status).toBe(401);
    expect(fetcher.forces.length).toBe(0);
  });

  it("returns 400 for missing event/delivery headers", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const body = JSON.stringify({
      ...REPO,
      action: "closed",
      pull_request: { number: 1 },
    });
    const req = new Request("http://localhost:7400/api/webhook", {
      method: "POST",
      headers: {
        "x-hub-signature-256": sign(body),
      },
      body,
    });
    const res = await handler.handle(req);
    expect(res.status).toBe(400);
  });

  it("dispatches pull_request.closed (merged) → forces fetcher and writes signal", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webhook-handler-"));
    const signalPath = join(tmp, "ticket.json");
    writeFileSync(
      signalPath,
      JSON.stringify({
        ticket: "T-1",
        status: "active",
        phase: 5,
        startedAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
        pr: { number: 322, url: "https://github.com/owner/repo/pull/322" },
      }),
    );
    try {
      const handler = createWebhookHandler({
        secret: SECRET,
        prFetcher: fetcher,
        findSignalPaths: (repo, num) =>
          repo === "owner/repo" && num === 322 ? [signalPath] : [],
      });
      const res = await handler.handle(
        makeReq({
          ...REPO,
          action: "closed",
          pull_request: {
            number: 322,
            merged: true,
            merged_at: "2026-05-03T12:34:56Z",
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(fetcher.forces).toEqual([{ repo: "owner/repo", number: 322 }]);
      const updated = JSON.parse(readFileSync(signalPath, "utf8"));
      expect(updated.status).toBe("done");
      expect(updated.pr.ciStatus).toBe("merged");
      expect(updated.pr.mergedAt).toBe("2026-05-03T12:34:56Z");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("dispatches pull_request.synchronize → forces fetcher, no signal write", async () => {
    let writeAttempted = false;
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      findSignalPaths: () => {
        writeAttempted = true;
        return [];
      },
    });
    const res = await handler.handle(
      makeReq({
        ...REPO,
        action: "synchronize",
        pull_request: { number: 322, merged: false },
      }),
    );
    expect(res.status).toBe(200);
    expect(fetcher.forces).toEqual([{ repo: "owner/repo", number: 322 }]);
    // findSignalPaths is only called for closed-merged
    expect(writeAttempted).toBe(false);
  });

  it("dispatches check_suite.completed → forces fetcher for each PR", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          check_suite: {
            status: "completed",
            conclusion: "success",
            pull_requests: [{ number: 1 }, { number: 2 }, { number: 3 }],
          },
        },
        { "x-github-event": "check_suite" },
      ),
    );
    expect(res.status).toBe(200);
    expect(fetcher.forces).toEqual([
      { repo: "owner/repo", number: 1 },
      { repo: "owner/repo", number: 2 },
      { repo: "owner/repo", number: 3 },
    ]);
  });

  it("dispatches pull_request_review.submitted → forces fetcher", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          action: "submitted",
          pull_request: { number: 50 },
          review: { state: "approved", body: "lgtm" },
        },
        { "x-github-event": "pull_request_review" },
      ),
    );
    expect(res.status).toBe(200);
    expect(fetcher.forces).toEqual([{ repo: "owner/repo", number: 50 }]);
  });

  it("issue_comment.created → previewFetcher.force when configured", async () => {
    const preview = new FakePreviewFetcher();
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      previewFetcher: preview,
    });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          action: "created",
          issue: { number: 80, pull_request: { url: "..." } },
          comment: { id: 1, body: "Preview: https://x.pages.dev", html_url: "..." },
        },
        { "x-github-event": "issue_comment" },
      ),
    );
    expect(res.status).toBe(200);
    expect(preview.forces).toEqual([{ repo: "owner/repo", number: 80 }]);
    expect(fetcher.forces.length).toBe(0);
  });

  it("pull_request_review_comment.created → previewFetcher.force", async () => {
    const preview = new FakePreviewFetcher();
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      previewFetcher: preview,
    });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          action: "created",
          pull_request: { number: 90 },
          comment: { id: 7, body: "nit", html_url: "..." },
        },
        { "x-github-event": "pull_request_review_comment" },
      ),
    );
    expect(res.status).toBe(200);
    expect(preview.forces).toEqual([{ repo: "owner/repo", number: 90 }]);
  });

  it("preview events are no-ops when previewFetcher is not configured", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          action: "created",
          issue: { number: 80, pull_request: { url: "..." } },
          comment: { id: 1, body: "hi", html_url: "..." },
        },
        { "x-github-event": "issue_comment" },
      ),
    );
    expect(res.status).toBe(200);
    expect(fetcher.forces.length).toBe(0);
  });

  it("deployment_status events are accepted but logged only", async () => {
    const preview = new FakePreviewFetcher();
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      previewFetcher: preview,
    });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          deployment: { id: 1, environment: "preview" },
          deployment_status: { state: "success", target_url: "..." },
        },
        { "x-github-event": "deployment_status" },
      ),
    );
    expect(res.status).toBe(200);
    expect(preview.forces.length).toBe(0);
    expect(fetcher.forces.length).toBe(0);
  });

  it("status events are no-ops in Phase 1 (no PR resolution yet)", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const res = await handler.handle(
      makeReq(
        { ...REPO, sha: "abc", state: "success" },
        { "x-github-event": "status" },
      ),
    );
    expect(res.status).toBe(200);
    expect(fetcher.forces.length).toBe(0);
  });

  it("dedupes by X-GitHub-Delivery (replay)", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const body = JSON.stringify({
      ...REPO,
      action: "closed",
      pull_request: { number: 322, merged: true, merged_at: null },
    });
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-once",
      "x-hub-signature-256": sign(body),
      "content-type": "application/json",
    };

    const r1 = await handler.handle(
      new Request("http://localhost/", { method: "POST", headers, body }),
    );
    expect(r1.status).toBe(200);
    expect(fetcher.forces.length).toBe(1);

    const r2 = await handler.handle(
      new Request("http://localhost/", { method: "POST", headers, body }),
    );
    expect(r2.status).toBe(200);
    const r2body = (await r2.json()) as { ok: boolean; replay: boolean };
    expect(r2body.replay).toBe(true);
    // No additional force calls
    expect(fetcher.forces.length).toBe(1);
  });

  it("emits webhook-event to subscribers", async () => {
    const emitted: Array<{ type: string; data: unknown }> = [];
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      emit: (type, data) => emitted.push({ type, data }),
    });
    await handler.handle(
      makeReq({
        ...REPO,
        action: "synchronize",
        pull_request: { number: 1 },
      }),
    );
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.type).toBe("webhook-event");
  });

  it("getLastWebhookAt records timestamp on dispatch", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const before = Date.now();
    await handler.handle(
      makeReq({
        ...REPO,
        action: "synchronize",
        pull_request: { number: 1 },
      }),
    );
    const after = Date.now();
    const ts = handler.getLastWebhookAt("owner/repo", 1);
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);
    expect(handler.getLastWebhookAt("owner/repo", 999)).toBeNull();
  });

  it("ignored events are accepted (200) without side effects", async () => {
    const handler = createWebhookHandler({ secret: SECRET, prFetcher: fetcher });
    const res = await handler.handle(
      makeReq(
        // `unrecognized_event` exercises the unhandled-event-name branch since
        // `release` is now a recognized event (CTL-226).
        { ...REPO, action: "whatever" },
        { "x-github-event": "unrecognized_event" },
      ),
    );
    expect(res.status).toBe(200);
    expect(fetcher.forces.length).toBe(0);
  });

  // CTL-226: regression-protect the topic mapper. Before the fix, ANY
  // pull_request payload with merged=true (including label edits on an
  // already-merged PR) was routed to github.pr.merged, which made workers
  // waiting on merge re-fire on every subsequent label change.
  it("pull_request.labeled on merged PR does NOT force-fire merge dispatch", async () => {
    const eventLog = new FakeEventLog();
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      eventLog,
    });
    const res = await handler.handle(
      makeReq({
        ...REPO,
        action: "labeled",
        // Merged PR — but the action is labeled, not closed.
        pull_request: {
          number: 326,
          merged: true,
          merged_at: "2026-05-04T06:42:52Z",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(1);
    expect(eventLog.appends[0]?.event).toBe("github.pr.labeled");
    expect(eventLog.appends[0]?.event).not.toBe("github.pr.merged");
  });

  it("release.published is accepted (200) and logged", async () => {
    const eventLog = new FakeEventLog();
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      eventLog,
    });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          action: "published",
          release: {
            id: 1234,
            tag_name: "catalyst-dev-v8.0.0",
            name: "catalyst-dev v8.0.0",
            draft: false,
            prerelease: false,
            html_url: "https://github.com/owner/repo/releases/tag/catalyst-dev-v8.0.0",
          },
        },
        { "x-github-event": "release" },
      ),
    );
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(1);
    expect(eventLog.appends[0]?.event).toBe("github.release.published");
    // No PR fetcher force — release events are repo-level, not PR-keyed.
    expect(fetcher.forces.length).toBe(0);
  });

  it("workflow_run.completed is accepted (200) and logged", async () => {
    const eventLog = new FakeEventLog();
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      eventLog,
    });
    const res = await handler.handle(
      makeReq(
        {
          ...REPO,
          action: "completed",
          workflow_run: {
            id: 555,
            workflow_id: 99,
            name: "CI",
            head_sha: "abc123",
            head_branch: "main",
            status: "completed",
            conclusion: "success",
            run_number: 42,
            html_url: "https://github.com/owner/repo/actions/runs/555",
            pull_requests: [{ number: 326 }],
          },
        },
        { "x-github-event": "workflow_run" },
      ),
    );
    expect(res.status).toBe(200);
    expect(eventLog.appends.length).toBe(1);
    expect(eventLog.appends[0]?.event).toBe("github.workflow_run.completed");
    expect(fetcher.forces.length).toBe(0);
  });

  it("idempotency cache evicts oldest beyond max", async () => {
    const handler = createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      idempotencyMax: 2,
    });
    const post = async (id: string): Promise<void> => {
      const body = JSON.stringify({
        ...REPO,
        action: "synchronize",
        pull_request: { number: 1 },
      });
      await handler.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": id,
            "x-hub-signature-256": sign(body),
          },
          body,
        }),
      );
    };
    await post("a");
    await post("b");
    expect(handler.hasSeenDelivery("a")).toBe(true);
    expect(handler.hasSeenDelivery("b")).toBe(true);
    await post("c"); // pushes "a" out
    expect(handler.hasSeenDelivery("a")).toBe(false);
    expect(handler.hasSeenDelivery("b")).toBe(true);
    expect(handler.hasSeenDelivery("c")).toBe(true);
  });
});

describe("buildEventLogEnvelope", () => {
  it("maps pull_request.closed (merged=true) → github.pr.merged", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "pull_request",
        repo: "o/r",
        number: 1,
        action: "closed",
        merged: true,
        mergedAt: "2026-05-03T12:00:00Z",
        draft: false,
        mergeable: true,
      },
      "del-1",
    );
    expect(env).not.toBeNull();
    expect(env!.event).toBe("github.pr.merged");
    expect(env!.scope).toEqual({ repo: "o/r", pr: 1 });
    expect(env!.id).toBe("evt_del-1");
  });

  it("maps pull_request.closed (merged=false) → github.pr.closed", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "pull_request",
        repo: "o/r",
        number: 1,
        action: "closed",
        merged: false,
        mergedAt: null,
        draft: false,
        mergeable: null,
      },
      "del-2",
    );
    expect(env!.event).toBe("github.pr.closed");
  });

  // CTL-226: pull_request payloads on already-merged PRs carry merged=true
  // for non-merge actions too (labeled, unlabeled, edited, …). The mapper
  // must not treat any merged=true payload as a merge event — only the one
  // with action=closed AND merged=true.
  it("maps pull_request.labeled (merged=true) → github.pr.labeled (NOT merged)", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "pull_request",
        repo: "o/r",
        number: 326,
        action: "labeled",
        merged: true,
        mergedAt: "2026-05-04T06:42:52Z",
        draft: false,
        mergeable: null,
      },
      "del-pr-labeled",
    );
    expect(env!.event).toBe("github.pr.labeled");
  });

  it("maps pull_request.unlabeled (merged=true) → github.pr.unlabeled", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "pull_request",
        repo: "o/r",
        number: 326,
        action: "unlabeled",
        merged: true,
        mergedAt: "2026-05-04T06:42:52Z",
        draft: false,
        mergeable: null,
      },
      "del-pr-unlabeled",
    );
    expect(env!.event).toBe("github.pr.unlabeled");
  });

  it("maps pull_request.synchronize → github.pr.synchronize", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "pull_request",
        repo: "o/r",
        number: 1,
        action: "synchronize",
        merged: false,
        mergedAt: null,
        draft: false,
        mergeable: null,
      },
      "del-sync",
    );
    expect(env!.event).toBe("github.pr.synchronize");
  });

  it("maps release.published → github.release.published", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "release",
        repo: "o/r",
        action: "published",
        releaseId: 1234,
        tag: "catalyst-dev-v8.0.0",
        name: "catalyst-dev v8.0.0",
        draft: false,
        prerelease: false,
        htmlUrl: "https://github.com/o/r/releases/tag/catalyst-dev-v8.0.0",
      },
      "del-release",
    );
    expect(env!.event).toBe("github.release.published");
    expect(env!.scope.repo).toBe("o/r");
    expect(env!.scope.tag).toBe("catalyst-dev-v8.0.0");
  });

  it("maps workflow_run.completed → github.workflow_run.completed", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "workflow_run",
        repo: "o/r",
        action: "completed",
        workflowId: 99,
        runId: 555,
        name: "CI",
        headSha: "abc123",
        headBranch: "main",
        status: "completed",
        conclusion: "success",
        runNumber: 42,
        htmlUrl: "https://github.com/o/r/actions/runs/555",
        prNumbers: [326],
      },
      "del-wfr",
    );
    expect(env!.event).toBe("github.workflow_run.completed");
    expect(env!.scope.sha).toBe("abc123");
    expect(env!.detail.conclusion).toBe("success");
    expect(env!.detail.prNumbers).toEqual([326]);
  });

  it("maps check_suite.completed → github.check_suite.completed", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "check_suite",
        repo: "o/r",
        prNumbers: [1, 2],
        status: "completed",
        conclusion: "success",
      },
      "del-3",
    );
    expect(env!.event).toBe("github.check_suite.completed");
    expect(env!.detail.conclusion).toBe("success");
  });

  it("maps deployment_status.success → github.deployment_status.success", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "deployment_status",
        repo: "o/r",
        deploymentId: 100,
        environment: "preview",
        state: "success",
        targetUrl: "https://x.pages.dev",
        environmentUrl: null,
      },
      "del-4",
    );
    expect(env!.event).toBe("github.deployment_status.success");
    expect(env!.scope.environment).toBe("preview");
  });

  it("returns null for ignored events", () => {
    const env = buildEventLogEnvelope(
      { kind: "ignored", reason: "unknown event" },
      "del-5",
    );
    expect(env).toBeNull();
  });

  it("propagates author on pull_request_review envelopes", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "pull_request_review",
        repo: "o/r",
        number: 50,
        action: "submitted",
        reviewState: "changes_requested",
        reviewer: "codex[bot]",
        body: "fix",
        author: { login: "codex[bot]", type: "Bot" },
      },
      "del-6",
    );
    expect(env!.event).toBe("github.pr_review.submitted");
    expect(env!.detail.author).toEqual({ login: "codex[bot]", type: "Bot" });
  });

  it("propagates author on issue_comment envelopes", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "issue_comment",
        repo: "o/r",
        number: 80,
        action: "created",
        commentId: 999,
        body: "lgtm",
        htmlUrl: "https://example.com",
        author: { login: "alice", type: "User" },
      },
      "del-7",
    );
    expect(env!.event).toBe("github.issue_comment.created");
    expect(env!.detail.author).toEqual({ login: "alice", type: "User" });
  });

  it("propagates author on pull_request_review_comment envelopes", () => {
    const env = buildEventLogEnvelope(
      {
        kind: "pull_request_review_comment",
        repo: "o/r",
        number: 90,
        action: "created",
        commentId: 7,
        body: "nit",
        htmlUrl: "https://example.com",
        author: { login: "dependabot[bot]", type: "Bot" },
      },
      "del-8",
    );
    expect(env!.event).toBe("github.pr_review_comment.created");
    expect(env!.detail.author).toEqual({
      login: "dependabot[bot]",
      type: "Bot",
    });
  });
});

describe("createWebhookHandler — event log fan-out", () => {
  const fetcher = new FakeFetcher();

  function makeHandler(eventLog: FakeEventLog) {
    return createWebhookHandler({
      secret: SECRET,
      prFetcher: fetcher,
      eventLog,
    });
  }

  it("appends one log entry per accepted event", async () => {
    const eventLog = new FakeEventLog();
    const handler = makeHandler(eventLog);
    await handler.handle(
      makeReq({
        ...REPO,
        action: "synchronize",
        pull_request: { number: 1 },
      }),
    );
    expect(eventLog.appends.length).toBe(1);
    expect(eventLog.appends[0]?.event).toBe("github.pr.synchronize");
  });

  it("does not log replayed (already-seen) deliveries", async () => {
    const eventLog = new FakeEventLog();
    const handler = makeHandler(eventLog);
    const body = JSON.stringify({
      ...REPO,
      action: "synchronize",
      pull_request: { number: 1 },
    });
    const headers = {
      "x-github-event": "pull_request",
      "x-github-delivery": "dup-id",
      "x-hub-signature-256": sign(body),
      "content-type": "application/json",
    };
    await handler.handle(
      new Request("http://localhost/", { method: "POST", headers, body }),
    );
    await handler.handle(
      new Request("http://localhost/", { method: "POST", headers, body }),
    );
    expect(eventLog.appends.length).toBe(1);
  });

  it("does not log when signature fails", async () => {
    const eventLog = new FakeEventLog();
    const handler = makeHandler(eventLog);
    await handler.handle(
      makeReq(
        {
          ...REPO,
          action: "synchronize",
          pull_request: { number: 1 },
        },
        { "x-hub-signature-256": "sha256=bad" },
      ),
    );
    expect(eventLog.appends.length).toBe(0);
  });

  it("handler still succeeds when log append throws", async () => {
    const eventLog = new FakeEventLog();
    eventLog.failNext = true;
    const handler = makeHandler(eventLog);
    const res = await handler.handle(
      makeReq({
        ...REPO,
        action: "synchronize",
        pull_request: { number: 1 },
      }),
    );
    expect(res.status).toBe(200);
    // The first call's log append rejected; subsequent dispatch still ran.
    expect(fetcher.forces.some((f) => f.number === 1)).toBe(true);
  });

  it("does not log ignored events", async () => {
    const eventLog = new FakeEventLog();
    const handler = makeHandler(eventLog);
    await handler.handle(
      makeReq(
        { ...REPO, action: "edited" },
        { "x-github-event": "release" },
      ),
    );
    expect(eventLog.appends.length).toBe(0);
  });
});
