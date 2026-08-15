// phase-yield-e2e.test.mjs — CTL-1854: the whole path, end to end, no mocks of it.
//
// Run: cd plugins/dev/scripts/execution-core && bun test phase-yield-e2e.test.mjs
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Three defects on this ticket shared one shape: **the path existed but did not
// run, or did not mean what it said.**
//
//   1. The expiry branch referenced a variable declared later in the function.
//      Every call threw a TDZ ReferenceError that a best-effort `catch` swallowed,
//      so expiry NEVER RAN — past a green unit test AND a passing mutation control,
//      because that test asserted the branch's SOURCE ORDER rather than executing it.
//   2. countYieldedOccupancy returned a bare number, so "no yields" and "could not
//      look" were byte-identical to four callers that subtract it from maxParallel.
//   3. The fix for (2) scanned CTL-702's `phase-*-yield-*.json` AUDIT TOMBSTONES —
//      an unrelated mechanism sharing the word "yield" — so one torn tombstone
//      would have held fleet admission closed forever.
//
// A test that never executes the path proves the path exists, not that it works.
// So this file drives the REAL artifacts: the real bash emitter writes the yield,
// a real clock is advanced past the ceiling, the real expiry evaluator runs over a
// real signal directory, and the real occupancy reader is asked what freed. The
// only injected thing is time — which is the one input a test may not wait for.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expireYieldedSignals } from "./scheduler.mjs";
import { countYieldedOccupancy } from "./signal-reader.mjs";
import { MAX_YIELD_MS, YIELD_EXPIRED_REASON, YIELDED_STATUS } from "../lib/phase-yield.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT = join(HERE, "..", "phase-agent-emit-complete");

function scenario() {
  const orch = mkdtempSync(join(tmpdir(), "yield-e2e-"));
  mkdirSync(join(orch, "workers", "PROJ-1"), { recursive: true });
  mkdirSync(join(orch, "events"), { recursive: true });
  writeFileSync(
    join(orch, "workers", "PROJ-1", "phase-implement.json"),
    JSON.stringify({ ticket: "PROJ-1", phase: "implement", status: "running" })
  );
  return orch;
}
const signalOf = (orch) =>
  JSON.parse(readFileSync(join(orch, "workers", "PROJ-1", "phase-implement.json"), "utf8"));

// The REAL emitter, as an agent would invoke it.
function declareYield(orch, extraArgs = []) {
  return execFileSync(
    "bash",
    [EMIT, "--phase", "implement", "--ticket", "PROJ-1", "--status", "yield", "--orch-dir", orch, ...extraArgs],
    { env: { ...process.env, CATALYST_DIR: orch }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

describe("CTL-1854 end to end: declare → hold → expire", () => {
  test("the real emitter writes a real yield, and it holds exactly one slot", () => {
    const orch = scenario();
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true }); // control
    declareYield(orch);
    const sig = signalOf(orch);
    expect(sig.status).toBe(YIELDED_STATUS);
    expect(typeof sig.yieldedAt).toBe("string");
    expect(sig.completedAt).toBeUndefined(); // non-terminal
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });
  });

  test("⚠️ THE WHOLE PATH: a live yield survives a tick; an expired one does not", () => {
    const orch = scenario();
    declareYield(orch);

    // Advance a real injected clock, rather than sleeping. `expireYieldedSignals`
    // runs the REAL evaluator over the REAL directory — this is the step whose
    // absence went unnoticed for four rounds.
    const realNow = Date.now;
    try {
      // (a) Inside the deadline: the tick must leave it alone.
      globalThis.Date.now = () => realNow() + 60_000;
      expireYieldedSignals(orch);
      expect(signalOf(orch).status).toBe(YIELDED_STATUS);
      expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });

      // (b) Past the ceiling: the tick must write the terminal.
      globalThis.Date.now = () => realNow() + MAX_YIELD_MS + 60_000;
      expireYieldedSignals(orch);
    } finally {
      globalThis.Date.now = realNow;
    }

    const sig = signalOf(orch);
    expect(sig).toMatchObject({
      status: "failed",
      outcome: "abandoned",
      failureReason: YIELD_EXPIRED_REASON,
    });
    // ...and the slot it was holding is freed by exactly one.
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true });
  });

  test("a CTL-702 tombstone in the same dir affects neither the hold nor the expiry", () => {
    // The name collision that nearly stalled fleet dispatch: these files share the
    // word "yield" and are audit artifacts, not lifecycle signals.
    const orch = scenario();
    declareYield(orch);
    writeFileSync(join(orch, "workers", "PROJ-1", "phase-implement-yield-deadbeef.json"), "{tor");
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });

    const realNow = Date.now;
    try {
      globalThis.Date.now = () => realNow() + MAX_YIELD_MS + 60_000;
      expireYieldedSignals(orch);
    } finally {
      globalThis.Date.now = realNow;
    }
    expect(signalOf(orch).failureReason).toBe(YIELD_EXPIRED_REASON);
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true });
  });

  test("⚠️ a torn REAL signal reports could-not-look, not an empty slot", () => {
    // Defect 2 of the three: occupancy returned a bare number, so an unreadable
    // signal read as ZERO — i.e. as free capacity — to four callers that subtract
    // it from maxParallel. The tombstone case above proves the exclusion did not
    // become a blanket "ignore anything unparseable"; this proves the fail-closed
    // half is still armed for the files that matter.
    const orch = scenario();
    declareYield(orch);
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true }); // control
    writeFileSync(join(orch, "workers", "PROJ-1", "phase-implement.json"), '{"status":"awaiting-w');
    const out = countYieldedOccupancy(orch);
    expect(out.ok).toBe(false);
    expect(out.count).toBe(0);
    // The pair (count 0, ok false) is what lets every caller hold admission; a bare
    // 0 would be indistinguishable from "no yields outstanding".
  });

  test("a short --yield-seconds expires on ITS deadline, through the real emitter", () => {
    const orch = scenario();
    declareYield(orch, ["--yield-seconds", "60"]);
    expect(signalOf(orch).yieldMs).toBe(60_000);

    const realNow = Date.now;
    try {
      globalThis.Date.now = () => realNow() + 30_000;
      expireYieldedSignals(orch);
      expect(signalOf(orch).status).toBe(YIELDED_STATUS); // still inside 60s
      globalThis.Date.now = () => realNow() + 90_000;
      expireYieldedSignals(orch);
    } finally {
      globalThis.Date.now = realNow;
    }
    expect(signalOf(orch).failureReason).toBe(YIELD_EXPIRED_REASON);
  });

  test("the emitter REFUSES a yield it cannot record, and publishes no event", () => {
    // ⚠️ THIS ASSERTION USED TO BE VACUOUS — a check that cannot fail, inside the
    // gate built to catch checks that cannot fail. It shelled out with stderr
    // discarded and `|| true`, so a broken glob, a never-created log, or any error
    // produced the expected empty output; and it substring-searched structured
    // JSON, so an unrelated field could satisfy it.
    //
    // Now: read the log directly, parse each line, and match the EVENT NAME field.
    // A POSITIVE CONTROL runs first — a successful yield must produce exactly one
    // such event — so the later zero is evidence that nothing was emitted rather
    // than evidence that nothing can be observed.
    const yieldEvents = (orch) => {
      const dir = join(orch, "events");
      if (!existsSync(dir)) return null; // cannot observe — distinct from zero
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      if (files.length === 0) return null;
      let n = 0;
      for (const f of files) {
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          const name = ev?.attributes?.["event.name"] ?? ev?.event ?? ev?.name ?? "";
          if (name === "phase.implement.yield.PROJ-1") n += 1;
        }
      }
      return n;
    };

    // POSITIVE CONTROL: a real yield emits exactly one such event.
    const okOrch = scenario();
    declareYield(okOrch);
    expect(yieldEvents(okOrch)).toBe(1);

    // Now the negative: a refused yield emits none — and the instrument above is
    // proven capable of returning non-zero.
    const orch = scenario();
    writeFileSync(
      join(orch, "workers", "PROJ-1", "phase-implement.json"),
      JSON.stringify({ ticket: "PROJ-1", phase: "implement", status: "done" })
    );
    expect(() => declareYield(orch)).toThrow(); // non-zero exit
    expect(signalOf(orch).status).toBe("done"); // completed phase preserved
    expect(yieldEvents(orch) ?? 0).toBe(0);
  });
});

describe("⚠️ a supported wait is not an anomaly", () => {
  // The stalled detector's cutoff is 15 minutes; a yield may live for 30, and its
  // worker has intentionally exited so nothing refreshes `updatedAt`. Reporting a
  // valid 15–30 minute yield as `stalled` is a FALSE attention, and a detector
  // that cries wolf on a supported state is worse than one that stays quiet.
  test("a live yield raises no stalled attention; an expired one still does", async () => {
    const { detectStalled } = await import("./stalled-detector.mjs");
    const now = Date.now();
    const at = (min) => ({
      currentStatus: YIELDED_STATUS,
      updatedAtMs: now - min * 60_000,
      nowMs: now,
      signal: { status: YIELDED_STATUS, yieldedAt: new Date(now - min * 60_000).toISOString() },
    });
    // Inside the ceiling — silent, even past the 15-minute staleness cutoff.
    expect(detectStalled(at(5)).attention).toBeNull();
    expect(detectStalled(at(20)).attention).toBeNull();
    // Past it — the exemption ends with the deadline, so a genuinely stuck ticket
    // is still reported rather than hidden forever by the status.
    expect(detectStalled(at(45)).attention).toMatchObject({ kind: "stalled" });
    // Control: an ordinary stale worker is unaffected by any of this.
    expect(detectStalled({ currentStatus: "running", updatedAtMs: now - 45 * 60_000, nowMs: now }).attention)
      .toMatchObject({ kind: "stalled" });
  });

  test("⚠️ the PRODUCTION input shape — no hand-built signal — still reports", () => {
    // The first cut of the exemption asked `!classifyYield(...).expired`, which is
    // TRUE when the classifier says "not a yield at all". The real adapter supplies
    // `currentStatus` (not `status`) and no anchors, so the classifier saw no yield,
    // the exemption applied unconditionally, and EVERY awaiting-work signal was
    // hidden forever — a permanent blindfold, strictly worse than the false
    // attention it replaced. My test passed only because it hand-built inputs that
    // production never produces.
    const { detectStalled } = require("./stalled-detector.mjs");
    const now = Date.now();
    const legacyShape = {
      ticket: "T", nowMs: now, updatedAtMs: now - 45 * 60_000,
      currentStatus: YIELDED_STATUS, prState: "NONE", commitCount: 0,
    };
    // No `signal` key at all: the exemption must NOT be granted.
    expect(detectStalled(legacyShape).attention).toMatchObject({ kind: "stalled" });
  });
});


describe("⚠️ round 22: terminals a yield must not overwrite", () => {
  test("turn-cap-exhausted is refused, like every other terminal", () => {
    const orch = scenario();
    writeFileSync(
      join(orch, "workers", "PROJ-1", "phase-implement.json"),
      JSON.stringify({ ticket: "PROJ-1", phase: "implement", status: "turn-cap-exhausted" })
    );
    expect(() => declareYield(orch)).toThrow();
    expect(signalOf(orch).status).toBe("turn-cap-exhausted");
  });

  test("EVERY codex post-launch terminal writer is generation-fenced", async () => {
    // Fencing one writer in a family of three is not fencing the family: the
    // auth-park and rate-park siblings RETURN BEFORE the failed branch, so the
    // first cut left two paths through which an old generation could overwrite a
    // newer generation's live yield. One computation now guards all three.
    const src = await Bun.file(new URL("./codex-run-phase-agent.mjs", import.meta.url)).text();
    expect(src).toContain("const _staleGeneration =");
    // Each post-launch writer must sit behind it. Counted, so a NEW unfenced
    // writer added later fails this rather than slipping in beside them.
    const guarded = (src.match(/if \(!_staleGeneration/g) ?? []).length;
    expect(guarded).toBe(3);
  });

  test("structurally invalid signals are inconclusive, not a confident zero", async () => {
    // `{}` and `null` are valid JSON. Validating parseability without structure
    // let a record that says nothing read as "no yield here" — the same fail-open
    // shape one level in from the torn-file case.
    const { countYieldedOccupancy } = await import("./signal-reader.mjs");
    const orch = mkdtempSync(join(tmpdir(), "yieldstruct-"));
    mkdirSync(join(orch, "workers", "PROJ-1"), { recursive: true });
    const p = join(orch, "workers", "PROJ-1", "phase-implement.json");
    writeFileSync(p, JSON.stringify({ status: YIELDED_STATUS, ticket: "PROJ-1", phase: "implement" }));
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true }); // control
    for (const bad of ["{}", "null", "[]", '"str"', "42", '{"status":123}']) {
      writeFileSync(p, bad);
      expect({ bad, ok: countYieldedOccupancy(orch).ok }).toEqual({ bad, ok: false });
    }
    // ...and a valid non-yield is still a CONCLUSIVE zero, so the check did not
    // simply become "everything is inconclusive".
    writeFileSync(p, JSON.stringify({ status: "running", ticket: "PROJ-1", phase: "implement" }));
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true });
  });

});

describe("⚠️ round 24: a record must be about the file it lives in", () => {
  test("identity mismatch is inconclusive; absent identity is tolerated", async () => {
    // A signal whose `phase` disagrees with its filename is not a signal about
    // this phase — counting it charges a slot to the wrong worker, or misses the
    // yield really holding one. Absent identity is fine (older signals omit it and
    // the path is authoritative); a PRESENT contradiction is corruption we cannot
    // interpret, so it gets the same verdict as unparseable.
    const { countYieldedOccupancy } = await import("./signal-reader.mjs");
    const orch = mkdtempSync(join(tmpdir(), "yieldident-"));
    mkdirSync(join(orch, "workers", "PROJ-1"), { recursive: true });
    const p = join(orch, "workers", "PROJ-1", "phase-implement.json");
    const w = (o) => writeFileSync(p, JSON.stringify(o));

    w({ status: YIELDED_STATUS, ticket: "PROJ-1", phase: "implement" });
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true }); // control
    w({ status: YIELDED_STATUS, ticket: "PROJ-1", phase: "review" });
    expect(countYieldedOccupancy(orch)).toMatchObject({ ok: false, reason: "signal-identity-mismatch" });
    w({ status: YIELDED_STATUS, ticket: "PROJ-9", phase: "implement" });
    expect(countYieldedOccupancy(orch)).toMatchObject({ ok: false, reason: "signal-identity-mismatch" });
    // Absent identity must NOT become inconclusive, or every legacy signal wedges
    // admission — the failure mode of over-tightening this check.
    w({ status: YIELDED_STATUS });
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true });
  });

  test("the bash ownership guards reject a statusless record", async () => {
    // `jq -e '.status // ""'` exits 0 on `{}` with an empty string, so the
    // fail-closed guard fell through and dispatched. Structure must be validated,
    // not just parseability — the same lesson as the JS occupancy reader.
    for (const f of ["orchestrate-auto-fixup", "orchestrate-auto-rebase"]) {
      const src = await Bun.file(new URL(`../${f}`, import.meta.url)).text();
      expect(src).toContain('(.status|type)=="string"');
      expect(src).toContain('.status != ""');
    }
  });
});

describe("⚠️ round 25: a yield with no identity in its JSON must still expire", () => {
  test("identity is derived from the path, so the hold cannot become permanent", () => {
    // Two individually reasonable choices combined into a permanent hold:
    // occupancy TOLERATED an absent ticket/phase (older signals omit them, and the
    // path is authoritative), while the expiry writer built its target FROM the
    // record — producing `workers//phase-.json`, which cannot exist. The yield was
    // counted forever and could never be cleared.
    const orch = mkdtempSync(join(tmpdir(), "yieldnoident-"));
    mkdirSync(join(orch, "workers", "PROJ-1"), { recursive: true });
    writeFileSync(
      join(orch, "workers", "PROJ-1", "phase-implement.json"),
      JSON.stringify({ status: YIELDED_STATUS, yieldedAt: "2020-01-01T00:00:00Z" }) // no ticket/phase
    );
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 1, ok: true }); // counted...
    expireYieldedSignals(orch);
    const sig = JSON.parse(readFileSync(join(orch, "workers", "PROJ-1", "phase-implement.json"), "utf8"));
    expect(sig).toMatchObject({ status: "failed", failureReason: YIELD_EXPIRED_REASON }); // ...and cleared
    expect(countYieldedOccupancy(orch)).toMatchObject({ count: 0, ok: true });
  });

  test("an empty --yield-seconds is rejected, not silently defaulted", () => {
    // `--yield-seconds "$WAIT"` with WAIT unset looked identical to the flag being
    // absent, so the emitter substituted the 30-minute ceiling for the caller's
    // intended bound and exited 0.
    const orch = scenario();
    expect(() => declareYield(orch, ["--yield-seconds", ""])).toThrow();
    expect(signalOf(orch).status).toBe("running"); // nothing written
    // Control: the flag genuinely ABSENT still succeeds and uses the ceiling.
    const orch2 = scenario();
    declareYield(orch2);
    expect(signalOf(orch2).status).toBe(YIELDED_STATUS);
    expect(signalOf(orch2).yieldMs).toBeUndefined();
  });
});
