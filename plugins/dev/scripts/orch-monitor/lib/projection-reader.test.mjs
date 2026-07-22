// projection-reader.test.mjs — CTL-1489: vite-safe orch-monitor projection reader.
// Run: cd plugins/dev/scripts/orch-monitor && bun test lib/projection-reader.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertWorkerState,
} from "../../broker/broker-state.mjs";
import {
  readWorkerSignalsFromProjection,
  findHeldRunFromProjection,
} from "./projection-reader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "om-proj-reader-"));
  dbPath = join(tmpDir, "filter-state.db");
  openBrokerStateDb(dbPath);
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seed(over = {}) {
  const pick = (k, dflt) => (k in over ? over[k] : dflt);
  upsertWorkerState({
    orchestrator: pick("orchestrator", "CTL-1"),
    ticket: pick("ticket", "CTL-1"),
    phase: pick("phase", "implement"),
    status: pick("status", "running"),
    worktreePath: pick("worktreePath", "/wt/CTL-1"),
    bgJobId: pick("bgJobId", "bg-1"),
    generation: pick("generation", 2),
    artifact: pick("artifact", "thoughts/x.md"),
    eventTs: "2026-07-22T00:00:00Z",
    eventId: pick("eventId", "e1"),
  });
}

describe("orch-monitor readWorkerSignalsFromProjection", () => {
  test("reproduces the WorkerSignal shape from durable state", async () => {
    seed();
    closeBrokerStateDb(); // reader re-opens dbPath itself
    const sigs = await readWorkerSignalsFromProjection(dbPath);
    const s = sigs.find((x) => x.ticket === "CTL-1");
    expect(s).toBeDefined();
    for (const k of [
      "ticket", "layout", "signalPath", "phase", "status",
      "liveness", "updatedAt", "pr", "worktreePath", "host", "raw",
    ]) {
      expect(k in s, `missing ${k}`).toBe(true);
    }
    expect(s.liveness.kind).toBe("bg");
    expect(s.worktreePath).toBe("/wt/CTL-1");
  });

  test("returns [] when the DB file is absent (never throws)", async () => {
    expect(await readWorkerSignalsFromProjection(join(tmpDir, "nope.db"))).toEqual([]);
  });
});

describe("orch-monitor findHeldRunFromProjection", () => {
  test("returns { phase, signal } for a needs-input worker", async () => {
    seed({ ticket: "CTL-3", phase: "implement", status: "needs-input" });
    closeBrokerStateDb();
    const held = await findHeldRunFromProjection("CTL-3", dbPath);
    expect(held.phase).toBe("implement");
    expect(held.signal.status).toBe("needs-input");
  });

  test("returns null for a running worker", async () => {
    seed({ ticket: "CTL-5", status: "running" });
    closeBrokerStateDb();
    expect(await findHeldRunFromProjection("CTL-5", dbPath)).toBe(null);
  });
});

// CTL-1372 build-graph guard: the source MUST NOT contain a literal
// import("../../broker/broker-state.mjs") — that would let esbuild pull
// bun:sqlite into the vite config bundle and break `vite build`.
describe("CTL-1372 vite-graph guard", () => {
  test("reader contains no literal broker-state.mjs dynamic import", () => {
    const src = readFileSync(join(HERE, "projection-reader.mjs"), "utf8");
    // no literal import("...broker-state.mjs")
    expect(/import\(\s*["'][^"']*broker-state\.mjs["']\s*\)/.test(src)).toBe(false);
    // and it DOES use the computed-specifier constant
    expect(src.includes("BROKER_STATE_MODULE")).toBe(true);
  });
});
