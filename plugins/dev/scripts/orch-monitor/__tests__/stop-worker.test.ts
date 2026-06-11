// stop-worker.test.ts — unit coverage for the read-model's ONE destructive
// endpoint helper (CTL-890, BFF8 — the design's P10). Every collaborator is
// injected so nothing reads a real signal, spawns a real `claude`, or runs the
// real fence CLI. These tests encode the four Gherkin scenarios directly:
//   1. A confirmed stop terminates the worker.
//   2. Optimistic rollback on a flaky stop (the endpoint's `stopping` contract
//      + the stop-failed path the UI rolls back from).
//   3. A stale-generation node is fenced out (verified-stale → rejected).
//   4. Single-host stop is unaffected (fence-check is an identity no-op pass).
import { describe, it, expect } from "bun:test";
import {
  stopWorker,
  runFenceCheck,
  readClusterHostCount,
  claudeStop,
} from "../lib/stop-worker.mjs";

// A 36-char UUID and its 8-char short form (the `claude stop` target).
const FULL_UUID = "a1b2c3d4-0000-0000-0000-000000000000";
const SHORT_ID = "a1b2c3d4";

// A minimal verbatim phase signal as readPhaseSignalVerbatim returns it.
function signal(over: Record<string, unknown> = {}) {
  return {
    ticket: "CTL-845",
    phase: "implement",
    status: "working",
    bg_job_id: FULL_UUID,
    generation: 3,
    ...over,
  };
}

// Default injections: single-host (fence no-op), a successful stop.
function deps(over: Partial<Parameters<typeof stopWorker>[1]> = {}) {
  return {
    readSignal: () => Promise.resolve(signal()),
    fenceCheck: () => ({ ok: true, noop: true, stale: false }),
    stop: () => ({ ok: true }),
    ...over,
  };
}

describe("stopWorker — Scenario 1: a confirmed stop terminates the worker", () => {
  it("typed confirm matches → issues `claude stop <shortId>` and reports `stopping`", async () => {
    const stopped: string[] = [];
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({
        stop: (id: string) => {
          stopped.push(id);
          return { ok: true };
        },
      }),
    );
    expect(stopped).toEqual([SHORT_ID]);
    expect(res).toEqual({
      status: "stopping",
      ticket: "CTL-845",
      phase: "implement",
      shortId: SHORT_ID,
      fenceNoop: true,
    });
  });

  it("derives the 8-char shortId from a full-UUID bg_job_id (claude stop rejects UUIDs)", async () => {
    const stopped: string[] = [];
    await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({
        readSignal: () => Promise.resolve(signal({ bg_job_id: FULL_UUID })),
        stop: (id: string) => {
          stopped.push(id);
          return { ok: true };
        },
      }),
    );
    expect(stopped).toEqual([SHORT_ID]);
    expect(stopped[0]?.length).toBe(8);
  });

  it("an already-short bg_job_id passes through unchanged", async () => {
    const stopped: string[] = [];
    await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({
        readSignal: () => Promise.resolve(signal({ bg_job_id: SHORT_ID })),
        stop: (id: string) => {
          stopped.push(id);
          return { ok: true };
        },
      }),
    );
    expect(stopped).toEqual([SHORT_ID]);
  });
});

describe("stopWorker — typed-confirm gate", () => {
  it("a mismatched confirm is rejected WITHOUT issuing any stop", async () => {
    let stopCalled = false;
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-844" },
      deps({
        stop: () => {
          stopCalled = true;
          return { ok: true };
        },
      }),
    );
    expect(stopCalled).toBe(false);
    expect(res).toEqual({ status: "confirm_mismatch", expected: "CTL-845" });
  });

  it("a missing confirm is rejected", async () => {
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: undefined },
      deps(),
    );
    expect(res.status).toBe("confirm_mismatch");
  });
});

describe("stopWorker — no run / no live session", () => {
  it("a missing signal → not_found (nothing to stop)", async () => {
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({ readSignal: () => Promise.resolve(null) }),
    );
    expect(res).toEqual({ status: "not_found" });
  });

  it("a run with no bg_job_id → no_session, never a blind kill", async () => {
    let stopCalled = false;
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({
        readSignal: () => Promise.resolve(signal({ bg_job_id: null })),
        stop: () => {
          stopCalled = true;
          return { ok: true };
        },
      }),
    );
    expect(stopCalled).toBe(false);
    expect(res).toEqual({ status: "no_session", ticket: "CTL-845", phase: "implement" });
  });

  it("a run with an unparseable bg_job_id → no_session", async () => {
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({ readSignal: () => Promise.resolve(signal({ bg_job_id: "not-a-hex-id" })) }),
    );
    expect(res.status).toBe("no_session");
  });
});

describe("stopWorker — Scenario 2: optimistic rollback on a flaky stop", () => {
  it("`stopping` is the optimistic contract the UI marks before the rollback window", async () => {
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps(),
    );
    // The endpoint reports `stopping` + the exact identity; the UI arms its ~10s
    // timer and rolls back if the next board frame still shows the worker working.
    expect(res.status).toBe("stopping");
  });

  it("a `claude stop` failure surfaces as stop_failed (the UI rolls back from this too)", async () => {
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({ stop: () => ({ ok: false, error: "no such session" }) }),
    );
    expect(res).toEqual({
      status: "stop_failed",
      ticket: "CTL-845",
      phase: "implement",
      shortId: SHORT_ID,
      error: "no such session",
    });
  });
});

describe("stopWorker — Scenario 3: a stale-generation node is fenced out", () => {
  it("a verified-stale fence rejects the stop and does NOT kill the worker", async () => {
    let stopCalled = false;
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({
        // multi-host fence reports VERIFIED stale (CLI exit 10)
        fenceCheck: () => ({ ok: false, noop: false, stale: true }),
        stop: () => {
          stopCalled = true;
          return { ok: true };
        },
      }),
    );
    expect(stopCalled).toBe(false);
    expect(res).toEqual({
      status: "fenced",
      ticket: "CTL-845",
      phase: "implement",
      shortId: SHORT_ID,
    });
  });

  it("an indeterminate fence (CLI errored) refuses to kill — fail-closed", async () => {
    let stopCalled = false;
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({
        fenceCheck: () => ({ ok: false, noop: false, stale: false }),
        stop: () => {
          stopCalled = true;
          return { ok: true };
        },
      }),
    );
    expect(stopCalled).toBe(false);
    expect(res.status).toBe("fence_indeterminate");
  });
});

describe("stopWorker — Scenario 4: single-host stop is unaffected (fence no-op)", () => {
  it("single-host fence pass proceeds normally with fenceNoop:true", async () => {
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({ fenceCheck: () => ({ ok: true, noop: true, stale: false }) }),
    );
    expect(res.status).toBe("stopping");
    expect((res as { fenceNoop: boolean }).fenceNoop).toBe(true);
  });

  it("a multi-host CURRENT fence also proceeds, but fenceNoop:false", async () => {
    const res = await stopWorker(
      { ticket: "CTL-845", phase: "implement", confirm: "CTL-845" },
      deps({ fenceCheck: () => ({ ok: true, noop: false, stale: false }) }),
    );
    expect(res.status).toBe("stopping");
    expect((res as { fenceNoop: boolean }).fenceNoop).toBe(false);
  });
});

describe("runFenceCheck — single-host no-op vs multi-host CLI", () => {
  it("hostCount<=1 → identity no-op pass, NEVER spawns a subprocess", () => {
    let spawned = false;
    const out = runFenceCheck(
      { ticket: "CTL-845", generation: 3 },
      {
        hostCount: 1,
        spawn: () => {
          spawned = true;
          return { status: 0, stdout: "" };
        },
      },
    );
    expect(spawned).toBe(false);
    expect(out).toEqual({ ok: true, noop: true, stale: false });
  });

  it("hostCount=0 (degenerate roster) also treated as single-host no-op", () => {
    const out = runFenceCheck({ ticket: "CTL-845", generation: 3 }, { hostCount: 0 });
    expect(out.ok).toBe(true);
    expect(out.noop).toBe(true);
  });

  it("multi-host + fence CLI exit 0 → current (ok, not noop)", () => {
    const out = runFenceCheck(
      { ticket: "CTL-845", generation: 3 },
      { hostCount: 2, spawn: () => ({ status: 0, stdout: '{"current":true}\n' }) },
    );
    expect(out).toEqual({ ok: true, noop: false, stale: false });
  });

  it("multi-host + fence CLI exit 10 → verified stale", () => {
    const out = runFenceCheck(
      { ticket: "CTL-845", generation: 3 },
      { hostCount: 2, spawn: () => ({ status: 10, stdout: '{"current":false}\n' }) },
    );
    expect(out).toEqual({ ok: false, noop: false, stale: true });
  });

  it("multi-host + any other non-zero / spawn error → indeterminate (fail-closed)", () => {
    expect(
      runFenceCheck(
        { ticket: "CTL-845", generation: 3 },
        { hostCount: 2, spawn: () => ({ status: 1, stdout: "" }) },
      ),
    ).toEqual({ ok: false, noop: false, stale: false });
    expect(
      runFenceCheck(
        { ticket: "CTL-845", generation: 3 },
        { hostCount: 2, spawn: () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null }) },
      ),
    ).toEqual({ ok: false, noop: false, stale: false });
  });

  it("multi-host + a null generation can't be fence-checked → indeterminate, no spawn", () => {
    let spawned = false;
    const out = runFenceCheck(
      { ticket: "CTL-845", generation: null },
      {
        hostCount: 2,
        spawn: () => {
          spawned = true;
          return { status: 0, stdout: "" };
        },
      },
    );
    expect(spawned).toBe(false);
    expect(out).toEqual({ ok: false, noop: false, stale: false });
  });

  it("multi-host builds the right argv: node <cli> fence-check <ticket> <gen>", () => {
    const captured: { bin: string; args: readonly string[] }[] = [];
    runFenceCheck(
      { ticket: "CTL-845", generation: 3 },
      {
        hostCount: 2,
        nodeBin: "/usr/bin/node",
        cli: "/x/cluster-claim.mjs",
        spawn: (bin: string, args: readonly string[]) => {
          captured.push({ bin, args });
          return { status: 0, stdout: "" };
        },
      },
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.bin).toBe("/usr/bin/node");
    expect(captured[0]?.args).toEqual([
      "/x/cluster-claim.mjs",
      "fence-check",
      "CTL-845",
      "3",
    ]);
  });
});

describe("readClusterHostCount — single-host default", () => {
  it("an absent / unreadable hosts.json → single-host default of 1", () => {
    const out = readClusterHostCount({
      env: {},
      read: () => {
        throw new Error("ENOENT");
      },
    });
    expect(out).toBe(1);
  });

  it("a roster of one → 1", () => {
    const out = readClusterHostCount({
      env: { CATALYST_CONFIG_FILE: "/repo/.catalyst/config.json" },
      read: () => JSON.stringify(["mini"]),
    });
    expect(out).toBe(1);
  });

  it("a roster of three → 3", () => {
    const out = readClusterHostCount({
      env: { CATALYST_CONFIG_FILE: "/repo/.catalyst/config.json" },
      read: () => JSON.stringify(["mini", "mac-studio", "laptop"]),
    });
    expect(out).toBe(3);
  });

  it("a malformed / non-array roster → single-host default of 1", () => {
    expect(
      readClusterHostCount({ env: {}, read: () => "not json" }),
    ).toBe(1);
    expect(
      readClusterHostCount({ env: {}, read: () => JSON.stringify({ not: "an array" }) }),
    ).toBe(1);
    expect(
      readClusterHostCount({ env: {}, read: () => JSON.stringify([]) }),
    ).toBe(1);
    // an array of empties is filtered to zero valid hosts → 1
    expect(
      readClusterHostCount({ env: {}, read: () => JSON.stringify(["", null, 7]) }),
    ).toBe(1);
  });
});

describe("claudeStop — the kill primitive", () => {
  it("exit 0 → ok:true", () => {
    expect(claudeStop(SHORT_ID, { spawn: () => ({ status: 0 }) })).toEqual({ ok: true });
  });

  it("non-zero exit → ok:false with the stderr message", () => {
    expect(
      claudeStop(SHORT_ID, { spawn: () => ({ status: 1, stderr: "no such session" }) }),
    ).toEqual({ ok: false, error: "no such session" });
  });

  it("spawn throwing → ok:false, never propagates", () => {
    const res = claudeStop(SHORT_ID, {
      spawn: () => {
        throw new Error("EACCES");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("EACCES");
  });
});
