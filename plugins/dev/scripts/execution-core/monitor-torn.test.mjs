// CTL-1809: the daemon monitor's LIVE event-log tail must COUNT a torn line, not drop it
// silently. Run: cd plugins/dev/scripts/execution-core && bun test monitor-torn.test.mjs
//
// This is the SECOND uncovered live tail of the unified event log, structurally identical to
// the broker's (covered by broker/tailer-torn.test.mjs). Both read the same file —
// monitor.mjs's readNewEvents and broker/tailer.mjs's readNewEvents each call
// getEventLogPath(), and execution-core/config.mjs's and broker/config.mjs's implementations
// resolve to the same `$CATALYST_DIR/events/YYYY-MM.jsonl`.
//
// It is not a side path. startTailing drives readNewEvents from an fs.watch callback AND a
// setInterval poll for the daemon's whole life, and it routes:
//   handleStateChangedEvent   → dispatchTriage
//   handleIssueUpdatedEvent   → the eligible projection fold
//   handleCommentCreatedEvent → onComment (CTL-768 comment-wake / needs-input clear)
// A torn line therefore silently drops a triage dispatch or a human's reply.
//
// Deliberately a separate file rather than a case in monitor.test.mjs: that suite is EXCLUDED
// from the required execution-core job (documented there as flaky — it drives real timers and
// fs.watch). A case added there would never run in CI, which is the same "covered on paper"
// shape this ticket is about. Every drive below calls stopMonitor() before appending, so this
// file arms no timer and no watcher.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMonitor, stopMonitor, readNewEvents, __resetForTests } from "./monitor.mjs";
import { dropProject } from "./eligible-set.mjs";
import { tornLineCount, resetTornLineCount } from "./event-tail.mjs";
// CTL-1216: resolve the event-log filename through the production leaf so this
// fixture follows the ACTIVE scheme. A pinned monthly name addresses a file the
// code under test never opens.
import { eventLogBasenameFor, resolveRotationScheme } from "../lib/event-log-paths.mjs";

let catalystDir;
let prevCatalystDir;
let stderrChunks;
let realStderrWrite;
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

// A linearis stub that reports no eligible tickets, so startMonitor's boot reconcile +
// sweepMissingTriage dispatch nothing and every dispatch counted below came off the tail.
function execEmpty() {
  return () => ({ code: 0, stdout: JSON.stringify({ nodes: [] }), stderr: "" });
}

function eventLogPath() {
  const now = new Date();
  const ym = eventLogBasenameFor(now, resolveRotationScheme({ env: process.env })).replace(/\.jsonl$/, "");
  return join(catalystDir, "events", `${ym}.jsonl`);
}

function appendEventLog(text) {
  mkdirSync(join(catalystDir, "events"), { recursive: true });
  appendFileSync(eventLogPath(), text);
}

// One linear.issue.updated event. The survivor observable is deliberately the
// handleIssueUpdatedEvent → onUpdate fold rather than handleStateChangedEvent → dispatchTriage:
// the fold is pure and in-process, while the →Triage path runs the real applyTriageStatus
// (a linearis spawn per event) and is exactly why monitor.test.mjs's burst cases are the ones
// excluded from CI as timing-flaky. Same tail, same loop, same per-line `catch` — measured at
// a production handler, not a stub, with no wall-clock dependency.
const updateEvent = (ticket) =>
  JSON.stringify({
    event: "linear.issue.updated",
    detail: { ticket, teamKey: "ENG", toState: "Ready" },
  });

// Boot the monitor with tailerOpts populated, then immediately disarm its timers/watcher.
// stopMonitor clears reconcileTimer / tailerPollTimer / coordinationPollTimer and closes both
// watchers; it does NOT clear tailerOpts, so a direct readNewEvents() below still runs the
// full production handler chain with no wall-clock dependency anywhere in this file.
function bootQuiescent(onUpdate) {
  enroll("ENG", { status: "Ready" });
  startMonitor({
    exec: execEmpty(),
    reconcileIntervalMs: 60_000,
    tailerPollMs: 0,
    resumeFromCursor: false,
    orchDir: join(catalystDir, "execution-core"),
    onUpdate,
    readMaxParallelFn: () => 10,
    liveBackgroundCount: () => 0, // plenty of free slots — the budget never gates these drives
  });
  stopMonitor();
}

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-torn-"));
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
  __resetForTests();
  resetTornLineCount();
  enrolledTeams.clear();
  registryEntries.length = 0;
  // Capture the sparse-warn output rather than let it escape into suite output.
  stderrChunks = [];
  realStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  process.stderr.write = realStderrWrite;
  stopMonitor();
  __resetForTests();
  resetTornLineCount();
  for (const t of enrolledTeams) dropProject(t);
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

describe("CTL-1809 — monitor live tail counts torn lines", () => {
  test("a torn line between two valid events is counted, and both survivors still route", () => {
    expect(tornLineCount()).toBe(0); // positive control: the counter starts cold.
    const onUpdate = mock(() => {});
    bootQuiescent(onUpdate);
    expect(onUpdate.mock.calls.length).toBe(0); // boot routed nothing.

    appendEventLog(
      `${updateEvent("ENG-1")}\n` + `TORN{"attributes":{"event.na\n` + `${updateEvent("ENG-2")}\n`
    );
    readNewEvents();

    // The tear is now audible…
    expect(tornLineCount()).toBe(1);
    // …and it did not swallow the batch. Measured at the real handleIssueUpdatedEvent fold.
    expect(onUpdate.mock.calls.map((c) => c[0].identifier)).toEqual(["ENG-1", "ENG-2"]);
  });

  test("the drop is operator-visible on stderr, naming the counter", () => {
    bootQuiescent(mock(() => {}));
    appendEventLog("NOT JSON AT ALL\n");
    readNewEvents();

    expect(tornLineCount()).toBe(1);
    const err = stderrChunks.join("");
    expect(err).toContain("TORN event-log line");
    expect(err).toContain("torn_lines_total=1");
  });

  test("a clean batch counts zero — the detector is not counting healthy lines", () => {
    // Negative control for the two cases above: if this ever counted, `1` would prove nothing
    // about torn lines specifically.
    const onUpdate = mock(() => {});
    bootQuiescent(onUpdate);
    appendEventLog(`${updateEvent("ENG-3")}\n${updateEvent("ENG-4")}\n`);
    readNewEvents();

    expect(tornLineCount()).toBe(0);
    expect(onUpdate.mock.calls.length).toBe(2);
  });

  test("a trailing partial line is NOT counted — it is an in-flight write, not damage", () => {
    // readNewEvents pops the trailing partial into leftoverBuf and never parses it. Counting
    // it would make the detector alarm on every healthy actively-written log.
    const onUpdate = mock(() => {});
    bootQuiescent(onUpdate);
    appendEventLog(`${updateEvent("ENG-5")}\n{"event":"linear.issue.upda`);
    readNewEvents();

    expect(tornLineCount()).toBe(0);
    expect(onUpdate.mock.calls.length).toBe(1);
  });

  test("the counter is SHARED with the broker's detector, not a second one", () => {
    // noteTornLine is module-level in event-tail.mjs on purpose: one detector per process per
    // log. If monitor.mjs ever grows its own private counter, this reads 0 while the module's
    // own count reads 1 — the exact drift that makes two numbers for one file untrustworthy.
    bootQuiescent(mock(() => {}));
    appendEventLog(`{{{ not json\n`);
    readNewEvents();
    expect(tornLineCount()).toBe(1);
  });
});
