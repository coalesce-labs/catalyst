// CTL-1100 Phase 2: GET /api/fsm/descriptor — HTTP integration tests.
// Uses createServer({port:0,startWatcher:false}) + fetch.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import {
  PHASES,
  NEXT_PHASE,
  DESCRIPTOR_PATH,
  ANCILLARY_PHASES,
  TERMINAL_PHASE,
  NEW_WORK_ENTRY_PHASE,
  REMEDIATE_CYCLE_CAP,
} from "../../lib/workflow-descriptor.mjs";
import { REVIVE_BUDGET } from "../../lib/phase-fsm.mjs";
import { enumerateTransitions } from "../../lib/fsm-descriptor.mjs";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fsm-descriptor-test-"));
  const dbPath = join(tmpDir, "catalyst.db");
  server = createServer({ port: 0, startWatcher: false, dbPath, wtDir: tmpDir });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── 6. GET /api/fsm/descriptor returns 200 + full shape ────────────────────

describe("GET /api/fsm/descriptor", () => {
  it("returns 200 JSON with the correct shape", async () => {
    const res = await fetch(`${baseUrl}/api/fsm/descriptor`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("phases deep-equals PHASES", async () => {
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as Record<string, unknown>;
    expect(body.phases).toEqual(PHASES);
  });

  it("terminalPhase, entryPhase, remediateCycleCap, reviveBudget are correct", async () => {
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as Record<string, unknown>;
    expect(body.terminalPhase).toBe(TERMINAL_PHASE);
    expect(body.entryPhase).toBe(NEW_WORK_ENTRY_PHASE);
    expect(body.remediateCycleCap).toBe(REMEDIATE_CYCLE_CAP);
    expect(body.reviveBudget).toBe(REVIVE_BUDGET);
    expect(body.ancillaryPhases).toEqual(ANCILLARY_PHASES);
    expect(typeof body.nonPreemptable).toBe("object");
    expect(typeof body.stageRank).toBe("object");
    expect(typeof body.nextPhase).toBe("object");
    expect(typeof body.cycles).toBe("object");
  });

  it("descriptorSha is a 64-char hex string matching raw file bytes", async () => {
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as Record<string, unknown>;
    expect(typeof body.descriptorSha).toBe("string");
    expect(body.descriptorSha as string).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHash("sha256").update(readFileSync(DESCRIPTOR_PATH)).digest("hex");
    expect(body.descriptorSha).toBe(expected);
  });

  it("rulesSha field is present (string or null)", async () => {
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as Record<string, unknown>;
    expect("rulesSha" in body).toBe(true);
    // null or a hex string are both valid
    if (body.rulesSha !== null) {
      expect(typeof body.rulesSha).toBe("string");
    }
  });

  it("transitions[] contains all NEXT_PHASE advance edges", async () => {
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as {
      transitions: Array<{ from: string; to: string; kind: string; classification: string }>;
    };
    for (const [from, to] of Object.entries(NEXT_PHASE)) {
      const edge = body.transitions.find((t) => t.from === from && t.to === to && t.kind === "advance");
      expect(edge).toBeDefined();
    }
  });

  it("has verify->remediate and remediate->verify in transitions", async () => {
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as {
      transitions: Array<{ from: string; to: string }>;
    };
    expect(body.transitions.some((t) => t.from === "verify" && t.to === "remediate")).toBe(true);
    expect(body.transitions.some((t) => t.from === "remediate" && t.to === "verify")).toBe(true);
  });

  it("advance transitions are classification:'advance' (CTL-1101 P2: *->advance guard)", async () => {
    // CTL-1101 P2 added *->advance to fsm-guards.json, classifying all 9 advance edges.
    // Previously these were 'unclassified'; now they carry classification:'advance'.
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as {
      transitions: Array<{ kind: string; classification: string }>;
    };
    const advanceEdges = body.transitions.filter((t) => t.kind === "advance");
    expect(advanceEdges.length).toBeGreaterThan(0);
    for (const edge of advanceEdges) {
      expect(edge.classification).toBe("advance");
    }
  });

  it("transitions count matches enumerateTransitions() output", async () => {
    const body = await (await fetch(`${baseUrl}/api/fsm/descriptor`)).json() as {
      transitions: unknown[];
    };
    const expected = enumerateTransitions();
    expect(body.transitions.length).toBe(expected.length);
  });
});
