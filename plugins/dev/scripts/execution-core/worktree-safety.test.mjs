// worktree-safety.test.mjs — CTL-791. Proves the data-loss guarantee: an in-use,
// dirty, unmerged, unpushed, or unknown-provenance worktree is NEVER removed; only
// a genuinely-done one is, and only after its docs are archived — never with
// --force.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSafeToRemoveWorktree,
  cleanPorcelain,
  MACHINE_LOCAL_NOISE,
  deferWorktreeCleanup,
  archiveWorktreeArtifacts,
  safeTeardownWorktree,
  hasOrchProvenance,
} from "./worktree-safety.mjs";

// gitStub — a runGit fake driven by a per-arg response map. Defaults model the
// safe state: clean tree, an upstream with 0 ahead.
function gitStub({ porcelain = " M .catalyst/config.json\n", upstream = "origin/b", ahead = "0", statusRc = 0 } = {}) {
  return (args) => {
    if (args[0] === "status") return { status: statusRc, stdout: porcelain };
    if (args.includes("@{u}") && args[0] === "rev-parse") return { status: upstream ? 0 : 1, stdout: upstream ?? "" };
    if (args[0] === "rev-list") return { status: 0, stdout: `${ahead}\n` };
    return { status: 0, stdout: "" };
  };
}
const SAFE_CTX = { ticket: "CTL-1", repoRoot: "/r", branch: "b", terminal: true, prMerged: true, orchProvenance: true };
const SAFE_DEPS = { runGit: gitStub(), agentsList: [], agentsOk: true, procLive: false };

describe("isSafeToRemoveWorktree — every unsafe condition blocks removal (fail-closed)", () => {
  test("all gates pass → safe", () => {
    expect(isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, SAFE_DEPS)).toEqual({ safe: true, reasons: [] });
  });
  test("not terminal → not-terminal", () => {
    expect(isSafeToRemoveWorktree("/wt/CTL-1", { ...SAFE_CTX, terminal: false }, SAFE_DEPS).reasons).toContain("not-terminal");
  });
  test("PR not merged → not-merged (even when a local rev-list would look merged — squash case)", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-1", { ...SAFE_CTX, prMerged: false }, SAFE_DEPS);
    expect(v.safe).toBe(false);
    expect(v.reasons).toContain("not-merged");
  });
  test("committed-unpushed (upstream resolves, ahead>0) → unpushed-commits", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, runGit: gitStub({ ahead: "3" }) });
    expect(v.reasons).toContain("unpushed-commits");
  });
  test("NO upstream is NOT treated as unpushed (detached/local-only branches)", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, runGit: gitStub({ upstream: null }) });
    expect(v.reasons).not.toContain("unpushed-commits");
    expect(v.safe).toBe(true);
  });
  test("real edit (noise excluded) → dirty-worktree", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, runGit: gitStub({ porcelain: " M apps/web/x.ts\n" }) });
    expect(v.reasons).toContain("dirty-worktree");
  });
  test("untracked code → dirty-worktree", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, runGit: gitStub({ porcelain: "?? new-file.ts\n" }) });
    expect(v.reasons).toContain("dirty-worktree");
  });
  test("noise-only tree (the universal real-worktree state) → clean", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, runGit: gitStub({ porcelain: " M .catalyst/config.json\n?? .trunk/x\n" }) });
    expect(v.reasons).not.toContain("dirty-worktree");
  });
  test("status unreadable → status-unreadable (fail-closed)", () => {
    expect(isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, runGit: gitStub({ statusRc: 128 }) }).reasons).toContain("status-unreadable");
  });
  test("live session under the tree (idle background — the incident hole) → live-session", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, {
      ...SAFE_DEPS,
      agentsList: [{ sessionId: "s", cwd: "/wt/CTL-1/sub", kind: "background", status: "idle" }],
    });
    expect(v.reasons).toContain("live-session");
  });
  test("sibling-prefix session does NOT count (/wt/CTL-64 vs /wt/CTL-649)", () => {
    const v = isSafeToRemoveWorktree("/wt/CTL-64", { ...SAFE_CTX, ticket: "CTL-64" }, {
      ...SAFE_DEPS,
      agentsList: [{ sessionId: "s", cwd: "/wt/CTL-649", status: "idle" }],
    });
    expect(v.reasons).not.toContain("live-session");
  });
  test("lsof-detectable process under the tree (not in claude agents) → proc-live", () => {
    expect(isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, procLive: true }).reasons).toContain("proc-live");
  });
  test("agents read failed → agents-stale (never treat an unreadable fleet as empty)", () => {
    expect(isSafeToRemoveWorktree("/wt/CTL-1", SAFE_CTX, { ...SAFE_DEPS, agentsOk: false }).reasons).toContain("agents-stale");
  });
  test("unknown provenance → unknown-provenance (interactive worktrees are never touched)", () => {
    expect(isSafeToRemoveWorktree("/wt/X", { ...SAFE_CTX, orchProvenance: false }, SAFE_DEPS).reasons).toContain("unknown-provenance");
  });
  test("multiple failures are ALL collected (no short-circuit)", () => {
    const v = isSafeToRemoveWorktree("/wt/X", { ...SAFE_CTX, terminal: false, prMerged: false, orchProvenance: false }, {
      ...SAFE_DEPS,
      runGit: gitStub({ porcelain: " M apps/x.ts\n" }),
      procLive: true,
    });
    expect(v.reasons).toEqual(expect.arrayContaining(["not-terminal", "not-merged", "dirty-worktree", "proc-live", "unknown-provenance"]));
  });
});

describe("cleanPorcelain", () => {
  test("every machine-local noise path is excluded", () => {
    for (const n of MACHINE_LOCAL_NOISE) {
      expect(cleanPorcelain(` M ${n}\n`)).toEqual([]);
    }
  });
  test("a rename of real code is dirty", () => {
    expect(cleanPorcelain('R  old.ts -> new.ts\n').length).toBe(1);
  });
});

describe("filesystem-backed: defer / archive / safeTeardown", () => {
  let tmp, queueDir, archiveDir, wt;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "wt-safety-"));
    queueDir = join(tmp, "queue");
    archiveDir = join(tmp, "arch");
    wt = join(tmp, "wt", "CTL-1");
    mkdirSync(wt, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test("deferWorktreeCleanup writes an OUT-OF-TREE marker + emits, and writes NOTHING into the worktree", () => {
    const emitted = [];
    const r = deferWorktreeCleanup(wt, { ticket: "CTL-1", branch: "b", reasons: ["dirty-worktree", "not-merged"] }, {
      emit: (t, f) => { emitted.push({ t, f }); return Promise.resolve(true); },
      queueDir,
    });
    expect(r).toEqual({ removed: false, deferred: true, reasons: ["dirty-worktree", "not-merged"] });
    expect(emitted[0].t).toBe("worktree.cleanup-deferred");
    expect(readdirSync(queueDir).length).toBe(1); // marker outside the worktree
    expect(readdirSync(wt)).toEqual([]); // NOTHING written into the tree (no self-dirty)
  });

  test("archiveWorktreeArtifacts is FAIL-CLOSED when thoughts/ has content and humanlayer errors", () => {
    mkdirSync(join(wt, "thoughts"), { recursive: true });
    writeFileSync(join(wt, "thoughts", "note.md"), "unsynced");
    const exec = () => ({ status: 1, stderr: "humanlayer: not found" });
    expect(archiveWorktreeArtifacts(wt, { ticket: "CTL-1" }, { exec, archiveDir }).ok).toBe(false);
  });

  test("archiveWorktreeArtifacts copies loose *.md docs and succeeds (verified)", () => {
    writeFileSync(join(wt, "DESIGN.md"), "# design");
    const exec = () => ({ status: 0, stdout: "" });
    const r = archiveWorktreeArtifacts(wt, { ticket: "CTL-1" }, { exec, archiveDir });
    expect(r.ok).toBe(true);
    expect(existsSync(join(archiveDir, "CTL-1", "DESIGN.md"))).toBe(true);
  });

  test("safeTeardownWorktree: unsafe verdict → DEFERS, never removes", () => {
    let removed = false;
    const r = safeTeardownWorktree(
      { repoRoot: tmp, ticket: "CTL-1", worktreePath: wt, terminal: true, prMerged: false, branch: "b" },
      {
        agents: () => ({ list: [], ok: true }),
        procLive: () => false,
        archive: () => ({ ok: true }),
        removeWorktree: () => { removed = true; return { status: 0 }; },
        runGit: gitStub(),
        orchDirs: [],
        emit: () => Promise.resolve(true),
        queueDir,
      },
    );
    expect(removed).toBe(false);
    expect(r.deferred).toBe(true);
    expect(r.reasons).toContain("not-merged");
  });

  test("safeTeardownWorktree: archive failure → DEFERS, never removes", () => {
    let removed = false;
    const r = safeTeardownWorktree(
      { repoRoot: tmp, ticket: "CTL-1", worktreePath: wt, terminal: true, prMerged: true, branch: "b" },
      {
        agents: () => ({ list: [], ok: true }),
        procLive: () => false,
        archive: () => ({ ok: false, error: "sync failed" }),
        removeWorktree: () => { removed = true; return { status: 0 }; },
        runGit: gitStub(),
        orchDirs: [join(tmp, "run")],
        emit: () => Promise.resolve(true),
        queueDir,
      },
    );
    expect(removed).toBe(false);
    expect(r.deferred).toBe(true);
  });

  test("safeTeardownWorktree: all-pass → archives then removes (argv has NO --force)", () => {
    // provenance: workers/CTL-1 under a fake orchDir
    const orch = join(tmp, "run");
    mkdirSync(join(orch, "workers", "CTL-1"), { recursive: true });
    let removeArgs = null;
    const r = safeTeardownWorktree(
      { repoRoot: tmp, ticket: "CTL-1", worktreePath: wt, terminal: true, prMerged: true, branch: "b" },
      {
        agents: () => ({ list: [], ok: true }),
        procLive: () => false,
        archive: () => ({ ok: true }),
        removeWorktree: (p) => { removeArgs = p; return { status: 0 }; },
        runGit: gitStub(),
        orchDirs: [orch],
        emit: () => Promise.resolve(true),
        queueDir,
      },
    );
    expect(r.removed).toBe(true);
    expect(removeArgs).toBe(wt); // removeWorktree(path) — the default uses no --force
  });

  test("safeTeardownWorktree: a session opened AFTER the gate (TOCTOU) → defers on the pre-remove re-check", () => {
    let removed = false;
    let probes = 0;
    const r = safeTeardownWorktree(
      { repoRoot: tmp, ticket: "CTL-1", worktreePath: wt, terminal: true, prMerged: true, branch: "b" },
      {
        agents: () => ({ list: [], ok: true }),
        // first probe (gate) clear; second probe (pre-remove re-check) live.
        procLive: () => (probes++ === 0 ? false : true),
        archive: () => ({ ok: true }),
        removeWorktree: () => { removed = true; return { status: 0 }; },
        runGit: gitStub(),
        orchDirs: [(() => { const o = join(tmp, "run"); mkdirSync(join(o, "workers", "CTL-1"), { recursive: true }); return o; })()],
        emit: () => Promise.resolve(true),
        queueDir,
      },
    );
    expect(removed).toBe(false);
    expect(r.reasons).toContain("live-session-late");
  });

  test("hasOrchProvenance: true with workers/<ticket>/ dir, false without", () => {
    const orch = join(tmp, "run");
    mkdirSync(join(orch, "workers", "CTL-1"), { recursive: true });
    expect(hasOrchProvenance("CTL-1", { orchDirs: [orch] })).toBe(true);
    expect(hasOrchProvenance("CTL-999", { orchDirs: [orch] })).toBe(false);
  });
});
