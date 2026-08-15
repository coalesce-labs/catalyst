// advance-idempotency.test.mjs — CTL-1805.
//
// The CI-STABLE proof of the advancement idempotency guard (A1) plus a distilled
// assertion of the A2 SDK-`done`-prelaunch no-op contract. The rich 13-tick CTL-56
// reproduction that drives the real schedulerTick lives in scheduler.test.mjs (the
// real-timer harness), which is deliberately EXCLUDED from CI for debounced-tick
// flakiness — so the load-bearing invariants that MUST fail CI on a regression are
// mirrored here as pure, deterministic helper + contract tests. Same discipline as
// in-flight-supersede.test.mjs / phantom-worker-dir.test.mjs.
//
// CI-INCLUDED (registered in .github/workflows/execution-core-tests.yml).
//
// Run: cd plugins/dev/scripts/execution-core && bun test advance-idempotency.test.mjs

import { afterAll, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAdvanceEdgeKey,
  advanceMarkerPath,
  isAdvanceAlreadyApplied,
  recordAdvanceApplied,
} from "./advance-guard.mjs";
import { verifyDispatchedSignal, NOOP_DONE_PRELAUNCH } from "./scheduler.mjs";

const tmpDirs = [];
function freshOrchDir() {
  const d = mkdtempSync(join(tmpdir(), "ctl1805-advguard-"));
  tmpDirs.push(d);
  mkdirSync(join(d, "workers", "CTL-56"), { recursive: true });
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ─── computeAdvanceEdgeKey — keyed on the PREDECESSOR'S IDENTITY, not the bare edge ───
describe("computeAdvanceEdgeKey", () => {
  const base = {
    ticket: "CTL-56",
    from: "monitor-merge",
    to: "monitor-deploy",
    predRaw: { generation: 1, updatedAt: "2026-08-12T05:18:36Z" },
  };

  test("is stable (byte-identical) for identical inputs — the replay case", () => {
    expect(computeAdvanceEdgeKey(base)).toBe(computeAdvanceEdgeKey({ ...base }));
  });

  test("DIFFERS when the predecessor generation differs — a legitimate re-advance", () => {
    const bumped = { ...base, predRaw: { ...base.predRaw, generation: 2 } };
    expect(computeAdvanceEdgeKey(bumped)).not.toBe(computeAdvanceEdgeKey(base));
  });

  test("DIFFERS when the predecessor updatedAt differs", () => {
    const restamped = { ...base, predRaw: { ...base.predRaw, updatedAt: "2026-08-12T05:19:00Z" } };
    expect(computeAdvanceEdgeKey(restamped)).not.toBe(computeAdvanceEdgeKey(base));
  });

  test("DIFFERS on the edge itself (from/to), not only the predecessor", () => {
    expect(computeAdvanceEdgeKey({ ...base, to: "teardown" })).not.toBe(
      computeAdvanceEdgeKey(base)
    );
    expect(computeAdvanceEdgeKey({ ...base, from: "pr" })).not.toBe(computeAdvanceEdgeKey(base));
  });

  test('null/undefined/empty fields render DISTINCTLY — no null==undefined=="" collision', () => {
    const nullGen = computeAdvanceEdgeKey({
      ...base,
      predRaw: { generation: null, updatedAt: "x" },
    });
    const undefGen = computeAdvanceEdgeKey({ ...base, predRaw: { updatedAt: "x" } });
    const nullPred = computeAdvanceEdgeKey({ ...base, predRaw: null });
    // null and undefined generation both render as the explicit ∅ token — the
    // guard treats "no generation recorded" as one identity, not two.
    expect(nullGen).toBe(undefGen);
    // But an EMPTY-string field must never collapse into a populated one.
    const emptyUpdatedAt = computeAdvanceEdgeKey({
      ...base,
      predRaw: { generation: 1, updatedAt: "" },
    });
    const realUpdatedAt = computeAdvanceEdgeKey({
      ...base,
      predRaw: { generation: 1, updatedAt: "2026-08-12T05:18:36Z" },
    });
    expect(emptyUpdatedAt).not.toBe(realUpdatedAt);
    // A wholly-absent predecessor is distinct from an edge with a real one.
    expect(nullPred).not.toBe(computeAdvanceEdgeKey(base));
  });
});

// ─── isAdvanceAlreadyApplied / recordAdvanceApplied — the durable marker round-trip ───
describe("advance marker round-trip", () => {
  const T = "CTL-56";
  const FROM = "monitor-merge";
  const TO = "monitor-deploy";
  const KEY = "CTL-56|monitor-merge|monitor-deploy|1|2026-08-12T05:18:36Z";

  test("absent marker → false (fail-open toward allowing the advance)", () => {
    const orchDir = freshOrchDir();
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, KEY)).toBe(false);
  });

  test("after record → true for the SAME key", () => {
    const orchDir = freshOrchDir();
    expect(recordAdvanceApplied(orchDir, T, FROM, TO, KEY)).toBe(true);
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, KEY)).toBe(true);
  });

  test("after record → false for a DIFFERENT key (stale marker does not suppress)", () => {
    const orchDir = freshOrchDir();
    recordAdvanceApplied(orchDir, T, FROM, TO, KEY);
    const bumpedKey = "CTL-56|monitor-merge|monitor-deploy|2|2026-08-12T05:20:00Z";
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, bumpedKey)).toBe(false);
  });

  test("re-record OVERWRITES the marker to the new key (rename, not O_EXCL)", () => {
    const orchDir = freshOrchDir();
    recordAdvanceApplied(orchDir, T, FROM, TO, KEY);
    const newKey = "CTL-56|monitor-merge|monitor-deploy|2|2026-08-12T05:20:00Z";
    expect(recordAdvanceApplied(orchDir, T, FROM, TO, newKey)).toBe(true);
    // old key no longer matches; new key does.
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, KEY)).toBe(false);
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, newKey)).toBe(true);
  });

  test("marker payload carries key/from/to/appliedAt", () => {
    const orchDir = freshOrchDir();
    recordAdvanceApplied(orchDir, T, FROM, TO, KEY);
    const parsed = JSON.parse(readFileSync(advanceMarkerPath(orchDir, T, FROM, TO), "utf8"));
    expect(parsed.key).toBe(KEY);
    expect(parsed.from).toBe(FROM);
    expect(parsed.to).toBe(TO);
    expect(typeof parsed.appliedAt).toBe("string");
  });

  test("corrupt (non-JSON) marker → false (fail-open)", () => {
    const orchDir = freshOrchDir();
    writeFileSync(advanceMarkerPath(orchDir, T, FROM, TO), "{not json");
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, KEY)).toBe(false);
  });

  test("unreadable marker (read throws) → false (fail-open)", () => {
    const orchDir = freshOrchDir();
    const throwingRead = () => {
      throw new Error("EIO");
    };
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, KEY, { readFileSync: throwingRead })).toBe(
      false
    );
  });

  test("record write failure → false, never throws (best-effort)", () => {
    const orchDir = freshOrchDir();
    const throwingWrite = () => {
      throw new Error("ENOSPC");
    };
    expect(recordAdvanceApplied(orchDir, T, FROM, TO, KEY, { writeFileSync: throwingWrite })).toBe(
      false
    );
    // and the guard still reports not-applied (no marker landed).
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, KEY)).toBe(false);
  });
});

// ─── Helper-level suppression: the exact discriminator the sweep relies on ───
describe("guard suppression discriminates a replay from a legitimate re-advance", () => {
  const T = "CTL-56";
  const FROM = "monitor-merge";
  const TO = "monitor-deploy";
  const predV1 = { generation: 1, updatedAt: "2026-08-12T05:18:36Z" };

  test("an UNCHANGED predecessor re-firing the same edge is suppressed", () => {
    const orchDir = freshOrchDir();
    const key = computeAdvanceEdgeKey({ ticket: T, from: FROM, to: TO, predRaw: predV1 });
    recordAdvanceApplied(orchDir, T, FROM, TO, key);
    // second tick, same on-disk predecessor → same key → suppressed.
    const key2 = computeAdvanceEdgeKey({ ticket: T, from: FROM, to: TO, predRaw: predV1 });
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, key2)).toBe(true);
  });

  test("a BUMPED predecessor generation is NOT suppressed (backward re-dispatch)", () => {
    const orchDir = freshOrchDir();
    const key = computeAdvanceEdgeKey({ ticket: T, from: FROM, to: TO, predRaw: predV1 });
    recordAdvanceApplied(orchDir, T, FROM, TO, key);
    const predV2 = { generation: 2, updatedAt: "2026-08-12T06:00:00Z" };
    const key2 = computeAdvanceEdgeKey({ ticket: T, from: FROM, to: TO, predRaw: predV2 });
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, key2)).toBe(false);
  });
});

// ─── Remediate-cycle disambiguation — proves NO REMEDIATE_CYCLE_FILES change needed ───
describe("verify⇄remediate re-entry: each cycle re-earns its advance", () => {
  test("two remediate→verify re-entries at generations 1 and 2 produce DIFFERENT keys", () => {
    const orchDir = freshOrchDir();
    const T = "CTL-56";
    const FROM = "remediate";
    const TO = "verify";
    // cycle 1: remediate gen 1 done → verify re-dispatched, marker recorded.
    const cycle1 = computeAdvanceEdgeKey({
      ticket: T,
      from: FROM,
      to: TO,
      predRaw: { generation: 1, updatedAt: "2026-08-12T05:00:00Z" },
    });
    recordAdvanceApplied(orchDir, T, FROM, TO, cycle1);
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, cycle1)).toBe(true);

    // cycle 2: verify failed again, remediate gen 2 done → a DIFFERENT predecessor
    // identity reusing the SAME .advance-remediate-to-verify.applied filename. It
    // must NOT be suppressed — the guard keys on predecessor identity, not the
    // edge alone, so no REMEDIATE_CYCLE_FILES entry is required.
    const cycle2 = computeAdvanceEdgeKey({
      ticket: T,
      from: FROM,
      to: TO,
      predRaw: { generation: 2, updatedAt: "2026-08-12T05:30:00Z" },
    });
    expect(isAdvanceAlreadyApplied(orchDir, T, FROM, TO, cycle2)).toBe(false);
  });
});

// ─── A2: SDK `done` prelaunch is a non-success NO-OP (distilled CI-stable mirror) ───
// The rich version lives in scheduler.test.mjs's verifyDispatchedSignal block; this
// is the assertion CI actually enforces, since scheduler.test.mjs is CI-excluded.
describe("verifyDispatchedSignal — SDK `done` prelaunch is a no-op, not a launch (A2)", () => {
  function writeSignal(orchDir, ticket, status) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket, phase: "research", status, bg_job_id: null })
    );
  }

  test("requireBgJob:false + `done` → { ok:false, reason:noop_done_prelaunch, noop:true }", () => {
    const orchDir = freshOrchDir();
    writeSignal(orchDir, "CTL-105", "done");
    expect(verifyDispatchedSignal(orchDir, "CTL-105", "research", { requireBgJob: false })).toEqual(
      {
        ok: false,
        reason: NOOP_DONE_PRELAUNCH,
        noop: true,
      }
    );
  });

  test("requireBgJob:false + in-flight (dispatched/running) stays ok:true (no demotion)", () => {
    const orchDir = freshOrchDir();
    for (const status of ["dispatched", "running"]) {
      const id = `CTL-105-${status}`;
      writeSignal(orchDir, id, status);
      const v = verifyDispatchedSignal(orchDir, id, "research", { requireBgJob: false });
      expect(v).toEqual({ ok: true });
      expect(v.noop).toBeUndefined();
    }
  });

  test("requireBgJob:true + `done` stays status_not_runnable (bg path unchanged)", () => {
    const orchDir = freshOrchDir();
    writeSignal(orchDir, "CTL-105-bg", "done");
    expect(verifyDispatchedSignal(orchDir, "CTL-105-bg", "research")).toEqual({
      ok: false,
      reason: "status_not_runnable",
    });
  });
});
