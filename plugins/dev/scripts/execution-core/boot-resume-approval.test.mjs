// boot-resume-approval.test.mjs — CTL-644. processApprovedResumes: dispatch
// gated tickets whose operator-approval sentinel exists.
//
// Run: cd plugins/dev/scripts/execution-core && bun test boot-resume-approval.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processApprovedResumes,
  bootResumePendingPath,
  bootResumeApprovedPath,
  listPendingApprovals,
  approveBootResume,
  surfaceStalePendingApprovals,
  BOOT_RESUME_PENDING_TTL_MS,
} from "./boot-resume.mjs";
import { readFileSync } from "node:fs";
import { defaultReviveDispatch } from "./recovery.mjs"; // CTL-1367 P1: real revive seam for the async-dispatch behavior test

let orchDir;
let prevCatalystDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "boot-resume-approval-"));
  // Keep the real defaultReviveDispatch's default lifecycle emits out of the
  // operator's ~/catalyst/events log when a test uses the real revive seam.
  prevCatalystDir = process.env.CATALYST_DIR;
  process.env.CATALYST_DIR = orchDir;
  mkdirSync(join(orchDir, "events"), { recursive: true });
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(orchDir, { recursive: true, force: true });
});

function writePendingMarker(dir, ticket, phase, worktreePath) {
  const workerDir = join(dir, "workers", ticket);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    bootResumePendingPath(dir, ticket),
    JSON.stringify({ ticket, phase, worktreePath, requestedAt: "2026-06-08T00:00:00Z" })
  );
}

function writeApprovedMarker(dir, ticket) {
  const workerDir = join(dir, "workers", ticket);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(bootResumeApprovedPath(dir, ticket), "");
}

function makeReviveDispatch(code = 0) {
  const calls = [];
  const fn = (...args) => { calls.push(args); return { code }; };
  fn.calls = calls;
  return fn;
}

describe("processApprovedResumes (CTL-644)", () => {
  test("approved gated ticket dispatches + clears both sentinels on success", () => {
    writePendingMarker(orchDir, "CTL-50", "implement", "/wt/CTL-50");
    writeApprovedMarker(orchDir, "CTL-50");

    const reviveDispatch = makeReviveDispatch(0);

    processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(1);
    expect(reviveDispatch.calls[0][0]).toMatchObject({ ticket: "CTL-50", phase: "implement" });

    // Both sentinels cleared
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-50"))).toBe(false);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-50"))).toBe(false);
  });

  // ── CTL-2192 remediation: the ADJACENT DOOR ──────────────────────────────
  //
  // reconcileBoot excludes tickets whose boot-time orphan reap could not be
  // confirmed. processApprovedResumes runs eight lines later in startDaemon and
  // used to dispatch on the two sentinels ALONE, so a ticket the line above had
  // just refused walked straight through here — "never dispatch beside an
  // unconfirmed orphan" held only on the path that was tested.
  test("⛔ an approved ticket whose orphan reap is UNCONFIRMED is NOT dispatched", () => {
    writePendingMarker(orchDir, "CTL-60", "implement", "/wt/CTL-60");
    writeApprovedMarker(orchDir, "CTL-60");

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
      reapFailedTickets: new Set(["CTL-60"]),
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res.dispatched).toBe(0);
    expect(res.reapBlocked).toBe(1);
    // BOTH sentinels retained: the approval is still valid, it is just not
    // actionable on this boot. Clearing them would silently DROP the resume.
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-60"))).toBe(true);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-60"))).toBe(true);
  });

  test("⛔ the block survives an UNREADABLE pending marker (checked before the read)", () => {
    // An unreadable marker must not mask the guard — otherwise a corrupt file
    // downgrades a safety refusal into an unrelated "skipping" warn.
    writePendingMarker(orchDir, "CTL-61", "implement", "/wt/CTL-61");
    writeFileSync(bootResumePendingPath(orchDir, "CTL-61"), "{not json");
    writeApprovedMarker(orchDir, "CTL-61");

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
      reapFailedTickets: new Set(["CTL-61"]),
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res.reapBlocked).toBe(1);
  });

  // ⛔ POSITIVE CONTROL. Without this the test above would pass just as well if
  // the guard had disabled approved-resume dispatch outright.
  test("positive control — a ticket NOT in the reap-failed set still dispatches", () => {
    writePendingMarker(orchDir, "CTL-62", "implement", "/wt/CTL-62");
    writeApprovedMarker(orchDir, "CTL-62");

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
      reapFailedTickets: new Set(["CTL-999"]), // a DIFFERENT ticket
    });

    expect(reviveDispatch.calls.map((c) => c[0].ticket)).toContain("CTL-62");
    expect(res.reapBlocked).toBe(0);
  });

  // ── CTL-2192 (Codex #3955 round 2 P1): the PER-TICK door ─────────────────
  //
  // The reapFailedTickets guard above only fires when a caller supplies the boot
  // verdict. The scheduler's per-tick call supplies nothing — and `startScheduler`
  // runs `runTick()` immediately as its "authoritative initial pass", so that
  // unguarded call happens on the SAME boot whose reap just failed. The boot pass
  // retains the approval; the first tick, moments later, dispatched it anyway.
  // The per-tick path therefore re-derives liveness itself.
  test("⛔ a LIVE sdk worker blocks the approval even with NO reapFailedTickets (the per-tick call)", () => {
    writePendingMarker(orchDir, "CTL-70", "implement", "/wt/CTL-70");
    writeApprovedMarker(orchDir, "CTL-70");

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
      // Exactly what scheduler.mjs passes: no boot verdict at all.
      sdkLiveness: () => ({ state: "live", reason: "orphan-child-alive", childPid: 4242 }),
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res.dispatched).toBe(0);
    expect(res.reapBlocked).toBe(1);
    // Deferred, not dropped — the approval stays valid for a later tick.
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-70"))).toBe(true);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-70"))).toBe(true);
  });

  // ⛔ POSITIVE CONTROL for the three cases below: without it they would pass
  // just as well if the oracle blocked unconditionally.
  test("positive control — a DEAD verdict dispatches (the orphan really is gone)", () => {
    writePendingMarker(orchDir, "CTL-71", "implement", "/wt/CTL-71");
    writeApprovedMarker(orchDir, "CTL-71");

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
      sdkLiveness: () => ({ state: "dead", reason: "orphan-child-dead", childPid: 4242 }),
    });

    expect(reviveDispatch.calls.map((c) => c[0].ticket)).toContain("CTL-71");
    expect(res.reapBlocked).toBe(0);
  });

  test("UNKNOWN does not block — a legacy projection must never strand an approval", () => {
    // The fail direction, and it matters more here than elsewhere: this is an
    // OPERATOR's approval. Blocking on `unknown` would hold every one of them on
    // a host whose projections predate child-pid discovery.
    writePendingMarker(orchDir, "CTL-72", "implement", "/wt/CTL-72");
    writeApprovedMarker(orchDir, "CTL-72");

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
      sdkLiveness: () => ({ state: "unknown", reason: "legacy-projection-no-child-record", childPid: null }),
    });

    expect(reviveDispatch.calls.map((c) => c[0].ticket)).toContain("CTL-72");
    expect(res.reapBlocked).toBe(0);
  });

  test("a THROWING oracle is unknown, not a block — it cannot wedge every approval", () => {
    writePendingMarker(orchDir, "CTL-73", "implement", "/wt/CTL-73");
    writeApprovedMarker(orchDir, "CTL-73");

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
      sdkLiveness: () => { throw new Error("ps exploded"); },
    });

    expect(reviveDispatch.calls.map((c) => c[0].ticket)).toContain("CTL-73");
    expect(res.reapBlocked).toBe(0);
  });

  // ⛔ WIRED, NOT MERELY DEFAULTED. Every case above injects the oracle, so all
  // of them would pass with the production default left unwired. This one injects
  // NOTHING and drives the real classifySdkWorkerLiveness off a projection on
  // disk — a dead daemon pid plus a childPid that is genuinely alive (our own),
  // which is precisely the `orphan-child-alive` shape a reapFailed orphan leaves.
  test("the real oracle is wired: an orphan-child-alive projection blocks the per-tick call", () => {
    writePendingMarker(orchDir, "CTL-74", "implement", "/wt/CTL-74");
    writeApprovedMarker(orchDir, "CTL-74");
    mkdirSync(join(orchDir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(orchDir, ".sdk-workers", "CTL-74.json"),
      JSON.stringify({
        ticket: "CTL-74",
        phase: "implement",
        worktreePath: "/wt/CTL-74",
        generation: 1,
        pid: 999999, // a daemon pid that is not running
        childPid: process.pid, // unambiguously alive
        childPidResolved: true,
        updatedAt: "2026-08-23T00:00:00Z",
      })
    );

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res.reapBlocked).toBe(1);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-74"))).toBe(true);
  });

  // ⛔ …and its control: the SAME real-oracle path, same projection shape, with
  // only the childPid changed to one that is not running. Without this, the test
  // above would pass just as well if the block came from the projection merely
  // EXISTING rather than from the child being alive.
  test("real-oracle control: the same projection with a DEAD childPid dispatches", () => {
    writePendingMarker(orchDir, "CTL-75", "implement", "/wt/CTL-75");
    writeApprovedMarker(orchDir, "CTL-75");
    mkdirSync(join(orchDir, ".sdk-workers"), { recursive: true });
    writeFileSync(
      join(orchDir, ".sdk-workers", "CTL-75.json"),
      JSON.stringify({
        ticket: "CTL-75",
        phase: "implement",
        worktreePath: "/wt/CTL-75",
        generation: 1,
        pid: 999999,
        childPid: 999998, // not running either → orphan-child-dead
        childPidResolved: true,
        updatedAt: "2026-08-23T00:00:00Z",
      })
    );

    const reviveDispatch = makeReviveDispatch(0);
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.map((c) => c[0].ticket)).toContain("CTL-75");
    expect(res.reapBlocked).toBe(0);
  });

  test("pending marker present but no approval sentinel — no dispatch, marker retained", () => {
    writePendingMarker(orchDir, "CTL-51", "review", "/wt/CTL-51");
    // No approved sentinel written

    const reviveDispatch = makeReviveDispatch(0);

    processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-51"))).toBe(true);
  });

  test("approval dispatch routes through reviveDispatch seam — same budget/storm guards as cheap path", () => {
    writePendingMarker(orchDir, "CTL-52", "verify", "/wt/CTL-52");
    writeApprovedMarker(orchDir, "CTL-52");

    // Use a tracking reviveDispatch that records its args — the point is
    // that processApprovedResumes must call reviveDispatch (not a raw
    // dispatch), so existing MAX_REVIVES and storm-breaker guards apply.
    const reviveDispatch = makeReviveDispatch(0);
    const rawDispatch = makeReviveDispatch(0);

    processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: rawDispatch,
      appendEvent: () => true,
    });

    // reviveDispatch is invoked; raw dispatch is NOT invoked directly.
    expect(reviveDispatch.calls.length).toBe(1);
    expect(rawDispatch.calls.length).toBe(0);
  });

  // CTL-1367 P1 + E2: with the REAL defaultReviveDispatch, an approved-resume routed
  // through an ASYNC (executor=sdk) dispatch must settle synchronously off the
  // prelaunch signal — counted dispatched, sentinels cleared — NOT recorded as a
  // failure because the dispatch returned a Promise. Proves the injected dispatch fn
  // actually drives the re-dispatch (behavior, not just param-passed) AND the E2
  // wiring (processApprovedResumes threads `dispatch` → reviveDispatch).
  test("an async (sdk) dispatch through the real reviveDispatch settles + clears sentinels", async () => {
    writePendingMarker(orchDir, "CTL-async", "implement", "/wt/CTL-async");
    writeApprovedMarker(orchDir, "CTL-async");
    // Seed the phase signal defaultReviveDispatch resets, then the async dispatch
    // synchronously re-writes it to dispatched (the SDK prelaunch) and returns a Promise.
    const signalPath = join(orchDir, "workers", "CTL-async", "phase-implement.json");
    writeFileSync(signalPath, JSON.stringify({ ticket: "CTL-async", phase: "implement", status: "running", bg_job_id: "bg-x" }));
    let resolveQuery;
    const queryDone = new Promise((res) => { resolveQuery = res; });
    const dispatch = () => {
      writeFileSync(signalPath, JSON.stringify({ ticket: "CTL-async", phase: "implement", status: "dispatched", bg_job_id: null }));
      return queryDone; // detached in-process query
    };
    const result = processApprovedResumes({
      orchDir,
      reviveDispatch: defaultReviveDispatch, // the REAL seam
      dispatch, // async (sdk-shaped)
      appendEvent: () => true,
    });
    expect(result.dispatched).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-async"))).toBe(false);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-async"))).toBe(false);
    resolveQuery({ code: 0 });
    await queryDone;
  });

  // CTL-639 verify: cover the dispatch-failure retry contract and the edge
  // paths the original 3 tests left untested.
  test("dispatch failure (code: 1) retains both sentinels and counts failed", () => {
    writePendingMarker(orchDir, "CTL-53", "implement", "/wt/CTL-53");
    writeApprovedMarker(orchDir, "CTL-53");

    const reviveDispatch = makeReviveDispatch(1); // non-zero → failure

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(res).toMatchObject({ dispatched: 0, failed: 1 });
    // Sentinels retained so the next tick retries.
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-53"))).toBe(true);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-53"))).toBe(true);
  });

  test("reviveDispatch throwing is caught and counted as a failure (sentinels retained)", () => {
    writePendingMarker(orchDir, "CTL-54", "review", "/wt/CTL-54");
    writeApprovedMarker(orchDir, "CTL-54");

    const reviveDispatch = () => { throw new Error("boom"); };

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(res).toMatchObject({ dispatched: 0, failed: 1 });
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-54"))).toBe(true);
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-54"))).toBe(true);
  });

  test("approved sentinel with an unreadable pending marker is skipped (no dispatch)", () => {
    const workerDir = join(orchDir, "workers", "CTL-55");
    mkdirSync(workerDir, { recursive: true });
    // Pending path is a present-but-corrupt JSON file; approval sentinel present.
    writeFileSync(bootResumePendingPath(orchDir, "CTL-55"), "{not valid json");
    writeApprovedMarker(orchDir, "CTL-55");

    const reviveDispatch = makeReviveDispatch(0);

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res).toMatchObject({ dispatched: 0, failed: 0 });
  });

  test("non-directory entries at the workers/ level are ignored", () => {
    // A stray file directly under workers/ must not be treated as a ticket dir
    // (guards the withFileTypes/isDirectory() filter, CTL-639 hardening).
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(join(orchDir, "workers", "stray.txt"), "not a ticket");

    const reviveDispatch = makeReviveDispatch(0);

    const res = processApprovedResumes({
      orchDir,
      reviveDispatch,
      dispatch: () => {},
      appendEvent: () => true,
    });

    expect(reviveDispatch.calls.length).toBe(0);
    expect(res).toMatchObject({ dispatched: 0, failed: 0 });
  });

  test("missing workers/ directory returns zero counts without throwing", () => {
    // orchDir exists but has no workers/ subdir yet.
    const res = processApprovedResumes({
      orchDir,
      reviveDispatch: makeReviveDispatch(0),
      dispatch: () => {},
      appendEvent: () => true,
    });
    expect(res).toMatchObject({ dispatched: 0, failed: 0 });
  });
});

// ─── CTL-1443 (P1-loop-3): the gate becomes operable — list / approve / expire ─
describe("boot-resume approval surfacing (CTL-1443)", () => {
  const writeGate = (ticket, phase, requestedAtMs) => {
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
    writeFileSync(
      bootResumePendingPath(orchDir, ticket),
      JSON.stringify({ ticket, phase, worktreePath: "/wt", requestedAt: new Date(requestedAtMs).toISOString() }),
    );
  };

  test("listPendingApprovals enumerates gates with age + approval state", () => {
    const now = Date.now();
    writeGate("OTL-41", "recovery-pass", now - 5 * 3600e3);
    writeGate("CTL-1", "implement", now - 1000);
    writeFileSync(bootResumeApprovedPath(orchDir, "CTL-1"), "");
    const gates = listPendingApprovals(orchDir, { now: () => now });
    const byTicket = Object.fromEntries(gates.map((g) => [g.ticket, g]));
    expect(byTicket["OTL-41"].phase).toBe("recovery-pass");
    expect(byTicket["OTL-41"].approved).toBe(false);
    expect(byTicket["OTL-41"].ageMs).toBeGreaterThan(4 * 3600e3);
    expect(byTicket["CTL-1"].approved).toBe(true);
  });

  test("approveBootResume writes the sentinel; refuses without a gate", () => {
    writeGate("OTL-41", "recovery-pass", Date.now());
    expect(approveBootResume(orchDir, "OTL-41")).toEqual({ approved: true });
    expect(existsSync(bootResumeApprovedPath(orchDir, "OTL-41"))).toBe(true);
    expect(approveBootResume(orchDir, "CTL-none").approved).toBe(false);
  });

  test("a stale gate surfaces ONCE: needs-human signal with a brief + alert + surfacedAt stamp", () => {
    const now = Date.now();
    writeGate("OTL-41", "recovery-pass", now - BOOT_RESUME_PENDING_TTL_MS - 1000);
    const alerts = [];
    const labels = [];
    const out = surfaceStalePendingApprovals({
      orchDir,
      now: () => now,
      emitAlert: (a) => alerts.push(a),
      labelNeedsHuman: (dir, t) => labels.push(t),
    });
    expect(out).toEqual(["OTL-41"]);
    // Codex P1: the needs-human LABEL is what deriveAttention keys on — the
    // signal explanation alone never reaches the Needs-You bucket.
    expect(labels).toEqual(["OTL-41"]);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "OTL-41", "phase-recovery-pass.json"), "utf8"),
    );
    expect(sig.status).toBe("stalled"); // terminal-sweep-owned label lifecycle (Codex R2)
    expect(sig.stalledReason).toBe("boot-resume-gate-expired");
    expect(sig.ticket).toBe("OTL-41");
    expect(sig.explanation.escalation_type).toBe("authorization");
    expect(sig.explanation.call_to_action).toContain("boot-resume-approve");
    expect(sig.worktreePath).toBe("/wt"); // Codex P2: preserved for the CTL-615 revive cross-check
    expect(alerts[0].identifier).toBe("OTL-41");
    // idempotent: the surfacedAt stamp suppresses a second surfacing
    const out2 = surfaceStalePendingApprovals({ orchDir, now: () => now, emitAlert: (a) => alerts.push(a), labelNeedsHuman: () => {} });
    expect(out2).toEqual([]);
    expect(alerts.length).toBe(1);
    // and approval still works after surfacing (marker retained)
    expect(approveBootResume(orchDir, "OTL-41")).toEqual({ approved: true });
  });

  test("fresh and approved gates are never surfaced", () => {
    const now = Date.now();
    writeGate("CTL-2", "implement", now - 1000); // fresh
    writeGate("CTL-3", "implement", now - BOOT_RESUME_PENDING_TTL_MS - 1000); // stale but approved
    writeFileSync(bootResumeApprovedPath(orchDir, "CTL-3"), "");
    expect(surfaceStalePendingApprovals({ orchDir, now: () => now, emitAlert: () => {}, labelNeedsHuman: () => {} })).toEqual([]);
  });

  test("processApprovedResumes runs the sweep (stale gate surfaces on the normal tick path)", () => {
    const now = Date.now();
    writeGate("CTL-4", "implement", now - BOOT_RESUME_PENDING_TTL_MS - 1000);
    const alerts = [];
    processApprovedResumes({
      orchDir,
      reviveDispatch: () => ({ code: 0 }),
      appendEvent: () => {},
      emitStaleGateAlert: (a) => alerts.push(a),
      staleGateLabelNeedsHuman: () => {},
    });
    expect(alerts.length).toBe(1);
    expect(alerts[0].identifier).toBe("CTL-4");
  });
});

describe("boot-resume approval lifetime (CTL-1443 Codex R2)", () => {
  test("classifyStalledTicket skips gate-expired parks (no unstuck re-ask loop)", async () => {
    const { classifyStalledTicket } = await import("./unstuck-sweep.mjs");
    // CTL-2158: the verdict now names WHY it is quiet ("already-escalated") and is
    // derived by stall-class.mjs rather than a hand-typed STALL_CATEGORY_MAP row —
    // see stall-class-wiring.test.mjs for the mutation proof. The guarded property
    // (a gate-expired park never re-enters the unstuck escalate path) is unchanged.
    expect(classifyStalledTicket({ reason: "boot-resume-gate-expired" })).toMatchObject({
      category: "skip",
      action: "skip",
    });
  });
});
