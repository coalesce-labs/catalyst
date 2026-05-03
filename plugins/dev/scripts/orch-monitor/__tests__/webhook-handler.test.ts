import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWebhookHandler,
  type PrFetcherForceLike,
  type PreviewFetcherForceLike,
} from "../lib/webhook-handler";

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
        { ...REPO, action: "edited" },
        { "x-github-event": "release" },
      ),
    );
    expect(res.status).toBe(200);
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
