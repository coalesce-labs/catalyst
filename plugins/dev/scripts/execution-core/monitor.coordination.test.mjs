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
  setCloudFeedGate,
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

// Append to the LOCAL event log that readNewEvents() drains (catalystDir/events/
// <YYYY-MM>.jsonl — see config.mjs getEventLogPath). Used to exercise the local
// tail alongside the coordination tail for the shared cross-source dedup.
function eventLogPath() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(catalystDir, "events", `${ym}.jsonl`);
}

function appendEventLog(obj) {
  mkdirSync(join(catalystDir, "events"), { recursive: true });
  appendFileSync(eventLogPath(), JSON.stringify(obj) + "\n");
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

  // ── CTL-1847 (Codex P1, #3439) ────────────────────────────────────────────
  // This tail routed webhook comments straight into markAndCheckCommentSeen
  // without consulting the dispatch-source gate, so on multi-host deployments
  // the webhook copy won the race, poisoned dedup, and the later cloud-feed copy
  // was skipped — enforce was NOT authoritative for human comments there.
  test("CTL-1847: in enforce, a WEBHOOK comment on this tail is suppressed, not delivered", () => {
    setMultiHost();
    const onComment = mock(() => {});
    const captured = [];
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    setCloudFeedGate({
      mode: "enforce",
      isReady: () => true,
      capture: { append: (e, v) => captured.push(v) },
    });
    try {
      const ev = commentEvent({ ticket: "CTL-8", commentId: "cmt-gate-1" });
      ev.attributes["webhook.delivery.id"] = "d-1"; // a smee-sourced copy
      appendCoordination(ev);
      readNewCoordinationComments();
      expect(onComment).not.toHaveBeenCalled();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ reason: "smee-captured", tail: "coordination" });
    } finally {
      setCloudFeedGate(null);
    }
  });

  test("CTL-1847: the suppressed copy does NOT poison dedup — the feed copy still delivers", () => {
    // The whole point of gating ABOVE the dedup. If the suppressed webhook copy
    // were marked seen, the feed's copy would be skipped and the comment would
    // reach no inbox at all.
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    setCloudFeedGate({ mode: "enforce", isReady: () => true, capture: { append: () => {} } });
    try {
      const webhookCopy = commentEvent({ ticket: "CTL-9", commentId: "cmt-gate-2" });
      webhookCopy.attributes["webhook.delivery.id"] = "d-2";
      appendCoordination(webhookCopy);
      readNewCoordinationComments();
      expect(onComment).not.toHaveBeenCalled();

      const feedCopy = commentEvent({ ticket: "CTL-9", commentId: "cmt-gate-2" });
      feedCopy.body.payload.source = "cloud-feed";
      // Round 6: a feed event dispatches only if the sweep that emitted it
      // stamped it authoritative. An unstamped copy is correctly suppressed —
      // this test caught exactly that when the stamp landed.
      feedCopy.body.payload.feedAuthority = true;
      appendCoordination(feedCopy);
      readNewCoordinationComments();
      expect(onComment).toHaveBeenCalledTimes(1);
    } finally {
      setCloudFeedGate(null);
    }
  });

  test("NEGATIVE CONTROL: with no gate installed (mode off) the webhook comment delivers as before", () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    setCloudFeedGate(null);
    const ev = commentEvent({ ticket: "CTL-10", commentId: "cmt-gate-3" });
    ev.attributes["webhook.delivery.id"] = "d-3";
    appendCoordination(ev);
    readNewCoordinationComments();
    expect(onComment).toHaveBeenCalledTimes(1);
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

  test("constraint 2 (reverse): coordination tail then local tail fires onComment exactly once — the local tail HONORS the shared dedup", () => {
    // phase-review remediation (CTL-1655, Codex P2): the local event-log tail
    // (readNewEvents) must SKIP a linear.comment.created the coordination-mirror
    // tail already dispatched — plan §Phase 2 "whichever tail sees a given
    // comment first wins and the other skips". Before the fix the local tail
    // inserted into the dedup but ignored the result, so it re-dispatched (a
    // second Phase B worker for one Linear comment — the CTL-1653 pathology).
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({ exec: execReturning({}), reconcileIntervalMs: 60_000, onComment });
    const ev = commentEvent({ ticket: "CTL-2b", commentId: "cmt-dedup-2" });
    // Coordination-mirror tail wins the race and dispatches first (marks dedup).
    appendCoordination(ev);
    readNewCoordinationComments();
    expect(onComment).toHaveBeenCalledTimes(1);
    // The SAME comment also lands on the local event log (the originating host
    // has it in both places). The local tail must skip — not re-dispatch.
    appendEventLog(ev);
    readNewEvents();
    expect(onComment).toHaveBeenCalledTimes(1);
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

  // phase-review remediation (CTL-1655): the coordination tail must have a poll
  // fallback like the event-log tailer — fs.watch misses cross-process appends on
  // macOS, and there is no reconcile backstop for the coordination mirror.
  test("poll fallback: a comment appended after boot is drained by the coordination poll timer with NO manual call (multi-host)", async () => {
    setMultiHost();
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    // Short poll cadence so the sibling coordination poll timer fires in-test.
    startMonitor({
      exec: execReturning({}),
      reconcileIntervalMs: 60_000,
      tailerPollMs: 10,
      onComment,
    });
    // Append AFTER the boot-drain and deliberately do NOT call
    // readNewCoordinationComments — only the poll timer can pick this up.
    appendCoordination(commentEvent({ ticket: "CTL-11", commentId: "cmt-poll" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ ticket: "CTL-11" });
  });

  // phase-review remediation (CTL-1655, Codex P2): the startTailing fs.watch gate
  // is startup-only, so a daemon that BOOTS single-host and later gains a peer must
  // still drain the mirror without a restart. The coordination poll timer is the
  // only re-arming path, so it must be armed unconditionally (the reader self-no-ops
  // while single-host). Before the fix the poll timer was gated on the boot-time
  // host count, so a live roster expansion silently dropped every cross-host wake.
  test("poll re-arms after a live single-host → multi-host roster expansion (no restart)", async () => {
    // Boot SINGLE-host (no setMultiHost yet).
    const onComment = mock(() => {});
    enroll("CTL", { status: "Todo" });
    startMonitor({
      exec: execReturning({}),
      reconcileIntervalMs: 60_000,
      tailerPollMs: 10,
      onComment,
    });
    // A second host joins the roster AFTER boot; then a cross-host comment lands.
    setMultiHost();
    appendCoordination(commentEvent({ ticket: "CTL-13", commentId: "cmt-expand" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment.mock.calls[0][0]).toMatchObject({ ticket: "CTL-13" });
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
