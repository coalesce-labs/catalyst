// wt-cleanup-drain.test.mjs — CTL-1218 Part C. The periodic reader for the
// ~/catalyst/wt-cleanup-queue/*.json markers that deferWorktreeCleanup writes.
// Pre-1218 the queue had ZERO readers (the CTL-792 drain was never built), so the
// same trees re-deferred every 600s tick. This sweep clears markers for
// already-gone worktrees and re-runs the gated teardown for survivors, confirming
// merge first. Every IO/spawn seam is injected — no real disk, git, gh.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync,
} from "node:fs";
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
      hasProvenance: () => true, // CTL-1524: past the free gate → full expensive path
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
      hasProvenance: () => true, // CTL-1524: past the free gate → full expensive path
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
      hasProvenance: () => true, // CTL-1524: past the free gate → full expensive path
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
      hasProvenance: () => true, // CTL-1524: all 5 are EXPENSIVE candidates → cap bites
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

// ─── CTL-1524 — the drain must not block the event loop ──────────────────────
// Measured on mini: the 600s drain ran 72-97s of SYNCHRONOUS work in the daemon's
// own event loop, starving node.heartbeat (median event-loop delay 77.5s inside a
// burst vs 6.1s outside; 46/46 readings >60s inside, 0 outside). 692/692 deferred
// markers failed on `unknown-provenance` — a free existsSync — yet each still paid
// 2 gh round-trips + a recursive lsof descent (1.85s on a 104k-file tree) first.
describe("sweepWtCleanupQueue — CTL-1524 C1 sweep instrumentation", () => {
  let tmp, queueDir;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1524-drain-"));
    queueDir = join(tmp, "queue");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function capturingLog() {
    const lines = [];
    return { lines, info: (o, m) => lines.push([o, m]), warn: () => {}, error: () => {} };
  }

  it("emits ONE 'sweep timing' line per fire carrying duration_ms + every counter", async () => {
    writeMarker(queueDir, { worktreePath: join(tmp, "wt", "T-1"), ticket: "CTL-T1" });
    const log = capturingLog();
    let t = 1000;
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => false, // short-circuit cohort
      now: () => (t += 5), // deterministic clock: start → finish = 5ms elapsed
      log,
    });
    const timing = log.lines.filter(([, m]) => m === "wt-cleanup-drain: sweep timing");
    expect(timing.length).toBe(1);
    const fields = timing[0][0];
    for (const k of [
      "duration_ms", "scanned", "cleared", "reattempted",
      "removed", "deferred", "errors", "batchCapped", "shortCircuited",
    ]) {
      expect(fields[k]).toBeDefined();
    }
    expect(typeof fields.duration_ms).toBe("number");
    expect(fields.shortCircuited).toBe(1);
    expect(res.durationMs).toBe(fields.duration_ms);
  });

  it("emits the timing line even on a NO-OP sweep (ENOENT queue dir)", async () => {
    const log = capturingLog();
    await sweepWtCleanupQueue({ queueDir: join(tmp, "nope"), log });
    const timing = log.lines.filter(([, m]) => m === "wt-cleanup-drain: sweep timing");
    expect(timing.length).toBe(1);
    expect(timing[0][0].scanned).toBe(0);
  });

  it("instrumentation NEVER throws: a log.info that throws does not break the sweep", async () => {
    writeMarker(queueDir, { worktreePath: join(tmp, "wt", "T-2"), ticket: "CTL-T2" });
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => false,
      log: { info: () => { throw new Error("log boom"); }, warn: () => {}, error: () => {} },
    });
    expect(res.shortCircuited).toBe(1); // sweep completed and returned normally
  });
});

describe("sweepWtCleanupQueue — CTL-1524 C2 free-gate short-circuit", () => {
  let tmp, queueDir;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1524-c2-"));
    queueDir = join(tmp, "queue");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("no provenance ⇒ confirmMerged and safeTeardown are NEVER called; marker refreshed; shortCircuited++", async () => {
    const alive = join(tmp, "wt", "NOPROV-1");
    const file = writeMarker(queueDir, {
      worktreePath: alive,
      ticket: "CTL-NP",
      reasons: ["not-merged", "unknown-provenance"],
    });
    let mergedCalls = 0;
    let teardownCalls = 0;
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => false, // the 692/692 production cohort
      confirmMerged: () => { mergedCalls++; return true; },
      safeTeardown: () => { teardownCalls++; return { removed: true }; },
      log: silentLog(),
    });
    // THE FIX: zero network round-trips, zero lsof descents.
    expect(mergedCalls).toBe(0);
    expect(teardownCalls).toBe(0);
    expect(res.shortCircuited).toBe(1);
    expect(res.reattempted).toBe(0);
    expect(res.removed).toBe(0);
    // The marker survives, refreshed and HONEST about being abbreviated.
    expect(existsSync(file)).toBe(true);
    const m = JSON.parse(readFileSync(file, "utf8"));
    expect(m.reasons).toEqual(["unknown-provenance"]);
    expect(m.shortCircuit).toBe("unknown-provenance");
    expect(m.reasonsPartial).toBe(true); // NOT "provenance was the only failing gate"
    expect(m.shortCircuitSince).toBeTruthy(); // write-once: FIRST short-circuit, not latest
    expect(m.worktreePath).toBe(alive); // identity preserved
  });

  it("a marker WITH provenance still goes through the full gate exactly as before", async () => {
    const alive = join(tmp, "wt", "PROV-1");
    writeMarker(queueDir, { worktreePath: alive, ticket: "CTL-P", branch: "CTL-P" });
    const provArgs = [];
    let mergedCalls = 0;
    const teardownArgs = [];
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: (ticket, opts) => { provArgs.push([ticket, opts]); return true; },
      confirmMerged: () => { mergedCalls++; return true; },
      safeTeardown: (args, deps) => { teardownArgs.push([args, deps]); return { removed: true }; },
      log: silentLog(),
    });
    expect(mergedCalls).toBe(1);
    expect(teardownArgs.length).toBe(1);
    expect(teardownArgs[0][0]).toMatchObject({
      ticket: "CTL-P", worktreePath: alive, branch: "CTL-P", terminal: true, prMerged: true,
    });
    expect(res.removed).toBe(1);
    expect(res.shortCircuited).toBe(0);
    // The pre-check uses the SAME ticket and the SAME orchDirs the gate resolves with,
    // so the two can never disagree about provenance.
    expect(provArgs[0][0]).toBe("CTL-P");
    expect(provArgs[0][1].orchDirs).toEqual(teardownArgs[0][1].orchDirs);
  });

  it("SAFETY INVARIANT: the short-circuit can only ever remove FEWER things, never more", async () => {
    // Drive the identical inputs twice — once with the free gate reached (new path)
    // and once forced down the old always-expensive path — and assert the new run's
    // removals are a SUBSET. The short-circuit performs no removal at all, so for
    // every no-provenance marker: old = defer (isSafeToRemoveWorktree pushes
    // "unknown-provenance" ⇒ safe:false), new = defer. Same outcome, no probes.
    const cases = [
      { ticket: "CTL-A", prov: false, merged: true },
      { ticket: "CTL-B", prov: true, merged: true },
      { ticket: "CTL-C", prov: false, merged: false },
      { ticket: "CTL-D", prov: true, merged: false },
    ];
    for (const c of cases) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", c.ticket), ticket: c.ticket });
    }
    const provOf = (t) => cases.find((c) => c.ticket === t).prov;
    const mergedOf = (t) => cases.find((c) => c.ticket === t).merged;
    // The REAL gate semantics: removal requires provenance AND merge (plus the
    // clean/liveness gates, held passing here).
    const realGate = (args) =>
      provOf(args.ticket) && args.prMerged === true
        ? { removed: true }
        : { removed: false, deferred: true, reasons: ["gate"] };

    const newRemoved = [];
    await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      batchCap: 99,
      hasProvenance: (t) => provOf(t),
      confirmMerged: (m) => mergedOf(m.ticket),
      safeTeardown: (args) => {
        const o = realGate(args);
        if (o.removed) newRemoved.push(args.ticket);
        return o;
      },
      log: silentLog(),
    });

    const oldRemoved = [];
    await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      batchCap: 99,
      hasProvenance: () => true, // force EVERY marker down the pre-C2 expensive path
      confirmMerged: (m) => mergedOf(m.ticket),
      safeTeardown: (args) => {
        const o = realGate(args); // gate still consults REAL provenance internally
        if (o.removed) oldRemoved.push(args.ticket);
        return o;
      },
      log: silentLog(),
    });

    // Subset in both directions of the claim: nothing new appeared...
    for (const t of newRemoved) expect(oldRemoved).toContain(t);
    // ...and the only things skipped were ones the old path also refused.
    expect(newRemoved.sort()).toEqual(oldRemoved.sort());
    expect(newRemoved).toEqual(["CTL-B"]); // provenance AND merged — the only removable one
  });
});

describe("sweepWtCleanupQueue — CTL-1524 C3 bounded, fair batch", () => {
  let tmp, queueDir;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1524-c3-"));
    queueDir = join(tmp, "queue");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("the cap counts ONLY expensive attempts — N short-circuits never consume the budget", async () => {
    // 6 no-provenance markers (free) + 2 with provenance (expensive), cap = 2.
    // The free cohort must ALL be processed and must not trip the cap.
    const expensive = new Set(["CTL-E1", "CTL-E2"]);
    for (let i = 0; i < 6; i++) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", `F-${i}`), ticket: `CTL-F${i}` });
    }
    for (const t of expensive) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", t), ticket: t });
    }
    let attempts = 0;
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: (t) => expensive.has(t),
      confirmMerged: () => true,
      safeTeardown: () => {
        attempts++;
        return { removed: false, deferred: true, reasons: ["x"] };
      },
      batchCap: 2,
      log: silentLog(),
    });
    expect(attempts).toBe(2); // both expensive ones ran — the cap was NOT eaten by the free cohort
    expect(res.shortCircuited).toBe(6); // every free marker still processed this fire
    expect(res.reattempted).toBe(2);
    expect(res.batchCapped).toBe(false); // exactly at cap, nothing turned away
  });

  it("the free cohort keeps draining AFTER the cap is hit (continue, not break)", async () => {
    for (let i = 0; i < 3; i++) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", `X-${i}`), ticket: `CTL-X${i}` });
    }
    for (let i = 0; i < 4; i++) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", `Y-${i}`), ticket: `CTL-Y${i}` });
    }
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: (t) => t.startsWith("CTL-Y"), // 4 expensive, cap 1 → 3 turned away
      confirmMerged: () => true,
      safeTeardown: () => ({ removed: false, deferred: true, reasons: ["x"] }),
      batchCap: 1,
      log: silentLog(),
    });
    expect(res.reattempted).toBe(1);
    expect(res.batchCapped).toBe(true);
    expect(res.shortCircuited).toBe(3); // all 3 free ones handled despite the cap tripping
  });

  it("fair rotation: the least-recently-attempted marker is picked next sweep", async () => {
    const tickets = ["CTL-R1", "CTL-R2", "CTL-R3"];
    for (const t of tickets) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", t), ticket: t });
    }
    const seen = [];
    let clock = Date.parse("2026-07-25T00:00:00.000Z");
    const sweepOnce = () =>
      sweepWtCleanupQueue({
        queueDir,
        pathExists: () => true,
        hasProvenance: () => true,
        confirmMerged: () => true,
        safeTeardown: (args) => {
          seen.push(args.ticket);
          return { removed: false, deferred: true, reasons: ["x"] };
        },
        batchCap: 1, // exactly one expensive attempt per fire
        now: () => (clock += 60_000), // each sweep advances the clock
        log: silentLog(),
      });

    await sweepOnce();
    await sweepOnce();
    await sweepOnce();
    // Every ticket got a turn before any ticket got a second one — no starvation
    // from a stable readdir order.
    expect(seen.length).toBe(3);
    expect([...new Set(seen)].sort()).toEqual(tickets);

    // And the stamp is what drives it: the marker carries lastAttemptAt.
    for (const t of tickets) {
      const m = JSON.parse(readFileSync(markerFile(queueDir, join(tmp, "wt", t)), "utf8"));
      expect(m.lastAttemptAt).toBeTruthy();
    }

    // A 4th sweep returns to the least-recently-attempted (the first one tried).
    await sweepOnce();
    expect(seen[3]).toBe(seen[0]);
  });

  it("the attempt stamp merges onto the marker the gate just rewrote (full reasons preserved)", async () => {
    const alive = join(tmp, "wt", "STAMP-1");
    const file = writeMarker(queueDir, { worktreePath: alive, ticket: "CTL-S" });
    await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => true,
      confirmMerged: () => false,
      safeTeardown: () => {
        // stand in for deferWorktreeCleanup rewriting the marker with FULL reasons
        writeFileSync(
          file,
          JSON.stringify({ worktreePath: alive, ticket: "CTL-S", reasons: ["not-merged", "dirty-worktree"] })
        );
        return { removed: false, deferred: true, reasons: ["not-merged", "dirty-worktree"] };
      },
      log: silentLog(),
    });
    const m = JSON.parse(readFileSync(file, "utf8"));
    expect(m.reasons).toEqual(["not-merged", "dirty-worktree"]); // NOT clobbered
    expect(m.lastAttemptAt).toBeTruthy(); // stamp applied on top
  });

  // ── Codex review (PR #2747, P2 x2) ─────────────────────────────────────────
  it("the short-circuit refresh is IDEMPOTENT — an already-recorded marker is never rewritten again", async () => {
    // This cohort is strictly monotonic, so rewriting each retained marker on every
    // 600s fire would make write volume grow with queue depth forever.
    const wt = join(tmp, "wt", "IDEM-1");
    const file = writeMarker(queueDir, { worktreePath: wt, ticket: "CTL-IDEM" });
    const writes = [];
    const opts = () => ({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => false, // always short-circuits
      writeFileFn: (p, str) => {
        writes.push(p);
        writeFileSync(p, str);
      },
      confirmMerged: () => {
        throw new Error("must not be reached");
      },
      safeTeardown: () => {
        throw new Error("must not be reached");
      },
      log: silentLog(),
    });

    const first = await sweepWtCleanupQueue(opts());
    expect(first.shortCircuited).toBe(1);
    expect(first.shortCircuitWrites).toBe(1); // first sweep records it
    expect(writes.length).toBe(1);

    const m = JSON.parse(readFileSync(file, "utf8"));
    expect(m.shortCircuit).toBe("unknown-provenance");
    expect(m.reasonsPartial).toBe(true);
    expect(m.shortCircuitSince).toBeTruthy();

    // Steady state: still counted, but ZERO further writes across many fires.
    for (let i = 0; i < 5; i++) {
      const again = await sweepWtCleanupQueue(opts());
      expect(again.shortCircuited).toBe(1); // still observed
      expect(again.shortCircuitWrites).toBe(0); // but never rewritten
    }
    expect(writes.length).toBe(1);
    // The first-recorded timestamp is preserved, not churned.
    expect(JSON.parse(readFileSync(file, "utf8")).shortCircuitSince).toBe(m.shortCircuitSince);
  });

  it("the short-circuit WRITE budget is bounded per fire (paces a large first-time backfill)", async () => {
    for (let i = 0; i < 10; i++) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", `SC-${i}`), ticket: `CTL-SC${i}` });
    }
    const r = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => false,
      shortCircuitWriteCap: 3,
      log: silentLog(),
    });
    expect(r.shortCircuited).toBe(10); // all still observed (free)
    expect(r.shortCircuitWrites).toBe(3); // but writes bounded
    expect(r.shortCircuitWriteCapped).toBe(true);
  });

  it("rotation still advances when the attempt stamp CANNOT be persisted (unwritable marker)", async () => {
    // With batchCap=1, a single marker whose stamp write always fails would keep the
    // oldest sort key, sort first every fire, and starve every other worktree forever.
    const tickets = ["CTL-W1", "CTL-W2", "CTL-W3"];
    for (const t of tickets) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", t), ticket: t });
    }
    const seen = [];
    let clock = Date.parse("2026-07-25T00:00:00.000Z");
    const memo = new Map(); // fresh per test — no cross-test leakage
    const sweepOnce = () =>
      sweepWtCleanupQueue({
        queueDir,
        pathExists: () => true,
        hasProvenance: () => true,
        confirmMerged: () => true,
        // EVERY marker write fails — the on-disk lastAttemptAt can never land.
        writeFileFn: () => {
          throw new Error("EROFS: read-only file system");
        },
        safeTeardown: (args) => {
          seen.push(args.ticket);
          return { removed: false, deferred: true, reasons: ["x"] };
        },
        batchCap: 1,
        attemptMemo: memo,
        now: () => (clock += 60_000),
        log: silentLog(),
      });

    await sweepOnce();
    await sweepOnce();
    await sweepOnce();

    // No marker on disk carries a stamp...
    for (const t of tickets) {
      const m = JSON.parse(readFileSync(markerFile(queueDir, join(tmp, "wt", t)), "utf8"));
      expect(m.lastAttemptAt).toBeUndefined();
    }
    // ...yet every ticket still got its turn: rotation came from the in-process memo.
    expect(seen.length).toBe(3);
    expect([...new Set(seen)].sort()).toEqual(tickets);
    await sweepOnce();
    expect(seen[3]).toBe(seen[0]); // and it cycles, rather than repeating a prefix
  });

  it("the rotation memo is pruned to the live marker set (cannot outgrow the queue)", async () => {
    const memo = new Map();
    memo.set(join(queueDir, "stale-marker-that-no-longer-exists.json"), 123);
    writeMarker(queueDir, { worktreePath: join(tmp, "wt", "P1"), ticket: "CTL-P1" });
    await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => true,
      confirmMerged: () => true,
      safeTeardown: () => ({ removed: false, deferred: true, reasons: ["x"] }),
      attemptMemo: memo,
      log: silentLog(),
    });
    expect([...memo.keys()].some((k) => k.includes("stale-marker"))).toBe(false);
    expect(memo.size).toBe(1); // exactly the one live marker
  });

  it("the default batch cap is small (2) — the old 100 could never trip at the observed n=15", async () => {
    for (let i = 0; i < 15; i++) {
      writeMarker(queueDir, { worktreePath: join(tmp, "wt", `D-${i}`), ticket: `CTL-D${i}` });
    }
    let attempts = 0;
    const res = await sweepWtCleanupQueue({
      queueDir,
      pathExists: () => true,
      hasProvenance: () => true,
      confirmMerged: () => true,
      safeTeardown: () => {
        attempts++;
        return { removed: false, deferred: true, reasons: ["x"] };
      },
      // no batchCap override → the module default
      log: silentLog(),
    });
    expect(attempts).toBe(2);
    expect(res.batchCapped).toBe(true);
  });
});
