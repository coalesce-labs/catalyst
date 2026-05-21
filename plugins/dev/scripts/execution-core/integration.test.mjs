// End-to-end integration tests for the execution-core Todo-state monitor
// (CTL-535 Phase 5). Each test builds a temp CATALYST_DIR with a stubbed
// enrollment dir + repo config and a mocked linearis exec — nothing touches
// the real Linear API or the developer's ~/catalyst. The four AC* tests map
// 1:1 onto the ticket's acceptance criteria.
// Run: cd plugins/dev/scripts/execution-core && bun test integration.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startMonitor,
  stopMonitor,
  reconcileAll,
  handleStateChangedEvent,
  __resetForTests,
} from "./monitor.mjs";
import { getEligibleSet, dropProject } from "./eligible-set.mjs";

let catalystDir;
let enrollmentDir;
let prevCatalystDir;
const enrolledKeys = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-int-"));
  process.env.CATALYST_DIR = catalystDir;
  enrollmentDir = join(catalystDir, "execution-core", "projects");
  mkdirSync(enrollmentDir, { recursive: true });
  __resetForTests();
  enrolledKeys.clear();
});

afterEach(() => {
  stopMonitor();
  __resetForTests();
  for (const k of enrolledKeys) dropProject(k);
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function enroll(projectKey, eligibleQuery) {
  const repoRoot = mkdtempSync(join(catalystDir, `repo-${projectKey}-`));
  mkdirSync(join(repoRoot, ".catalyst"), { recursive: true });
  const catalyst = { linear: { teamKey: eligibleQuery?.team ?? "T" } };
  if (eligibleQuery) catalyst.orchestration = { executionCore: { eligibleQuery } };
  writeFileSync(
    join(repoRoot, ".catalyst", "config.json"),
    JSON.stringify({ catalyst }),
  );
  writeFileSync(
    join(enrollmentDir, `${projectKey}.json`),
    JSON.stringify({ projectKey, repoRoot }),
  );
  enrolledKeys.add(projectKey);
  return repoRoot;
}

const node = (identifier, priority = 2) => ({
  identifier,
  state: { name: "Todo" },
  priority,
});

// Legacy flat state_changed event — the tailer feeds these to the handler.
const evt = (ticket, teamKey, toState) => ({
  event: "linear.issue.state_changed",
  detail: { ticket, teamKey, toState },
});

// A mocked linearis exec keyed on the --team flag, reading a live `nodesByTeam`
// object so a test can change what linearis "reports" between calls.
function mockExec(nodesByTeam) {
  return (_cmd, args) => {
    const team = args[args.indexOf("--team") + 1];
    return {
      code: 0,
      stdout: JSON.stringify({ nodes: nodesByTeam[team] ?? [] }),
      stderr: "",
    };
  };
}

describe("execution-core integration — acceptance criteria", () => {
  test("AC1 — a state_changed event INTO the eligible state triggers a reconcile that adds the ticket", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const reported = { ENG: [] };
    const exec = mockExec(reported);
    startMonitor({ exec, debounceMs: 25, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha")).toEqual([]); // startup reconcile: empty

    reported.ENG = [node("ENG-9")]; // linearis now reports ENG-9 as Todo
    handleStateChangedEvent(evt("ENG-9", "ENG", "Todo"), { exec, debounceMs: 25 });
    await sleep(70);
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-9"]);
  });

  test("AC1b — a state_changed event OUT of the eligible state removes the ticket immediately", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = mockExec({ ENG: [node("ENG-1"), node("ENG-2")] });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha")).toHaveLength(2);

    handleStateChangedEvent(evt("ENG-1", "ENG", "In Progress"));
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  test("AC2 — the reconcile poll catches a missed webhook (no event written, the poll still converges)", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const reported = { ENG: [] };
    const exec = mockExec(reported);
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha")).toEqual([]);

    reported.ENG = [node("ENG-5")]; // webhook missed — linearis truth changed
    reconcileAll({ exec }); // the periodic backstop tick
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-5"]);
  });

  test("AC3 — poll-only mode: with no event log file at all, startMonitor + the reconcile poll produce a correct set", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = mockExec({ ENG: [node("ENG-1")] });
    // no events/ directory, no log file exists
    expect(() => startMonitor({ exec, reconcileIntervalMs: 60_000 })).not.toThrow();
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });

  test("AC4 — the configurable query is honored: a priority floor narrows which tickets land in the set", () => {
    enroll("alpha", { team: "ENG", status: "Todo", priority: 2 });
    const exec = mockExec({
      ENG: [node("ENG-1", 1), node("ENG-2", 2), node("ENG-3", 3), node("ENG-0", 0)],
    });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
  });
});

describe("execution-core integration — rebuild + isolation", () => {
  test("the startup reconcile rebuilds the eligible set from scratch (no persisted state needed)", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = mockExec({ ENG: [node("ENG-1")] });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
    expect(
      existsSync(join(catalystDir, "execution-core", "eligible", "alpha.json")),
    ).toBe(true);
  });

  test("a second enrolled project is served independently (per-project isolation)", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    enroll("beta", { team: "PLAT", status: "Todo" });
    const exec = mockExec({
      ENG: [node("ENG-1")],
      PLAT: [node("PLAT-1"), node("PLAT-2")],
    });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
    expect(getEligibleSet("beta").map((t) => t.identifier)).toEqual([
      "PLAT-1",
      "PLAT-2",
    ]);
  });
});
