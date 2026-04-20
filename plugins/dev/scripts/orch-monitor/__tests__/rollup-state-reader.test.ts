import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOrchestratorState } from "../lib/state-reader";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rollup-state-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setupOrch(
  id: string,
  workers: Record<string, object>,
  fragments: Record<string, string> = {},
): string {
  const orchDir = join(tmpRoot, id);
  mkdirSync(join(orchDir, "workers"), { recursive: true });
  writeFileSync(
    join(orchDir, "state.json"),
    JSON.stringify({ id, startedAt: "2026-04-20T10:00:00Z", waves: [] }),
  );
  for (const [ticket, data] of Object.entries(workers)) {
    writeFileSync(
      join(orchDir, "workers", `${ticket}.json`),
      JSON.stringify(data, null, 2),
    );
  }
  for (const [ticket, body] of Object.entries(fragments)) {
    writeFileSync(join(orchDir, "workers", `${ticket}-rollup.md`), body);
  }
  return orchDir;
}

describe("readOrchestratorState — rollupBriefing", () => {
  it("is undefined when no workers have PRs and no fragments exist", () => {
    const orchDir = setupOrch("orch-empty", {
      "CTL-1": {
        ticket: "CTL-1",
        status: "done",
        phase: 5,
        startedAt: "",
        updatedAt: "",
      },
    });
    const state = readOrchestratorState(orchDir);
    expect(state.rollupBriefing).toBeUndefined();
  });

  it("populates whatShipped from workers with PR numbers", () => {
    const orchDir = setupOrch("orch-with-prs", {
      "CTL-42": {
        ticket: "CTL-42",
        status: "done",
        phase: 5,
        startedAt: "",
        updatedAt: "",
        pr: { number: 300, url: "https://github.com/a/b/pull/300", title: "feat: x" },
      },
    });
    const state = readOrchestratorState(orchDir);
    expect(state.rollupBriefing).toBeDefined();
    expect(state.rollupBriefing!.whatShipped).toHaveLength(1);
    expect(state.rollupBriefing!.whatShipped[0].ticket).toBe("CTL-42");
    expect(state.rollupBriefing!.whatShipped[0].pr).toBe(300);
  });

  it("reads worker rollup fragment files and wires them into gotchas", () => {
    const orchDir = setupOrch(
      "orch-with-fragments",
      {
        "CTL-5": {
          ticket: "CTL-5",
          status: "done",
          phase: 5,
          startedAt: "",
          updatedAt: "",
          pr: { number: 100, url: "https://github.com/a/b/pull/100" },
        },
      },
      { "CTL-5": "Heads up: migration runs on first boot." },
    );
    const state = readOrchestratorState(orchDir);
    expect(state.rollupBriefing).toBeDefined();
    expect(state.rollupBriefing!.gotchas).toContain("### CTL-5");
    expect(state.rollupBriefing!.gotchas).toContain(
      "Heads up: migration runs on first boot.",
    );
    expect(state.rollupBriefing!.whatShipped[0].oneliner).toContain(
      "Heads up",
    );
  });

  it("includes orphan fragments (no matching worker PR) in gotchas", () => {
    const orchDir = setupOrch(
      "orch-orphan-fragment",
      {},
      { "CTL-9": "Important note with no worker signal." },
    );
    const state = readOrchestratorState(orchDir);
    expect(state.rollupBriefing).toBeDefined();
    expect(state.rollupBriefing!.whatShipped).toHaveLength(0);
    expect(state.rollupBriefing!.gotchas).toContain("CTL-9");
  });

  it("ignores files that don't match the *-rollup.md pattern", () => {
    const orchDir = setupOrch(
      "orch-noise",
      {
        "CTL-1": {
          ticket: "CTL-1",
          status: "done",
          phase: 5,
          startedAt: "",
          updatedAt: "",
          pr: { number: 1, url: "" },
        },
      },
    );
    // write noise files in workers/
    writeFileSync(join(orchDir, "workers", "README.md"), "readme");
    writeFileSync(join(orchDir, "workers", "CTL-1-notes.md"), "notes");

    const state = readOrchestratorState(orchDir);
    expect(state.rollupBriefing).toBeDefined();
    expect(state.rollupBriefing!.gotchas).toBe("");
  });
});
