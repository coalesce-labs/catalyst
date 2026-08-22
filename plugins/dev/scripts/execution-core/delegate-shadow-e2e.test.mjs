// delegate-shadow-e2e.test.mjs — CTL-1774 Phase 4: integration test
// Proves the operator-facing contract through the REAL (un-spied) emitter path:
// shadow mode writes one `delegate.would-route` JSONL line to a temp event log;
// off mode writes nothing.
//
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-shadow-e2e.test.mjs

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routeStuckTicketToDelegate } from "./delegate-first.mjs";
import { appendDelegateEvent } from "./delegate-event.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
let prevDelegateFirst;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  prevDelegateFirst = process.env.CATALYST_DELEGATE_FIRST;
  orchDir = mkdtempSync(join(tmpdir(), "del-e2e-orch-"));
  catalystDir = mkdtempSync(join(tmpdir(), "del-e2e-cat-"));
  process.env.CATALYST_DIR = catalystDir;
  // Create the events dir so the real emitter can write to it.
  mkdirSync(join(catalystDir, "events"), { recursive: true });
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  if (prevDelegateFirst === undefined) delete process.env.CATALYST_DELEGATE_FIRST;
  else process.env.CATALYST_DELEGATE_FIRST = prevDelegateFirst;
  rmSync(orchDir, { recursive: true, force: true });
  rmSync(catalystDir, { recursive: true, force: true });
});

describe("CTL-1774 Phase 4 — end-to-end integration", () => {
  test("shadow mode: real appendDelegateEvent writes one delegate.would-route line to the event log", () => {
    const labelSpy = mock(() => ({ applied: true }));

    routeStuckTicketToDelegate(orchDir, "CTL-TEST", {
      site: "terminal-sweep",
      reason: "stalled",
      applyLabel: { applyLabel: labelSpy, transition: () => {}, applyPhaseStatus: () => {} },
      env: { CATALYST_DELEGATE_FIRST: "shadow" },
      appendEvent: (evt) => appendDelegateEvent({ ...evt, orchId: "CTL-TEST" }),
    });

    // ⛔ CTL-2159: was toHaveBeenCalledTimes(1). Shadow no longer labels because
    // NOTHING labels — the publish chokepoint routes through the classifier.
    expect(labelSpy).toHaveBeenCalledTimes(0);

    // Real emitter wrote to the event log
    const now = new Date();
    const logPath = join(
      catalystDir,
      "events",
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`
    );
    const raw = readFileSync(logPath, "utf8").trim().split("\n");
    expect(raw).toHaveLength(1);
    const ev = JSON.parse(raw[0]);
    expect(ev.attributes["event.name"]).toBe("delegate.would-route");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-TEST");
    expect(ev.attributes["catalyst.delegate.site"]).toBe("terminal-sweep");
    expect(ev.attributes["catalyst.delegate.reason"]).toBe("stalled");
    expect(ev.severityText).toBe("INFO");

    // Verify .delegate-queue/ was NOT created — shadow never enqueues
    let queueExists = false;
    try {
      readFileSync(join(orchDir, ".delegate-queue"), "utf8");
      queueExists = true;
    } catch {
      /* expected */
    }
    expect(queueExists).toBe(false);
  });

  test("off mode: no event written to the event log (byte-identical to pre-CTL-1774 behavior)", () => {
    const labelSpy = mock(() => ({ applied: true }));

    routeStuckTicketToDelegate(orchDir, "CTL-TEST", {
      site: "terminal-sweep",
      reason: "stalled",
      applyLabel: { applyLabel: labelSpy, transition: () => {}, applyPhaseStatus: () => {} },
      env: { CATALYST_DELEGATE_FIRST: "off" },
      appendEvent: (evt) => appendDelegateEvent({ ...evt, orchId: "CTL-TEST" }),
    });

    // ⛔ CTL-2159: was toHaveBeenCalledTimes(1) — see the shadow case above.
    expect(labelSpy).toHaveBeenCalledTimes(0);

    // No file written
    const now = new Date();
    const logPath = join(
      catalystDir,
      "events",
      `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`
    );
    let fileExists = false;
    try {
      readFileSync(logPath, "utf8");
      fileExists = true;
    } catch {
      /* expected */
    }
    expect(fileExists).toBe(false);
  });
});
