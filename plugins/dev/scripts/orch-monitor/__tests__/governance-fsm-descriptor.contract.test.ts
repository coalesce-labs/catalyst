// governance-fsm-descriptor.contract.test.ts — CTL-1100 Phase 7
// Contract: the /api/fsm/descriptor HTTP body is derived from the exact same
// daemon modules the contract test imports. A hand-copied phase list or a
// stale workflow.default.json must turn this suite red.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createServer } from "../server";

// Import the exact daemon modules the endpoint serves from.
import {
  PHASES,
  NEXT_PHASE,
  DESCRIPTOR_PATH,
  STAGE_RANK,
  TERMINAL_PHASE,
  NEW_WORK_ENTRY_PHASE,
  NON_PREEMPTABLE_PHASES,
  ANCILLARY_PHASES,
  REMEDIATE_CYCLE_CAP,
} from "../../lib/workflow-descriptor.mjs";
import { REVIVE_BUDGET } from "../../lib/phase-fsm.mjs";
import { enumerateTransitions } from "../../lib/fsm-descriptor.mjs";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gov-fsm-contract-"));
  server = createServer({ port: 0, startWatcher: false, dbPath: join(tmpDir, "catalyst.db"), wtDir: tmpDir });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchDescriptor(): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/fsm/descriptor`);
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}

function jsonNorm<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

// ─── 1. descriptorSha matches sha256(bytes of DESCRIPTOR_PATH) ──────────────

describe("GET /api/fsm/descriptor — descriptorSha contract", () => {
  it("descriptorSha equals sha256 of workflow-descriptor.mjs bytes", async () => {
    const body = await fetchDescriptor();
    const expected = createHash("sha256")
      .update(readFileSync(DESCRIPTOR_PATH))
      .digest("hex");
    expect(body.descriptorSha).toBe(expected);
  });
});

// ─── 2. Scalar fields deep-equal live daemon exports ─────────────────────────

describe("GET /api/fsm/descriptor — scalar field contracts", () => {
  it("phases deep-equals PHASES", async () => {
    const body = await fetchDescriptor();
    expect(body.phases).toEqual(jsonNorm(PHASES));
  });

  it("stageRank deep-equals STAGE_RANK", async () => {
    const body = await fetchDescriptor();
    // Key-order-sensitive: STAGE_RANK is an object keyed by phase name.
    expect(body.stageRank).toEqual(jsonNorm(STAGE_RANK));
  });

  it("nextPhase map deep-equals NEXT_PHASE", async () => {
    const body = await fetchDescriptor();
    expect(body.nextPhase).toEqual(jsonNorm(NEXT_PHASE));
  });

  it("terminalPhase equals TERMINAL_PHASE", async () => {
    const body = await fetchDescriptor();
    expect(body.terminalPhase).toBe(TERMINAL_PHASE);
  });

  it("entryPhase equals NEW_WORK_ENTRY_PHASE", async () => {
    const body = await fetchDescriptor();
    expect(body.entryPhase).toBe(NEW_WORK_ENTRY_PHASE);
  });

  it("nonPreemptable deep-equals [...NON_PREEMPTABLE_PHASES] (Set spread to array)", async () => {
    const body = await fetchDescriptor();
    // NON_PREEMPTABLE_PHASES is a Set; the endpoint spreads it to an array.
    expect(body.nonPreemptable).toEqual([...NON_PREEMPTABLE_PHASES]);
  });

  it("ancillaryPhases deep-equals ANCILLARY_PHASES", async () => {
    const body = await fetchDescriptor();
    expect(body.ancillaryPhases).toEqual(jsonNorm(ANCILLARY_PHASES));
  });

  it("remediateCycleCap equals REMEDIATE_CYCLE_CAP", async () => {
    const body = await fetchDescriptor();
    expect(body.remediateCycleCap).toBe(REMEDIATE_CYCLE_CAP);
  });

  it("reviveBudget equals REVIVE_BUDGET", async () => {
    const body = await fetchDescriptor();
    expect(body.reviveBudget).toBe(REVIVE_BUDGET);
  });
});

// ─── 3. Edge totality — enumerateTransitions() produces the expected set ────

describe("GET /api/fsm/descriptor — edge totality contract", () => {
  it("transitions includes every edge from enumerateTransitions()", async () => {
    const body = await fetchDescriptor();
    const bodyTransitions = body.transitions as Array<{ from: string; to: string; classification: string }>;

    const expectedEdges = new Set(
      enumerateTransitions().map((t: { from: string; to: string }) => `${t.from}->${t.to}`)
    );
    const bodyEdges = new Set(bodyTransitions.map((t) => `${t.from}->${t.to}`));

    // Every expected edge must appear in the body (no dropped edges).
    for (const edge of expectedEdges) {
      expect(bodyEdges.has(edge)).toBe(true);
    }
    // No extra edges should appear.
    expect(bodyEdges.size).toBe(expectedEdges.size);
  });

  it("every uncurated edge has classification:'unclassified'", async () => {
    const body = await fetchDescriptor();
    const bodyTransitions = body.transitions as Array<{ from: string; to: string; classification: string; guardText: string | null }>;

    // Edges with no guard in fsm-guards.json must be unclassified, not dropped.
    const uncurated = bodyTransitions.filter((t) => t.guardText === null);
    for (const t of uncurated) {
      expect(t.classification).toBe("unclassified");
    }
  });

  it("transitions array is non-empty (at least the happy-path edges exist)", async () => {
    const body = await fetchDescriptor();
    const transitions = body.transitions as unknown[];
    expect(transitions.length).toBeGreaterThan(0);
  });
});
