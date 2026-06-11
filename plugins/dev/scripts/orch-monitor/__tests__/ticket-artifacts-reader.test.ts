// CTL-889 (P9): unit tests for the ticket-artifacts reader. Pure logic — the
// directory lister + file reader are injected, so no real thoughts tree.
// Encodes the Gherkin acceptance scenario:
//   • "Artifacts resolve to thoughts paths" (returns
//      thoughts/shared/{research,plan}/*-<ticket>.md paths for the spine 📄 links;
//      cross-node visibility gated on a thoughts-sync push — eventual consistency)
import { describe, it, expect } from "bun:test";
import {
  buildArtifactList,
  readTicketArtifacts,
} from "../lib/ticket-artifacts-reader.mjs";

// Build a fake thoughts tree: dirname → [filenames]. The reader scans
// "research" and "plans" (and tolerates "plan").
function fakeTree(tree: Record<string, string[]>) {
  const lister = (dir: string): string[] => {
    const key = Object.keys(tree).find((k) => dir.endsWith(k));
    if (!key) throw new Error("ENOENT");
    return tree[key];
  };
  const reader = (path: string): string =>
    `# peek of ${path.split("/").pop()}\n\nbody`;
  return { lister, reader };
}

describe("buildArtifactList — thoughts artifact resolution (P9)", () => {
  it("resolves research + plan paths for a ticket with the spine 📄 links", async () => {
    const { lister, reader } = fakeTree({
      research: [
        "2026-06-08-CTL-845-research.md",
        "2026-06-08-CTL-900-other.md",
      ],
      plans: ["2026-06-08-CTL-845.md"],
    });
    const out = await buildArtifactList("CTL-845", {
      thoughtsDir: "/repo/thoughts/shared",
      lister,
      reader,
    });
    const paths = out.artifacts.map((a) => a.path).sort();
    expect(paths).toContain("thoughts/shared/research/2026-06-08-CTL-845-research.md");
    expect(paths).toContain("thoughts/shared/plans/2026-06-08-CTL-845.md");
    // The unrelated CTL-900 file is excluded.
    expect(paths).not.toContain("thoughts/shared/research/2026-06-08-CTL-900-other.md");
    // research sorts before plan.
    expect(out.artifacts[0].kind).toBe("research");
    expect(out.artifacts[out.artifacts.length - 1].kind).toBe("plan");
  });

  it("matches the ticket id whether suffixed OR embedded mid-name (case-insensitive)", async () => {
    const { lister, reader } = fakeTree({
      research: [
        "2026-06-07-ctl-845-humanlayer-thoughts-init-crash.md", // embedded, lowercase
        "2026-06-08-CTL-845.md", // suffixed
      ],
      plans: [],
    });
    const out = await buildArtifactList("CTL-845", {
      thoughtsDir: "/repo/thoughts/shared",
      lister,
      reader,
    });
    expect(out.artifacts.map((a) => a.path)).toEqual(
      expect.arrayContaining([
        "thoughts/shared/research/2026-06-07-ctl-845-humanlayer-thoughts-init-crash.md",
        "thoughts/shared/research/2026-06-08-CTL-845.md",
      ]),
    );
  });

  it("does NOT match a longer ticket id by prefix (CTL-84 ≠ CTL-845)", async () => {
    const { lister, reader } = fakeTree({
      research: ["2026-06-08-CTL-845-research.md"],
      plans: [],
    });
    const out = await buildArtifactList("CTL-84", {
      thoughtsDir: "/repo/thoughts/shared",
      lister,
      reader,
    });
    expect(out.artifacts).toEqual([]);
  });

  it("includes a peek preview and the cross-node eventual-consistency caveat", async () => {
    const { lister, reader } = fakeTree({
      research: ["2026-06-08-CTL-845.md"],
      plans: [],
    });
    const out = await buildArtifactList("CTL-845", {
      thoughtsDir: "/repo/thoughts/shared",
      lister,
      reader,
    });
    expect(out.artifacts[0].peek).toContain("# peek of 2026-06-08-CTL-845.md");
    // CTL-866 caveat is surfaced on every response (eventual consistency).
    expect(out.crossNodeCaveat).toMatch(/thoughts-sync push/);
    expect(out.crossNodeCaveat).toMatch(/eventual consistency/i);
  });

  it("degrades to an empty list (never throws) when the thoughts dirs are absent", async () => {
    const out = await buildArtifactList("CTL-845", {
      thoughtsDir: "/repo/thoughts/shared",
      lister: () => {
        throw new Error("ENOENT");
      },
      reader: () => "",
    });
    expect(out.artifacts).toEqual([]);
    expect(out.ticket).toBe("CTL-845");
  });
});

describe("readTicketArtifacts — route-facing reader (P9)", () => {
  it("resolves against an injected cwd + fs collaborators", async () => {
    const out = await readTicketArtifacts("CTL-845", {
      cwd: "/repo",
      lister: (dir: string) =>
        dir.endsWith("research") ? ["2026-06-08-CTL-845.md"] : [],
      reader: () => "# body",
    });
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0].path).toBe("thoughts/shared/research/2026-06-08-CTL-845.md");
  });
});
