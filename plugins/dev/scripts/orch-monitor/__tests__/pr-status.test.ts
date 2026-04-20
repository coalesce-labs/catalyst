import { describe, it, expect } from "bun:test";
import {
  createPrStatusFetcher,
  fetchPrForBranch,
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
      "gh pr view 42 --repo owner/repo --json state,mergedAt,mergeStateStatus,isDraft",
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
      "gh pr view 1 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft",
      { stdout: '{"state":"OPEN","mergedAt":null}', ok: true },
    );
    responses.set(
      "gh pr view 2 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft",
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
    responses.set("gh pr view 5 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft", {
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
    responses.set("gh pr view 7 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft", {
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

  it("fetchPrForBranch returns null on empty list", async () => {
    const runner: Runner = (_args) =>
      Promise.resolve({ stdout: "[]", ok: true });
    const got = await fetchPrForBranch("o/r", "feat/x", runner);
    expect(got).toBeNull();
  });

  it("fetchPrForBranch returns normalized MERGED entry", async () => {
    const runner: Runner = (args) => {
      expect(args).toEqual([
        "gh",
        "pr",
        "list",
        "--repo",
        "o/r",
        "--head",
        "feat/x",
        "--state",
        "all",
        "--json",
        "number,state,mergedAt,mergeStateStatus,isDraft,url",
        "--limit",
        "1",
      ]);
      return Promise.resolve({
        stdout: JSON.stringify([
          {
            number: 42,
            state: "MERGED",
            mergedAt: "2026-04-13T12:00:00Z",
            url: "https://github.com/o/r/pull/42",
          },
        ]),
        ok: true,
      });
    };
    const got = await fetchPrForBranch("o/r", "feat/x", runner);
    expect(got).not.toBeNull();
    expect(got!.number).toBe(42);
    expect(got!.state).toBe("MERGED");
    expect(got!.mergedAt).toBe("2026-04-13T12:00:00Z");
    expect(got!.url).toBe("https://github.com/o/r/pull/42");
  });

  it("fetchPrForBranch normalizes DRAFT/unknown to UNKNOWN", async () => {
    const runner: Runner = () =>
      Promise.resolve({
        stdout: JSON.stringify([
          { number: 3, state: "DRAFT", mergedAt: null, url: "u" },
        ]),
        ok: true,
      });
    const got = await fetchPrForBranch("o/r", "b", runner);
    expect(got!.state).toBe("UNKNOWN");
    expect(got!.mergedAt).toBeNull();
  });

  it("fetchPrForBranch returns null on runner failure", async () => {
    const runner: Runner = () =>
      Promise.resolve({ stdout: "", ok: false });
    const got = await fetchPrForBranch("o/r", "b", runner);
    expect(got).toBeNull();
  });

  it("fetchPrForBranch returns null on malformed JSON", async () => {
    const runner: Runner = () =>
      Promise.resolve({ stdout: "not json{{", ok: true });
    const got = await fetchPrForBranch("o/r", "b", runner);
    expect(got).toBeNull();
  });

  it("fetchPrForBranch tolerates missing fields", async () => {
    const runner: Runner = () =>
      Promise.resolve({
        stdout: JSON.stringify([{ number: 1 }]),
        ok: true,
      });
    const got = await fetchPrForBranch("o/r", "b", runner);
    expect(got!.number).toBe(1);
    expect(got!.state).toBe("UNKNOWN");
    expect(got!.mergedAt).toBeNull();
    expect(got!.url).toBe("");
  });

  it("parses mergeStateStatus and isDraft when present", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh pr view 10 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft",
      {
        stdout:
          '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"BLOCKED","isDraft":false}',
        ok: true,
      },
    );
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "o/r", number: 10 }]);
    const got = fetcher.get("o/r", 10);
    expect(got).not.toBeNull();
    expect(got!.mergeStateStatus).toBe("BLOCKED");
    expect(got!.isDraft).toBe(false);
  });

  it("normalizes mergeStateStatus casing and unknown values", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "gh 2.0", ok: true });
    responses.set(
      "gh pr view 11 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft",
      {
        stdout:
          '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"dirty","isDraft":true}',
        ok: true,
      },
    );
    responses.set(
      "gh pr view 12 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft",
      {
        stdout:
          '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"WEIRD","isDraft":"yes"}',
        ok: true,
      },
    );
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([
      { repo: "o/r", number: 11 },
      { repo: "o/r", number: 12 },
    ]);
    const a = fetcher.get("o/r", 11);
    expect(a!.mergeStateStatus).toBe("DIRTY");
    expect(a!.isDraft).toBe(true);
    const b = fetcher.get("o/r", 12);
    expect(b!.mergeStateStatus).toBe("UNKNOWN");
    expect(b!.isDraft).toBe(false);
  });

  it("defaults mergeStateStatus/isDraft on gh failure", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set(
      "gh pr view 13 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft",
      { stdout: "", ok: false },
    );
    const fetcher = createPrStatusFetcher({ runner: makeRunner(responses) });
    await fetcher.refreshAll([{ repo: "o/r", number: 13 }]);
    const got = fetcher.get("o/r", 13);
    expect(got!.mergeStateStatus).toBe("UNKNOWN");
    expect(got!.isDraft).toBe(false);
  });

  it("fetchPrForBranch includes mergeStateStatus and isDraft", async () => {
    const runner: Runner = () =>
      Promise.resolve({
        stdout: JSON.stringify([
          {
            number: 77,
            state: "OPEN",
            mergedAt: null,
            mergeStateStatus: "BEHIND",
            isDraft: false,
            url: "https://github.com/o/r/pull/77",
          },
        ]),
        ok: true,
      });
    const got = await fetchPrForBranch("o/r", "feat/y", runner);
    expect(got!.mergeStateStatus).toBe("BEHIND");
    expect(got!.isDraft).toBe(false);
  });

  it("start triggers an immediate refresh and stop clears the interval", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set("gh pr view 9 --repo o/r --json state,mergedAt,mergeStateStatus,isDraft", {
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
