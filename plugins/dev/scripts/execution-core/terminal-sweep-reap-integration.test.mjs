import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeRequestTerminalSweepReap } from "./scheduler.mjs";

describe("terminal-sweep reap scheduler integration", () => {
  const term = { terminal: true, reason: "linear-terminal", state: "Done" };
  const target = { worktreePath: "/wt/PROJ-900", worktreeOnDisk: true, branch: "PROJ-900", bgJobId: "job-1", inFlight: false, liveSessionInWorktree: false };

  test.each([["shadow", "terminalSweep.would.reap-request"], ["enforce", "orphans.reap-requested"]])("%s emits the targeted event once", (mode, type) => {
    const orchDir = mkdtempSync(join(tmpdir(), "cat169-int-")); const events = [];
    mkdirSync(join(orchDir, "workers", "PROJ-900"), { recursive: true });
    const seam = { mode, resolveTarget: () => target, emit: (event, fields) => events.push({ event, fields }) };
    maybeRequestTerminalSweepReap(orchDir, "PROJ-900", term, seam);
    maybeRequestTerminalSweepReap(orchDir, "PROJ-900", term, seam);
    expect(events).toEqual([{ event: type, fields: { ticket: "PROJ-900", worktreePath: "/wt/PROJ-900", branch: "PROJ-900", bgJobId: "job-1", reason: "terminal-sweep-out-of-band-merge" } }]);
    expect(existsSync(join(orchDir, "workers", "PROJ-900", ".terminal-sweep-reap.applied"))).toBe(true);
  });

  test("off, canceled, live, and inert seams emit nothing", () => {
    const events = []; const base = { resolveTarget: () => target, emit: (...args) => events.push(args), hasRequested: () => false, markRequested: () => true };
    maybeRequestTerminalSweepReap("/orch", "PROJ-900", term, { ...base, mode: "off" });
    maybeRequestTerminalSweepReap("/orch", "PROJ-900", { ...term, state: "Canceled" }, { ...base, mode: "shadow" });
    maybeRequestTerminalSweepReap("/orch", "PROJ-900", term, { ...base, mode: "shadow", resolveTarget: () => ({ ...target, liveSessionInWorktree: true }) });
    maybeRequestTerminalSweepReap("/orch", "PROJ-900", term, undefined);
    expect(events).toHaveLength(0);
  });

  test("marks before emitting and contains resolver exceptions", () => {
    const order = [];
    maybeRequestTerminalSweepReap("/orch", "PROJ-900", term, { mode: "shadow", hasRequested: () => false, resolveTarget: () => target, markRequested: () => { order.push("mark"); return true; }, emit: () => order.push("emit") });
    expect(order).toEqual(["mark", "emit"]);
    expect(() => maybeRequestTerminalSweepReap("/orch", "PROJ-900", term, { mode: "shadow", hasRequested: () => false, resolveTarget: () => { throw new Error("boom"); }, emit: () => {} })).not.toThrow();
  });
});
