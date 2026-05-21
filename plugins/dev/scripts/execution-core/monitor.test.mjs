// Unit tests for the execution-core monitor core (CTL-535 Phase 4).
// Run: cd plugins/dev/scripts/execution-core && bun test monitor.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStateChangedEvent,
  reconcileProject,
  reconcileAll,
  handleStateChangedEvent,
  startMonitor,
  stopMonitor,
  __resetForTests,
} from "./monitor.mjs";
import { setProjectEligible, getEligibleSet, dropProject } from "./eligible-set.mjs";

let catalystDir;
let enrollmentDir;
let prevCatalystDir;
const enrolledKeys = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-mon-"));
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

// Create a stub repo + enrollment record. `eligibleQuery` null => enrolled
// but unconfigured. Returns the repoRoot.
function enroll(projectKey, eligibleQuery) {
  const repoRoot = mkdtempSync(join(catalystDir, `repo-${projectKey}-`));
  mkdirSync(join(repoRoot, ".catalyst"), { recursive: true });
  const catalyst = { linear: { teamKey: eligibleQuery?.team ?? "T" } };
  if (eligibleQuery) {
    catalyst.orchestration = { executionCore: { eligibleQuery } };
  }
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

function unenroll(projectKey) {
  unlinkSync(join(enrollmentDir, `${projectKey}.json`));
}

// A fake exec keyed on the linearis `--team` argv flag. Tracks call count.
function execReturning(nodesByTeam) {
  const fn = (_cmd, args) => {
    fn.calls += 1;
    const team = args[args.indexOf("--team") + 1];
    return {
      code: 0,
      stdout: JSON.stringify({ nodes: nodesByTeam[team] ?? [] }),
      stderr: "",
    };
  };
  fn.calls = 0;
  return fn;
}

const node = (identifier, priority = 2) => ({
  identifier,
  state: { name: "Todo" },
  priority,
});

describe("parseStateChangedEvent", () => {
  test("reads attributes['event.name'] + body.payload (canonical OTel shape)", () => {
    const parsed = parseStateChangedEvent({
      attributes: {
        "event.name": "linear.issue.state_changed",
        "linear.issue.identifier": "ENG-1",
      },
      body: { payload: { teamKey: "ENG", toState: "In Progress" } },
    });
    expect(parsed).toEqual({ identifier: "ENG-1", teamKey: "ENG", toState: "In Progress" });
  });

  test("reads event.event + event.detail (legacy flat shape)", () => {
    const parsed = parseStateChangedEvent({
      event: "linear.issue.state_changed",
      detail: { ticket: "ENG-2", teamKey: "ENG", toState: "Done" },
    });
    expect(parsed).toEqual({ identifier: "ENG-2", teamKey: "ENG", toState: "Done" });
  });

  test("returns null for a non-state_changed event", () => {
    expect(parseStateChangedEvent({ event: "pr.merged" })).toBeNull();
    expect(parseStateChangedEvent({})).toBeNull();
  });

  test("returns null when no ticket identifier can be extracted", () => {
    expect(
      parseStateChangedEvent({
        attributes: { "event.name": "linear.issue.state_changed" },
        body: { payload: { teamKey: "ENG", toState: "Todo" } },
      }),
    ).toBeNull();
  });
});

describe("reconcileProject", () => {
  test("runs the query and writes the eligible set", () => {
    const repoRoot = enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1"), node("ENG-2")] });
    reconcileProject("alpha", repoRoot, { exec });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1", "ENG-2"]);
  });

  test("preserves the prior eligible set when runEligibleQuery throws", () => {
    const repoRoot = enroll("alpha", { team: "ENG", status: "Todo" });
    setProjectEligible("alpha", [node("ENG-PRIOR")], { source: "reconcile", query: {} });
    const throwingExec = () => ({ code: 1, stdout: "", stderr: "linearis down" });
    reconcileProject("alpha", repoRoot, { exec: throwingExec });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-PRIOR"]);
  });

  test("skips (no crash) a project whose loadProjectConfig returns null", () => {
    const repoRoot = enroll("alpha", null); // enrolled, no executionCore config
    const exec = execReturning({});
    expect(() => reconcileProject("alpha", repoRoot, { exec })).not.toThrow();
    expect(exec.calls).toBe(0);
  });
});

describe("handleStateChangedEvent", () => {
  test("an event whose toState != eligible status fast-path-removes the ticket", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    setProjectEligible("alpha", [node("ENG-1"), node("ENG-2")], {
      source: "reconcile",
      query: { team: "ENG", status: "Todo" },
    });
    handleStateChangedEvent({
      event: "linear.issue.state_changed",
      detail: { ticket: "ENG-1", teamKey: "ENG", toState: "In Progress" },
    });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-2"]);
  });

  test("an event whose toState == eligible status schedules a debounced reconcile (no immediate poll)", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Todo" },
      },
      { exec, debounceMs: 30 },
    );
    expect(exec.calls).toBe(0); // not polled synchronously
    await sleep(70);
    expect(exec.calls).toBe(1);
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-9"]);
  });

  test("multiple events for one project within the debounce window coalesce into one reconcile", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    for (const ticket of ["ENG-7", "ENG-8", "ENG-9"]) {
      handleStateChangedEvent(
        {
          event: "linear.issue.state_changed",
          detail: { ticket, teamKey: "ENG", toState: "Todo" },
        },
        { exec, debounceMs: 30 },
      );
    }
    await sleep(80);
    expect(exec.calls).toBe(1);
  });

  test("an event whose teamKey matches no enrolled project's query team is ignored", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    setProjectEligible("alpha", [node("ENG-1")], {
      source: "reconcile",
      query: { team: "ENG", status: "Todo" },
    });
    const exec = execReturning({});
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "OTHER-1", teamKey: "OTHER", toState: "In Progress" },
      },
      { exec, debounceMs: 30 },
    );
    await sleep(60);
    expect(exec.calls).toBe(0);
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });
});

describe("lifecycle", () => {
  test("startMonitor runs an immediate reconcileAll", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")] });
    startMonitor({ exec, reconcileIntervalMs: 60_000 });
    expect(getEligibleSet("alpha").map((t) => t.identifier)).toEqual(["ENG-1"]);
  });

  test("reconcileAll re-globs the enrollment dir — a new record is picked up, a removed one is dropped", () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-1")], PLAT: [node("PLAT-1")] });
    reconcileAll({ exec });
    expect(getEligibleSet("alpha")).toHaveLength(1);

    enroll("beta", { team: "PLAT", status: "Todo" });
    reconcileAll({ exec });
    expect(getEligibleSet("beta").map((t) => t.identifier)).toEqual(["PLAT-1"]);

    unenroll("alpha");
    reconcileAll({ exec });
    expect(getEligibleSet("alpha")).toEqual([]); // dropProject'd
  });

  test("stopMonitor clears pending debounce timers (a queued reconcile never fires)", async () => {
    enroll("alpha", { team: "ENG", status: "Todo" });
    const exec = execReturning({ ENG: [node("ENG-9")] });
    handleStateChangedEvent(
      {
        event: "linear.issue.state_changed",
        detail: { ticket: "ENG-9", teamKey: "ENG", toState: "Todo" },
      },
      { exec, debounceMs: 40 },
    );
    stopMonitor(); // clears the queued debounce timer
    await sleep(80);
    expect(exec.calls).toBe(0);
  });
});
