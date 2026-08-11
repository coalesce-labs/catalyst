// triage-cap-outcome.test.mjs — CAT-83: integration coverage for productive
// triage outcomes, stale artifacts, and one-shot cap escalation side effects.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ownedBy } from "./hrw.mjs";
import {
  TRIAGE_DISPATCH_CAP,
  bumpTriageDispatchCount,
  dispatchTriage,
  readTriageDispatchCount,
} from "./monitor.mjs";

let orchDir;
beforeEach(() => { orchDir = mkdtempSync(join(tmpdir(), "triage-cap-outcome-")); });
afterEach(() => { rmSync(orchDir, { recursive: true, force: true }); });

function seed(ticket, { artifact = false, status = null, count = 0 } = {}) {
  const worker = join(orchDir, "workers", ticket);
  mkdirSync(worker, { recursive: true });
  if (artifact) writeFileSync(join(worker, "triage.json"), "{}");
  if (status) writeFileSync(join(worker, "phase-triage.json"), JSON.stringify({ status }));
  for (let i = 0; i < count; i++) bumpTriageDispatchCount(orchDir, ticket);
}

function capOpts(overrides = {}) {
  return {
    orchDir,
    dispatch: () => ({ code: 0 }),
    isDraining: () => false,
    hosts: ["vega"],
    hostName: "vega",
    labelNeedsHuman: () => {},
    postCapComment: () => {},
    appendCapEvent: () => {},
    ...overrides,
  };
}

describe("dispatchTriage — outcome-aware cap (CAT-83)", () => {
  test("done signal plus artifact clears the current episode and does not dispatch", () => {
    seed("CAT-83", { artifact: true, status: "done", count: TRIAGE_DISPATCH_CAP });
    let dispatches = 0;
    expect(dispatchTriage("CAT-83", capOpts({ dispatch: () => { dispatches++; return { code: 0 }; } }))).toBe(false);
    expect(readTriageDispatchCount(orchDir, "CAT-83")).toBe(0);
    expect(dispatches).toBe(0);
  });

  test("stale artifact plus failed signal still parks at cap; comment and event emit once", () => {
    seed("CAT-83", { artifact: true, status: "failed", count: TRIAGE_DISPATCH_CAP });
    let labels = 0; let comments = 0; let events = 0; let dispatches = 0;
    const opts = capOpts({
      dispatch: () => { dispatches++; return { code: 0 }; },
      labelNeedsHuman: () => { labels++; },
      postCapComment: () => { comments++; },
      appendCapEvent: () => { events++; },
    });
    expect(dispatchTriage("CAT-83", opts)).toBe(false);
    expect(dispatchTriage("CAT-83", opts)).toBe(false);
    expect(readTriageDispatchCount(orchDir, "CAT-83")).toBe(TRIAGE_DISPATCH_CAP);
    expect(dispatches).toBe(0);
    expect(labels).toBe(2);
    expect(comments).toBe(1);
    expect(events).toBe(1);
  });

  test("failed cap comment delivery retries on the next capped sweep", () => {
    seed("CAT-83", { status: "failed", count: TRIAGE_DISPATCH_CAP });
    let comments = 0; let events = 0;
    const opts = capOpts({
      postCapComment: () => {
        comments++;
        if (comments === 1) throw new Error("temporary Linear failure");
      },
      appendCapEvent: () => { events++; },
    });
    expect(dispatchTriage("CAT-83", opts)).toBe(false);
    expect(dispatchTriage("CAT-83", opts)).toBe(false);
    expect(comments).toBe(2);
    expect(events).toBe(1);
  });

  test("multi-host fence reset runs only for an owned productive transition", () => {
    const hosts = ["vega", "mini"];
    let ownedTicket = "CAT-83";
    while (!ownedBy(ownedTicket, hosts, "vega")) ownedTicket += "x";
    seed(ownedTicket, { artifact: true, status: "done", count: 1 });
    let resets = 0;
    dispatchTriage(ownedTicket, capOpts({ hosts, resetFenceTriageAttempt: () => { resets++; } }));
    dispatchTriage(ownedTicket, capOpts({ hosts, resetFenceTriageAttempt: () => { resets++; } }));
    expect(resets).toBe(1);
  });

  test("non-owner host neither parks nor clears", () => {
    const hosts = ["vega", "mini"];
    let ticket = "CAT-83";
    while (ownedBy(ticket, hosts, "vega")) ticket += "x";
    seed(ticket, { artifact: true, status: "done", count: TRIAGE_DISPATCH_CAP });
    let labels = 0;
    expect(dispatchTriage(ticket, capOpts({ hosts, labelNeedsHuman: () => { labels++; } }))).toBe(false);
    expect(readTriageDispatchCount(orchDir, ticket)).toBe(TRIAGE_DISPATCH_CAP);
    expect(labels).toBe(0);
  });
});
