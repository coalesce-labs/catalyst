import { describe, it, expect } from "bun:test";
import { assembleRollup } from "../lib/rollup";
import type { WorkerState } from "../lib/state-reader";

function makeWorker(overrides: Partial<WorkerState> & { ticket: string }): WorkerState {
  const base: WorkerState = {
    ticket: overrides.ticket,
    label: null,
    status: "done",
    phase: 5,
    wave: null,
    pid: null,
    alive: false,
    pr: null,
    startedAt: "",
    updatedAt: "",
    timeSinceUpdate: 0,
    lastHeartbeat: null,
    definitionOfDone: {},
  };
  return { ...base, ...overrides };
}

const GEN_AT = "2026-04-20T12:00:00Z";

describe("assembleRollup", () => {
  it("returns null when orchestrator has no PRs and no fragments", () => {
    const result = assembleRollup(
      { id: "orch-1", startedAt: "", workers: {} },
      {},
      GEN_AT,
    );
    expect(result).toBeNull();
  });

  it("includes workers with PR numbers in whatShipped, sorted by ticket", () => {
    const result = assembleRollup(
      {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-42": makeWorker({
            ticket: "CTL-42",
            pr: { number: 300, url: "https://github.com/a/b/pull/300", title: "feat: beta" },
          }),
          "CTL-10": makeWorker({
            ticket: "CTL-10",
            pr: { number: 299, url: "https://github.com/a/b/pull/299", title: "feat: alpha" },
          }),
        },
      },
      {},
      GEN_AT,
    );
    expect(result).not.toBeNull();
    expect(result!.whatShipped).toHaveLength(2);
    expect(result!.whatShipped[0].ticket).toBe("CTL-10");
    expect(result!.whatShipped[0].pr).toBe(299);
    expect(result!.whatShipped[0].title).toBe("feat: alpha");
    expect(result!.whatShipped[1].ticket).toBe("CTL-42");
    expect(result!.generatedBy).toBe("auto");
    expect(result!.generatedAt).toBe(GEN_AT);
  });

  it("falls back to ticket when PR title missing", () => {
    const result = assembleRollup(
      {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-5": makeWorker({
            ticket: "CTL-5",
            pr: { number: 42, url: "" },
          }),
        },
      },
      {},
      GEN_AT,
    );
    expect(result!.whatShipped[0].title).toBe("CTL-5");
  });

  it("skips workers without a PR number", () => {
    const result = assembleRollup(
      {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-1": makeWorker({ ticket: "CTL-1", pr: null }),
          "CTL-2": makeWorker({
            ticket: "CTL-2",
            pr: { number: 7, url: "" },
          }),
        },
      },
      {},
      GEN_AT,
    );
    expect(result!.whatShipped).toHaveLength(1);
    expect(result!.whatShipped[0].ticket).toBe("CTL-2");
  });

  it("populates whatToSee with PR URLs when PRs exist", () => {
    const result = assembleRollup(
      {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-5": makeWorker({
            ticket: "CTL-5",
            pr: { number: 101, url: "https://github.com/a/b/pull/101" },
          }),
        },
      },
      {},
      GEN_AT,
    );
    expect(result!.whatToSee).toContain("https://github.com/a/b/pull/101");
  });

  it("concatenates worker fragments into gotchas under per-ticket headings, sorted", () => {
    const result = assembleRollup(
      {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-1": makeWorker({
            ticket: "CTL-1",
            pr: { number: 1, url: "" },
          }),
          "CTL-2": makeWorker({
            ticket: "CTL-2",
            pr: { number: 2, url: "" },
          }),
        },
      },
      {
        "CTL-2": "Migration runs on first boot.",
        "CTL-1": "Feature flag default is on.",
      },
      GEN_AT,
    );
    expect(result!.gotchas).toContain("### CTL-1");
    expect(result!.gotchas).toContain("Feature flag default is on.");
    expect(result!.gotchas).toContain("### CTL-2");
    expect(result!.gotchas.indexOf("### CTL-1")).toBeLessThan(
      result!.gotchas.indexOf("### CTL-2"),
    );
  });

  it("returns rollup with only fragments when no PRs present", () => {
    const result = assembleRollup(
      {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-3": makeWorker({ ticket: "CTL-3" }),
        },
      },
      { "CTL-3": "Important note." },
      GEN_AT,
    );
    expect(result).not.toBeNull();
    expect(result!.whatShipped).toHaveLength(0);
    expect(result!.whatToSee).toBe("");
    expect(result!.gotchas).toContain("Important note.");
  });

  it("sets oneliner to first non-blank line of fragment, truncated", () => {
    const fragment = "  \n\nFirst meaningful line that is quite long ".padEnd(200, "x") +
      "\nSecond line";
    const result = assembleRollup(
      {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-9": makeWorker({
            ticket: "CTL-9",
            pr: { number: 5, url: "" },
          }),
        },
      },
      { "CTL-9": fragment },
      GEN_AT,
    );
    const item = result!.whatShipped[0];
    expect(item.oneliner).toBeDefined();
    expect(item.oneliner!.length).toBeLessThanOrEqual(120);
    expect(item.oneliner!.startsWith("First meaningful line")).toBe(true);
  });

  it("is structurally idempotent given same generatedAt", () => {
    const args = {
      orch: {
        id: "orch-1",
        startedAt: "",
        workers: {
          "CTL-1": makeWorker({
            ticket: "CTL-1",
            pr: { number: 7, url: "https://x/7", title: "feat: x" },
          }),
        },
      },
      fragments: { "CTL-1": "note" },
    };
    const a = assembleRollup(args.orch, args.fragments, GEN_AT);
    const b = assembleRollup(args.orch, args.fragments, GEN_AT);
    expect(a).toEqual(b);
  });
});
