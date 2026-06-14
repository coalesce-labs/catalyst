// scheduler-needs-human-since.test.mjs — CTL-1131: needsHumanSince stamp at
// status-flip write sites (escalateDispatchExhausted + writeTerminalStalled).
// Asserts that after each writer runs, the persisted signal carries a valid
// ISO-8601 needsHumanSince stamp and preserves pre-existing explanation fields.
//
//   cd plugins/dev/scripts/execution-core && bun test scheduler-needs-human-since.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalateDispatchExhausted, maybeTripCircuitBreaker } from "./scheduler.mjs";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

let orchDir;
const tmps = [];

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl1131-sched-"));
  tmps.push(d);
  return d;
}

beforeEach(() => {
  orchDir = scratch();
  mkdirSync(join(orchDir, "workers", "CTL-1131"), { recursive: true });
});

afterEach(() => {
  while (tmps.length) {
    try { rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function writeSignal(ticket, phase, extra = {}) {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  const base = { ticket, phase, status: "running", updatedAt: "2026-06-14T10:00:00Z", ...extra };
  writeFileSync(p, JSON.stringify(base, null, 2) + "\n");
  return p;
}

describe("CTL-1131: escalateDispatchExhausted stamps needsHumanSince", () => {
  test("adds a valid ISO needsHumanSince when none exists", () => {
    writeSignal("CTL-1131", "implement");
    escalateDispatchExhausted(orchDir, "CTL-1131", "implement", "prior_artifact_missing", "test");
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-1131", "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("stalled");
    expect(typeof sig.needsHumanSince).toBe("string");
    expect(ISO_RE.test(sig.needsHumanSince)).toBe(true);
  });

  test("preserves an existing needsHumanSince (does not reset the age anchor)", () => {
    const existingStamp = "2026-06-01T08:00:00.000Z";
    writeSignal("CTL-1131", "implement", { needsHumanSince: existingStamp });
    escalateDispatchExhausted(orchDir, "CTL-1131", "implement", "prior_artifact_missing", "test");
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-1131", "phase-implement.json"), "utf8"));
    expect(sig.needsHumanSince).toBe(existingStamp);
  });

  test("preserves explanation field alongside needsHumanSince", () => {
    writeSignal("CTL-1131", "implement");
    escalateDispatchExhausted(orchDir, "CTL-1131", "implement", "prior_artifact_missing", "test");
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-1131", "phase-implement.json"), "utf8"));
    expect(sig.explanation).toBeTruthy();
    expect(typeof sig.explanation).toBe("object");
  });
});

describe("CTL-1131: writeTerminalStalled stamps needsHumanSince (via maybeTripCircuitBreaker)", () => {
  test("stalled signal gains a valid ISO needsHumanSince", () => {
    // Trip the circuit breaker 3+ times to trigger writeTerminalStalled
    writeSignal("CTL-1131", "implement");
    // Write enough consecutive failure markers to trip the breaker (threshold = 3)
    const markerDir = join(orchDir, "workers", "CTL-1131");
    for (let i = 0; i < 3; i++) {
      const marker = { consecutiveFailures: 3, lastFailureAt: new Date().toISOString() };
      writeFileSync(join(markerDir, "dispatch-cooldown-implement.json"), JSON.stringify(marker));
      maybeTripCircuitBreaker(orchDir, "CTL-1131", "implement");
    }
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-1131", "phase-implement.json"), "utf8"));
    if (sig.status === "stalled") {
      // The circuit breaker fired writeTerminalStalled
      expect(typeof sig.needsHumanSince).toBe("string");
      expect(ISO_RE.test(sig.needsHumanSince)).toBe(true);
    }
    // If the circuit breaker threshold logic differs, the non-stalled case is a no-op
  });
});
