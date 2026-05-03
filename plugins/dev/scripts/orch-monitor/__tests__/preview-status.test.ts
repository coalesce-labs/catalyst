import { describe, it, expect } from "bun:test";
import {
  createPreviewFetcher,
  extractPreviewUrls,
  mapDeploymentState,
  previewBackoffMs,
  DEFAULT_PREVIEW_PATTERNS,
  type Runner,
  type RunnerResult,
} from "../lib/preview-status";

function makeRunner(
  responses: Map<string, RunnerResult> | ((args: string[]) => RunnerResult),
): Runner {
  return (args) => {
    if (typeof responses === "function") return Promise.resolve(responses(args));
    const key = args.join(" ");
    return Promise.resolve(responses.get(key) ?? { stdout: "", ok: false });
  };
}

describe("DEFAULT_PREVIEW_PATTERNS", () => {
  it("includes common deployment providers", () => {
    expect(DEFAULT_PREVIEW_PATTERNS).toContain("*.pages.dev");
    expect(DEFAULT_PREVIEW_PATTERNS).toContain("*.vercel.app");
    expect(DEFAULT_PREVIEW_PATTERNS).toContain("*.netlify.app");
    expect(DEFAULT_PREVIEW_PATTERNS).toContain("*.up.railway.app");
  });
});

describe("extractPreviewUrls", () => {
  it("extracts Cloudflare Pages URLs from text", () => {
    const text = "Visit the preview at https://abc-123.my-project.pages.dev for testing";
    const urls = extractPreviewUrls(text);
    expect(urls).toContain("https://abc-123.my-project.pages.dev");
  });

  it("extracts Vercel preview URLs", () => {
    const text = "Preview: https://my-app-git-feat-abc.vercel.app";
    const urls = extractPreviewUrls(text);
    expect(urls).toContain("https://my-app-git-feat-abc.vercel.app");
  });

  it("extracts Railway preview URLs", () => {
    const text = "Deploy: https://my-service-pr-42.up.railway.app/";
    const urls = extractPreviewUrls(text);
    expect(urls).toContain("https://my-service-pr-42.up.railway.app");
  });

  it("extracts Netlify preview URLs", () => {
    const text = "https://deploy-preview-42--my-site.netlify.app is ready";
    const urls = extractPreviewUrls(text);
    expect(urls).toContain("https://deploy-preview-42--my-site.netlify.app");
  });

  it("extracts multiple URLs from the same text", () => {
    const text =
      "Frontend: https://app.pages.dev Backend: https://api.vercel.app";
    const urls = extractPreviewUrls(text);
    expect(urls.length).toBe(2);
  });

  it("deduplicates URLs", () => {
    const text =
      "https://app.pages.dev and again https://app.pages.dev";
    const urls = extractPreviewUrls(text);
    expect(urls.length).toBe(1);
  });

  it("returns empty array when no preview URLs found", () => {
    const text = "No deployment links here, just https://github.com/foo/bar";
    const urls = extractPreviewUrls(text);
    expect(urls.length).toBe(0);
  });

  it("strips trailing slashes from URLs", () => {
    const text = "https://app.pages.dev/";
    const urls = extractPreviewUrls(text);
    expect(urls[0]).toBe("https://app.pages.dev");
  });

  it("supports custom patterns", () => {
    const text = "Preview at https://my-app.fly.dev/dashboard";
    const urls = extractPreviewUrls(text, ["*.fly.dev"]);
    expect(urls).toContain("https://my-app.fly.dev");
  });

  it("extracts URLs with paths but returns only the origin", () => {
    const text = "https://abc.pages.dev/some/path?q=1";
    const urls = extractPreviewUrls(text);
    expect(urls[0]).toBe("https://abc.pages.dev");
  });
});

describe("mapDeploymentState", () => {
  it("maps success/active to live", () => {
    expect(mapDeploymentState("success")).toBe("live");
    expect(mapDeploymentState("active")).toBe("live");
  });

  it("maps pending/in_progress/queued to deploying", () => {
    expect(mapDeploymentState("pending")).toBe("deploying");
    expect(mapDeploymentState("in_progress")).toBe("deploying");
    expect(mapDeploymentState("queued")).toBe("deploying");
  });

  it("maps error/failure to failed", () => {
    expect(mapDeploymentState("error")).toBe("failed");
    expect(mapDeploymentState("failure")).toBe("failed");
  });

  it("maps inactive to inactive", () => {
    expect(mapDeploymentState("inactive")).toBe("inactive");
  });

  it("maps unknown states to unknown", () => {
    expect(mapDeploymentState("something_else")).toBe("unknown");
    expect(mapDeploymentState("")).toBe("unknown");
  });
});

describe("createPreviewFetcher", () => {
  it("get returns empty array when cache is empty", () => {
    const fetcher = createPreviewFetcher({
      runner: makeRunner(new Map()),
    });
    expect(fetcher.get("owner/repo", 1)).toEqual([]);
  });

  it("extracts preview URLs from PR comments", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh api repos/owner/repo/pulls/42/comments --paginate --jq .[].body",
      {
        stdout:
          "Preview ready at https://my-app-abc123.pages.dev\nLGTM\n",
        ok: true,
      },
    );
    responses.set(
      "gh api repos/owner/repo/deployments --jq [.[] | {environment, environment_url, state}]",
      { stdout: "", ok: true },
    );
    const fetcher = createPreviewFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "owner/repo", number: 42 }]);
    const links = fetcher.get("owner/repo", 42);
    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://my-app-abc123.pages.dev");
    expect(links[0].provider).toBe("cloudflare");
    expect(links[0].source).toBe("comment");
  });

  it("extracts preview URLs from GitHub deployments API", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh api repos/owner/repo/pulls/42/comments --paginate --jq .[].body",
      { stdout: "", ok: true },
    );
    responses.set(
      "gh api repos/owner/repo/deployments --jq [.[] | {environment, environment_url, state}]",
      {
        stdout: JSON.stringify([
          {
            environment: "Preview",
            environment_url: "https://preview-abc.vercel.app",
            state: "success",
          },
        ]),
        ok: true,
      },
    );
    const fetcher = createPreviewFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "owner/repo", number: 42 }]);
    const links = fetcher.get("owner/repo", 42);
    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://preview-abc.vercel.app");
    expect(links[0].provider).toBe("vercel");
    expect(links[0].source).toBe("deployment");
    expect(links[0].status).toBe("live");
  });

  it("deduplicates links across sources", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh api repos/o/r/pulls/1/comments --paginate --jq .[].body",
      {
        stdout: "Preview: https://app.pages.dev\n",
        ok: true,
      },
    );
    responses.set(
      "gh api repos/o/r/deployments --jq [.[] | {environment, environment_url, state}]",
      {
        stdout: JSON.stringify([
          {
            environment: "Preview",
            environment_url: "https://app.pages.dev",
            state: "success",
          },
        ]),
        ok: true,
      },
    );
    const fetcher = createPreviewFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "o/r", number: 1 }]);
    const links = fetcher.get("o/r", 1);
    expect(links.length).toBe(1);
    expect(links[0].status).toBe("live");
  });

  it("degrades silently when gh probe fails", async () => {
    const runner: Runner = (args) => {
      if (args[1] === "--version")
        return Promise.resolve({ stdout: "", ok: false });
      throw new Error("should not be called");
    };
    const fetcher = createPreviewFetcher({ runner });
    await fetcher.refreshAll([{ repo: "o/r", number: 1 }]);
    expect(fetcher.get("o/r", 1)).toEqual([]);
  });

  it("degrades silently when comments API fails", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh api repos/o/r/pulls/1/comments --paginate --jq .[].body",
      { stdout: "", ok: false },
    );
    responses.set(
      "gh api repos/o/r/deployments --jq [.[] | {environment, environment_url, state}]",
      { stdout: "", ok: true },
    );
    const fetcher = createPreviewFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "o/r", number: 1 }]);
    expect(fetcher.get("o/r", 1)).toEqual([]);
  });

  it("refreshAll on empty input is a no-op", async () => {
    let calls = 0;
    const runner: Runner = () => {
      calls++;
      return Promise.resolve({ stdout: "", ok: true });
    };
    const fetcher = createPreviewFetcher({ runner });
    await fetcher.refreshAll([]);
    expect(calls).toBe(0);
  });

  it("dedupes identical PR refs in a single refreshAll", async () => {
    let apiCalls = 0;
    const runner: Runner = (args) => {
      if (args[1] === "--version")
        return Promise.resolve({ stdout: "", ok: true });
      apiCalls++;
      return Promise.resolve({ stdout: "", ok: true });
    };
    const fetcher = createPreviewFetcher({ runner });
    await fetcher.refreshAll([
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 1 },
    ]);
    expect(apiCalls).toBe(2);
  });

  it("start triggers immediate refresh and stop clears interval", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh api repos/o/r/pulls/1/comments --paginate --jq .[].body",
      {
        stdout: "https://app.pages.dev\n",
        ok: true,
      },
    );
    responses.set(
      "gh api repos/o/r/deployments --jq [.[] | {environment, environment_url, state}]",
      { stdout: "", ok: true },
    );
    const fetcher = createPreviewFetcher({ runner: makeRunner(responses) });
    fetcher.start([{ repo: "o/r", number: 1 }], 60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetcher.get("o/r", 1).length).toBe(1);
    fetcher.stop();
  });
});

describe("previewBackoffMs", () => {
  it("returns 0 for streak <= 0", () => {
    expect(previewBackoffMs(0)).toBe(0);
    expect(previewBackoffMs(-1)).toBe(0);
  });

  it("matches the documented schedule", () => {
    expect(previewBackoffMs(1)).toBe(30_000);
    expect(previewBackoffMs(2)).toBe(60_000);
    expect(previewBackoffMs(3)).toBe(2 * 60_000);
    expect(previewBackoffMs(6)).toBe(30 * 60_000);
    expect(previewBackoffMs(100)).toBe(30 * 60_000);
  });
});

describe("createPreviewFetcher (Phase 5 — terminal-skip + backoff + force)", () => {
  it("refreshAll skips refs whose PR state is MERGED or CLOSED", async () => {
    let calls = 0;
    const runner: Runner = (args) => {
      if (args[1] === "--version")
        return Promise.resolve({ stdout: "", ok: true });
      calls++;
      return Promise.resolve({ stdout: "", ok: true });
    };
    const fetcher = createPreviewFetcher({
      runner,
      getPrState: (ref) => (ref.number === 1 ? "MERGED" : "OPEN"),
    });
    await fetcher.refreshAll([
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 2 },
    ]);
    // Only #2 should be fetched (2 calls — one for comments, one for deployments)
    expect(calls).toBe(2);
  });

  it("refreshAll skips refs with recent webhook event", async () => {
    let calls = 0;
    const runner: Runner = (args) => {
      if (args[1] === "--version")
        return Promise.resolve({ stdout: "", ok: true });
      calls++;
      return Promise.resolve({ stdout: "", ok: true });
    };
    const fetcher = createPreviewFetcher({
      runner,
      lastWebhookAt: () => Date.now() - 60_000, // 1 min ago
    });
    await fetcher.refreshAll([{ repo: "o/r", number: 1 }]);
    expect(calls).toBe(0);
  });

  it("refreshAll respects UNKNOWN backoff after both fetches fail", async () => {
    let calls = 0;
    const runner: Runner = (args) => {
      if (args[1] === "--version")
        return Promise.resolve({ stdout: "", ok: true });
      calls++;
      return Promise.resolve({ stdout: "", ok: false });
    };
    const fetcher = createPreviewFetcher({ runner });
    await fetcher.refreshAll([{ repo: "o/r", number: 5 }]);
    expect(calls).toBe(2);
    // Second call should be skipped due to backoff
    await fetcher.refreshAll([{ repo: "o/r", number: 5 }]);
    expect(calls).toBe(2);
  });

  it("force(ref) bypasses the filters", async () => {
    let calls = 0;
    const runner: Runner = (args) => {
      if (args[1] === "--version")
        return Promise.resolve({ stdout: "", ok: true });
      calls++;
      const path = args[2] ?? "";
      if (path.includes("comments")) return Promise.resolve({ stdout: "https://app.pages.dev\n", ok: true });
      return Promise.resolve({ stdout: "[]", ok: true });
    };
    const fetcher = createPreviewFetcher({
      runner,
      getPrState: () => "MERGED",
    });
    // refreshAll skips because PR is MERGED
    await fetcher.refreshAll([{ repo: "o/r", number: 1 }]);
    expect(calls).toBe(0);
    // force still works
    await fetcher.force({ repo: "o/r", number: 1 });
    expect(calls).toBe(2);
    expect(fetcher.get("o/r", 1).length).toBe(1);
  });

  it("successful fetch resets unknownStreak and clears nextRetryAt", async () => {
    let attempts = 0;
    const runner: Runner = (args) => {
      if (args[1] === "--version")
        return Promise.resolve({ stdout: "", ok: true });
      attempts++;
      const path = args[2] ?? "";
      // First attempt: both fail. Second attempt: both succeed.
      if (attempts <= 2) {
        return Promise.resolve({ stdout: "", ok: false });
      }
      if (path.includes("comments"))
        return Promise.resolve({
          stdout: "https://app.pages.dev\n",
          ok: true,
        });
      return Promise.resolve({ stdout: "[]", ok: true });
    };
    const fetcher = createPreviewFetcher({ runner });
    await fetcher.force({ repo: "o/r", number: 1 });
    await fetcher.force({ repo: "o/r", number: 1 });
    expect(fetcher.get("o/r", 1).length).toBe(1);
  });
});
