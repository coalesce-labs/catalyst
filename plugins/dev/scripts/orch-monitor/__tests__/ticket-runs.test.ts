// CTL-886 (BFF4): unit tests for the run→worker identity layer. Encodes the
// ticket's Gherkin acceptance scenarios against real on-disk fixtures (temp
// worker dirs + a temp catalyst.db) — no live API, no network.
//
//   • "A ticket's full run history is queryable" — one run per phase signal;
//      finished runs (no live BoardWorker) included; each carries model,
//      bg_job_id, attempt, generation, status, startedAt/completedAt,
//      host{name,id}, and pr{} when present.
//   • "Per-phase PR and deploy detail come free from the signals" — PR + DEPLOY
//      derived from phase-pr / phase-monitor-merge / phase-monitor-deploy; no
//      live GitHub call.
//   • "One run signal is served verbatim" — the raw phase-<phase>.json contents,
//      untransformed.
//   • "Cost/tokens/turns are joined, not invented" — cost comes from the
//      catalyst.db join, null when no telemetry row (never a fabricated 0).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  assembleTicketRuns,
  readPhaseSignalVerbatim,
  toRunEntity,
} from "../lib/ticket-runs.mjs";
import { hostName, hostId } from "../lib/canonical-event-shared";

let root: string;
let workersDir: string;
let dbPath: string;

function writeSignal(ticket: string, phase: string, body: Record<string, unknown>) {
  const dir = join(workersDir, ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(body));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ticket-runs-"));
  workersDir = join(root, "workers");
  mkdirSync(workersDir, { recursive: true });
  dbPath = join(root, "catalyst.db");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("assembleTicketRuns — full run history (CTL-886)", () => {
  it("returns one run entity per phase signal, in PHASE_ORDER", async () => {
    writeSignal("CTL-845", "triage", { ticket: "CTL-845", phase: "triage", status: "done" });
    writeSignal("CTL-845", "research", { ticket: "CTL-845", phase: "research", status: "done" });
    writeSignal("CTL-845", "plan", { ticket: "CTL-845", phase: "plan", status: "done" });
    writeSignal("CTL-845", "implement", { ticket: "CTL-845", phase: "implement", status: "done" });

    const { ticket, runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(ticket).toBe("CTL-845");
    expect(runs.map((r) => r.phase)).toEqual(["triage", "research", "plan", "implement"]);
  });

  it("each run carries model, bg_job_id, attempt, generation, status, timestamps, host{name,id}", async () => {
    writeSignal("CTL-845", "implement", {
      ticket: "CTL-845",
      phase: "implement",
      status: "done",
      model: "sonnet",
      bg_job_id: "7238ca37",
      attempt: 2,
      generation: 1,
      startedAt: "2026-06-07T07:59:10Z",
      completedAt: "2026-06-07T08:22:23Z",
      host: { name: "mini-1", id: "deadbeefdeadbeef" },
    });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    const run = runs[0];
    expect(run.model).toBe("sonnet");
    expect(run.bg_job_id).toBe("7238ca37");
    expect(run.attempt).toBe(2);
    expect(run.generation).toBe(1);
    expect(run.status).toBe("done");
    expect(run.startedAt).toBe("2026-06-07T07:59:10Z");
    expect(run.completedAt).toBe("2026-06-07T08:22:23Z");
    expect(run.host).toEqual({ name: "mini-1", id: "deadbeefdeadbeef" });
    // durationMs derived from start/complete
    expect(run.durationMs).toBe(
      Date.parse("2026-06-07T08:22:23Z") - Date.parse("2026-06-07T07:59:10Z"),
    );
  });

  it("INCLUDES finished runs (no live BoardWorker) — reads signals, not the live-agent list", async () => {
    // A phase that finished long ago: terminal status, completedAt set, no live
    // agent anywhere. It MUST still surface as a run record.
    writeSignal("CTL-845", "verify", {
      ticket: "CTL-845",
      phase: "verify",
      status: "done",
      startedAt: "2026-06-01T00:00:00Z",
      completedAt: "2026-06-01T00:05:00Z",
    });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs).toHaveLength(1);
    expect(runs[0].phase).toBe("verify");
    expect(runs[0].status).toBe("done");
  });

  it("single-host identity NO-OP: signal without host defaults to this host's identity", async () => {
    // Older signals predate CTL-852 host attribution — the single-node MVP
    // defaults to THIS host (exact identity no-op), never invents a phantom host.
    writeSignal("CTL-845", "plan", { ticket: "CTL-845", phase: "plan", status: "done" });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs[0].host).toEqual({ name: hostName(), id: hostId() });
  });

  it("returns an empty run list (not a throw) when the ticket has no worker dir", async () => {
    const { ticket, runs } = await assembleTicketRuns("CTL-999", { workersDir, dbPath });
    expect(ticket).toBe("CTL-999");
    expect(runs).toEqual([]);
  });

  it("skips phases with no signal file (only present signals become runs)", async () => {
    writeSignal("CTL-845", "triage", { ticket: "CTL-845", phase: "triage", status: "done" });
    writeSignal("CTL-845", "pr", { ticket: "CTL-845", phase: "pr", status: "done" });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs.map((r) => r.phase)).toEqual(["triage", "pr"]);
  });
});

describe("assembleTicketRuns — PR + deploy detail rides free from the signals (CTL-886)", () => {
  it("derives PR detail from phase-pr.json (pr.{number,url}) verbatim", async () => {
    writeSignal("CTL-845", "pr", {
      ticket: "CTL-845",
      phase: "pr",
      status: "done",
      pr: { number: 1434, url: "https://github.com/coalesce-labs/catalyst/pull/1434" },
    });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs[0].pr).toEqual({
      number: 1434,
      url: "https://github.com/coalesce-labs/catalyst/pull/1434",
    });
  });

  it("derives full merge detail from phase-monitor-merge.json (mergedAt, ciStatus, mergeCommitSha)", async () => {
    writeSignal("CTL-845", "monitor-merge", {
      ticket: "CTL-845",
      phase: "monitor-merge",
      status: "done",
      pr: {
        number: 1434,
        mergedAt: "2026-06-07T06:36:48Z",
        ciStatus: "merged",
        mergeCommitSha: "0098e484eb27fe7e78459b528ad56e32bf4618b2",
      },
    });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs[0].pr).toEqual({
      number: 1434,
      mergedAt: "2026-06-07T06:36:48Z",
      ciStatus: "merged",
      mergeCommitSha: "0098e484eb27fe7e78459b528ad56e32bf4618b2",
    });
  });

  it("surfaces the early draft-PR floor from phase-implement.json (draftPr.{number,url,isDraft})", async () => {
    writeSignal("CTL-845", "implement", {
      ticket: "CTL-845",
      phase: "implement",
      status: "done",
      draftPr: { number: 1028, url: "https://example/pull/1028", isDraft: true },
    });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs[0].pr).toEqual({ number: 1028, url: "https://example/pull/1028", isDraft: true });
  });

  it("the DEPLOY card data is derived from phase-monitor-deploy.json", async () => {
    writeSignal("CTL-845", "monitor-deploy", {
      ticket: "CTL-845",
      phase: "monitor-deploy",
      status: "done",
      pr: { number: 1434, mergeCommitSha: "abc123" },
    });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    const deploy = runs.find((r) => r.phase === "monitor-deploy");
    expect(deploy).toBeDefined();
    expect(deploy?.pr).toEqual({ number: 1434, mergeCommitSha: "abc123" });
  });

  it("a phase with no PR shape carries pr:null (no empty stub)", async () => {
    writeSignal("CTL-845", "research", { ticket: "CTL-845", phase: "research", status: "done" });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs[0].pr).toBeNull();
  });
});

describe("assembleTicketRuns — cost is JOINED, not invented (CTL-886)", () => {
  function seedDb() {
    execFileSync("sqlite3", [
      dbPath,
      `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        ticket_key TEXT,
        skill_name TEXT
      );
      CREATE TABLE session_metrics (
        session_id TEXT PRIMARY KEY,
        cost_usd REAL DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        num_turns INTEGER DEFAULT 0
      );
      INSERT INTO sessions VALUES ('s1','CTL-845','phase-implement');
      INSERT INTO session_metrics VALUES ('s1',0.50,2000,1000,42);
      `,
    ]);
  }

  it("per-run cost comes from the catalyst.db join, never the signal", async () => {
    seedDb();
    // The signal itself carries NO cost — only identity/timestamp/status.
    writeSignal("CTL-845", "implement", {
      ticket: "CTL-845",
      phase: "implement",
      status: "done",
    });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs[0].cost).toEqual({ costUSD: 0.5, tokens: 3000, turns: 42 });
  });

  it("a run with no telemetry row gets cost:null (no fabricated zero)", async () => {
    seedDb(); // db has a row for implement only
    writeSignal("CTL-845", "research", { ticket: "CTL-845", phase: "research", status: "done" });
    const { runs } = await assembleTicketRuns("CTL-845", { workersDir, dbPath });
    expect(runs[0].cost).toBeNull();
  });

  it("cost stays null when the catalyst.db is absent entirely", async () => {
    // dbPath points at a non-existent file — no join, no throw, no fabrication.
    writeSignal("CTL-845", "implement", { ticket: "CTL-845", phase: "implement", status: "done" });
    const { runs } = await assembleTicketRuns("CTL-845", {
      workersDir,
      dbPath: join(root, "does-not-exist.db"),
    });
    expect(runs[0].cost).toBeNull();
  });
});

describe("readPhaseSignalVerbatim — one signal served verbatim (CTL-886)", () => {
  it("returns the raw phase-<phase>.json contents untransformed", async () => {
    const body = {
      ticket: "CTL-845",
      phase: "implement",
      orchestrator: "CTL-845",
      model: "sonnet",
      turnCap: 75,
      status: "done",
      bg_job_id: "7238ca37",
      generation: 1,
      attempt: 1,
      startedAt: "2026-06-07T07:59:10Z",
      completedAt: "2026-06-07T08:22:23Z",
      host: { name: "mini-1", id: "deadbeefdeadbeef" },
      pr: { number: 1028, url: "https://example/pull/1028" },
    };
    writeSignal("CTL-845", "implement", body);
    const signal = await readPhaseSignalVerbatim("CTL-845", "implement", { workersDir });
    // Byte-for-byte the same object the agent wrote — nothing added/dropped.
    expect(signal).toEqual(body);
  });

  it("returns null when the phase has no signal on disk", async () => {
    const signal = await readPhaseSignalVerbatim("CTL-845", "implement", { workersDir });
    expect(signal).toBeNull();
  });

  it("returns null for a phase name outside the canonical pipeline (no path traversal)", async () => {
    writeSignal("CTL-845", "implement", { ticket: "CTL-845", phase: "implement", status: "done" });
    // an unknown / malicious phase string is rejected before any file read
    expect(await readPhaseSignalVerbatim("CTL-845", "../triage", { workersDir })).toBeNull();
    expect(await readPhaseSignalVerbatim("CTL-845", "bogus", { workersDir })).toBeNull();
  });
});

describe("toRunEntity — field mapping (CTL-886)", () => {
  it("maps a verbatim signal to a run entity and joins the supplied cost row", () => {
    const run = toRunEntity(
      "implement",
      {
        ticket: "CTL-845",
        phase: "implement",
        status: "done",
        model: "opus",
        bg_job_id: "abc",
        attempt: 1,
        generation: 2,
        orchestrator: "CTL-845",
        startedAt: "2026-06-07T00:00:00Z",
        completedAt: "2026-06-07T00:10:00Z",
        updatedAt: "2026-06-07T00:10:00Z",
        worktreePath: "/wt/CTL-845",
        catalystSessionId: "sess_xyz",
        host: { name: "h", id: "abcd000000000000" },
        pr: { number: 7 },
      },
      { costUSD: 1.23, tokens: 100, turns: 9 },
    );
    expect(run).toEqual({
      ticket: "CTL-845",
      phase: "implement",
      status: "done",
      model: "opus",
      bg_job_id: "abc",
      attempt: 1,
      generation: 2,
      orchestrator: "CTL-845",
      startedAt: "2026-06-07T00:00:00Z",
      completedAt: "2026-06-07T00:10:00Z",
      updatedAt: "2026-06-07T00:10:00Z",
      durationMs: 600000,
      host: { name: "h", id: "abcd000000000000" },
      worktreePath: "/wt/CTL-845",
      sessionId: "sess_xyz",
      pr: { number: 7 },
      cost: { costUSD: 1.23, tokens: 100, turns: 9 },
    });
  });

  it("collapses a clock-skewed (end < start) duration to null, not a negative", () => {
    const run = toRunEntity("verify", {
      ticket: "CTL-1",
      phase: "verify",
      status: "done",
      startedAt: "2026-06-07T00:10:00Z",
      completedAt: "2026-06-07T00:00:00Z",
    });
    expect(run.durationMs).toBeNull();
  });
});
