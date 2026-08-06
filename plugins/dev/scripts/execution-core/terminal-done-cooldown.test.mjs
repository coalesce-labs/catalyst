// terminal-done-cooldown.test.mjs — CTL-1157 A1: the fence-suppress cooldown on
// the terminal-Done branch. Pure-sync (injected clock + fence), no real timers or
// fs.watch, so this suite is CI-safe (scheduler.test.mjs is excluded from the CI
// allowlist for its real-timer debounce suite — these assertions must live here).
//
// Context: on a multi-host fleet a genuinely-stale terminal fence used to re-run
// the fence-check subprocess (and the Linear reads it fronts) EVERY tick, forever
// — the CTL-1423 ~1,090/hr `stale fence` WARN storm — because ONLY the
// stalled/failed branch stamped the CTL-1329 cooldown; the terminalDoneOnce branch
// did not. A1 extends the same cooldown rail to terminalDoneOnce.
//
// Run: cd plugins/dev/scripts/execution-core && bun test terminal-done-cooldown.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { terminalDoneOnce } from "./scheduler.mjs";

describe("terminalDoneOnce — fence-suppress cooldown (CTL-1157 A1)", () => {
  const DEFAULT_COOLDOWN_MS = 15 * 60_000; // matches FENCE_SUPPRESS_COOLDOWN_MS default
  let orchDir;
  const wdir = (t) => join(orchDir, "workers", t);
  const suppressMarker = (t) => join(wdir(t), ".fence-suppressed");
  const doneMarker = (t) => join(wdir(t), ".terminal-done.applied");
  const mkWorker = (t) => mkdirSync(wdir(t), { recursive: true });
  // A writeStatus stub that records terminal-Done writes. emitDoneApplied is
  // injected to a no-op so a real Done write never touches the shared event log.
  const okWriteStatus = (doneCalls) => ({
    applyPhaseStatus: () => {},
    applyTerminalDone: ({ ticket }) => {
      doneCalls.push(ticket);
      return { applied: true, from_state: "Validate", to_state: "Done" };
    },
    applyLabel: () => ({ applied: true }),
  });

  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "term-cd-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("fence FAILS → arms the .fence-suppressed cooldown AND writes no Done", () => {
    const t = "CTL-1423";
    mkWorker(t);
    const doneCalls = [];
    terminalDoneOnce(orchDir, t, okWriteStatus(doneCalls), undefined, {
      multiHost: true,
      fence: () => false, // a genuinely stale/superseded fence
      now: () => 1_000,
      emitDoneApplied: () => {},
    });
    expect(doneCalls).toEqual([]); // suppressed — no terminal Done write
    expect(existsSync(suppressMarker(t))).toBe(true); // cooldown armed (the burn fix)
    expect(existsSync(doneMarker(t))).toBe(false); // no once-marker either
  });

  test("a FRESH cooldown short-circuits BEFORE the fence-check (no probe, no Done)", () => {
    const t = "CTL-1423";
    mkWorker(t);
    writeFileSync(suppressMarker(t), JSON.stringify({ ts: 1_000 }));
    let fenceCalls = 0;
    const doneCalls = [];
    terminalDoneOnce(orchDir, t, okWriteStatus(doneCalls), undefined, {
      multiHost: true,
      fence: () => {
        fenceCalls++;
        return true; // even a would-pass fence must NOT be consulted during cooldown
      },
      now: () => 1_000 + 60_000, // 1 min later — inside the 15-min window
      emitDoneApplied: () => {},
    });
    expect(fenceCalls).toBe(0); // the whole point: the fence subprocess is skipped
    expect(doneCalls).toEqual([]); // and no Done write this window
  });

  test("an EXPIRED cooldown re-probes; a now-current fence self-heals to Done", () => {
    const t = "CTL-1423";
    mkWorker(t);
    writeFileSync(suppressMarker(t), JSON.stringify({ ts: 1_000 }));
    let fenceCalls = 0;
    const doneCalls = [];
    terminalDoneOnce(orchDir, t, okWriteStatus(doneCalls), undefined, {
      multiHost: true,
      fence: () => {
        fenceCalls++;
        return true; // fence has become current again
      },
      now: () => 1_000 + DEFAULT_COOLDOWN_MS + 1, // just past the window
      emitDoneApplied: () => {},
    });
    expect(fenceCalls).toBe(1); // re-probed after the window
    expect(doneCalls).toEqual([t]); // fence current → the Done write lands
    expect(existsSync(doneMarker(t))).toBe(true); // once-marker written
  });

  test("single-host (multiHost:false) → real fence passes, Done lands, no cooldown marker", () => {
    const t = "CTL-1423";
    mkWorker(t);
    const doneCalls = [];
    // No `fence` override → uses the real fenceGuard, which returns true
    // unconditionally on single-host (multiHost:false).
    terminalDoneOnce(orchDir, t, okWriteStatus(doneCalls), undefined, {
      multiHost: false,
      now: () => 1_000,
      emitDoneApplied: () => {},
    });
    expect(doneCalls).toEqual([t]);
    expect(existsSync(suppressMarker(t))).toBe(false); // never armed on the happy path
    expect(existsSync(doneMarker(t))).toBe(true);
  });

  test("already-applied (.terminal-done.applied present) → no fence-check, no re-write", () => {
    const t = "CTL-1423";
    mkWorker(t);
    writeFileSync(doneMarker(t), "");
    let fenceCalls = 0;
    const doneCalls = [];
    terminalDoneOnce(orchDir, t, okWriteStatus(doneCalls), undefined, {
      multiHost: true,
      fence: () => {
        fenceCalls++;
        return true;
      },
      now: () => 1_000,
      emitDoneApplied: () => {},
    });
    expect(fenceCalls).toBe(0); // once-marker short-circuits before anything else
    expect(doneCalls).toEqual([]);
  });
});
