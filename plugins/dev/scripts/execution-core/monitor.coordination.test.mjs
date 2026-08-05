// Unit tests for the CTL-1655 coordination-mirror comment tail.
// Run: cd plugins/dev/scripts/execution-core && bun test monitor.coordination.test.mjs
//
// Covers:
//   Phase 1 — commentKeyOf + markAndCheckCommentSeen dedup primitive
//   Phase 2 — readNewCoordinationComments (all 8 design constraints)
//   Phase 3 — lifecycle wiring (boot-drain foldOnly, single-host no-op)
//   Phase 4 — cross-host observability breadcrumb, re-label-race guard

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commentKeyOf,
  markAndCheckCommentSeen,
  readNewCoordinationComments,
  readNewEvents,
  startMonitor,
  stopMonitor,
  handleCommentCreatedEvent,
  __resetForTests,
  __resetCommentDedupForTests,
} from "./monitor.mjs";
import { log } from "./config.mjs";
import { dropProject } from "./eligible-set.mjs";
import { __resetFleetFreezeLatch } from "./fleet-freeze-alert.mjs";

// ── test harness ─────────────────────────────────────────────────────────────

let catalystDir;
let prevCatalystDir;
let prevHosts;
const enrolledTeams = new Set();
const registryEntries = [];

function writeRegistry() {
  writeFileSync(
    join(catalystDir, "execution-core", "registry.json"),
    JSON.stringify({ projects: registryEntries }, null, 2)
  );
}

function enroll(team, eligibleQuery) {
  const repoRoot = mkdtempSync(join(catalystDir, `repo-${team}-`));
  registryEntries.push({ team, repoRoot, eligibleQuery: eligibleQuery ?? null });
  writeRegistry();
  enrolledTeams.add(team);
  return repoRoot;
}

function execReturning(nodesByTeam) {
  return (_cmd, args) => {
    const team = args[args.indexOf("--team") + 1];
    return {
      code: 0,
      stdout: JSON.stringify({ nodes: nodesByTeam[team] ?? [] }),
      stderr: "",
    };
  };
}

function coordinationPath() {
  return join(catalystDir, "coordination.jsonl");
}

function appendCoordination(obj) {
  mkdirSync(catalystDir, { recursive: true });
  appendFileSync(coordinationPath(), JSON.stringify(obj) + "\n");
}

function commentEvent({ ticket = "CTL-1", commentId = "cmt-1", authorId = "u-1" } = {}) {
  return {
    id: `env-${commentId}`,
    attributes: {
      "event.name": "linear.comment.created",
      "linear.issue.identifier": ticket,
    },
    body: {
      payload: {
        ticket,
        commentId,
        body: "a human reply",
        authorId,
        authorName: "Human",
      },
    },
  };
}

function setMultiHost(hosts = ["mini", "mini-2"]) {
  // CATALYST_STATIC_ROSTER makes getStaticRoster() → getClusterHosts() return
  // a roster of > 1. Tests set CATALYST_DIR to a tmpdir so the cluster-repo
  // source (readClusterRepoRoster) reads a non-existent dir and returns null;
  // CATALYST_STATIC_ROSTER is therefore the correct tier-2 override.
  prevHosts = process.env.CATALYST_STATIC_ROSTER;
  process.env.CATALYST_STATIC_ROSTER = hosts.join(",");
}

function clearMultiHost() {
  if (prevHosts === undefined) delete process.env.CATALYST_STATIC_ROSTER;
  else process.env.CATALYST_STATIC_ROSTER = prevHosts;
}

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-coord-"));
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
  __resetForTests();
  __resetCommentDedupForTests();
  __resetFleetFreezeLatch();
  enrolledTeams.clear();
  registryEntries.length = 0;
});

afterEach(() => {
  stopMonitor();
  __resetForTests();
  __resetCommentDedupForTests();
  for (const t of enrolledTeams) dropProject(t);
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  clearMultiHost();
  rmSync(catalystDir, { recursive: true, force: true });
});

// ── Phase 1: commentKeyOf ─────────────────────────────────────────────────────

describe("commentKeyOf (CTL-1655 Phase 1)", () => {
  test("prefers body.payload.commentId", () => {
    const ev = commentEvent({ commentId: "cmt-42" });
    expect(commentKeyOf(ev)).toBe("cmt-42");
  });

  test("falls back to envelope id when commentId absent", () => {
    const ev = { id: "env-99", attributes: { "event.name": "linear.comment.created" } };
    expect(commentKeyOf(ev)).toBe("env-99");
  });

  test("returns undefined for a row with neither key", () => {
    expect(commentKeyOf({ attributes: { "event.name": "linear.comment.created" } })).toBeUndefined();
  });

  test("returns undefined for null/undefined input", () => {
    expect(commentKeyOf(null)).toBeUndefined();
    expect(commentKeyOf(undefined)).toBeUndefined();
  });

  test("coerces key to string", () => {
    const ev = { body: { payload: { commentId: 123 } } };
    expect(typeof commentKeyOf(ev)).toBe("string");
  });

  test("detail shape (legacy flat) falls back to detail.commentId", () => {
    const ev = { id: "env-x", detail: { commentId: "legacy-c1" } };
    expect(commentKeyOf(ev)).toBe("legacy-c1");
  });
});

// ── Phase 1: markAndCheckCommentSeen ─────────────────────────────────────────

describe("markAndCheckCommentSeen (CTL-1655 Phase 1)", () => {
  test("first-seen key returns false (not yet seen)", () => {
    expect(markAndCheckCommentSeen("key-1")).toBe(false);
  });

  test("same key returns true on second call", () => {
    markAndCheckCommentSeen("key-2");
    expect(markAndCheckCommentSeen("key-2")).toBe(true);
  });

  test("distinct keys are independent", () => {
    markAndCheckCommentSeen("a");
    expect(markAndCheckCommentSeen("b")).toBe(false);
  });

  test("null/undefined key returns false and is NOT inserted", () => {
    expect(markAndCheckCommentSeen(null)).toBe(false);
    expect(markAndCheckCommentSeen(undefined)).toBe(false);
    // A second call with the same null is still false (not persisted)
    expect(markAndCheckCommentSeen(null)).toBe(false);
  });

  test("eviction: oldest key evicted after cap overflows, newest survive", () => {
    const CAP = 2000;
    for (let i = 0; i < CAP; i++) {
      markAndCheckCommentSeen(`key-${i}`);
    }
    // Adding one more should evict key-0 (oldest insertion)
    markAndCheckCommentSeen("overflow-key");
    // Check surviving keys FIRST (before re-inserting evicted key-0, which
    // would itself trigger an eviction of the next-oldest key).
    expect(markAndCheckCommentSeen("key-1999")).toBe(true); // most recent original
    expect(markAndCheckCommentSeen("overflow-key")).toBe(true); // just inserted
    // key-0 should now be evicted (treated as never-seen)
    expect(markAndCheckCommentSeen("key-0")).toBe(false);
  });
});

// ── Phase 2: readNewCoordinationComments ─────────────────────────────────────

describe("readNewCoordinationComments (CTL-1655 Phase 2)", () => {
  test("constraint 5: single-host is a no-op even with coordination.jsonl present", () => {
    // No CATALYST_CLUSTER_HOSTS → single host → no-op
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    appendCoordination(commentEvent({ ticket: "CTL-1" }));
    readNewCoordinationComments();
    expect(onComment).not.toHaveBeenCalled();
  });

  test("constraint 5: multi-host processes the comment file", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    appendCoordination(commentEvent({ ticket: "CTL-1" }));
    readNewCoordinationComments();
    expect(onComment).toHaveBeenCalledTimes(1);
  });

  test("constraint 1 (comment-only filter): non-comment rows do NOT reach onComment", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    // Write a mix: phase event, state-changed event, comment event
    appendCoordination({ attributes: { "event.name": "phase.implement.complete.CTL-1" }, body: {} });
    appendCoordination({ attributes: { "event.name": "linear.issue.state_changed", "linear.issue.identifier": "CTL-1" }, body: { payload: { toState: "Done" } } });
    appendCoordination({ attributes: { "event.name": "worker.transition.CTL-1" }, body: {} });
    appendCoordination(commentEvent({ ticket: "CTL-1", commentId: "cmt-filter-1" }));
    readNewCoordinationComments();
    // Only the comment row reaches onComment
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ ticket: "CTL-1" });
  });

  test("constraint 2 (cross-source dedup): same commentId from local tail then coordination tail fires onComment exactly once", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    const ev = commentEvent({ ticket: "CTL-2", commentId: "cmt-dedup-1" });
    // Simulate the local tail having already processed this comment (inserts into dedup).
    markAndCheckCommentSeen(commentKeyOf(ev)); // local tail inserts
    // Now the coordination tail sees the same commentId.
    appendCoordination(ev);
    readNewCoordinationComments();
    // Should be skipped by the dedup gate.
    expect(onComment).not.toHaveBeenCalled();
  });

  test("constraint 2: two different commentIds each dispatch exactly once", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    appendCoordination(commentEvent({ ticket: "CTL-3", commentId: "cmt-a" }));
    appendCoordination(commentEvent({ ticket: "CTL-3", commentId: "cmt-b" }));
    readNewCoordinationComments();
    expect(onComment).toHaveBeenCalledTimes(2);
  });

  test("constraint 3 (absent mirror): no coordination.jsonl → no-op, no throw", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    // Don't create coordination.jsonl
    expect(() => readNewCoordinationComments()).not.toThrow();
    expect(onComment).not.toHaveBeenCalled();
  });

  test("constraint 3 (empty mirror): empty coordination.jsonl → no-op", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    writeFileSync(coordinationPath(), ""); // empty file
    readNewCoordinationComments();
    expect(onComment).not.toHaveBeenCalled();
  });

  test("malformed line tolerance: garbage line before valid comment → valid row still processes", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    appendFileSync(coordinationPath(), "NOT JSON\n");
    appendCoordination(commentEvent({ ticket: "CTL-4", commentId: "cmt-valid" }));
    readNewCoordinationComments();
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ ticket: "CTL-4" });
  });

  test("constraint 4 (foldOnly boot-drain): foldOnly withholds onComment entirely", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    appendCoordination(commentEvent({ ticket: "CTL-5", commentId: "cmt-fold" }));
    readNewCoordinationComments({ foldOnly: true });
    expect(onComment).not.toHaveBeenCalled();
  });

  test("constraint 4: foldOnly does NOT insert into dedup, so a later live call still processes the comment", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    appendCoordination(commentEvent({ ticket: "CTL-6", commentId: "cmt-no-poison" }));
    // boot drain (foldOnly) — cursor advances but comment is not processed
    readNewCoordinationComments({ foldOnly: true });
    expect(onComment).not.toHaveBeenCalled();
    // A fresh comment appended AFTER the boot drain
    appendCoordination(commentEvent({ ticket: "CTL-6", commentId: "cmt-live" }));
    readNewCoordinationComments();
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ commentId: "cmt-live" });
  });
});

// ── Phase 3: startMonitor lifecycle ──────────────────────────────────────────

describe("startMonitor — coordination boot-drain (CTL-1655 Phase 3)", () => {
  test("boot-drain (resumeFromCursor:true) withholds onComment for pre-existing coordination rows", () => {
    setMultiHost();
    // Write a coordination event BEFORE startMonitor (simulates a historical row).
    appendCoordination(commentEvent({ ticket: "CTL-7", commentId: "cmt-boot" }));
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    // startMonitor seeds + foldOnly-drains coordination cursor on boot.
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    // The pre-existing row should NOT have fired onComment.
    expect(onComment).not.toHaveBeenCalled();
  });

  test("boot-drain: fresh comment appended AFTER startMonitor is processed", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    // Now append a fresh comment and drain manually.
    appendCoordination(commentEvent({ ticket: "CTL-8", commentId: "cmt-fresh" }));
    readNewCoordinationComments();
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ ticket: "CTL-8" });
  });

  test("single-host (no CATALYST_CLUSTER_HOSTS): boot-drain does not arm coordination watcher", () => {
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    appendCoordination(commentEvent({ ticket: "CTL-9", commentId: "cmt-single" }));
    readNewCoordinationComments();
    // Single-host → still no-op regardless of the manual call
    expect(onComment).not.toHaveBeenCalled();
  });
});

// ── Phase 4: cross-host observability breadcrumb ──────────────────────────────

describe("readNewCoordinationComments — breadcrumb (CTL-1655 Phase 4)", () => {
  test("emits a log.info breadcrumb naming the ticket on a cross-host wake", () => {
    setMultiHost();
    const msgs = [];
    const spy = spyOn(log, "info").mockImplementation((...args) => msgs.push(args));
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000 });
    appendCoordination(commentEvent({ ticket: "CTL-10", commentId: "cmt-breadcrumb" }));
    readNewCoordinationComments();
    spy.mockRestore();
    const breadcrumb = msgs.find(([, msg]) => typeof msg === "string" && msg.includes("comment.wake.cross-host.CTL-10"));
    expect(breadcrumb).toBeDefined();
  });

  test("breadcrumb is NOT emitted for a locally-ingested comment (dedup already marked it)", () => {
    setMultiHost();
    const msgs = [];
    const spy = spyOn(log, "info").mockImplementation((...args) => msgs.push(args));
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000 });
    const ev = commentEvent({ ticket: "CTL-11", commentId: "cmt-local" });
    // Simulate local tail already marking this comment.
    markAndCheckCommentSeen(commentKeyOf(ev));
    appendCoordination(ev);
    readNewCoordinationComments();
    spy.mockRestore();
    const breadcrumb = msgs.find(([, msg]) => typeof msg === "string" && msg.includes("comment.wake.cross-host.CTL-11"));
    expect(breadcrumb).toBeUndefined();
  });

  test("breadcrumb is emitted at most once per unique commentId (dedup-idempotent)", () => {
    setMultiHost();
    const msgs = [];
    const spy = spyOn(log, "info").mockImplementation((...args) => msgs.push(args));
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000 });
    appendCoordination(commentEvent({ ticket: "CTL-12", commentId: "cmt-once" }));
    readNewCoordinationComments();
    // Reset cursor to simulate re-reading the same bytes (e.g. file re-opened at same offset).
    // Actually, test duplicate delivery: add another copy in a second file drain.
    // But since the cursor advanced, we need to simulate via a second appendCoordination
    // with the SAME commentId — the dedup should block it.
    appendCoordination(commentEvent({ ticket: "CTL-12", commentId: "cmt-once" }));
    readNewCoordinationComments();
    spy.mockRestore();
    const count = msgs.filter(([, msg]) => typeof msg === "string" && msg.includes("comment.wake.cross-host.CTL-12")).length;
    expect(count).toBe(1);
  });
});

// ── Phase 2: namespace contract parity ───────────────────────────────────────

describe("breadcrumb name — namespace contract (CTL-1142 / CTL-1655 Phase 4)", () => {
  test("comment.wake.cross-host.* does NOT start with forbidden prefixes", async () => {
    const { isBrokerProtectedName } = await import("../broker/namespace-contract.mjs");
    const exampleName = "comment.wake.cross-host.CTL-1655";
    expect(isBrokerProtectedName(exampleName)).toBe(false);
  });
});
