import { describe, it, expect } from "bun:test";
import {
  resolveOrchestrator,
  type ActiveOrchestrator,
} from "../lib/orchestrator-resolver";

const ACTIVE: ActiveOrchestrator[] = [
  {
    id: "orch-foo-2026-05-04",
    branchPrefix: "orch-foo-2026-05-04-",
    prs: [
      { repo: "owner/repo", number: 100 },
      { repo: "owner/repo", number: 101 },
    ],
  },
  {
    id: "orch-bar-2026-05-04",
    branchPrefix: "orch-bar-2026-05-04-",
    prs: [{ repo: "owner/repo", number: 200 }],
  },
];

describe("resolveOrchestrator", () => {
  it("returns null when no active orchestrators", () => {
    expect(resolveOrchestrator({ repo: "owner/repo", pr: 100 }, [])).toBeNull();
  });

  it("matches by (repo, pr)", () => {
    expect(
      resolveOrchestrator({ repo: "owner/repo", pr: 100 }, ACTIVE),
    ).toBe("orch-foo-2026-05-04");
    expect(
      resolveOrchestrator({ repo: "owner/repo", pr: 200 }, ACTIVE),
    ).toBe("orch-bar-2026-05-04");
  });

  it("returns null when PR doesn't belong to any orchestrator", () => {
    expect(
      resolveOrchestrator({ repo: "owner/repo", pr: 999 }, ACTIVE),
    ).toBeNull();
  });

  it("does not cross-match PRs across repos with same number", () => {
    expect(
      resolveOrchestrator({ repo: "other/repo", pr: 100 }, ACTIVE),
    ).toBeNull();
  });

  it("matches by head ref prefix", () => {
    expect(
      resolveOrchestrator(
        { repo: "owner/repo", headRef: "orch-foo-2026-05-04-CTL-234" },
        ACTIVE,
      ),
    ).toBe("orch-foo-2026-05-04");
  });

  it("requires the trailing dash on the prefix (no false-positive on similar IDs)", () => {
    const overlap: ActiveOrchestrator[] = [
      {
        id: "orch-foo",
        branchPrefix: "orch-foo-",
        prs: [],
      },
    ];
    // "orch-foobar-1" must NOT match "orch-foo-" — different orchestrator family.
    expect(
      resolveOrchestrator(
        { repo: "owner/repo", headRef: "orch-foobar-1" },
        overlap,
      ),
    ).toBeNull();
  });

  it("PR number match takes precedence over head ref", () => {
    // PR 100 is owned by orch-foo, but headRef points at orch-bar's prefix.
    // We trust the PR-number lookup (more specific).
    const conflictActive: ActiveOrchestrator[] = [
      {
        id: "orch-foo",
        branchPrefix: "orch-foo-",
        prs: [{ repo: "owner/repo", number: 100 }],
      },
      {
        id: "orch-bar",
        branchPrefix: "orch-bar-",
        prs: [],
      },
    ];
    expect(
      resolveOrchestrator(
        { repo: "owner/repo", pr: 100, headRef: "orch-bar-CTL-99" },
        conflictActive,
      ),
    ).toBe("orch-foo");
  });

  it("falls back to head ref when PR is set but unknown", () => {
    expect(
      resolveOrchestrator(
        {
          repo: "owner/repo",
          pr: 555,
          headRef: "orch-foo-2026-05-04-CTL-1",
        },
        ACTIVE,
      ),
    ).toBe("orch-foo-2026-05-04");
  });

  it("returns null when neither pr nor headRef is provided", () => {
    expect(resolveOrchestrator({ repo: "owner/repo" }, ACTIVE)).toBeNull();
  });

  it("returns null when headRef is empty string", () => {
    expect(
      resolveOrchestrator(
        { repo: "owner/repo", headRef: "" },
        ACTIVE,
      ),
    ).toBeNull();
  });

  it("prefers the longest matching prefix when multiple match", () => {
    const nested: ActiveOrchestrator[] = [
      {
        id: "orch-a",
        branchPrefix: "orch-a-",
        prs: [],
      },
      {
        id: "orch-a-b",
        branchPrefix: "orch-a-b-",
        prs: [],
      },
    ];
    // headRef starts with both "orch-a-" and "orch-a-b-" — pick the more specific one.
    expect(
      resolveOrchestrator(
        { repo: "owner/repo", headRef: "orch-a-b-CTL-1" },
        nested,
      ),
    ).toBe("orch-a-b");
  });
});
