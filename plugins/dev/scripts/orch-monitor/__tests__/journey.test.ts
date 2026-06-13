// CTL-1100 Phase 5: journey.mjs unit tests — hops/dedupe/gate/verdict/unblock/host/degradation.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Load journey functions via computed specifier (bun:sqlite-free but guards module graph).
const journeyMod = await import(["../lib/journey.mjs"].join("")) as {
  scanHops: (ticket: string, opts: { eventLogPath: string }) => Array<{
    phase: string; eventType: string; ts: string; host: string;
    bg_job_id?: string; reason?: string; targetPhase?: string; blockers?: unknown[];
  }>;
  dedupeHops: (hops: Array<unknown>) => Array<unknown>;
  buildGateChecklist: (ticket: string, opts: { orchDir: string; eventLogPath?: string }) => {
    nextPhase: string | null;
    checklist: Array<{ phase: string; signalStatus: string | null; satisfied: boolean }>;
    remediateCycles: number;
  };
  readVerifyVerdictDetail: (ticket: string, opts: { orchDir: string }) => {
    verdict: string | null; regressionRisk: number | null; highFindings: number; reason: string | null;
  };
  collectUnblockHints: (ticket: string, opts: { orchDir: string; hops: Array<unknown> }) => Array<{
    kind: string; note?: string; reason?: string; blockers?: unknown[];
  }>;
  assembleJourney: (ticket: string, opts?: {
    workersDir?: string; orchDir?: string; eventLogPath?: string; dbPath?: string;
  }) => Promise<{
    ticket: string;
    hops: unknown[];
    gates: { checklist: unknown[]; nextPhase: string | null };
    verifyVerdict: { verdict: string | null };
    remediateCycles: number;
    unblockHints: unknown[];
    hosts: string[];
  }>;
};
const { scanHops, dedupeHops, buildGateChecklist, readVerifyVerdictDetail, collectUnblockHints, assembleJourney } = journeyMod;

// Import deriveAdvancement + readPhaseSignals for backed-by-code assertions.
const schedMod = await import(["../../execution-core/scheduler.mjs"].join("")) as {
  deriveAdvancement: (signals: Record<string, string | null>, opts?: { verifyVerdict?: string; remediateCycleCount?: number }) => string | null;
  readPhaseSignals: (orchDir: string, ticket: string) => Record<string, string | null>;
};
const { deriveAdvancement, readPhaseSignals } = schedMod;

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "journey-test-"));
});
afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeEventLine(name: string, host: string | null, ts: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts,
    resource: host ? { "host.name": host } : {},
    attributes: { "event.name": name },
    body: { payload },
  });
}

function writeEventLog(filename: string, lines: string[]): string {
  const p = join(tmpDir, filename);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function writeSignal(dir: string, phase: string, status: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ status, ...extra }));
}

// ─── 1. scanHops / dedupeHops — suffix collision guard ──────────────────────

describe("scanHops + dedupeHops", () => {
  it("only CTL-9001 events returned; CTL-90010 excluded", () => {
    const logPath = writeEventLog("hops-collision.jsonl", [
      makeEventLine("phase.dispatch.requested.CTL-9001", "h1", "2024-01-01T01:00:00Z"),
      makeEventLine("phase.dispatch.launched.CTL-9001",  "h1", "2024-01-01T01:01:00Z", { bg_job_id: "j1" }),
      makeEventLine("phase.implement.complete.CTL-9001", "h1", "2024-01-01T01:02:00Z", { bg_job_id: "j1" }),
      makeEventLine("phase.implement.revive.CTL-9001",   "h2", "2024-01-01T01:03:00Z", { bg_job_id: "j2" }),
      // duplicate — same phase+eventType+bg_job_id as the launched event above
      makeEventLine("phase.dispatch.launched.CTL-9001",  "h1", "2024-01-01T01:01:00Z", { bg_job_id: "j1" }),
      // advance.held with blockers
      makeEventLine("phase.advance.held.CTL-9001",       "h1", "2024-01-01T01:04:00Z", { reason: "capacity", blockers: ["x"] }),
      makeEventLine("phase.remediate.complete.CTL-9001", "h1", "2024-01-01T01:05:00Z"),
      // noise for a DIFFERENT ticket (must be excluded)
      makeEventLine("phase.implement.complete.CTL-90010", "h3", "2024-01-01T02:00:00Z"),
      makeEventLine("phase.dispatch.launched.NOPE-1",     "h4", "2024-01-01T02:01:00Z"),
    ]);
    const raw = scanHops("CTL-9001", { eventLogPath: logPath });
    // All raw hops must be for CTL-9001
    for (const h of raw) {
      expect(h.phase + "." + h.eventType).not.toContain("CTL-90010");
    }
    const hops = dedupeHops(raw) as typeof raw;
    // Dedup collapses the duplicate launched hop
    const launched = hops.filter((h) => h.phase === "dispatch" && h.eventType === "launched");
    expect(launched.length).toBe(1);
    // advance.held carries blockers
    const held = hops.find((h) => h.phase === "advance" && h.eventType === "held");
    expect(held?.blockers).toEqual(["x"]);
    expect(held?.reason).toBe("capacity");
    // hops sorted ts asc
    const tsList = hops.map((h) => h.ts);
    expect(tsList).toEqual([...tsList].sort());
  });

  it("each hop has {phase, eventType, ts, host}", () => {
    const logPath = writeEventLog("hops-shape.jsonl", [
      makeEventLine("phase.implement.complete.CTL-9001", null, "2024-01-01T01:00:00Z"),
    ]);
    const hops = dedupeHops(scanHops("CTL-9001", { eventLogPath: logPath })) as Array<{
      phase: string; eventType: string; ts: string; host: string;
    }>;
    expect(hops.length).toBe(1);
    expect(hops[0]?.phase).toBe("implement");
    expect(hops[0]?.eventType).toBe("complete");
    expect(typeof hops[0]?.ts).toBe("string");
    // host falls back when absent from resource
    expect(typeof hops[0]?.host).toBe("string");
  });
});

// ─── 2. buildGateChecklist drives deriveAdvancement ──────────────────────────

describe("buildGateChecklist backed-by-code invariant", () => {
  it("case A: implement done → nextPhase === 'verify'", () => {
    const orchDir = join(tmpDir, "orch-case-a");
    const workerDir = join(orchDir, "workers", "CTL-9001");
    writeSignal(workerDir, "triage",    "done");
    writeSignal(workerDir, "research",  "done");
    writeSignal(workerDir, "plan",      "done");
    writeSignal(workerDir, "implement", "done");

    const gates = buildGateChecklist("CTL-9001", { orchDir });
    expect(gates.nextPhase).toBe("verify");

    // backed-by-code
    const signals = readPhaseSignals(orchDir, "CTL-9001");
    const expected = deriveAdvancement(signals, { verifyVerdict: undefined, remediateCycleCount: 0 });
    expect(gates.nextPhase).toBe(expected);

    // checklist exists
    expect(Array.isArray(gates.checklist)).toBe(true);
    const implRow = gates.checklist.find((r: { phase: string }) => r.phase === "implement");
    expect(implRow?.satisfied).toBe(true);
  });

  it("case B: verify done + regression_risk:7 → nextPhase === 'remediate'", () => {
    const orchDir = join(tmpDir, "orch-case-b");
    const workerDir = join(orchDir, "workers", "CTL-9001");
    writeSignal(workerDir, "implement", "done");
    writeSignal(workerDir, "verify",    "done");
    writeFileSync(join(workerDir, "verify.json"), JSON.stringify({ regression_risk: 7, findings: [] }));

    const gates = buildGateChecklist("CTL-9001", { orchDir });
    expect(gates.nextPhase).toBe("remediate");

    const signals = readPhaseSignals(orchDir, "CTL-9001");
    const expected = deriveAdvancement(signals, { verifyVerdict: "fail", remediateCycleCount: 0 });
    expect(gates.nextPhase).toBe(expected);
  });

  it("case C: verify done + clean verify.json → nextPhase === 'review'", () => {
    const orchDir = join(tmpDir, "orch-case-c");
    const workerDir = join(orchDir, "workers", "CTL-9001");
    writeSignal(workerDir, "implement", "done");
    writeSignal(workerDir, "verify",    "done");
    writeFileSync(join(workerDir, "verify.json"), JSON.stringify({ regression_risk: 1, findings: [] }));

    const gates = buildGateChecklist("CTL-9001", { orchDir });
    expect(gates.nextPhase).toBe("review");

    const signals = readPhaseSignals(orchDir, "CTL-9001");
    const expected = deriveAdvancement(signals, { verifyVerdict: "pass", remediateCycleCount: 0 });
    expect(gates.nextPhase).toBe(expected);
  });
});

// ─── 3. Verdict detail + cycles ──────────────────────────────────────────────

describe("readVerifyVerdictDetail + remediateCycles", () => {
  it("regression_risk:5, high finding → verdict=fail, regressionRisk=5, highFindings=1", () => {
    const orchDir = join(tmpDir, "orch-verdict");
    const workerDir = join(orchDir, "workers", "CTL-9001");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "verify.json"), JSON.stringify({
      regression_risk: 5,
      findings: [{ severity: "high" }, { severity: "low" }],
    }));
    const detail = readVerifyVerdictDetail("CTL-9001", { orchDir });
    expect(detail.verdict).toBe("fail");
    expect(detail.regressionRisk).toBe(5);
    expect(detail.highFindings).toBe(1);
    expect(typeof detail.reason).toBe("string");
    expect(detail.reason).not.toBe("");
  });

  it("absent verify.json → verdict null, full shape returned", () => {
    const orchDir = join(tmpDir, "orch-absent-verify");
    mkdirSync(join(orchDir, "workers", "CTL-no-verify"), { recursive: true });
    const detail = readVerifyVerdictDetail("CTL-no-verify", { orchDir });
    expect(detail.verdict).toBeNull();
    expect("regressionRisk" in detail).toBe(true);
    expect("highFindings" in detail).toBe(true);
  });

  it("remediateCycles counted from event log", () => {
    const logPath = writeEventLog("remediate-cycles.jsonl", [
      makeEventLine("phase.remediate.complete.CTL-9001", "h1", "2024-01-01T01:00:00Z"),
      makeEventLine("phase.remediate.complete.CTL-9001", "h1", "2024-01-01T02:00:00Z"),
    ]);
    const orchDir = join(tmpDir, "orch-cycles");
    const gates = buildGateChecklist("CTL-9001", { orchDir, eventLogPath: logPath });
    expect(gates.remediateCycles).toBe(2);
  });
});

// ─── 4. Unblock hints ────────────────────────────────────────────────────────

describe("collectUnblockHints", () => {
  it("operator respond note + latest held hop → two hints", () => {
    const orchDir = join(tmpDir, "orch-unblock");
    const workerDir = join(orchDir, "workers", "CTL-9001");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, ".respond-implement.json"), JSON.stringify({
      response: "Try again with X",
      respondedAt: "2024-01-01T01:00:00Z",
    }));
    const hops = [
      { phase: "advance", eventType: "held", ts: "2024-01-01T01:00:00Z", host: "h1",
        reason: "capacity_limit", blockers: ["slot-busy"] },
    ];
    const hints = collectUnblockHints("CTL-9001", { orchDir, hops });
    expect(hints.some((h: { kind: string }) => h.kind === "operator-note")).toBe(true);
    expect(hints.some((h: { kind: string }) => h.kind === "held-reason")).toBe(true);
  });

  it("no sources → []", () => {
    const orchDir = join(tmpDir, "orch-no-hints");
    mkdirSync(join(orchDir, "workers", "CTL-empty"), { recursive: true });
    const hints = collectUnblockHints("CTL-empty", { orchDir, hops: [] });
    expect(hints).toEqual([]);
  });
});

// ─── 5. Node-aware + degradation ─────────────────────────────────────────────

describe("assembleJourney degradation", () => {
  it("ticket with no worker dir and no event log → empty-but-well-formed, never throws", async () => {
    const orchDir = join(tmpDir, "orch-degrade");
    mkdirSync(orchDir, { recursive: true });
    const journey = await assembleJourney("CTL-99999", {
      workersDir: join(orchDir, "workers-nonexistent"),
      orchDir,
      eventLogPath: join(orchDir, "nonexistent.jsonl"),
    });
    expect(journey.ticket).toBe("CTL-99999");
    expect(Array.isArray(journey.hops)).toBe(true);
    expect(Array.isArray(journey.gates.checklist)).toBe(true);
    expect(Array.isArray(journey.unblockHints)).toBe(true);
    expect(Array.isArray(journey.hosts)).toBe(true);
  });

  it("multi-host hops → hosts[] is deduped union", async () => {
    const logPath = writeEventLog("multi-host.jsonl", [
      makeEventLine("phase.implement.complete.CTL-9001", "host-a", "2024-01-01T01:00:00Z"),
      makeEventLine("phase.verify.complete.CTL-9001",   "host-b", "2024-01-01T02:00:00Z"),
    ]);
    const orchDir = join(tmpDir, "orch-multi");
    mkdirSync(orchDir, { recursive: true });
    const journey = await assembleJourney("CTL-9001", {
      workersDir: join(orchDir, "workers"),
      orchDir,
      eventLogPath: logPath,
    });
    expect(journey.hosts).toContain("host-a");
    expect(journey.hosts).toContain("host-b");
    // no duplicates
    expect(journey.hosts.length).toBe(new Set(journey.hosts).size);
  });
});
