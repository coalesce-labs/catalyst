// governance-journey.contract.test.ts — CTL-1100 Phase 7
// Contract: GET /api/journey/:ticket gates deep-equal deriveAdvancement()
// computed from the same readers. Mutating verify.json between fetches must
// change body.gates (proves recomputation, not cached storage).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
// @ts-expect-error — execution-core mjs modules have no .d.mts; runtime types are correct
import * as schedulerMod from "../../execution-core/scheduler.mjs";
// @ts-expect-error — execution-core mjs modules have no .d.mts; runtime types are correct
import * as workDoneProbesMod from "../../execution-core/work-done-probes.mjs";

// Re-type the untyped .mjs exports at the boundary so call sites stay type-safe.
const readPhaseSignals = (schedulerMod as {
  readPhaseSignals: (orchDir: string, ticket: string) => unknown;
}).readPhaseSignals;
const deriveAdvancement = (schedulerMod as {
  deriveAdvancement: (
    signals: unknown,
    opts: { verifyVerdict?: unknown; remediateCycleCount?: number },
  ) => unknown;
}).deriveAdvancement;
const readVerifyVerdict = (workDoneProbesMod as {
  readVerifyVerdict: (opts: { ticket: string; orchDir: string }) => unknown;
}).readVerifyVerdict;

// ─── Setup: seed a temp orch dir with phase signals + verify artifact ─────────

let tmpDir: string;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
const TICKET = "CTL-5555";

function workerDir(): string {
  return join(tmpDir, "workers", TICKET);
}

function writeSignal(phase: string, status: string) {
  writeFileSync(
    join(workerDir(), `phase-${phase}.json`),
    JSON.stringify({ status, bg_job_id: "bg_test", updatedAt: new Date().toISOString() }),
  );
}

function writeVerify(regressionRisk: number, findings: Array<{ severity: string; title: string }> = []) {
  writeFileSync(
    join(workerDir(), "verify.json"),
    JSON.stringify({
      regression_risk: regressionRisk,
      findings,
      tests_attempted: true,
      generatedAt: new Date().toISOString(),
    }),
  );
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gov-journey-contract-"));
  mkdirSync(workerDir(), { recursive: true });

  // Seed: implement done → verify done (no high findings → should advance to review).
  writeSignal("implement", "done");
  writeSignal("verify", "done");
  writeVerify(0, []); // regression_risk < 5, no high findings → "pass"

  server = createServer({
    port: 0,
    startWatcher: false,
    dbPath: join(tmpDir, "catalyst.db"),
    wtDir: tmpDir,
    annotationsDbPath: join(tmpDir, "annotations.db"), // hermetic — never the host ~/catalyst path
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── helpers ────────────────────────────────────────────────────────────────

function jsonNorm<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ─── 1. gates deep-equals deriveAdvancement() on same data ──────────────────

describe("GET /api/journey/:ticket — gates contract", () => {
  it("body.gates.nextPhase deep-equals deriveAdvancement(signals, {verifyVerdict, remediateCycleCount})", async () => {
    const res = await fetch(`${baseUrl}/api/journey/${TICKET}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ticket: string;
      gates: { nextPhase: unknown; checklist: unknown[] };
      remediateCycles: number;
    };

    // Re-derive using the exact same daemon functions.
    const signals = readPhaseSignals(tmpDir, TICKET);
    const verdict = readVerifyVerdict({ ticket: TICKET, orchDir: tmpDir });
    const expectedNext = deriveAdvancement(signals, {
      verifyVerdict: verdict ?? undefined,
      remediateCycleCount: 0,
    });

    expect(body.gates.nextPhase).toEqual(jsonNorm(expectedNext));
  });

  it("body.gates.checklist has all phases as objects with phase/signalStatus/satisfied", async () => {
    const res = await fetch(`${baseUrl}/api/journey/${TICKET}`);
    const body = await res.json() as { gates: { checklist: Array<{ phase: string; signalStatus: string | null; satisfied: boolean }> } };

    expect(Array.isArray(body.gates.checklist)).toBe(true);
    expect(body.gates.checklist.length).toBeGreaterThan(0);
    for (const item of body.gates.checklist) {
      expect(typeof item.phase).toBe("string");
      expect("signalStatus" in item).toBe(true);
      expect(typeof item.satisfied).toBe("boolean");
    }
  });
});

// ─── 2. Mutation of verify.json between fetches changes body.gates ───────────

describe("GET /api/journey/:ticket — recomputation contract (not cached)", () => {
  it("changing verify.json to high-finding changes nextPhase to remediate", async () => {
    // First fetch: pass verdict → expect review (or further).
    const before = await fetch(`${baseUrl}/api/journey/${TICKET}`);
    const bodyBefore = await before.json() as { gates: { nextPhase: unknown } };
    const nextBefore = bodyBefore.gates.nextPhase;

    // Mutate: inject a high-severity finding → "fail" verdict → remediate.
    writeVerify(0, [{ severity: "high", title: "regression detected" }]);

    // Second fetch: must reflect the mutation (proves recomputation).
    const after = await fetch(`${baseUrl}/api/journey/${TICKET}`);
    const bodyAfter = await after.json() as { gates: { nextPhase: unknown } };
    const nextAfter = bodyAfter.gates.nextPhase;

    // Restore to pass state for other tests.
    writeVerify(0, []);

    // The nextPhase must have changed (pass → fail diverts to remediate).
    expect(nextAfter).not.toEqual(nextBefore);
    expect(nextAfter).toBe("remediate");
  });
});
