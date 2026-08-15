// phase-yield-e2e.test.mjs — CTL-1854: the whole path, end to end, no mocks of it.
//
// Run: cd plugins/dev/scripts/execution-core && bun test phase-yield-e2e.test.mjs
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Three defects on this ticket shared one shape: **the path existed but did not
// run, or did not mean what it said.**
//
//   1. The expiry branch referenced a variable declared later in the function.
//      Every call threw a TDZ ReferenceError that a best-effort `catch` swallowed,
//      so expiry NEVER RAN — past a green unit test AND a passing mutation control,
//      because that test asserted the branch's SOURCE ORDER rather than executing it.
//   2. countYieldedOccupancy returned a bare number, so "no yields" and "could not
//      look" were byte-identical to four callers that subtract it from maxParallel.
//   3. The fix for (2) scanned CTL-702's `phase-*-yield-*.json` AUDIT TOMBSTONES —
//      an unrelated mechanism sharing the word "yield" — so one torn tombstone
//      would have held fleet admission closed forever.
//
// A test that never executes the path proves the path exists, not that it works.
// So this file drives the REAL artifacts: the real bash emitter writes the yield,
// a real clock is advanced past the ceiling, the real expiry evaluator runs over a
// real signal directory, and the real occupancy reader is asked what freed. The
// only injected thing is time — which is the one input a test may not wait for.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expireYieldedSignals } from "./scheduler.mjs";
import { countYieldedOccupancy } from "./signal-reader.mjs";
import { MAX_YIELD_MS, YIELD_EXPIRED_REASON, YIELDED_STATUS } from "../lib/phase-yield.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT = join(HERE, "..", "phase-agent-emit-complete");

function scenario() {
  const orch = mkdtempSync(join(tmpdir(), "yield-e2e-"));
  mkdirSync(join(orch, "workers", "PROJ-1"), { recursive: true });
  mkdirSync(join(orch, "events"), { recursive: true });
  writeFileSync(
    join(orch, "workers", "PROJ-1", "phase-implement.json"),
    JSON.stringify({ ticket: "PROJ-1", phase: "implement", status: "running" })
  );
  return orch;
}
const signalOf = (orch) =>
  JSON.parse(readFileSync(join(orch, "workers", "PROJ-1", "phase-implement.json"), "utf8"));

// The REAL emitter, as an agent would invoke it.
function declareYield(orch, extraArgs = []) {
  return execFileSync(
    "bash",
    [EMIT, "--phase", "implement", "--ticket", "PROJ-1", "--status", "yield", "--orch-dir", orch, ...extraArgs],
    { env: { ...process.env, CATALYST_DIR: orch }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

describe("CTL-1854 end to end: declare → hold → expire", () => {
  test("the real emitter writes a real yield, and it holds exactly one slot", () => {
    const orch = scenario();
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true }); // control
    declareYield(orch);
    const sig = signalOf(orch);
    expect(sig.status).toBe(YIELDED_STATUS);
    expect(typeof sig.yieldedAt).toBe("string");
    expect(sig.completedAt).toBeUndefined(); // non-terminal
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });
  });

  test("⚠️ THE WHOLE PATH: a live yield survives a tick; an expired one does not", () => {
    const orch = scenario();
    declareYield(orch);

    // Advance a real injected clock, rather than sleeping. `expireYieldedSignals`
    // runs the REAL evaluator over the REAL directory — this is the step whose
    // absence went unnoticed for four rounds.
    const realNow = Date.now;
    try {
      // (a) Inside the deadline: the tick must leave it alone.
      globalThis.Date.now = () => realNow() + 60_000;
      expireYieldedSignals(orch);
      expect(signalOf(orch).status).toBe(YIELDED_STATUS);
      expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });

      // (b) Past the ceiling: the tick must write the terminal.
      globalThis.Date.now = () => realNow() + MAX_YIELD_MS + 60_000;
      expireYieldedSignals(orch);
    } finally {
      globalThis.Date.now = realNow;
    }

    const sig = signalOf(orch);
    expect(sig).toMatchObject({
      status: "failed",
      outcome: "abandoned",
      failureReason: YIELD_EXPIRED_REASON,
    });
    // ...and the slot it was holding is freed by exactly one.
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true });
  });

  test("a CTL-702 tombstone in the same dir affects neither the hold nor the expiry", () => {
    // The name collision that nearly stalled fleet dispatch: these files share the
    // word "yield" and are audit artifacts, not lifecycle signals.
    const orch = scenario();
    declareYield(orch);
    writeFileSync(join(orch, "workers", "PROJ-1", "phase-implement-yield-deadbeef.json"), "{tor");
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });

    const realNow = Date.now;
    try {
      globalThis.Date.now = () => realNow() + MAX_YIELD_MS + 60_000;
      expireYieldedSignals(orch);
    } finally {
      globalThis.Date.now = realNow;
    }
    expect(signalOf(orch).failureReason).toBe(YIELD_EXPIRED_REASON);
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true });
  });

  test("⚠️ a torn REAL signal reports could-not-look, not an empty slot", () => {
    // Defect 2 of the three: occupancy returned a bare number, so an unreadable
    // signal read as ZERO — i.e. as free capacity — to four callers that subtract
    // it from maxParallel. The tombstone case above proves the exclusion did not
    // become a blanket "ignore anything unparseable"; this proves the fail-closed
    // half is still armed for the files that matter.
    const orch = scenario();
    declareYield(orch);
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true }); // control
    writeFileSync(join(orch, "workers", "PROJ-1", "phase-implement.json"), '{"status":"awaiting-w');
    const out = countYieldedOccupancy(orch);
    expect(out.ok).toBe(false);
    expect(out.count).toBe(0);
    // The pair (count 0, ok false) is what lets every caller hold admission; a bare
    // 0 would be indistinguishable from "no yields outstanding".
  });

  test("a short --yield-seconds expires on ITS deadline, through the real emitter", () => {
    const orch = scenario();
    declareYield(orch, ["--yield-seconds", "60"]);
    expect(signalOf(orch).yieldMs).toBe(60_000);

    const realNow = Date.now;
    try {
      globalThis.Date.now = () => realNow() + 30_000;
      expireYieldedSignals(orch);
      expect(signalOf(orch).status).toBe(YIELDED_STATUS); // still inside 60s
      globalThis.Date.now = () => realNow() + 90_000;
      expireYieldedSignals(orch);
    } finally {
      globalThis.Date.now = realNow;
    }
    expect(signalOf(orch).failureReason).toBe(YIELD_EXPIRED_REASON);
  });

  test("the emitter REFUSES a yield it cannot record, and publishes no event", () => {
    const orch = scenario();
    writeFileSync(
      join(orch, "workers", "PROJ-1", "phase-implement.json"),
      JSON.stringify({ ticket: "PROJ-1", phase: "implement", status: "done" })
    );
    expect(() => declareYield(orch)).toThrow(); // non-zero exit
    expect(signalOf(orch).status).toBe("done"); // completed phase preserved
    // No yield event escaped for a declaration that did not happen.
    const eventsDir = join(orch, "events");
    const any = existsSync(eventsDir)
      ? execFileSync("bash", ["-c", `grep -l 'implement.yield' ${eventsDir}/*.jsonl 2>/dev/null || true`], { encoding: "utf8" })
      : "";
    expect(any.trim()).toBe("");
  });
});

describe("⚠️ a supported wait is not an anomaly", () => {
  // The stalled detector's cutoff is 15 minutes; a yield may live for 30, and its
  // worker has intentionally exited so nothing refreshes `updatedAt`. Reporting a
  // valid 15–30 minute yield as `stalled` is a FALSE attention, and a detector
  // that cries wolf on a supported state is worse than one that stays quiet.
  test("a live yield raises no stalled attention; an expired one still does", async () => {
    const { detectStalled } = await import("./stalled-detector.mjs");
    const now = Date.now();
    const at = (min) => ({
      currentStatus: YIELDED_STATUS,
      updatedAtMs: now - min * 60_000,
      nowMs: now,
      signal: { status: YIELDED_STATUS, yieldedAt: new Date(now - min * 60_000).toISOString() },
    });
    // Inside the ceiling — silent, even past the 15-minute staleness cutoff.
    expect(detectStalled(at(5)).attention).toBeNull();
    expect(detectStalled(at(20)).attention).toBeNull();
    // Past it — the exemption ends with the deadline, so a genuinely stuck ticket
    // is still reported rather than hidden forever by the status.
    expect(detectStalled(at(45)).attention).toMatchObject({ kind: "stalled" });
    // Control: an ordinary stale worker is unaffected by any of this.
    expect(detectStalled({ currentStatus: "running", updatedAtMs: now - 45 * 60_000, nowMs: now }).attention)
      .toMatchObject({ kind: "stalled" });
  });
});
