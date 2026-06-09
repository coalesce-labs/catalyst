// repo-scope.test.ts — the PURE workspace-switcher core (CTL-897 / SHELL7).
// Encodes the four CTL-897 Gherkin scenarios at the logic layer (no DOM):
//   - single-repo config → bare label, no dropdown
//   - multi-repo config → All + per-repo dropdown, each with a scope dot
//   - active scope shows a checkmark
//   - selecting a scope filters the payload; All restores the unfiltered view
import { describe, expect, it } from "bun:test";
import type {
  BoardPayload,
  BoardTicket,
  BoardWorker,
  BoardQueueItem,
} from "../board/types";
import {
  REPO_SCOPE_ALL,
  filterPayloadByScope,
  isActiveScope,
  isMultiRepo,
  resolveScope,
  scopeOptions,
  singleRepoLabel,
} from "./repo-scope";

// ── tiny fixtures (only the fields the scope filter reads) ──────────────────
function ticket(id: string, repo: string): BoardTicket {
  return {
    id,
    title: id,
    type: "feature",
    repo,
    team: "T",
    phase: "implement",
    status: "Implement",
    model: null,
    linearState: "Implement",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 3,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-08T00:00:00Z",
  };
}
function worker(name: string, repo: string): BoardWorker {
  return {
    name,
    ticket: name,
    tickets: [name],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 0,
    repo,
    team: "T",
    runtimeMs: null,
    costUSD: null,
  };
}
function queueItem(id: string, repo: string): BoardQueueItem {
  return {
    id,
    title: id,
    priority: 3,
    createdAt: "2026-06-08T00:00:00Z",
    repo,
    team: "T",
    rank: 1,
    estimate: null,
    scope: null,
    project: null,
  };
}
function payload(repos: string[]): BoardPayload {
  return {
    generatedAt: "2026-06-08T00:00:00Z",
    config: { maxParallel: 4, inFlight: 0, freeSlots: 4, active: 0, working: 0, stuck: 0 },
    repos,
    workers: [worker("CTL-1", "catalyst"), worker("ADV-1", "adva")],
    tickets: [ticket("CTL-1", "catalyst"), ticket("ADV-1", "adva"), ticket("CTL-2", "catalyst")],
    queue: [queueItem("CTL-3", "catalyst"), queueItem("ADV-2", "adva")],
  };
}

describe("Scenario: Single-repo config shows just a label", () => {
  it("is not a dropdown when there is exactly one repo", () => {
    expect(isMultiRepo(["catalyst"])).toBe(false);
  });
  it("exposes that one repo's label", () => {
    expect(singleRepoLabel(["catalyst"])).toBe("catalyst");
  });
  it("renders no label when the config has not loaded (zero repos)", () => {
    expect(isMultiRepo([])).toBe(false);
    expect(singleRepoLabel([])).toBeNull();
  });
});

describe("Scenario: Multi-repo config shows a scoping dropdown", () => {
  const repos = ["catalyst", "adva", "otel"];
  it("is a dropdown with two or more repos", () => {
    expect(isMultiRepo(repos)).toBe(true);
  });
  it("lists All plus each repo in config order", () => {
    const opts = scopeOptions(repos);
    expect(opts.map((o) => o.scope)).toEqual([REPO_SCOPE_ALL, "catalyst", "adva", "otel"]);
    expect(opts[0]).toMatchObject({ label: "All", isRepo: false });
    expect(opts.slice(1).every((o) => o.isRepo)).toBe(true);
  });
  it("threads a colored scope dot per repo from the config (never invents one)", () => {
    const colors = { catalyst: { text: "#c8a8f4" }, adva: { text: "#9ec7f4" } };
    const opts = scopeOptions(repos, colors);
    expect(opts.find((o) => o.scope === "catalyst")?.dotColor).toBe("#c8a8f4");
    expect(opts.find((o) => o.scope === "adva")?.dotColor).toBe("#9ec7f4");
    // otel has no configured color → no fabricated dot color (neutral fallback).
    expect(opts.find((o) => o.scope === "otel")?.dotColor).toBeUndefined();
    // The synthetic All entry carries no scope dot.
    expect(opts[0].dotColor).toBeUndefined();
  });
});

describe("Scenario: the active scope shows a checkmark", () => {
  const opts = scopeOptions(["catalyst", "adva"]);
  it("marks exactly the active scope active", () => {
    const active = "adva";
    expect(opts.filter((o) => isActiveScope(o, active)).map((o) => o.scope)).toEqual(["adva"]);
  });
  it("marks All active when the scope is the all-sentinel", () => {
    expect(opts.filter((o) => isActiveScope(o, REPO_SCOPE_ALL)).map((o) => o.scope)).toEqual([
      REPO_SCOPE_ALL,
    ]);
  });
});

describe("Scenario: Scope actually filters the data", () => {
  const repos = ["catalyst", "adva"];
  it("restricts workers / tickets / queue to a selected repo", () => {
    const scoped = filterPayloadByScope(payload(repos), "catalyst");
    expect(scoped.workers.map((w) => w.name)).toEqual(["CTL-1"]);
    expect(scoped.tickets.map((t) => t.id)).toEqual(["CTL-1", "CTL-2"]);
    expect(scoped.queue.map((q) => q.id)).toEqual(["CTL-3"]);
  });
  it("preserves config + the repo list (the option set never collapses)", () => {
    const scoped = filterPayloadByScope(payload(repos), "adva");
    expect(scoped.repos).toEqual(repos);
    expect(scoped.config).toEqual(payload(repos).config);
  });
  it("selecting All restores the unfiltered view (identity no-op)", () => {
    const p = payload(repos);
    const scoped = filterPayloadByScope(p, REPO_SCOPE_ALL);
    // Referential identity — the all path does zero work (single-node no-op).
    expect(scoped).toBe(p);
    expect(scoped.tickets).toHaveLength(3);
  });
});

describe("stale-scope reconciliation (never goes silently empty)", () => {
  it("drops a scope that is no longer in the repo list", () => {
    expect(resolveScope("gone", ["catalyst", "adva"])).toBe(REPO_SCOPE_ALL);
  });
  it("keeps a still-valid repo scope", () => {
    expect(resolveScope("adva", ["catalyst", "adva"])).toBe("adva");
  });
  it("forces all when the config collapses to a single repo", () => {
    expect(resolveScope("adva", ["catalyst"])).toBe(REPO_SCOPE_ALL);
  });
  it("leaves the all-sentinel untouched", () => {
    expect(resolveScope(REPO_SCOPE_ALL, ["catalyst", "adva"])).toBe(REPO_SCOPE_ALL);
  });
});
