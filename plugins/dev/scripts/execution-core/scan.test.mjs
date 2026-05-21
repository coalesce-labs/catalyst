// Integration tests for the execution-core deterministic scan (CTL-533).
// Run: cd plugins/dev/scripts/execution-core && bun test scan.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "./scan.mjs";

let orchDir;
const NOW = Date.parse("2026-05-21T12:00:00Z");

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "exec-core-scan-"));
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// --- fixture helpers ------------------------------------------------------

function workersDir() {
  const dir = join(orchDir, "workers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFlat(ticket, body) {
  writeFileSync(
    join(workersDir(), `${ticket}.json`),
    JSON.stringify({ ticket, ...body }),
  );
}

function writeNested(ticket, phase, body) {
  const dir = join(workersDir(), ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, ...body }),
  );
}

// stubAdapters — deterministic fixtures for every injected I/O dependency.
// `over` deep-merges per sub-adapter so a test overrides only what it cares
// about.
function stubAdapters(over = {}) {
  return {
    git: {
      branch: () => "feat/branch",
      commitCount: () => 0,
      remoteBranchExists: () => false,
      ...over.git,
    },
    gh: {
      // prForBranch → { number, url, state } | null
      prForBranch: () => null,
      // prView → { state, mergeStateStatus, mergedAt, mergeCommitSha }
      prView: () => ({
        state: "OPEN",
        mergeStateStatus: "CLEAN",
        mergedAt: null,
        mergeCommitSha: null,
      }),
      ...over.gh,
    },
    deploy: {
      // skipDeployVerification per repo
      skipDeployVerification: () => true,
      productionEnvironment: () => "production",
      timeoutSec: () => 1800,
      ...over.deploy,
    },
    comms: {
      readSince: () => [],
      ...over.comms,
    },
  };
}

function baseInputs(over = {}) {
  const { adapters: adapterOver, ...rest } = over;
  return {
    orchDir,
    orchId: "test-orch",
    event: null,
    nowMs: NOW,
    commsCursor: 0,
    ...rest,
    adapters: stubAdapters(adapterOver),
  };
}

// --- tests ----------------------------------------------------------------

describe("runScan", () => {
  test("Step A: gathers branch + commit count + PR per worker via adapters", () => {
    writeFlat("CTL-1", { phase: 3, status: "implementing", pid: 1 });
    let branchCalls = 0;
    const out = runScan(
      baseInputs({
        adapters: { git: { branch: () => (branchCalls++, "feat/ctl-1") } },
      }),
    );
    expect(branchCalls).toBe(1);
    expect(out).toBeDefined();
  });

  test("Step C: a MERGED PR yields a patch + a worker-pr-merged event", () => {
    writeFlat("CTL-1", {
      phase: 4,
      status: "merging",
      pid: 1,
      pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    });
    const out = runScan(
      baseInputs({
        adapters: {
          gh: {
            prForBranch: () => ({
              number: 7,
              url: "https://github.com/o/r/pull/7",
              state: "MERGED",
            }),
            prView: () => ({
              state: "MERGED",
              mergeStateStatus: "CLEAN",
              mergedAt: "2026-05-21T11:00:00Z",
              mergeCommitSha: "deadbeef",
            }),
          },
        },
      }),
    );
    expect(out.patches).toHaveLength(1);
    expect(out.patches[0].patch.status).toBe("done");
    expect(out.events.some((e) => e.event === "worker-pr-merged")).toBe(true);
  });

  test("Step E: a 'merged'-status worker advances via nextDeployState", () => {
    writeFlat("CTL-1", {
      phase: 5,
      status: "merged",
      pid: 1,
      pr: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        mergeCommitSha: "abc",
      },
      // startedAt within the 1800s deploy timeout (now is 12:00:00Z).
      deploy: { startedAt: "2026-05-21T11:50:00Z" },
    });
    const out = runScan(
      baseInputs({
        event: {
          type: "github.deployment.created",
          environment: "production",
          state: null,
          sha: "abc",
        },
      }),
    );
    const deployPatch = out.patches.find(
      (p) => p.patch.status === "deploying",
    );
    expect(deployPatch).toBeDefined();
  });

  test("Step E: skips workers whose status is not merged/deploying/deploy-failed", () => {
    writeFlat("CTL-1", { phase: 3, status: "implementing", pid: 1 });
    const out = runScan(
      baseInputs({
        event: {
          type: "github.deployment.created",
          environment: "production",
          state: null,
          sha: "abc",
        },
      }),
    );
    expect(out.patches.some((p) => p.patch.status === "deploying")).toBe(false);
  });

  test("Step F: attention comms messages surface in result.attentions", () => {
    writeFlat("CTL-1", { phase: 3, status: "implementing", pid: 1 });
    const out = runScan(
      baseInputs({
        adapters: {
          comms: {
            readSince: () => [
              { type: "attention", from: "CTL-9", body: "blocked" },
            ],
          },
        },
      }),
    );
    expect(out.attentions.some((a) => a.kind === "comms-attention")).toBe(true);
  });

  test("Step G: a stale no-PR worker surfaces a stalled attention", () => {
    writeFlat("CTL-1", {
      phase: 3,
      status: "implementing",
      pid: 1,
      updatedAt: "2026-05-21T10:00:00Z", // 2h stale
    });
    const out = runScan(baseInputs());
    expect(out.attentions.some((a) => a.kind === "stalled")).toBe(true);
  });

  test("always returns the 3 incident-handler invocation descriptors with --orch-dir/--orch-id", () => {
    writeFlat("CTL-1", { phase: 3, status: "implementing", pid: 1 });
    const out = runScan(baseInputs());
    expect(out.handlerInvocations).toHaveLength(3);
    const names = out.handlerInvocations.map((h) => h.name);
    expect(names).toEqual([
      "orchestrate-revive",
      "orchestrate-auto-fixup",
      "orchestrate-auto-rebase",
    ]);
    for (const h of out.handlerInvocations) {
      expect(h.args).toContain("--orch-dir");
      expect(h.args).toContain(orchDir);
      expect(h.args).toContain("--orch-id");
      expect(h.args).toContain("test-orch");
    }
  });

  test("patches are keyed by signalPath so the caller knows which file to merge", () => {
    writeFlat("CTL-1", {
      phase: 4,
      status: "merging",
      pid: 1,
      pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    });
    const out = runScan(
      baseInputs({
        adapters: {
          gh: {
            prForBranch: () => ({
              number: 7,
              url: "https://github.com/o/r/pull/7",
              state: "MERGED",
            }),
            prView: () => ({
              state: "MERGED",
              mergeStateStatus: "CLEAN",
              mergedAt: "2026-05-21T11:00:00Z",
              mergeCommitSha: "deadbeef",
            }),
          },
        },
      }),
    );
    expect(out.patches[0].signalPath).toContain("CTL-1.json");
  });

  test("an empty workers/ dir → empty patches/attentions/events, handlers still listed", () => {
    workersDir(); // create empty workers/
    const out = runScan(baseInputs());
    expect(out.patches).toEqual([]);
    expect(out.events).toEqual([]);
    expect(out.attentions).toEqual([]);
    expect(out.handlerInvocations).toHaveLength(3);
  });

  test("no workers/ dir at all → empty result, handlers still listed", () => {
    const out = runScan(baseInputs());
    expect(out.patches).toEqual([]);
    expect(out.handlerInvocations).toHaveLength(3);
  });

  test("reads BOTH flat and nested signals in one scan (CTL-505 regression guard)", () => {
    writeFlat("CTL-1", {
      phase: 3,
      status: "implementing",
      pid: 1,
      updatedAt: "2026-05-21T10:00:00Z",
    });
    writeNested("CTL-2", "implement", {
      status: "running",
      bg_job_id: "x1",
      updatedAt: "2026-05-21T10:00:00Z",
    });
    const out = runScan(baseInputs());
    // Both stale, no PR → each surfaces a stalled attention.
    const stalledTickets = out.attentions
      .filter((a) => a.kind === "stalled")
      .map((a) => a.ticket)
      .sort();
    expect(stalledTickets).toEqual(["CTL-1", "CTL-2"]);
  });

  test("advances the comms cursor by the number of messages drained", () => {
    writeFlat("CTL-1", { phase: 3, status: "implementing", pid: 1 });
    const out = runScan(
      baseInputs({
        commsCursor: 4,
        adapters: {
          comms: {
            readSince: () => [
              { type: "attention", from: "CTL-1", body: "a" },
              { type: "status", from: "CTL-1", body: "b" },
            ],
          },
        },
      }),
    );
    expect(out.newCommsCursor).toBe(6);
  });
});
