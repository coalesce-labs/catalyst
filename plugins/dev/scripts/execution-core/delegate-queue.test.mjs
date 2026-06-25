// delegate-queue.test.mjs — CTL-1331. The intent queue + slot-reservation ledger
// for the async board-health delegate. Deterministic: orchDir is a tmpdir, every
// clock / isBgJobAlive / maxParallel is injected — NO real claude/git/worktree.
//
// Mirrors the §10a TDD plan in
//   thoughts/shared/plans/2026-06-24-ctl-1331-async-worker-design.md
//   - atomic write + correct fields
//   - idempotent second enqueue (no overwrite)
//   - worker-live no-op (fake phase-recovery-pass.json running + injected isBgJobAlive→true)
//   - queue-full ceiling
//   - countQueuedDelegates counts only queued|claimed
//   - gcDelegateIntents removal/retention + returns count
//   - claim single-flight (second concurrent claim loses)
//   - stale-claim reclaim
//
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-queue.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueueDelegateIntent,
  countQueuedDelegates,
  gcDelegateIntents,
  claimIntent,
  transitionIntent,
  reclaimStaleClaims,
  DELEGATE_QUEUE_DIR,
  delegateQueueDir,
} from "./delegate-queue.mjs";

let orchDir;
const FIXED_NOW = 1_700_000_000_000;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1331-queue-"));
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function queueDir() {
  return join(orchDir, DELEGATE_QUEUE_DIR);
}

function intentPath(ticket) {
  return join(queueDir(), `${ticket}.json`);
}

function readIntent(ticket) {
  return JSON.parse(readFileSync(intentPath(ticket), "utf8"));
}

function listQueueFiles() {
  try {
    return readdirSync(queueDir());
  } catch {
    return [];
  }
}

// Seed a worker phase-recovery-pass.json signal (the live-worker idempotency input).
function seedRecoveryPassSignal(ticket, status, bgJobId = "bg-live-1") {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phase-recovery-pass.json"),
    JSON.stringify({ ticket, phase: "recovery-pass", status, bg_job_id: bgJobId })
  );
}

// Default deps: nothing alive, generous ceiling, fixed clock.
function deps(over = {}) {
  return {
    orchDir,
    isBgJobAlive: () => false,
    now: () => FIXED_NOW,
    maxParallel: 8,
    ...over,
  };
}

const INTENT = {
  kind: "board-health",
  phase: "recovery-pass",
  boardContext: { anomaly: "wip-spike", anchors: ["CTL-1"] },
  reason: "board-health: wip spike — holistic delegate",
};

// ─── dir derivation parity with .recovery-intents/ ───────────────────────────

describe("delegateQueueDir (matches the .recovery-intents/ derivation convention)", () => {
  test("derives <orchDir>/.delegate-queue", () => {
    expect(delegateQueueDir(orchDir)).toBe(join(orchDir, ".delegate-queue"));
    expect(DELEGATE_QUEUE_DIR).toBe(".delegate-queue");
  });
});

// ─── enqueue: atomic write + correct fields ──────────────────────────────────

describe("enqueueDelegateIntent — atomic write + fields", () => {
  test("writes a delegate-intent/v1 file with status:queued and all carried fields", () => {
    const r = enqueueDelegateIntent("CTL-1", INTENT, deps());
    expect(r.enqueued).toBe(true);

    const intent = readIntent("CTL-1");
    expect(intent.schema).toBe("delegate-intent/v1");
    expect(intent.ticket).toBe("CTL-1");
    expect(intent.status).toBe("queued");
    expect(intent.kind).toBe("board-health");
    expect(intent.phase).toBe("recovery-pass");
    expect(intent.boardContext).toEqual(INTENT.boardContext);
    expect(intent.reason).toBe(INTENT.reason);
    expect(intent.enqueuedAt).toBe(FIXED_NOW);
  });

  test("no tmp file is left behind after the rename", () => {
    enqueueDelegateIntent("CTL-1", INTENT, deps());
    const files = listQueueFiles();
    expect(files).toContain("CTL-1.json");
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });
});

// ─── enqueue idempotency layer 1: existing non-terminal intent ───────────────

describe("enqueueDelegateIntent — idempotent (queue-file existence)", () => {
  test("second enqueue while queued no-ops with already-pending and does NOT overwrite", () => {
    expect(enqueueDelegateIntent("CTL-1", INTENT, deps()).enqueued).toBe(true);
    const firstBody = readFileSync(intentPath("CTL-1"), "utf8");

    const r2 = enqueueDelegateIntent(
      "CTL-1",
      { ...INTENT, reason: "DIFFERENT reason should not overwrite" },
      deps()
    );
    expect(r2.enqueued).toBe(false);
    expect(r2.reason).toBe("already-pending");
    // byte-for-byte unchanged
    expect(readFileSync(intentPath("CTL-1"), "utf8")).toBe(firstBody);
  });

  test("claimed and launched intents also block a re-enqueue (non-terminal states)", () => {
    for (const status of ["claimed", "launched"]) {
      const t = `CTL-${status}`;
      mkdirSync(queueDir(), { recursive: true });
      writeFileSync(
        intentPath(t),
        JSON.stringify({ schema: "delegate-intent/v1", ticket: t, status })
      );
      const r = enqueueDelegateIntent(t, INTENT, deps());
      expect(r.enqueued).toBe(false);
      expect(r.reason).toBe("already-pending");
    }
  });

  test("a terminal intent (failed/superseded) does NOT block — re-enqueue overwrites", () => {
    for (const status of ["failed", "superseded"]) {
      const t = `CTL-${status}`;
      mkdirSync(queueDir(), { recursive: true });
      writeFileSync(
        intentPath(t),
        JSON.stringify({ schema: "delegate-intent/v1", ticket: t, status })
      );
      const r = enqueueDelegateIntent(t, INTENT, deps());
      expect(r.enqueued).toBe(true);
      expect(readIntent(t).status).toBe("queued");
    }
  });
});

// ─── enqueue idempotency layer 2: live recovery-pass worker ──────────────────

describe("enqueueDelegateIntent — live-worker idempotency", () => {
  test("a running recovery-pass worker with a live bg job no-ops with worker-live", () => {
    seedRecoveryPassSignal("CTL-1", "running", "bg-live-1");
    const r = enqueueDelegateIntent(
      "CTL-1",
      INTENT,
      deps({ isBgJobAlive: (id) => id === "bg-live-1" })
    );
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe("worker-live");
    expect(existsSync(intentPath("CTL-1"))).toBe(false); // never queued
  });

  test("a dispatched recovery-pass worker with a live bg job also no-ops", () => {
    seedRecoveryPassSignal("CTL-1", "dispatched", "bg-live-1");
    const r = enqueueDelegateIntent(
      "CTL-1",
      INTENT,
      deps({ isBgJobAlive: () => true })
    );
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe("worker-live");
  });

  test("a running worker whose bg job is DEAD does not block enqueue", () => {
    seedRecoveryPassSignal("CTL-1", "running", "bg-dead-1");
    const r = enqueueDelegateIntent(
      "CTL-1",
      INTENT,
      deps({ isBgJobAlive: () => false })
    );
    expect(r.enqueued).toBe(true);
  });

  test("a terminal recovery-pass worker (done) does not block enqueue", () => {
    seedRecoveryPassSignal("CTL-1", "done", "bg-live-1");
    const r = enqueueDelegateIntent(
      "CTL-1",
      INTENT,
      deps({ isBgJobAlive: () => true })
    );
    expect(r.enqueued).toBe(true);
  });
});

// ─── enqueue idempotency layer 3: hard ceiling ───────────────────────────────

describe("enqueueDelegateIntent — queue-full ceiling", () => {
  test("refuses to enqueue once countQueuedDelegates >= maxParallel", () => {
    const max = 3;
    mkdirSync(queueDir(), { recursive: true });
    for (let i = 0; i < max; i++) {
      writeFileSync(
        intentPath(`CTL-q${i}`),
        JSON.stringify({ schema: "delegate-intent/v1", ticket: `CTL-q${i}`, status: "queued" })
      );
    }
    const r = enqueueDelegateIntent("CTL-new", INTENT, deps({ maxParallel: max }));
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe("queue-full");
    expect(existsSync(intentPath("CTL-new"))).toBe(false);
  });

  test("launched/failed intents do NOT count toward the ceiling (only queued|claimed)", () => {
    const max = 2;
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(
      intentPath("CTL-launched"),
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-launched", status: "launched" })
    );
    writeFileSync(
      intentPath("CTL-failed"),
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-failed", status: "failed" })
    );
    // 0 queued|claimed → below ceiling → enqueue allowed
    const r = enqueueDelegateIntent("CTL-new", INTENT, deps({ maxParallel: max }));
    expect(r.enqueued).toBe(true);
  });

  test("maxParallel as a function source is honored", () => {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(
      intentPath("CTL-q0"),
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-q0", status: "queued" })
    );
    const r = enqueueDelegateIntent("CTL-new", INTENT, deps({ maxParallel: () => 1 }));
    expect(r.enqueued).toBe(false);
    expect(r.reason).toBe("queue-full");
  });
});

// ─── countQueuedDelegates ────────────────────────────────────────────────────

describe("countQueuedDelegates — counts only queued|claimed", () => {
  test("empty / missing queue dir → 0 (zero behavior change baseline)", () => {
    expect(countQueuedDelegates(orchDir)).toBe(0);
  });

  test("counts queued and claimed, excludes launched/failed/superseded", () => {
    mkdirSync(queueDir(), { recursive: true });
    const seed = (t, status) =>
      writeFileSync(intentPath(t), JSON.stringify({ schema: "delegate-intent/v1", ticket: t, status }));
    seed("CTL-a", "queued");
    seed("CTL-b", "claimed");
    seed("CTL-c", "launched");
    seed("CTL-d", "failed");
    seed("CTL-e", "superseded");
    seed("CTL-f", "queued");
    expect(countQueuedDelegates(orchDir)).toBe(3); // a, b, f
  });

  test("ignores claim sidecar files and malformed json", () => {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(intentPath("CTL-a"), JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-a", status: "queued" }));
    writeFileSync(join(queueDir(), "CTL-b.json.claimed-123-456"), "{}");
    writeFileSync(join(queueDir(), "CTL-c.json"), "not json {");
    expect(countQueuedDelegates(orchDir)).toBe(1);
  });
});

// ─── gcDelegateIntents ───────────────────────────────────────────────────────

describe("gcDelegateIntents — removal & retention", () => {
  function seedIntent(t, fields) {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(
      intentPath(t),
      JSON.stringify({ schema: "delegate-intent/v1", ticket: t, enqueuedAt: FIXED_NOW, ...fields })
    );
  }

  test("removes an intent whose worker reached a terminal phase-recovery-pass.json", () => {
    seedIntent("CTL-done", { status: "launched", bg_job_id: "bg-x", launchedAt: FIXED_NOW });
    seedRecoveryPassSignal("CTL-done", "done", "bg-x");
    const removed = gcDelegateIntents(orchDir, FIXED_NOW, deps({ isBgJobAlive: () => true }));
    expect(removed).toBe(1);
    expect(existsSync(intentPath("CTL-done"))).toBe(false);
  });

  test("removes a launched intent whose bg_job_id is dead", () => {
    seedIntent("CTL-dead", { status: "launched", bg_job_id: "bg-dead", launchedAt: FIXED_NOW });
    const removed = gcDelegateIntents(orchDir, FIXED_NOW, deps({ isBgJobAlive: () => false }));
    expect(removed).toBe(1);
    expect(existsSync(intentPath("CTL-dead"))).toBe(false);
  });

  test("removes any intent older than the TTL regardless of status", () => {
    seedIntent("CTL-old", { status: "queued", enqueuedAt: FIXED_NOW - 2_000_000 });
    const removed = gcDelegateIntents(
      orchDir,
      FIXED_NOW,
      deps({ ttlMs: 1_800_000 })
    );
    expect(removed).toBe(1);
    expect(existsSync(intentPath("CTL-old"))).toBe(false);
  });

  test("RETAINS a live queued intent (within TTL, no worker yet)", () => {
    seedIntent("CTL-live", { status: "queued", enqueuedAt: FIXED_NOW });
    const removed = gcDelegateIntents(orchDir, FIXED_NOW, deps());
    expect(removed).toBe(0);
    expect(existsSync(intentPath("CTL-live"))).toBe(true);
  });

  test("RETAINS a launched intent whose bg job is still alive and within TTL", () => {
    seedIntent("CTL-running", { status: "launched", bg_job_id: "bg-live", launchedAt: FIXED_NOW });
    const removed = gcDelegateIntents(
      orchDir,
      FIXED_NOW,
      deps({ isBgJobAlive: (id) => id === "bg-live" })
    );
    expect(removed).toBe(0);
    expect(existsSync(intentPath("CTL-running"))).toBe(true);
  });

  test("RETAINS a claimed intent (mid-flight, no bg job yet, within TTL)", () => {
    seedIntent("CTL-claimed", { status: "claimed", enqueuedAt: FIXED_NOW });
    const removed = gcDelegateIntents(orchDir, FIXED_NOW, deps());
    expect(removed).toBe(0);
    expect(existsSync(intentPath("CTL-claimed"))).toBe(true);
  });

  test("default TTL is 1_800_000ms when none injected", () => {
    seedIntent("CTL-justover", { status: "queued", enqueuedAt: FIXED_NOW - 1_800_001 });
    seedIntent("CTL-justunder", { status: "queued", enqueuedAt: FIXED_NOW - 1_799_999 });
    const removed = gcDelegateIntents(orchDir, FIXED_NOW, deps());
    expect(removed).toBe(1);
    expect(existsSync(intentPath("CTL-justover"))).toBe(false);
    expect(existsSync(intentPath("CTL-justunder"))).toBe(true);
  });

  test("empty / missing queue dir → 0 removed, no throw", () => {
    expect(gcDelegateIntents(orchDir, FIXED_NOW, deps())).toBe(0);
  });
});

// ─── claim single-flight ─────────────────────────────────────────────────────

describe("claimIntent — O_EXCL single-flight", () => {
  function seedQueued(t) {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(
      intentPath(t),
      JSON.stringify({ schema: "delegate-intent/v1", ticket: t, status: "queued", enqueuedAt: FIXED_NOW })
    );
  }

  test("a single claim succeeds and renames the intent file away", () => {
    seedQueued("CTL-1");
    const r = claimIntent(orchDir, "CTL-1", 111, FIXED_NOW);
    expect(r.claimed).toBe(true);
    expect(existsSync(intentPath("CTL-1"))).toBe(false); // original gone (renamed)
    expect(r.claimPath).toContain("CTL-1.json.claimed-111-");
    expect(existsSync(r.claimPath)).toBe(true);
  });

  test("a second concurrent claim of the same intent LOSES (rename source gone)", () => {
    seedQueued("CTL-1");
    const first = claimIntent(orchDir, "CTL-1", 111, FIXED_NOW);
    const second = claimIntent(orchDir, "CTL-1", 222, FIXED_NOW);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
  });

  test("claiming a non-existent intent loses cleanly", () => {
    const r = claimIntent(orchDir, "CTL-nope", 111, FIXED_NOW);
    expect(r.claimed).toBe(false);
  });
});

// ─── transitionIntent ────────────────────────────────────────────────────────

describe("transitionIntent — persist status changes", () => {
  test("flips a claimed sidecar to launched + records bg_job_id/worktreePath/launchedAt", () => {
    mkdirSync(queueDir(), { recursive: true });
    const claimPath = join(queueDir(), "CTL-1.json.claimed-111-222");
    writeFileSync(
      claimPath,
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-1", status: "claimed", enqueuedAt: FIXED_NOW })
    );
    const r = transitionIntent(orchDir, "CTL-1", {
      from: claimPath,
      status: "launched",
      bg_job_id: "bg-9",
      worktreePath: "/wt/CTL-1",
      launchedAt: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
    const intent = readIntent("CTL-1"); // back to canonical <TICKET>.json
    expect(intent.status).toBe("launched");
    expect(intent.bg_job_id).toBe("bg-9");
    expect(intent.worktreePath).toBe("/wt/CTL-1");
    expect(intent.launchedAt).toBe(FIXED_NOW);
    expect(existsSync(claimPath)).toBe(false); // sidecar consumed
  });

  test("marks a failed transition with a reason", () => {
    mkdirSync(queueDir(), { recursive: true });
    const claimPath = join(queueDir(), "CTL-2.json.claimed-1-2");
    writeFileSync(
      claimPath,
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-2", status: "claimed" })
    );
    const r = transitionIntent(orchDir, "CTL-2", {
      from: claimPath,
      status: "failed",
      reason: "dispatch-error",
    });
    expect(r.ok).toBe(true);
    const intent = readIntent("CTL-2");
    expect(intent.status).toBe("failed");
    expect(intent.reason).toBe("dispatch-error");
  });
});

// ─── reclaimStaleClaims ──────────────────────────────────────────────────────

describe("reclaimStaleClaims — renames a stale claimed-* back to queued", () => {
  test("a claimed-* older than the ceiling window is reclaimed to <TICKET>.json queued", () => {
    mkdirSync(queueDir(), { recursive: true });
    const staleTs = FIXED_NOW - 1_000_000; // > 900_000 default
    const claimPath = join(queueDir(), `CTL-1.json.claimed-999-${staleTs}`);
    writeFileSync(
      claimPath,
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-1", status: "claimed", enqueuedAt: staleTs })
    );
    const reclaimed = reclaimStaleClaims(orchDir, FIXED_NOW);
    expect(reclaimed).toBe(1);
    expect(existsSync(claimPath)).toBe(false);
    expect(existsSync(intentPath("CTL-1"))).toBe(true);
    expect(readIntent("CTL-1").status).toBe("queued");
  });

  test("a fresh claimed-* (within the window) is left alone", () => {
    mkdirSync(queueDir(), { recursive: true });
    const freshTs = FIXED_NOW - 1_000; // well within 900_000
    const claimPath = join(queueDir(), `CTL-1.json.claimed-999-${freshTs}`);
    writeFileSync(
      claimPath,
      JSON.stringify({ schema: "delegate-intent/v1", ticket: "CTL-1", status: "claimed" })
    );
    const reclaimed = reclaimStaleClaims(orchDir, FIXED_NOW);
    expect(reclaimed).toBe(0);
    expect(existsSync(claimPath)).toBe(true);
    expect(existsSync(intentPath("CTL-1"))).toBe(false);
  });

  test("the ceiling window is injectable (ceilingMs)", () => {
    mkdirSync(queueDir(), { recursive: true });
    const ts = FIXED_NOW - 5_000;
    const claimPath = join(queueDir(), `CTL-1.json.claimed-1-${ts}`);
    writeFileSync(claimPath, JSON.stringify({ ticket: "CTL-1", status: "claimed" }));
    expect(reclaimStaleClaims(orchDir, FIXED_NOW, 1_000)).toBe(1); // 5s > 1s ceiling
    expect(readIntent("CTL-1").status).toBe("queued");
  });

  test("empty / missing queue dir → 0, no throw", () => {
    expect(reclaimStaleClaims(orchDir, FIXED_NOW)).toBe(0);
  });
});
