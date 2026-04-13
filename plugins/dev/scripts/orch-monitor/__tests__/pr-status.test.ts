import { describe, it, expect } from "bun:test";
import {
  createPrStatusFetcher,
  parseRepoFromPrUrl,
  type Runner,
  type RunnerResult,
} from "../lib/pr-status";

describe("parseRepoFromPrUrl", () => {
  it("parses a standard github PR URL", () => {
    expect(
      parseRepoFromPrUrl("https://github.com/rightsite-cloud/Adva/pull/123"),
    ).toBe("rightsite-cloud/Adva");
  });

  it("parses http (not just https)", () => {
    expect(parseRepoFromPrUrl("http://github.com/owner/repo/pull/1")).toBe(
      "owner/repo",
    );
  });

  it("returns null for missing path", () => {
    expect(parseRepoFromPrUrl("https://github.com/")).toBeNull();
  });

  it("returns null for non-github URL", () => {
    expect(parseRepoFromPrUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull();
  });

  it("returns null for empty/non-string", () => {
    expect(parseRepoFromPrUrl("")).toBeNull();
    // @ts-expect-error testing invalid input
    expect(parseRepoFromPrUrl(undefined)).toBeNull();
  });
});

function makeRunner(
  responses: Map<string, RunnerResult> | ((args: string[]) => RunnerResult),
): Runner {
  return (args) => {
    if (typeof responses === "function") return Promise.resolve(responses(args));
    const key = args.join(" ");
    return Promise.resolve(responses.get(key) ?? { stdout: "", ok: false });
  };
}

describe("createPrStatusFetcher", () => {
  it("get returns null when cache is empty", () => {
    const fetcher = createPrStatusFetcher({
      runner: makeRunner(new Map()),
    });
    expect(fetcher.get("owner/repo", 1)).toBeNull();
  });

  it("refreshAll updates cache from runner output", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh pr view 42 --repo owner/repo --json state,mergedAt",
      { stdout: '{"state":"MERGED","mergedAt":"2026-04-13T12:00:00Z"}', ok: true },
    );
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "owner/repo", number: 42 }]);
    const got = fetcher.get("owner/repo", 42);
    expect(got).not.toBeNull();
    expect(got!.state).toBe("MERGED");
    expect(got!.mergedAt).toBe("2026-04-13T12:00:00Z");
    expect(got!.number).toBe(42);
    expect(typeof got!.fetchedAt).toBe("string");
  });

  it("normalizes OPEN/CLOSED/MERGED and falls back to UNKNOWN for others", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh pr view 1 --repo o/r --json state,mergedAt",
      { stdout: '{"state":"OPEN","mergedAt":null}', ok: true },
    );
    responses.set(
      "gh pr view 2 --repo o/r --json state,mergedAt",
      { stdout: '{"state":"DRAFT","mergedAt":null}', ok: true },
    );
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 2 },
    ]);
    expect(fetcher.get("o/r", 1)?.state).toBe("OPEN");
    expect(fetcher.get("o/r", 1)?.mergedAt).toBeNull();
    expect(fetcher.get("o/r", 2)?.state).toBe("UNKNOWN");
  });

  it("dedupes identical PR refs in a single refreshAll", async () => {
    let viewCalls = 0;
    const runner: Runner = (args) => {
      if (args[1] === "--version") return Promise.resolve({ stdout: "", ok: true });
      viewCalls++;
      return Promise.resolve({ stdout: '{"state":"OPEN","mergedAt":null}', ok: true });
    };
    const fetcher = createPrStatusFetcher({ runner });
    await fetcher.refreshAll([
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 1 },
    ]);
    expect(viewCalls).toBe(1);
  });

  it("degrades silently when gh probe fails", async () => {
    const runner: Runner = (args) => {
      if (args[1] === "--version") return Promise.resolve({ stdout: "", ok: false });
      throw new Error("gh should not be invoked after probe failure");
    };
    const fetcher = createPrStatusFetcher({ runner });
    await fetcher.refreshAll([{ repo: "o/r", number: 1 }]);
    expect(fetcher.get("o/r", 1)).toBeNull();
  });

  it("degrades silently when runner throws on probe", async () => {
    const runner: Runner = () => {
      throw new Error("spawn failed");
    };
    let threw = false;
    const fetcher = createPrStatusFetcher({ runner });
    try {
      await fetcher.refreshAll([{ repo: "o/r", number: 1 }]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(fetcher.get("o/r", 1)).toBeNull();
  });

  it("caches state=UNKNOWN on JSON parse error", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set("gh pr view 5 --repo o/r --json state,mergedAt", {
      stdout: "not json{{",
      ok: true,
    });
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "o/r", number: 5 }]);
    expect(fetcher.get("o/r", 5)?.state).toBe("UNKNOWN");
  });

  it("caches state=UNKNOWN when gh pr view exits non-zero", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set("gh pr view 7 --repo o/r --json state,mergedAt", {
      stdout: "",
      ok: false,
    });
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "o/r", number: 7 }]);
    expect(fetcher.get("o/r", 7)?.state).toBe("UNKNOWN");
  });

  it("refreshAll on empty input is a no-op (doesn't even probe)", async () => {
    let calls = 0;
    const runner: Runner = () => {
      calls++;
      return Promise.resolve({ stdout: "", ok: true });
    };
    const fetcher = createPrStatusFetcher({ runner });
    await fetcher.refreshAll([]);
    expect(calls).toBe(0);
  });

  it("start triggers an immediate refresh and stop clears the interval", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set("gh pr view 9 --repo o/r --json state,mergedAt", {
      stdout: '{"state":"OPEN","mergedAt":null}',
      ok: true,
    });
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    fetcher.start([{ repo: "o/r", number: 9 }], 60_000);
    // Wait a tick for the immediate refresh to flush
    await new Promise((r) => setTimeout(r, 50));
    expect(fetcher.get("o/r", 9)?.state).toBe("OPEN");
    fetcher.stop();
  });
});
