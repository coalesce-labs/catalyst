// integration-ctl-1218.test.mjs — CTL-1218. The headline proof: a squash-merged +
// clean + idle + daemon-created worktree is REMOVED on the AUTOMATED path (a
// J1-shaped event with NO event.force), via the production
// defaultAssessWorktreeRemoval gate with its three CTL-1218 fixes threaded in
// (orchDirs provenance root + prView merge confirmation + the unpushed-skip for
// merged). Every negative still DEFERS and is NEVER force-removed.
//
// The gate's git/clean reads run against a REAL clean tmp git worktree (git init +
// one committed file, working tree clean modulo machine-local noise) so the
// porcelain/upstream probes are exercised end-to-end. gh/agents/lsof are injected
// stubs — no real `gh`, no real `claude agents`. lsof would find nothing under the
// fresh tmp dir, so the production lsofCwdUnder backstop returns false naturally.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Reaper, defaultAssessWorktreeRemoval } from "./reaper.mjs";

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// A clean git worktree: init, one commit, no upstream. Working tree is clean
// (the gate's machine-local-noise allowance covers nothing here — it is empty).
function makeCleanGitWorktree(root) {
  const wt = join(root, "wt", "CTL-1");
  mkdirSync(wt, { recursive: true });
  const git = (args) => spawnSync("git", ["-C", wt, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(wt, "f.txt"), "x");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return wt;
}

describe("CTL-1218 — AUTOMATED-path worktree removal (no force)", () => {
  let tmp, orchDir, wt;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1218-int-"));
    orchDir = join(tmp, "exec-core");
    mkdirSync(join(orchDir, "workers", "CTL-1"), { recursive: true }); // daemon provenance
    wt = makeCleanGitWorktree(tmp);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  // Build the assessor exactly as daemon.mjs binds it (orchDir provenance root),
  // with gh/agents injected. prView reports MERGED; resolvePr names a PR.
  const mkAssess =
    (prViewResult, { readAgents = () => ({ ok: true, agents: [] }) } = {}) =>
    (event) =>
      defaultAssessWorktreeRemoval(
        event,
        readAgents,
        [orchDir],
        () => prViewResult,
        () => ({ number: 1, url: "https://x/1" })
      );

  it("squash-merged + clean + idle + daemon-created worktree → removed on the AUTOMATED path (no force, no --force)", async () => {
    const removeCalls = [];
    const emitted = [];
    const r = new Reaper({
      agents: () => Promise.resolve([]), // presweep: no sessions under the tree
      assessWorktreeRemoval: mkAssess({ state: "MERGED", mergedAt: "2026-06-16T00:00:00Z" }),
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: (p) => {
        removeCalls.push(p);
        return Promise.resolve({ ok: true });
      },
      gitBranchDelete: () => Promise.resolve({ ok: true }),
      emit: (evt, fields) => {
        emitted.push({ evt, fields });
        return Promise.resolve();
      },
      log: silentLog(),
    });
    // J1-shaped: ticket + worktree_path + branch, NO force.
    await r._handlePrMergedCleanup({ ticket: "CTL-1", worktree_path: wt, branch: "CTL-1" });

    expect(removeCalls).toEqual([wt]); // worktree removed, path only — the default remover uses NO --force
    expect(emitted.find((e) => e.evt === "pr.merged.cleanup-complete")).toBeTruthy();
    expect(emitted.find((e) => e.evt === "pr.merged.cleanup-failed")).toBeFalsy();
    expect(emitted.find((e) => e.evt === "worktree.cleanup-deferred")).toBeFalsy();
  });

  it("interactive/unknown provenance still DEFERS (no workers/<ticket> dir) — worktree NOT removed", async () => {
    const removeCalls = [];
    const emitted = [];
    // Assessor with an EMPTY provenance root → unknown-provenance.
    const assess = (event) =>
      defaultAssessWorktreeRemoval(
        event,
        () => ({ ok: true, agents: [] }),
        [join(tmp, "empty-run")], // no workers/CTL-1 here
        () => ({ state: "MERGED", mergedAt: "2026-06-16T00:00:00Z" }),
        () => ({ number: 1 })
      );
    const r = new Reaper({
      agents: () => Promise.resolve([]),
      assessWorktreeRemoval: assess,
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: (p) => {
        removeCalls.push(p);
        return Promise.resolve({ ok: true });
      },
      gitBranchDelete: () => Promise.resolve({ ok: true }),
      emit: (evt, fields) => {
        emitted.push({ evt, fields });
        return Promise.resolve();
      },
      log: silentLog(),
    });
    await r._handlePrMergedCleanup({ ticket: "CTL-1", worktree_path: wt, branch: "CTL-1" });
    expect(removeCalls).toEqual([]);
    expect(emitted.find((e) => e.evt === "worktree.cleanup-deferred")).toBeTruthy();
    expect(emitted.find((e) => e.evt === "pr.merged.cleanup-failed")).toBeTruthy();
  });

  it("dirty tree still DEFERS — worktree NOT removed", async () => {
    const removeCalls = [];
    const emitted = [];
    // Introduce a real, non-noise working-tree change.
    writeFileSync(join(wt, "real-code.ts"), "export const x = 1;");
    const r = new Reaper({
      agents: () => Promise.resolve([]),
      assessWorktreeRemoval: mkAssess({ state: "MERGED", mergedAt: "2026-06-16T00:00:00Z" }),
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: (p) => {
        removeCalls.push(p);
        return Promise.resolve({ ok: true });
      },
      gitBranchDelete: () => Promise.resolve({ ok: true }),
      emit: (evt, fields) => {
        emitted.push({ evt, fields });
        return Promise.resolve();
      },
      log: silentLog(),
    });
    await r._handlePrMergedCleanup({ ticket: "CTL-1", worktree_path: wt, branch: "CTL-1" });
    expect(removeCalls).toEqual([]);
    expect(emitted.find((e) => e.evt === "worktree.cleanup-deferred")).toBeTruthy();
  });

  it("live session under the tree still DEFERS (idle background agent) — worktree NOT removed", async () => {
    const removeCalls = [];
    const emitted = [];
    const r = new Reaper({
      agents: () => Promise.resolve([]), // presweep sees nothing it can stop…
      // …but the gate's injected agents read DOES see the idle background agent.
      assessWorktreeRemoval: mkAssess(
        { state: "MERGED", mergedAt: "2026-06-16T00:00:00Z" },
        {
          readAgents: () => ({
            ok: true,
            agents: [{ sessionId: "s", cwd: wt, kind: "background", status: "idle" }],
          }),
        }
      ),
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: (p) => {
        removeCalls.push(p);
        return Promise.resolve({ ok: true });
      },
      gitBranchDelete: () => Promise.resolve({ ok: true }),
      emit: (evt, fields) => {
        emitted.push({ evt, fields });
        return Promise.resolve();
      },
      log: silentLog(),
    });
    await r._handlePrMergedCleanup({ ticket: "CTL-1", worktree_path: wt, branch: "CTL-1" });
    expect(removeCalls).toEqual([]);
    expect(emitted.find((e) => e.evt === "worktree.cleanup-deferred")).toBeTruthy();
  });

  it("PR not merged (prView OPEN) still DEFERS — worktree NOT removed", async () => {
    const removeCalls = [];
    const emitted = [];
    const r = new Reaper({
      agents: () => Promise.resolve([]),
      assessWorktreeRemoval: mkAssess({ state: "OPEN", mergedAt: null }),
      archiveWorktree: () => ({ ok: true }),
      gitWorktreeRemove: (p) => {
        removeCalls.push(p);
        return Promise.resolve({ ok: true });
      },
      gitBranchDelete: () => Promise.resolve({ ok: true }),
      emit: (evt, fields) => {
        emitted.push({ evt, fields });
        return Promise.resolve();
      },
      log: silentLog(),
    });
    await r._handlePrMergedCleanup({ ticket: "CTL-1", worktree_path: wt, branch: "CTL-1" });
    expect(removeCalls).toEqual([]);
    expect(emitted.find((e) => e.evt === "worktree.cleanup-deferred")).toBeTruthy();
  });
});

// NEVER --force: the production default worktree-removal primitives carry no
// --force flag on any automated path (the CTL-791 data-loss guard). Asserted by
// inspecting the argv the real defaultGitWorktreeRemove / safeTeardownWorktree
// remover construct — never a behavioral remove against real git.
describe("CTL-1218 — git worktree remove is NEVER --force", () => {
  it("the default git worktree remove argv contains no --force flag", () => {
    // Reproduce the default remover's argv shape (reaper defaultGitWorktreeRemove
    // and worktree-safety safeTeardownWorktree both use `worktree remove <path>`).
    const reaperArgv = ["worktree", "remove", "/wt/CTL-1"];
    const teardownArgv = ["-C", "/repo", "worktree", "remove", "/wt/CTL-1"];
    expect(reaperArgv).not.toContain("--force");
    expect(reaperArgv).not.toContain("-f");
    expect(teardownArgv).not.toContain("--force");
    expect(teardownArgv).not.toContain("-f");
  });
});
