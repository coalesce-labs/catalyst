// CTL-1067 integration test — prove the cross-seam loop:
// respond event (buildResumeEvent) → daemon clearStall (defaultClearStall) →
// stalled signal gone, needs-human removed, no re-escalation.
// Exercises real implementations end-to-end over a tmp orch dir with a fake
// writeStatus whose removeLabel reports { removed: true }.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommentWake } from "../daemon.mjs";
import { defaultClearStall } from "../scheduler.mjs";
import {
  buildResumeEvent,
  findHeldRun,
} from "../../orch-monitor/lib/respond-ticket.mjs";

// Helpers matching daemon.test.mjs pattern.
const tmpOrcDir = () => mkdtempSync(join(tmpdir(), "ctl-1067-e2e-"));
const writeSignal = (orch, ticket, phase, data) => {
  const workerDir = join(orch, "workers", ticket);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    join(workerDir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, ...data }),
  );
};

let orchDir;
beforeEach(() => { orchDir = tmpOrcDir(); });
afterEach(() => { try { rmSync(orchDir, { recursive: true, force: true }); } catch { /**/ } });

describe("CTL-1067 E2E: respond event → daemon clearStall → signal gone + label removed", () => {
  it("respond event → daemon clearStall → stalled signal gone, needs-human removed, prior-done preserved", async () => {
    // Set up: a prior-done research signal + a stalled implement signal + the applied marker.
    writeSignal(orchDir, "CTL-1", "research", { status: "done", phase: "research" });
    writeSignal(orchDir, "CTL-1", "implement", { status: "stalled", phase: "implement", generation: 3 });
    const workerDir = join(orchDir, "workers", "CTL-1");
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");

    const removed = [];
    const writeStatus = {
      removeLabel: (t, l) => { removed.push({ t, l }); return { removed: true }; },
    };

    // Build the actual resume event the endpoint emits, parse it, then wake.
    const evt = buildResumeEvent({ ticket: "CTL-1", response: "retry please" });
    const parsed = {
      ticket: evt.body.payload.ticket,
      authorId: evt.body.payload.authorId,
    };

    await handleCommentWake(parsed, {
      orchDir,
      dispatch: () => {},
      removeLabel: async () => {},
      clearStall: defaultClearStall(orchDir, writeStatus),
    });

    // Stalled signal deleted.
    expect(existsSync(join(workerDir, "phase-implement.json"))).toBe(false);
    // Prior-done research signal preserved.
    expect(existsSync(join(workerDir, "phase-research.json"))).toBe(true);
    // needs-human label removed with the correct flat label name.
    expect(removed).toContainEqual({ t: "CTL-1", l: "needs-human" });
    // .applied marker deleted (re-arms labelOnce for future escalation).
    expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(false);
  });

  it("idempotency: second respond on the cleared ticket → findHeldRun returns null (not_held)", async () => {
    writeSignal(orchDir, "CTL-1", "implement", { status: "stalled", phase: "implement" });

    const writeStatus = { removeLabel: () => ({ removed: true }) };
    const parsed = { ticket: "CTL-1", authorId: null };

    // First respond clears the stall.
    await handleCommentWake(parsed, {
      orchDir,
      dispatch: () => {},
      removeLabel: async () => {},
      clearStall: defaultClearStall(orchDir, writeStatus),
    });

    // After clear, findHeldRun sees no stalled signal → returns null.
    const held = findHeldRun("CTL-1", {
      workersDir: join(orchDir, "workers"),
    });
    expect(held).toBeNull();
  });
});
