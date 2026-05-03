import { describe, it, expect } from "bun:test";
import {
  createPrStatusFetcher,
  fetchPrForBranch,
  parseRepoFromPrUrl,
  unknownBackoffMs,
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

describe("unknownBackoffMs", () => {
  it("returns 0 for streak <= 0", () => {
    expect(unknownBackoffMs(0)).toBe(0);
    expect(unknownBackoffMs(-1)).toBe(0);
  });

  it("follows the schedule 30s, 60s, 2m, 5m, 15m, 30m", () => {
    expect(unknownBackoffMs(1)).toBe(30_000);
    expect(unknownBackoffMs(2)).toBe(60_000);
    expect(unknownBackoffMs(3)).toBe(2 * 60_000);
    expect(unknownBackoffMs(4)).toBe(5 * 60_000);
    expect(unknownBackoffMs(5)).toBe(15 * 60_000);
    expect(unknownBackoffMs(6)).toBe(30 * 60_000);
  });

  it("clamps at 30 minutes for streak > 6", () => {
    expect(unknownBackoffMs(7)).toBe(30 * 60_000);
    expect(unknownBackoffMs(100)).toBe(30 * 60_000);
  });
});

describe("createPrStatusFetcher (Phase 0 — terminal-skip + UNKNOWN backoff)", () => {
  const VIEW_ARGS = "--json state,mergedAt,mergeStateStatus,isDraft";

  function viewKey(num: number, repo = "o/r"): string {
    return `gh pr view ${num} --repo ${repo} ${VIEW_ARGS}`;
  }

  it("refreshAll skips refs whose cached state is MERGED", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    let viewCalls = 0;
    const runner: Runner = (args) => {
      const key = args.join(" ");
      const cached = responses.get(key);
      if (cached) return Promise.resolve(cached);
      if (args[1] === "pr" && args[2] === "view") viewCalls++;
      return Promise.resolve({
        stdout: '{"state":"MERGED","mergedAt":"2026-04-13T12:00:00Z"}',
        ok: true,
      });
    };
    const fetcher = createPrStatusFetcher({ runner });
    // Prime the cache as MERGED
    await fetcher.refreshAll([{ repo: "o/r", number: 42 }]);
    expect(viewCalls).toBe(1);
    expect(fetcher.get("o/r", 42)?.state).toBe("MERGED");
    // Second refresh should skip the MERGED ref
    await fetcher.refreshAll([{ repo: "o/r", number: 42 }]);
    expect(viewCalls).toBe(1);
  });

  it("refreshAll skips refs whose cached state is CLOSED", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    let viewCalls = 0;
    const runner: Runner = (args) => {
      const key = args.join(" ");
      const cached = responses.get(key);
      if (cached) return Promise.resolve(cached);
      if (args[1] === "pr" && args[2] === "view") viewCalls++;
      return Promise.resolve({
        stdout: '{"state":"CLOSED","mergedAt":null}',
        ok: true,
      });
    };
    const fetcher = createPrStatusFetcher({ runner });
    await fetcher.refreshAll([{ repo: "o/r", number: 50 }]);
    expect(viewCalls).toBe(1);
    expect(fetcher.get("o/r", 50)?.state).toBe("CLOSED");
    await fetcher.refreshAll([{ repo: "o/r", number: 50 }]);
    expect(viewCalls).toBe(1);
  });

  it("refreshAll respects UNKNOWN backoff (does not refetch before nextRetryAt)", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set(viewKey(60), { stdout: "", ok: false });
    let viewCalls = 0;
    const runner: Runner = (args) => {
      const key = args.join(" ");
      const cached = responses.get(key);
      if (args[1] === "pr" && args[2] === "view") viewCalls++;
      return Promise.resolve(cached ?? { stdout: "", ok: false });
    };
    const fetcher = createPrStatusFetcher({ runner });
    // First call → UNKNOWN, sets nextRetryAt 30s in the future
    await fetcher.refreshAll([{ repo: "o/r", number: 60 }]);
    expect(viewCalls).toBe(1);
    const cached = fetcher.get("o/r", 60);
    expect(cached?.state).toBe("UNKNOWN");
    expect(cached?.unknownStreak).toBe(1);
    expect(cached?.nextRetryAt).not.toBeNull();
    expect(new Date(cached!.nextRetryAt!).getTime()).toBeGreaterThan(Date.now());
    // Second call before nextRetryAt → skipped
    await fetcher.refreshAll([{ repo: "o/r", number: 60 }]);
    expect(viewCalls).toBe(1);
  });

  it("refreshAll refetches UNKNOWN ref once nextRetryAt is in the past", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    let viewCalls = 0;
    const runner: Runner = (args) => {
      const key = args.join(" ");
      if (args[1] === "pr" && args[2] === "view") viewCalls++;
      return Promise.resolve(responses.get(key) ?? { stdout: "", ok: false });
    };
    const fetcher = createPrStatusFetcher({ runner });
    // First call → UNKNOWN
    responses.set(viewKey(70), { stdout: "", ok: false });
    await fetcher.refreshAll([{ repo: "o/r", number: 70 }]);
    expect(viewCalls).toBe(1);
    // Manually rewind nextRetryAt into the past
    const cached = fetcher.get("o/r", 70);
    expect(cached?.nextRetryAt).not.toBeNull();
    cached!.nextRetryAt = new Date(Date.now() - 1000).toISOString();
    // Now success on retry
    responses.set(viewKey(70), {
      stdout: '{"state":"OPEN","mergedAt":null}',
      ok: true,
    });
    await fetcher.refreshAll([{ repo: "o/r", number: 70 }]);
    expect(viewCalls).toBe(2);
    expect(fetcher.get("o/r", 70)?.state).toBe("OPEN");
  });

  it("successful fetch resets unknownStreak to 0 and clears nextRetryAt", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set(viewKey(80), { stdout: "", ok: false });
    const fetcher = createPrStatusFetcher({
      runner: makeRunner(responses),
    });
    // First call fails → unknownStreak=1
    await fetcher.refreshAll([{ repo: "o/r", number: 80 }]);
    expect(fetcher.get("o/r", 80)?.unknownStreak).toBe(1);
    expect(fetcher.get("o/r", 80)?.nextRetryAt).not.toBeNull();
    // Force a retry with success
    responses.set(viewKey(80), {
      stdout: '{"state":"OPEN","mergedAt":null}',
      ok: true,
    });
    await fetcher.force({ repo: "o/r", number: 80 });
    const cached = fetcher.get("o/r", 80);
    expect(cached?.state).toBe("OPEN");
    expect(cached?.unknownStreak).toBe(0);
    expect(cached?.nextRetryAt).toBeNull();
  });

  it("consecutive UNKNOWN responses extend nextRetryAt per backoff schedule", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    responses.set(viewKey(90), { stdout: "", ok: false });
    const fetcher = createPrStatusFetcher({
      runner: makeRunner(responses),
    });
    const before1 = Date.now();
    await fetcher.force({ repo: "o/r", number: 90 });
    const c1 = fetcher.get("o/r", 90);
    expect(c1?.unknownStreak).toBe(1);
    const delay1 = new Date(c1!.nextRetryAt!).getTime() - before1;
    // streak=1 → 30s ± 100ms
    expect(delay1).toBeGreaterThanOrEqual(30_000 - 100);
    expect(delay1).toBeLessThanOrEqual(30_000 + 100);

    const before2 = Date.now();
    await fetcher.force({ repo: "o/r", number: 90 });
    const c2 = fetcher.get("o/r", 90);
    expect(c2?.unknownStreak).toBe(2);
    const delay2 = new Date(c2!.nextRetryAt!).getTime() - before2;
    // streak=2 → 60s
    expect(delay2).toBeGreaterThanOrEqual(60_000 - 100);
    expect(delay2).toBeLessThanOrEqual(60_000 + 100);

    const before3 = Date.now();
    await fetcher.force({ repo: "o/r", number: 90 });
    const c3 = fetcher.get("o/r", 90);
    expect(c3?.unknownStreak).toBe(3);
    const delay3 = new Date(c3!.nextRetryAt!).getTime() - before3;
    // streak=3 → 2m
    expect(delay3).toBeGreaterThanOrEqual(2 * 60_000 - 100);
    expect(delay3).toBeLessThanOrEqual(2 * 60_000 + 100);
  });

  it("force(ref) re-fetches a MERGED ref bypassing the filter", async () => {
    const responses = new Map<string, RunnerResult>();
    responses.set("gh --version", { stdout: "", ok: true });
    let viewCalls = 0;
    const runner: Runner = (args) => {
      const key = args.join(" ");
      const cached = responses.get(key);
      if (cached) return Promise.resolve(cached);
      if (args[1] === "pr" && args[2] === "view") viewCalls++;
      return Promise.resolve({
        stdout: '{"state":"MERGED","mergedAt":"2026-04-13T12:00:00Z"}',
        ok: true,
      });
    };
    const fetcher = createPrStatusFetcher({ runner });
    // Prime cache as MERGED
    await fetcher.refreshAll([{ repo: "o/r", number: 100 }]);
    expect(viewCalls).toBe(1);
    expect(fetcher.get("o/r", 100)?.state).toBe("MERGED");
    // refreshAll skips it
    await fetcher.refreshAll([{ repo: "o/r", number: 100 }]);
    expect(viewCalls).toBe(1);
    // force() bypasses the filter
    await fetcher.force({ repo: "o/r", number: 100 });
    expect(viewCalls).toBe(2);
  });
});
