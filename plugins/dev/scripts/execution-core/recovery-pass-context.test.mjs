// recovery-pass-context.test.mjs — the read-only mode/context resolver for the
// recovery-pass skill (CTL-1176 rung 3). The script itself shells out to the
// real broker-state cache + event log, so the unit surface here is the pure
// pieces: sweep union/dedupe, HRW identity at N=1, cache fail-open, and the
// dispatched-mode brief read. The end-to-end no-throw behavior is covered by the
// PR's smoke run (sweep over a nonexistent orch-dir prints MODE=sweep / TOTAL: 0).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { ownedBy } from "./hrw.mjs";

const SCRIPT = join(import.meta.dir, "recovery-pass-context.mjs");

function runScript(args, env = {}) {
  return execFileSync("bun", [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("HRW filter — identity at N=1", () => {
  it("a single-host roster owns every ticket (filter is a no-op)", () => {
    for (const t of ["CTL-1", "CTL-842", "OTL-7", "ADV-99"]) {
      expect(ownedBy(t, ["only-host"], "only-host")).toBe(true);
    }
  });

  it("a multi-host roster splits ownership (so the filter can drop)", () => {
    const roster = ["mini", "mac-studio", "macbook"];
    // Every ticket is owned by exactly one host; the sum of per-host ownership is 1.
    for (const t of ["CTL-842", "CTL-1188", "CTL-1190", "OTL-7"]) {
      const owners = roster.filter((h) => ownedBy(t, roster, h));
      expect(owners.length).toBe(1);
    }
  });
});

describe("sweep — worker-signal enumeration", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "rpc-sweep-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  function writeSignal(ticket, status, reason) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-recovery-pass.json`),
      JSON.stringify({ ticket, status, failureReason: reason })
    );
  }

  it("enumerates only stuck statuses (needs-human/failed/stalled), not running", () => {
    writeSignal("CTL-100", "needs-human", "review blocked");
    writeSignal("CTL-101", "failed", "tsc error");
    writeSignal("CTL-102", "stalled", "bg dead");
    writeSignal("CTL-103", "running", "in flight"); // must NOT appear
    writeSignal("CTL-104", "complete", "done"); // must NOT appear

    const out = runScript(["--orch-dir", orchDir], {
      CATALYST_EVENTS_DIR: join(orchDir, "no-events"),
    });
    expect(out).toContain("MODE=sweep");
    expect(out).toContain("STUCK CTL-100");
    expect(out).toContain("STUCK CTL-101");
    expect(out).toContain("STUCK CTL-102");
    expect(out).not.toContain("CTL-103");
    expect(out).not.toContain("CTL-104");
    expect(out).toContain("TOTAL: 3 items");
  });
});

describe("sweep — union dedupe across signals + event log", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "rpc-union-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  it("a ticket present in BOTH signal and event log appears ONCE with both sources", () => {
    // signal
    const dir = join(orchDir, "workers", "CTL-200");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-recovery-pass.json"),
      JSON.stringify({ ticket: "CTL-200", status: "needs-human", failureReason: "stuck" })
    );
    // event log under a temp CATALYST_EVENTS_DIR
    const eventsDir = join(orchDir, "events");
    mkdirSync(eventsDir, { recursive: true });
    const ym = new Date().toISOString().slice(0, 7);
    const evt = {
      attributes: { "event.name": "recovery.escalated" },
      body: { payload: { ticket: "CTL-200", reason: "value judgment" } },
    };
    const evt2 = {
      attributes: { "event.name": "recovery.would-escalate" },
      body: { payload: { ticket: "CTL-201", reason: "arch change" } },
    };
    writeFileSync(join(eventsDir, `${ym}.jsonl`), JSON.stringify(evt) + "\n" + JSON.stringify(evt2) + "\n");

    const out = runScript(["--orch-dir", orchDir], { CATALYST_EVENTS_DIR: eventsDir });
    // CTL-200: union — exactly one STUCK line, both sources noted
    const ctl200Lines = out.split("\n").filter((l) => l.includes("STUCK CTL-200"));
    expect(ctl200Lines.length).toBe(1);
    expect(ctl200Lines[0]).toContain("source=log/signals");
    // CTL-201: only on the event log
    expect(out).toContain("STUCK CTL-201");
    expect(out).toContain("source=log");
    expect(out).toContain("TOTAL: 2 items");
  });
});

describe("dispatched mode — brief read", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "rpc-brief-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  it("prints the brief block when recovery-pass.json exists", () => {
    const dir = join(orchDir, "workers", "CTL-300");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "recovery-pass.json"),
      JSON.stringify({
        failureReason: "merge conflict in eligible-set.mjs",
        diagnosis: { reason: "branch diverged from main", logsOutput: "line1\nline2\nline3" },
        deterministicSeamsTried: [
          { category: "source-conflict", outcome: "no-op", marker: "source-conflict" },
        ],
        guidance: "resolve the conflict and rebase",
      })
    );
    const out = runScript(["--ticket", "CTL-300", "--orch-dir", orchDir]);
    expect(out).toContain("MODE=dispatched ticket=CTL-300");
    expect(out).toContain("merge conflict in eligible-set.mjs");
    expect(out).toContain("branch diverged from main");
    expect(out).toContain("source-conflict: no-op");
    expect(out).toContain("resolve the conflict and rebase");
    expect(out).toContain("line3");
  });

  it("falls through to a ticket-scoped sweep when the brief is missing", () => {
    const out = runScript(["--ticket", "CTL-301", "--orch-dir", orchDir]);
    expect(out).toContain("MODE=dispatched ticket=CTL-301");
    expect(out).toContain("no brief");
    expect(out).toContain("ticket-scoped");
  });
});

describe("cache fail-open — db absent never aborts the gather", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "rpc-failopen-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  it("with no signals, no events, and an isolated empty CATALYST_DIR → MODE=sweep / TOTAL: 0, exit 0", () => {
    // Point CATALYST_DIR (which derives the broker filter-state.db path) at a
    // fresh empty temp dir so the cache read opens a brand-new empty schema —
    // it must not throw the gather, and with no other sources TOTAL is 0.
    const isolatedDir = join(orchDir, "catalyst-home");
    mkdirSync(isolatedDir, { recursive: true });
    const out = runScript(["--orch-dir", join(orchDir, "nope")], {
      CATALYST_DIR: isolatedDir,
      CATALYST_EVENTS_DIR: join(orchDir, "no-events"),
    });
    expect(out).toContain("MODE=sweep");
    expect(out).toContain("TOTAL: 0 items");
  });
});
