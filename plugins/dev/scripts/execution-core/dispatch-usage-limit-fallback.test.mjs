import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePhaseAwareDispatchFn } from "./dispatch.mjs";
import { parkLane } from "./lane-cooldown.mjs";

test("a bg phase falls back to codex while bg is parked", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-fallback-"));
  try {
    const now = Date.parse("2026-08-08T20:00:00Z");
    parkLane(dir, "bg", { resetsAt: "2026-08-10T18:00:00Z", now });
    const dispatched = [], events = [];
    const fn = makePhaseAwareDispatchFn({ bootExecutor: "bg", codexBootEligible: true, orchDir: dir, now: () => now,
      resolveExecutorForPhase: () => ({ source: "executorByPhase", executor: "bg" }),
      dispatchForExecutor: (executor) => (args) => { dispatched.push(executor); return { code: 0, args }; }, emitEvent: (event) => events.push(event) });
    fn({ ticket: "CAT-58", phase: "research" });
    expect(dispatched).toEqual(["codex-exec"]);
    expect(events.some((event) => event["event.name"] === "execution-core.executor.usage-limit-fallback")).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
