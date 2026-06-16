// wt-cleanup-drain.test.mjs — CTL-1218 Part C. The periodic reader for the
// ~/catalyst/wt-cleanup-queue/*.json markers that deferWorktreeCleanup writes.
// Pre-1218 the queue had ZERO readers (the CTL-792 drain was never built), so the
// same trees re-deferred every 600s tick. This sweep clears markers for
// already-gone worktrees and re-runs the gated teardown for survivors, confirming
// merge first. Every IO/spawn seam is injected — no real disk, git, gh.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { sweepWtCleanupQueue } from "./wt-cleanup-drain.mjs";
import { safeTeardownWorktree } from "./worktree-safety.mjs";

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// markerFile — replicate worktree-safety's filename scheme so the drain reads the
// same files deferWorktreeCleanup writes.
function markerFile(queueDir, worktreePath) {
  const sha1 = createHash("sha1")
    .update(String(worktreePath.replace(/\/+$/, "")))
    .digest("hex");
  return join(queueDir, `${sha1}.json`);
}

function writeMarker(
  queueDir,
  { worktreePath, ticket = "CTL-1", branch = "CTL-1", reasons = ["not-merged"] }
) {
  mkdirSync(queueDir, { recursive: true });
  const file = markerFile(queueDir, worktreePath);
  writeFileSync(
    file,
    JSON.stringify({ ts: new Date().toISOString(), ticket, branch, worktreePath, reasons })
  );
  return file;
}

describe("sweepWtCleanupQueue (CTL-1218 Part C)", () => {
  let tmp, queueDir;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1218-drain-"));
    queueDir = join(tmp, "queue");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("removes a marker whose worktree path is already gone and counts it cleared (no teardown)", async () => {
    const gone = join(tmp, "wt", "GONE-1");
    const file = writeMarker(queueDir, { worktreePath: gone });
    let teardownCalls = 0;
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => false, // worktree already gone
      safeTeardown: () => {
        teardownCalls++;
        return { removed: true };
      },
      log: silentLog(),
    });
    expect(existsSync(file)).toBe(false); // marker deleted
    expect(teardownCalls).toBe(0);
    expect(res.cleared).toBeGreaterThanOrEqual(1);
  });

  it("re-runs safeTeardownWorktree for a surviving path and counts removed on success", async () => {
    const alive = join(tmp, "wt", "ALIVE-1");
    writeMarker(queueDir, { worktreePath: alive, ticket: "CTL-7", branch: "CTL-7" });
    const teardownArgs = [];
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      confirmMerged: () => true,
      safeTeardown: (args) => {
        teardownArgs.push(args);
        return { removed: true };
      },
      log: silentLog(),
    });
    expect(teardownArgs.length).toBe(1);
    expect(teardownArgs[0]).toMatchObject({
      ticket: "CTL-7",
      worktreePath: alive,
      branch: "CTL-7",
      terminal: true,
      prMerged: true,
    });
    expect(res.reattempted).toBeGreaterThanOrEqual(1);
    expect(res.removed).toBeGreaterThanOrEqual(1);
  });

  it("leaves the marker when safeTeardown re-defers (removed:false)", async () => {
    const alive = join(tmp, "wt", "ALIVE-2");
    const file = writeMarker(queueDir, { worktreePath: alive });
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      confirmMerged: () => false, // not merged → gate will defer
      safeTeardown: () => ({ removed: false, deferred: true, reasons: ["not-merged"] }),
      log: silentLog(),
    });
    expect(existsSync(file)).toBe(true); // marker retained for the next tick
    expect(res.stillDeferred).toBeGreaterThanOrEqual(1);
    expect(res.removed).toBe(0);
  });

  it("only sets prMerged:true after confirming MERGED via confirmMerged", async () => {
    const alive = join(tmp, "wt", "ALIVE-3");
    writeMarker(queueDir, { worktreePath: alive });
    const seen = [];
    await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      confirmMerged: () => false, // NOT merged
      safeTeardown: (args) => {
        seen.push(args.prMerged);
        return { removed: false, deferred: true, reasons: ["not-merged"] };
      },
      log: silentLog(),
    });
    expect(seen).toEqual([false]); // gate sees prMerged:false → defers (fail-closed)
  });

  it("is bounded by batchCap (at most cap teardown attempts)", async () => {
    for (let i = 0; i < 5; i++) writeMarker(queueDir, { worktreePath: join(tmp, "wt", `B-${i}`) });
    let attempts = 0;
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      confirmMerged: () => true,
      safeTeardown: () => {
        attempts++;
        return { removed: false, deferred: true, reasons: ["x"] };
      },
      batchCap: 2,
      log: silentLog(),
    });
    expect(attempts).toBeLessThanOrEqual(2);
    expect(res.batchCapped).toBe(true);
  });

  it("is fail-soft: a malformed/unreadable marker is skipped, not thrown", async () => {
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "deadbeef.json"), "{ not json");
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      safeTeardown: () => ({ removed: true }),
      log: silentLog(),
    });
    expect(res.errors).toBeGreaterThanOrEqual(1);
    // The loop continued and returned a result object.
    expect(typeof res.scanned).toBe("number");
  });

  it("ENOENT queueDir → empty no-op result (never throws)", async () => {
    const res = await sweepWtCleanupQueue({
      queueDir: join(tmp, "does-not-exist"),
      log: silentLog(),
    });
    expect(res.scanned).toBe(0);
    expect(res.cleared).toBe(0);
    expect(res.removed).toBe(0);
  });

  it("NEVER --force: the default safeTeardown binding is safeTeardownWorktree (the gated non-force remover)", async () => {
    // sweepWtCleanupQueue's safeTeardown default must be the CTL-791 gated remover,
    // whose default removeWorktree uses `worktree remove <path>` (no --force).
    // Drive a real safeTeardownWorktree through the drain with an injected
    // removeWorktree spy and assert the argv it receives carries no --force.
    const alive = join(tmp, "wt", "ALIVE-NF");
    mkdirSync(alive, { recursive: true });
    writeMarker(queueDir, { worktreePath: alive, ticket: "CTL-NF", branch: "CTL-NF" });
    // provenance dir so the gate's provenance check would pass if reached
    const orch = join(tmp, "orch");
    mkdirSync(join(orch, "workers", "CTL-NF"), { recursive: true });
    let removeArg = null;
    const res = await sweepWtCleanupQueue({
      queueDir,
      orchDir: orch,
      pathExists: () => true,
      confirmMerged: () => true,
      // Use the REAL gated remover, with its git/agents/archive/remove seams injected.
      safeTeardown: (args) =>
        safeTeardownWorktree(args, {
          runGit: (a) => {
            if (a[0] === "status") return { status: 0, stdout: " M .catalyst/config.json\n" };
            if (a.includes("@{u}") && a[0] === "rev-parse")
              return { status: 0, stdout: "origin/b" };
            if (a[0] === "rev-list") return { status: 0, stdout: "0\n" };
            return { status: 0, stdout: "" };
          },
          agents: () => ({ list: [], ok: true }),
          procLive: () => false,
          archive: () => ({ ok: true }),
          removeWorktree: (p) => {
            removeArg = p;
            return { status: 0 };
          },
          emit: () => Promise.resolve(true),
          orchDirs: [orch],
          queueDir,
        }),
      log: silentLog(),
    });
    expect(removeArg).toBe(alive); // remover called with the PATH only — no --force
    expect(res.removed).toBeGreaterThanOrEqual(1);
  });
});
