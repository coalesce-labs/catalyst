// worker-dir-gc.test.mjs — CTL-1205. GC of stale execution-core/workers/<TICKET>/ dirs.
//
// Every fs/agents/clock/emit primitive is an injected, defaulted constructor
// param (mirrors job-dir-gc.test.mjs). NO test reads real disk or spawns `claude`.

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { sweepWorkerDirs } from "./worker-dir-gc.mjs";

const HOUR = 3600_000;
const RETENTION_24H = 24 * HOUR;
const ORCH = "/fake/execution-core";
const WORKERS = join(ORCH, "workers");

// Recording rm spy: records every (path, opts) tuple, never touches disk.
function rmSpy() {
  const calls = [];
  const fn = async (p, opts) => {
    calls.push({ path: p, opts });
  };
  fn.calls = calls;
  return fn;
}

// CAT-24: recording rename spy for the detach-before-delete step. Succeeds.
function renameSpy() {
  const calls = [];
  const fn = async (from, to) => {
    calls.push({ from, to });
  };
  fn.calls = calls;
  return fn;
}

// The GC-owned sibling a reclaimed dir is detached to before deletion.
const quarantineOf = (ticket, now) => join(WORKERS, `.gc-${ticket}-${now}`);

// sweep — sweepWorkerDirs with a default in-memory renameDir so no test ever
// touches real disk. Individual tests still override renameDir to assert on it.
function sweep(opts) {
  return sweepWorkerDirs({ renameDir: async () => {}, ...opts });
}

// Recording emit spy: records (eventType, fields) tuples, resolves true.
function emitSpy() {
  const calls = [];
  const fn = async (eventType, fields) => {
    calls.push({ eventType, fields });
    return true;
  };
  fn.calls = calls;
  return fn;
}

// Recording log spy with warn().
function logSpy() {
  const warn = [];
  return {
    warn: (...args) => warn.push(args),
    info: () => {},
    error: () => {},
    debug: () => {},
    _warn: warn,
  };
}

// A live agent row matching claude agents --json shape.
const agent = (sessionId) => ({ sessionId, status: "idle", kind: "background" });

// Fake readDir that returns an array of dir entries (with isDirectory).
function fakeDirs(names) {
  return async () => names.map((n) => ({ name: n, isDirectory: () => true }));
}

// Build a fake readWorkerMeta returning {statuses, shortIds} for a ticket.
function fakeWorkerMeta(map) {
  return async (ticket) => map[ticket] ?? { statuses: {}, shortIds: new Set() };
}

// Path-aware readDir for the redispatch-race test. `contents` maps an absolute
// path to its entry names; everything else answers empty. Unlike fakeDirs (which
// ignores its path) this can model the workers root, a ticket dir, and the
// quarantine sibling independently — which is what the race turns on.
function fakeTree(contents) {
  return async (path) =>
    (contents[path] ?? []).map((n) => ({ name: n, isDirectory: () => !n.includes(".") }));
}

describe("sweepWorkerDirs", () => {
  // CAT-24 (Codex P1 round 2): the atomic rename only protects redispatches that
  // START after it. phase-agent-dispatch reuses an existing path with `mkdir -p`
  // and writes its claim and phase signal afterwards, so a dispatch that began
  // while the gates were awaiting I/O lands its state in the dir being captured —
  // and the recursive rm would delete a live worker's claim. The sweep therefore
  // re-reads the dir after detaching and puts it back if anything appeared.
  it("restores a detached dir that a concurrent redispatch wrote into", async () => {
    const now = 1_000_000_000_000;
    const ticket = "CTL-RACE";
    const dir = join(WORKERS, ticket);
    const quarantine = quarantineOf(ticket, now);
    const rm = rmSpy();
    // The dir is an aged, zero-signal residue at snapshot time...
    const tree = { [WORKERS]: [ticket], [dir]: [], [quarantine]: [] };
    const renames = [];
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeTree(tree),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({ [ticket]: { statuses: {}, shortIds: new Set() } }),
      isInFlight: () => false,
      now: () => now,
      emitReap: emitSpy(),
      // ...but a redispatch lands its claim + signal in the SAME inode just before
      // the rename completes, so the renamed dir carries them.
      renameDir: async (from, to) => {
        renames.push([from, to]);
        if (from === dir) {
          tree[quarantine] = ["research.claim.1", "phase-research.json"];
          tree[dir] = [];
        } else {
          tree[dir] = tree[from];
        }
      },
    });

    // Detached, then put straight back — and never handed to rm.
    expect(renames).toEqual([
      [dir, quarantine],
      [quarantine, dir],
    ]);
    expect(rm.calls).toEqual([]);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedLive).toBe(1);
  });

  it("deletes a terminal, idle, aged worker dir", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const emit = emitSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9000"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9000": {
          statuses: { teardown: "done" },
          shortIds: new Set(["deadbeef"]),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(rm.calls[0].path).toBe(quarantineOf("CTL-9000", now));
    expect(rm.calls[0].opts).toEqual({ recursive: true, force: true });
    expect(res.reclaimed).toBe(1);
    expect(res.scanned).toBe(1);
    const swept = emit.calls.find((c) => c.eventType === "workers.gc.swept");
    expect(swept).toBeTruthy();
    expect(swept.fields.reclaimed).toBe(1);
  });

  it("fails closed when `claude agents` is unreadable", async () => {
    const rm = rmSpy();
    const emit = emitSpy();
    const log = logSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9000"]),
      statDir: async () => ({ mtimeMs: 0 }),
      rm,
      readAgents: () => ({ ok: false, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9000": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => 1_000_000_000_000,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log,
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skipped).toBe("agents-unreadable");
    expect(log._warn.length).toBeGreaterThanOrEqual(1);
    expect(emit.calls.find((c) => c.eventType === "workers.gc.swept")).toBeUndefined();
  });

  it("fails closed when `claude agents` throws", async () => {
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9000"]),
      statDir: async () => ({ mtimeMs: 0 }),
      rm,
      readAgents: () => {
        throw new Error("exec failed");
      },
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9000": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => 1_000_000_000_000,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skipped).toBe("agents-unreadable");
  });

  it("never deletes an in-flight dir (has signals, still running)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9001"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        // implement running — not terminal
        "CTL-9001": { statuses: { implement: "running" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedInFlight).toBe(1);
  });

  it("a zero-signal worker dir older than retention is reclaimed (CAT-24)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9002"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9002": { statuses: {}, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(res.reclaimed).toBe(1);
    expect(res.reclaimedZeroSignal).toBe(1);
    expect(res.reclaimedTickets).toEqual(["CTL-9002"]);
  });

  it("fails closed when a worker directory is unreadable", async () => {
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-unreadable"]),
      statDir: async () => ({ mtimeMs: 0 }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CAT-unreadable": { statuses: {}, shortIds: new Set(), unreadable: true },
      }),
      now: () => 1_000_000_000_000,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedUnreadable).toBe(1);
  });

  it("a zero-signal worker dir younger than retention is skippedRecent", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-young"]),
      statDir: async () => ({ mtimeMs: now - HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({ "CAT-young": { statuses: {}, shortIds: new Set() } }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedRecent).toBe(1);
  });

  it("a zero-signal dir whose recorded session is live is skippedLive", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-live"]),
      statDir: async () => ({ mtimeMs: now - 48 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [agent("abc12345-0000-0000-0000-000000000000")] }),
      readWorkerMeta: fakeWorkerMeta({
        "CAT-live": { statuses: {}, shortIds: new Set(["abc12345"]) },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedLive).toBe(1);
  });

  it("never deletes a dir whose session is still live", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    // teardown done = terminal, but bg_job_id is still in live agents
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9003"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [agent("abc12345-0000-0000-0000-000000000000")] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9003": {
          statuses: { teardown: "done" },
          shortIds: new Set(["abc12345"]),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedLive).toBe(1);
  });

  it("never deletes a dir younger than retention", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9004"]),
      statDir: async () => ({ mtimeMs: now - 1 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9004": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedRecent).toBe(1);
  });

  it("bounds deletions to batchCap and drains the rest next tick", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const tickets = Array.from({ length: 20 }, (_, i) => `CTL-${9100 + i}`);
    const metaMap = Object.fromEntries(
      tickets.map((t) => [t, { statuses: { teardown: "done" }, shortIds: new Set() }])
    );
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(tickets),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta(metaMap),
      now: () => now,
      retentionMs: RETENTION_24H,
      batchCap: 5,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(5);
    expect(res.reclaimed).toBe(5);
    expect(res.batchCapped).toBe(true);
  });

  it("counts a vanished dir as an error and continues", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9010"]),
      statDir: async () => {
        const e = new Error("ENOENT: no such file");
        e.code = "ENOENT";
        throw e;
      },
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9010": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.errors).toBe(1);
    expect(res.reclaimed).toBe(0);
  });

  it("emits workers.gc.swept only after a real reclaim", async () => {
    const now = 1_000_000_000_000;
    const emit = emitSpy();
    // All dirs are recent — nothing to reclaim
    await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9011"]),
      statDir: async () => ({ mtimeMs: now - 1 * HOUR }),
      rm: rmSpy(),
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9011": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit,
      env: {},
      log: logSpy(),
    });
    expect(emit.calls.length).toBe(0);

    // Now reclaim one
    const emit2 = emitSpy();
    await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9012"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm: rmSpy(),
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9012": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emit2,
      env: {},
      log: logSpy(),
    });
    expect(emit2.calls.length).toBe(1);
    expect(emit2.calls[0].eventType).toBe("workers.gc.swept");
  });

  it("rm's the detached worker dir alone with recursive+force", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9020"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9020": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(rm.calls[0].path).toBe(quarantineOf("CTL-9020", now));
    expect(rm.calls[0].opts).toEqual({ recursive: true, force: true });
  });

  it("never deletes a dir matching the self/controlling session", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9030"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9030": {
          statuses: { teardown: "done" },
          shortIds: new Set(["5e1f0001"]),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: { CLAUDE_CODE_SESSION_ID: "5e1f0001-0000-0000-0000-000000000000" },
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedLive).toBe(1);
  });

  it("handles teardown skipped as terminal (not in-flight, CTL-512 pattern)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    // teardown: "skipped" is terminal per the CTL-512 skipped-as-done pattern on TERMINAL_PHASE
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9040"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9040": {
          statuses: { "monitor-deploy": "skipped", teardown: "skipped" },
          shortIds: new Set(),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(1);
    expect(res.reclaimed).toBe(1);
  });

  it("keeps a dir with only monitor-deploy skipped (teardown still pending)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    // monitor-deploy: "skipped" alone is still in-flight — teardown has not run yet
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CTL-9041"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CTL-9041": {
          statuses: { "monitor-deploy": "skipped" },
          shortIds: new Set(),
        },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.skippedInFlight).toBe(1);
  });

  it("handles failed/stalled/aborted tickets as terminal (deletable)", async () => {
    const now = 1_000_000_000_000;
    for (const status of ["failed", "stalled", "aborted"]) {
      const rm = rmSpy();
      const res = await sweep({
        orchDir: ORCH,
        readDir: fakeDirs([`CTL-90${status}`]),
        statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
        rm,
        readAgents: () => ({ ok: true, agents: [] }),
        readWorkerMeta: fakeWorkerMeta({
          [`CTL-90${status}`]: {
            statuses: { implement: status },
            shortIds: new Set(),
          },
        }),
        now: () => now,
        retentionMs: RETENTION_24H,
        emit: emitSpy(),
        env: {},
        log: logSpy(),
      });
      expect(rm.calls.length).toBe(1);
      expect(res.reclaimed).toBe(1);
    }
  });

  // ─── CAT-24 (Codex P1): detach before delete ───

  it("detaches the dir to a GC-owned sibling BEFORE deleting it", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const renameDir = renameSpy();
    await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-detach"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      renameDir,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CAT-detach": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(renameDir.calls.length).toBe(1);
    expect(renameDir.calls[0].from).toBe(join(WORKERS, "CAT-detach"));
    expect(renameDir.calls[0].to).toBe(quarantineOf("CAT-detach", now));
    // The live path is NEVER the rm target — a concurrent redispatch that mkdirs
    // workers/CAT-detach again writes into a different inode we cannot touch.
    expect(rm.calls.map((c) => c.path)).not.toContain(join(WORKERS, "CAT-detach"));
    expect(rm.calls[0].path).toBe(quarantineOf("CAT-detach", now));
  });

  it("deletes NOTHING when the detach rename fails", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const log = logSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-raced"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      renameDir: async () => {
        throw new Error("EPERM: rename refused");
      },
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CAT-raced": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log,
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.errors).toBe(1);
    expect(log._warn.length).toBeGreaterThanOrEqual(1);
  });

  it("treats an ENOENT detach as benign (already gone — no error, no delete)", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-vanished"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      renameDir: async () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({
        "CAT-vanished": { statuses: { teardown: "done" }, shortIds: new Set() },
      }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.errors).toBe(0);
  });

  it("purges a leftover quarantine dir and never treats it as a ticket", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const readWorkerMeta = async (ticket) => {
      // A `.gc-` entry must never reach the meta reader — it is not a ticket.
      expect(ticket.startsWith(".gc-")).toBe(false);
      return { statuses: { teardown: "done" }, shortIds: new Set() };
    };
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs([".gc-CAT-old-123", "CAT-normal"]),
      statDir: async () => ({ mtimeMs: now - 25 * HOUR }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta,
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(res.scanned).toBe(1); // only CAT-normal is a ticket
    expect(rm.calls.map((c) => c.path)).toContain(join(WORKERS, ".gc-CAT-old-123"));
  });

  // ─── CAT-24 (Codex P1): unconsumed operator inbox ───

  it("never reclaims a zero-signal dir holding a fresh non-empty inbox", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-inbox"]),
      // Dir aged past retention, but the operator answered 1h ago: the reply is
      // unconsumed human input, not residue.
      statDir: async (p) =>
        String(p).endsWith("inbox.jsonl")
          ? { mtimeMs: now - HOUR, size: 412 }
          : { mtimeMs: now - 25 * HOUR },
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({ "CAT-inbox": { statuses: {}, shortIds: new Set() } }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.skippedPendingInbox).toBe(1);
  });

  it("reclaims a zero-signal dir whose inbox is empty", async () => {
    const now = 1_000_000_000_000;
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-emptyinbox"]),
      statDir: async (p) =>
        String(p).endsWith("inbox.jsonl")
          ? { mtimeMs: now - HOUR, size: 0 }
          : { mtimeMs: now - 25 * HOUR },
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({ "CAT-emptyinbox": { statuses: {}, shortIds: new Set() } }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(res.reclaimed).toBe(1);
    expect(res.skippedPendingInbox).toBe(0);
  });

  it("reclaims a zero-signal dir whose inbox itself aged past retention", async () => {
    const now = 1_000_000_000_000;
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-staleinbox"]),
      // Non-empty, but nobody consumed it in 25h — it ages out like the dir.
      statDir: async () => ({ mtimeMs: now - 25 * HOUR, size: 412 }),
      rm: rmSpy(),
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({ "CAT-staleinbox": { statuses: {}, shortIds: new Set() } }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(res.reclaimed).toBe(1);
  });

  it("fails closed when the inbox stat errors for a non-ENOENT reason", async () => {
    const now = 1_000_000_000_000;
    const res = await sweep({
      orchDir: ORCH,
      readDir: fakeDirs(["CAT-badinbox"]),
      statDir: async (p) => {
        if (String(p).endsWith("inbox.jsonl")) throw new Error("EACCES");
        return { mtimeMs: now - 25 * HOUR };
      },
      rm: rmSpy(),
      readAgents: () => ({ ok: true, agents: [] }),
      readWorkerMeta: fakeWorkerMeta({ "CAT-badinbox": { statuses: {}, shortIds: new Set() } }),
      now: () => now,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(res.reclaimed).toBe(0);
    expect(res.skippedPendingInbox).toBe(1);
  });

  it("handles an unreadable workers root gracefully (returns zeros)", async () => {
    const rm = rmSpy();
    const res = await sweep({
      orchDir: ORCH,
      readDir: async (p) => {
        // workers root throws ENOENT; ticket subdir readDir never called
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      statDir: async () => ({ mtimeMs: 0 }),
      rm,
      readAgents: () => ({ ok: true, agents: [] }),
      now: () => 1_000_000_000_000,
      retentionMs: RETENTION_24H,
      emit: emitSpy(),
      env: {},
      log: logSpy(),
    });
    expect(rm.calls.length).toBe(0);
    expect(res.reclaimed).toBe(0);
    expect(res.scanned).toBe(0);
  });
});
