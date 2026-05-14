// orch-state-reader.test.ts — tests for the orchestrator scan.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOrchStates } from "./orch-state-reader.ts";

const NOW = Date.parse("2026-05-14T16:00:00Z");

function makeOrch(root: string, name: string, state: Record<string, unknown>, workers: Record<string, unknown>[] = []) {
  const dir = join(root, name);
  mkdirSync(join(dir, "workers"), { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ orchestrator: name, ...state }));
  for (const w of workers) {
    const ticket = (w["ticket"] as string) ?? "T-?";
    writeFileSync(join(dir, "workers", `${ticket}.json`), JSON.stringify({
      ticket,
      orchestrator: name,
      workerName: `${name}-${ticket}`,
      status: "implementing",
      ...w,
    }));
  }
}

describe("readOrchStates", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "hud-os-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("missing runs dir → empty", () => {
    expect(readOrchStates(join(tmp, "missing"))).toEqual([]);
  });

  test("two orchestrators → 2 states with correct counts", () => {
    makeOrch(tmp, "orch-a", { currentWave: 1, totalWaves: 2, maxParallel: 3, queue: [1, 2, 3], startedAt: new Date(NOW - 3_600_000).toISOString(), baseBranch: "main" }, [
      { ticket: "T-1", workerName: "orch-a-T-1", status: "implementing" },
      { ticket: "T-2", workerName: "orch-a-T-2", status: "done" },
      { ticket: "T-3", workerName: "orch-a-T-3", status: "researching" },
    ]);
    makeOrch(tmp, "orch-b", { currentWave: 1, totalWaves: 1, maxParallel: 1, queue: [], startedAt: new Date(NOW - 60_000).toISOString() }, [
      { ticket: "T-9", workerName: "orch-b-T-9", status: "failed" },
    ]);

    const out = readOrchStates(tmp);
    expect(out).toHaveLength(2);
    const a = out.find((o) => o.id === "orch-a");
    const b = out.find((o) => o.id === "orch-b");
    if (!a || !b) throw new Error("expected both orchestrators to be present");
    expect(a.currentWave).toBe(1);
    expect(a.totalWaves).toBe(2);
    expect(a.queueLength).toBe(3);
    expect(a.maxParallel).toBe(3);
    expect(a.baseBranch).toBe("main");
    expect(a.workersCount.total).toBe(3);
    expect(a.workersCount.active).toBe(2);   // implementing + researching
    expect(b.workersCount.total).toBe(1);
    expect(b.workersCount.active).toBe(0);   // failed → terminal
  });

  test("orchestrator without state.json is skipped", () => {
    mkdirSync(join(tmp, "orch-no-state"), { recursive: true });
    expect(readOrchStates(tmp)).toEqual([]);
  });

  test("malformed state.json is skipped", () => {
    mkdirSync(join(tmp, "orch-bad"), { recursive: true });
    writeFileSync(join(tmp, "orch-bad", "state.json"), "{ not valid");
    expect(readOrchStates(tmp)).toEqual([]);
  });

  test("tolerates missing optional fields", () => {
    mkdirSync(join(tmp, "orch-min"), { recursive: true });
    writeFileSync(join(tmp, "orch-min", "state.json"), JSON.stringify({ orchestrator: "orch-min" }));
    const out = readOrchStates(tmp);
    expect(out).toHaveLength(1);
    expect(out[0].queueLength).toBe(0);
    expect(out[0].currentWave).toBeNull();
    expect(out[0].startedAt).toBeNull();
  });
});
