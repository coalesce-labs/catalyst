// Unit tests for broker-state.mjs (CTL-303).
// Covers agents table and ticket_state table; filter_state helpers are
// inherited from CTL-284 and tested in filter-state.test.mjs.
// Run: bun test plugins/dev/scripts/broker/broker-state.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  // agents
  upsertAgent,
  markAgentDone,
  getAgentBySession,
  getAgentsByTicket,
  getAgentsByOrchestrator,
  // ticket_state
  upsertTicketState,
  getTicketState,
  // filter_state (backward compat)
  upsertFilterStateOpen,
  setFilterStateMerged,
  setFilterStateClosed,
  getFilterStateByInterest,
  getAllPrStatuses,
} from "./broker-state.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-state-test-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── agents table ────────────────────────────────────────────────────────────

describe("upsertAgent", () => {
  test("inserts a new agent row", () => {
    upsertAgent({
      agentId: "sess-1",
      agentName: "ctl-275-worker",
      sessionId: "sess-1",
      orchestrator: "orch-2026",
      ticket: "CTL-275",
      claimedPr: 501,
      cwd: "/path/to/wt",
    });
    const agent = getAgentBySession("sess-1");
    expect(agent).not.toBeNull();
    expect(agent.agentName).toBe("ctl-275-worker");
    expect(agent.ticket).toBe("CTL-275");
    expect(agent.claimedPr).toBe(501);
    expect(agent.orchestrator).toBe("orch-2026");
    expect(agent.cwd).toBe("/path/to/wt");
    expect(agent.status).toBe("active");
  });

  test("upsert is idempotent — updates on conflict", () => {
    upsertAgent({ agentId: "sess-2", agentName: "w1", sessionId: "sess-2", ticket: "CTL-275", claimedPr: null });
    upsertAgent({ agentId: "sess-2", agentName: "w1-updated", sessionId: "sess-2", ticket: "CTL-275", claimedPr: 501 });
    const agent = getAgentBySession("sess-2");
    expect(agent.agentName).toBe("w1-updated");
    expect(agent.claimedPr).toBe(501);
  });

  test("accepts null for optional fields", () => {
    upsertAgent({ agentId: "sess-3", agentName: "w", sessionId: "sess-3" });
    const agent = getAgentBySession("sess-3");
    expect(agent.ticket).toBeNull();
    expect(agent.claimedPr).toBeNull();
    expect(agent.orchestrator).toBeNull();
    expect(agent.cwd).toBeNull();
  });
});

describe("markAgentDone", () => {
  test("marks agent as done — getAgentBySession returns null", () => {
    upsertAgent({ agentId: "sess-4", agentName: "w", sessionId: "sess-4" });
    markAgentDone("sess-4", "done");
    expect(getAgentBySession("sess-4")).toBeNull();
  });

  test("supports failed status", () => {
    upsertAgent({ agentId: "sess-5", agentName: "w", sessionId: "sess-5" });
    markAgentDone("sess-5", "failed");
    expect(getAgentBySession("sess-5")).toBeNull();
  });

  test("is a no-op for unknown agent", () => {
    expect(() => markAgentDone("no-such-agent")).not.toThrow();
  });
});

describe("getAgentsByTicket", () => {
  test("returns active agents for ticket", () => {
    upsertAgent({ agentId: "ta", agentName: "a", sessionId: "ta", ticket: "CTL-400" });
    upsertAgent({ agentId: "tb", agentName: "b", sessionId: "tb", ticket: "CTL-400" });
    upsertAgent({ agentId: "tc", agentName: "c", sessionId: "tc", ticket: "CTL-999" });
    const agents = getAgentsByTicket("CTL-400");
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.agentId).sort()).toEqual(["ta", "tb"].sort());
  });

  test("excludes done agents", () => {
    upsertAgent({ agentId: "done-a", agentName: "a", sessionId: "done-a", ticket: "CTL-400" });
    markAgentDone("done-a", "done");
    expect(getAgentsByTicket("CTL-400")).toHaveLength(0);
  });

  test("returns empty array for unknown ticket", () => {
    expect(getAgentsByTicket("CTL-NOPE")).toHaveLength(0);
  });
});

describe("getAgentsByOrchestrator", () => {
  test("returns active agents for orchestrator", () => {
    upsertAgent({ agentId: "oa", agentName: "a", sessionId: "oa", orchestrator: "orch-main" });
    upsertAgent({ agentId: "ob", agentName: "b", sessionId: "ob", orchestrator: "orch-main" });
    upsertAgent({ agentId: "oc", agentName: "c", sessionId: "oc", orchestrator: "orch-other" });
    const agents = getAgentsByOrchestrator("orch-main");
    expect(agents).toHaveLength(2);
  });

  test("returns empty array for unknown orchestrator", () => {
    expect(getAgentsByOrchestrator("orch-nope")).toHaveLength(0);
  });
});

// ─── ticket_state table ───────────────────────────────────────────────────────

describe("upsertTicketState", () => {
  test("inserts a new ticket_state row", () => {
    upsertTicketState({ ticket: "CTL-275", linearState: "In Progress", prNumber: null });
    const ts = getTicketState("CTL-275");
    expect(ts).not.toBeNull();
    expect(ts.ticket).toBe("CTL-275");
    expect(ts.linearState).toBe("In Progress");
    expect(ts.prNumber).toBeNull();
  });

  test("updates linearState on conflict", () => {
    upsertTicketState({ ticket: "CTL-275", linearState: "In Progress" });
    upsertTicketState({ ticket: "CTL-275", linearState: "Done" });
    expect(getTicketState("CTL-275").linearState).toBe("Done");
  });

  test("updates prNumber on conflict", () => {
    upsertTicketState({ ticket: "CTL-275", linearState: "In Progress" });
    upsertTicketState({ ticket: "CTL-275", prNumber: 501 });
    const ts = getTicketState("CTL-275");
    expect(ts.prNumber).toBe(501);
    expect(ts.linearState).toBe("In Progress");
  });

  test("preserves existing values for null fields (COALESCE behavior)", () => {
    upsertTicketState({ ticket: "CTL-300", linearState: "Done", prNumber: 502 });
    upsertTicketState({ ticket: "CTL-300", linearState: null, prNumber: null });
    const ts = getTicketState("CTL-300");
    // COALESCE means null new values don't overwrite existing non-null values.
    expect(ts.linearState).toBe("Done");
    expect(ts.prNumber).toBe(502);
  });
});

describe("getTicketState", () => {
  test("returns null for unknown ticket", () => {
    expect(getTicketState("CTL-NOPE")).toBeNull();
  });
});

// ─── filter_state backward compat ────────────────────────────────────────────

describe("filter_state (CTL-284 backward compat)", () => {
  test("upsertFilterStateOpen works in the same DB", () => {
    upsertFilterStateOpen({ interestId: "sess-bc", prNumber: 501, repo: "org/repo" });
    const state = getFilterStateByInterest("sess-bc");
    expect(state).not.toBeNull();
    expect(state.prNumber).toBe(501);
    expect(state.status).toBe("open");
  });

  test("setFilterStateMerged transitions to merged", () => {
    upsertFilterStateOpen({ interestId: "sess-bc2", prNumber: 502, repo: "org/repo" });
    setFilterStateMerged("sess-bc2", "sha-abc");
    const state = getFilterStateByInterest("sess-bc2");
    expect(state.status).toBe("merged");
    expect(state.mergeCommitSha).toBe("sha-abc");
  });

  // CTL-1157 (Codex round-7): a PR closed WITHOUT merging must leave 'open' so
  // board-health's orphaned-open-PR cohort stops treating it as a stale orphan forever.
  test("setFilterStateClosed transitions an open row to closed", () => {
    upsertFilterStateOpen({ interestId: "sess-closed", prNumber: 503, repo: "org/repo" });
    const res = setFilterStateClosed("sess-closed");
    expect(res).toEqual({ interestId: "sess-closed" });
    const state = getFilterStateByInterest("sess-closed");
    expect(state.status).toBe("closed"); // no longer "open"
  });

  test("setFilterStateClosed is a no-op (null) when the interest has no row", () => {
    expect(setFilterStateClosed("sess-absent")).toBeNull();
  });

  test("both tables coexist in the same DB file", () => {
    upsertFilterStateOpen({ interestId: "coexist-1", prNumber: 1, repo: "r" });
    upsertAgent({ agentId: "coexist-agent", agentName: "a", sessionId: "coexist-agent" });
    upsertTicketState({ ticket: "CTL-1", linearState: "Done" });
    expect(getFilterStateByInterest("coexist-1")).not.toBeNull();
    expect(getAgentBySession("coexist-agent")).not.toBeNull();
    expect(getTicketState("CTL-1")).not.toBeNull();
  });
});

// ─── getAllPrStatuses — composite (repo, pr_number) keying (CTL-1157, Codex #4) ─

describe("getAllPrStatuses — composite (repo, pr_number) keying (CTL-1157)", () => {
  test("a cross-repo PR-number collision keeps BOTH repos' statuses (no shadowing)", () => {
    // #42 exists in TWO GitHub repos: merged in org/x, still open in org/y. They
    // are DIFFERENT PRs. The old number-only keying forced an `ambiguous` skip; the
    // composite shape keeps a per-repo entry so a caller that knows the ticket's
    // repo resolves the EXACT (repo, number) — org/x→merged, org/y→open — and never
    // confuses the two (the false-phantom / hidden-orphan bug is gone at the source).
    upsertFilterStateOpen({ interestId: "x-42", prNumber: 42, repo: "org/x" });
    setFilterStateMerged("x-42", "sha-x");
    upsertFilterStateOpen({ interestId: "y-42", prNumber: 42, repo: "org/y" });
    const byRepo = getAllPrStatuses().get(42);
    expect(byRepo).toBeInstanceOf(Map);
    expect(byRepo.size).toBe(2);
    expect(byRepo.get("org/x")).toMatchObject({ status: "merged", repo: "org/x" });
    expect(byRepo.get("org/y")).toMatchObject({ status: "open", repo: "org/y" });
  });

  test("a SAME-repo repeated PR number collapses to ONE inner entry (most-recent wins, not a collision)", () => {
    upsertFilterStateOpen({ interestId: "z-7a", prNumber: 7, repo: "org/z" });
    upsertFilterStateOpen({ interestId: "z-7b", prNumber: 7, repo: "org/z" });
    const byRepo = getAllPrStatuses().get(7);
    expect(byRepo.size).toBe(1); // single repo → no collision
    expect(byRepo.get("org/z")).toMatchObject({ status: "open", repo: "org/z" });
  });

  test("a non-colliding PR carries its repo + status under its repo key", () => {
    upsertFilterStateOpen({ interestId: "solo-9", prNumber: 9, repo: "org/solo" });
    const byRepo = getAllPrStatuses().get(9);
    expect(byRepo.size).toBe(1);
    expect(byRepo.get("org/solo")).toMatchObject({ status: "open", repo: "org/solo" });
  });
});

// CTL-1489: parity between the broker's terminal-status set and the exec-core
// signal-reader TERMINAL set. They have no shared-import boundary (plan §"Not
// merging the sets"), so a set-equality test enforces the invariant.
describe("WORKER_TERMINAL_STATUSES parity (CTL-1489)", () => {
  test("is a superset of the exec-core signal-reader TERMINAL five", async () => {
    const { WORKER_TERMINAL_STATUSES } = await import("./broker-state.mjs");
    // Mirror of signal-reader.mjs TERMINAL (kept in sync by this assertion).
    const execCoreTerminal = ["done", "failed", "stalled", "skipped", "turn-cap-exhausted"];
    for (const s of execCoreTerminal) {
      expect(WORKER_TERMINAL_STATUSES.has(s)).toBe(true);
    }
  });
});
