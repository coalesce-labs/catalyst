// respond-ticket.test.ts — unit coverage for the read-model's SECOND write
// endpoint helper (CTL-924, BFF12 — HOME5's Answer / Unblock verb). Every
// collaborator is injected so nothing reads a real worker dir, runs the real
// fence CLI, touches the real Linear API, or appends to the real event log. These
// tests encode the three Gherkin scenarios directly:
//   1. Answer/unblock records the response, clears the needs-human marker, and
//      emits the resume event that drives CTL-876's loop.
//   2. The mutation is fence-aware: a verified-stale generation is rejected and
//      NOTHING is mutated.
//   3. Single-host pass-through: the fence-check is an identity no-op and the
//      response is recorded normally.
import { describe, it, expect } from "bun:test";
import {
  respondTicket,
  findHeldRun,
  clearNeedsHumanMarker,
  recordResponse,
  buildResumeEvent,
  emitResumeEvent,
  eventLogPath,
} from "../lib/respond-ticket.mjs";

// A minimal held phase signal (status:"needs-input" is the parked predicate the
// daemon's handleCommentWake matches).
function heldSignal(over: Record<string, unknown> = {}) {
  return {
    ticket: "CTL-845",
    phase: "implement",
    status: "needs-input",
    generation: 3,
    ...over,
  };
}

// Default injections: a held implement run, single-host fence no-op, recording
// collaborators captured so assertions can confirm the side effects fired.
function deps(over: Partial<Parameters<typeof respondTicket>[1]> = {}) {
  return {
    findHeld: () => ({ phase: "implement", signal: heldSignal() }),
    fenceCheck: () => ({ ok: true, noop: true, stale: false }),
    record: () => undefined,
    clearMarker: () => undefined,
    emit: () => undefined,
    ...over,
  };
}

describe("respondTicket — Scenario 1: answer/unblock records the response and resumes", () => {
  it("typed confirm matches → records, clears the marker, emits the resume event, reports `resuming`", () => {
    const recorded: unknown[] = [];
    const cleared: unknown[] = [];
    const emitted: unknown[] = [];
    const res = respondTicket(
      { ticket: "CTL-845", response: "go ahead — the dep is merged", confirm: "CTL-845" },
      deps({
        record: (a) => recorded.push(a),
        clearMarker: (a) => cleared.push(a),
        emit: (a) => emitted.push(a),
      }),
    );
    expect(res).toEqual({
      status: "resuming",
      ticket: "CTL-845",
      phase: "implement",
      fenceNoop: true,
    });
    // The response is recorded with the parked phase + the operator's note.
    expect(recorded).toEqual([
      { ticket: "CTL-845", phase: "implement", response: "go ahead — the dep is merged" },
    ]);
    // The needs-human marker is cleared (re-arms the daemon's labelOnce guard).
    expect(cleared).toEqual([{ ticket: "CTL-845" }]);
    // The resume event (CTL-876 loop) is emitted carrying the operator's response.
    expect(emitted).toEqual([
      { ticket: "CTL-845", response: "go ahead — the dep is merged" },
    ]);
  });

  it("the three mutations fire IN ORDER: record → clear marker → emit resume", () => {
    const order: string[] = [];
    respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({
        record: () => order.push("record"),
        clearMarker: () => order.push("clear"),
        emit: () => order.push("emit"),
      }),
    );
    expect(order).toEqual(["record", "clear", "emit"]);
  });
});

describe("respondTicket — no held run", () => {
  it("no parked needs-input run for the ticket → not_held, NOTHING mutated", () => {
    let mutated = false;
    const res = respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({
        findHeld: () => null,
        record: () => {
          mutated = true;
        },
        clearMarker: () => {
          mutated = true;
        },
        emit: () => {
          mutated = true;
        },
      }),
    );
    expect(res).toEqual({ status: "not_held" });
    expect(mutated).toBe(false);
  });
});

describe("respondTicket — typed-confirm gate", () => {
  it("a mismatched confirm is rejected WITHOUT any mutation", () => {
    let mutated = false;
    const mark = () => {
      mutated = true;
    };
    const res = respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-844" },
      deps({ record: mark, clearMarker: mark, emit: mark }),
    );
    expect(res).toEqual({ status: "confirm_mismatch", expected: "CTL-845" });
    expect(mutated).toBe(false);
  });

  it("a missing confirm is rejected", () => {
    const res = respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: undefined },
      deps(),
    );
    expect(res.status).toBe("confirm_mismatch");
  });
});

describe("respondTicket — Scenario 2: the mutation is fence-aware", () => {
  it("a verified-stale fence (exit 10) rejects the response and mutates NOTHING", () => {
    let mutated = false;
    const mark = () => {
      mutated = true;
    };
    const res = respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({
        // multi-host fence reports VERIFIED stale (CLI exit 10)
        fenceCheck: () => ({ ok: false, noop: false, stale: true }),
        record: mark,
        clearMarker: mark,
        emit: mark,
      }),
    );
    expect(res).toEqual({ status: "fenced", ticket: "CTL-845", phase: "implement" });
    expect(mutated).toBe(false);
  });

  it("an indeterminate fence (CLI errored) refuses to mutate — fail-closed", () => {
    let mutated = false;
    const mark = () => {
      mutated = true;
    };
    const res = respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({
        fenceCheck: () => ({ ok: false, noop: false, stale: false }),
        record: mark,
        clearMarker: mark,
        emit: mark,
      }),
    );
    expect(res).toEqual({
      status: "fence_indeterminate",
      ticket: "CTL-845",
      phase: "implement",
    });
    expect(mutated).toBe(false);
  });

  it("fence-checks the held run signal's OWN generation", () => {
    const seen: (number | null)[] = [];
    respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({
        findHeld: () => ({ phase: "implement", signal: heldSignal({ generation: 7 }) }),
        fenceCheck: ({ generation }) => {
          seen.push(generation);
          return { ok: true, noop: false, stale: false };
        },
      }),
    );
    expect(seen).toEqual([7]);
  });

  it("a non-numeric generation is passed to the fence-check as null (multi-host fails closed there)", () => {
    const seen: (number | null)[] = [];
    respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({
        findHeld: () => ({ phase: "implement", signal: heldSignal({ generation: undefined }) }),
        fenceCheck: ({ generation }) => {
          seen.push(generation);
          return { ok: true, noop: true, stale: false };
        },
      }),
    );
    expect(seen).toEqual([null]);
  });
});

describe("respondTicket — Scenario 3: single-host pass-through (fence no-op)", () => {
  it("single-host fence pass records normally with fenceNoop:true", () => {
    const res = respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({ fenceCheck: () => ({ ok: true, noop: true, stale: false }) }),
    );
    expect(res.status).toBe("resuming");
    expect((res as { fenceNoop: boolean }).fenceNoop).toBe(true);
  });

  it("a multi-host CURRENT fence also resumes, but fenceNoop:false", () => {
    const res = respondTicket(
      { ticket: "CTL-845", response: "ok", confirm: "CTL-845" },
      deps({ fenceCheck: () => ({ ok: true, noop: false, stale: false }) }),
    );
    expect(res.status).toBe("resuming");
    expect((res as { fenceNoop: boolean }).fenceNoop).toBe(false);
  });
});

describe("findHeldRun — match stalled escalation runs (CTL-1067)", () => {
  it("returns the stalled run + its verbatim signal", () => {
    const out = findHeldRun("CTL-1067", {
      readDir: () => ["phase-research.json", "phase-implement.json"],
      read: (p: string) =>
        p.includes("research")
          ? JSON.stringify({ status: "done", phase: "research" })
          : JSON.stringify({
              status: "stalled",
              phase: "implement",
              stalledReason: "prior-artifact-retry-exhausted",
              generation: 4,
            }),
    });
    expect(out?.phase).toBe("implement");
    expect(out?.signal?.status).toBe("stalled");
  });

  it("prefers a needs-input run over a stalled one in PHASE_ORDER", () => {
    const out = findHeldRun("CTL-1067", {
      readDir: () => ["phase-research.json", "phase-implement.json"],
      read: (p: string) =>
        p.includes("research")
          ? JSON.stringify({ status: "needs-input", phase: "research" })
          : JSON.stringify({ status: "stalled", phase: "implement" }),
    });
    expect(out?.phase).toBe("research");
    expect(out?.signal?.status).toBe("needs-input");
  });
});

describe("respondTicket — CTL-1067 stalled run is answerable", () => {
  it("a stalled run is answerable — records, clears marker, emits, returns resuming", () => {
    const recorded: unknown[] = [], cleared: unknown[] = [], emitted: unknown[] = [];
    const out = respondTicket(
      { ticket: "CTL-1067", response: "looked into it, retry", confirm: "CTL-1067" },
      {
        findHeld: () => ({ phase: "implement", signal: { status: "stalled", phase: "implement", generation: 4 } }),
        fenceCheck: () => ({ ok: true, noop: true, stale: false }),
        record: (a) => recorded.push(a),
        clearMarker: (a) => cleared.push(a),
        emit: (a) => emitted.push(a),
      },
    );
    expect(out.status).toBe("resuming");
    expect((out as { phase: string }).phase).toBe("implement");
    expect(recorded).toEqual([{ ticket: "CTL-1067", phase: "implement", response: "looked into it, retry" }]);
    expect(cleared).toEqual([{ ticket: "CTL-1067" }]);
    expect(emitted).toEqual([{ ticket: "CTL-1067", response: "looked into it, retry" }]);
  });

  it("stalled run + wrong typed-confirm → confirm_mismatch, NO mutation", () => {
    const recorded: unknown[] = [], cleared: unknown[] = [], emitted: unknown[] = [];
    const out = respondTicket(
      { ticket: "CTL-1067", response: "x", confirm: "WRONG" },
      {
        findHeld: () => ({ phase: "implement", signal: { status: "stalled", phase: "implement" } }),
        fenceCheck: () => ({ ok: true, noop: true, stale: false }),
        record: (a) => recorded.push(a),
        clearMarker: (a) => cleared.push(a),
        emit: (a) => emitted.push(a),
      },
    );
    expect(out.status).toBe("confirm_mismatch");
    expect([recorded, cleared, emitted]).toEqual([[], [], []]);
  });
});

describe("findHeldRun — locate the parked needs-input run", () => {
  it("returns the held run + its verbatim signal", () => {
    const out = findHeldRun("CTL-845", {
      // only implement is parked; research is a finished (done) run
      readDir: () => ["phase-implement.json", "phase-research.json"],
      read: (p: string) =>
        p.includes("research")
          ? JSON.stringify({ status: "done", phase: "research" })
          : JSON.stringify({ status: "needs-input", phase: "implement", generation: 3 }),
    });
    expect(out?.phase).toBe("implement");
    expect(out?.signal?.status).toBe("needs-input");
  });

  it("returns null when no run is parked (status not needs-input)", () => {
    const out = findHeldRun("CTL-845", {
      readDir: () => ["phase-implement.json"],
      read: () => JSON.stringify({ status: "working", phase: "implement" }),
    });
    expect(out).toBeNull();
  });

  it("an absent worker dir → null (nothing held)", () => {
    const out = findHeldRun("CTL-845", {
      readDir: () => {
        throw new Error("ENOENT");
      },
    });
    expect(out).toBeNull();
  });

  it("resolves the FIRST held run in PHASE_ORDER when several are parked", () => {
    const out = findHeldRun("CTL-845", {
      // listed out of order on disk; PHASE_ORDER puts research before implement
      readDir: () => ["phase-implement.json", "phase-research.json"],
      read: (p: string) =>
        JSON.stringify({
          status: "needs-input",
          phase: p.includes("research") ? "research" : "implement",
        }),
    });
    expect(out?.phase).toBe("research");
  });

  it("skips an unparseable signal without throwing", () => {
    const out = findHeldRun("CTL-845", {
      readDir: () => ["phase-implement.json"],
      read: () => "{ not json",
    });
    expect(out).toBeNull();
  });
});

describe("clearNeedsHumanMarker — inverse of the daemon's labelOnce marker", () => {
  it("removes the .applied + .skipped once-markers and reports what was removed", () => {
    const removed: string[] = [];
    const out = clearNeedsHumanMarker(
      { ticket: "CTL-845" },
      {
        workersDir: "/w",
        rm: (p: string) => {
          removed.push(p);
        },
      },
    );
    expect(out).toEqual([
      "/w/CTL-845/.linear-label-needs-human.applied",
      "/w/CTL-845/.linear-label-needs-human.skipped",
    ]);
    expect(removed).toEqual(out);
  });

  it("an absent marker is best-effort (never throws), removes only what exists", () => {
    const out = clearNeedsHumanMarker(
      { ticket: "CTL-845" },
      {
        workersDir: "/w",
        rm: (p: string) => {
          if (p.endsWith(".skipped")) throw new Error("ENOENT");
        },
      },
    );
    expect(out).toEqual(["/w/CTL-845/.linear-label-needs-human.applied"]);
  });
});

describe("recordResponse — durable operator-answer artifact", () => {
  it("writes a .respond-<phase>.json record with the operator's note", () => {
    const writes: { path: string; data: string }[] = [];
    const out = recordResponse(
      { ticket: "CTL-845", phase: "implement", response: "unblocked: dep merged", now: new Date("2026-06-09T00:00:00Z") },
      {
        workersDir: "/w",
        write: (path: string, data: string) => writes.push({ path, data }),
        mkdir: () => undefined,
      },
    );
    expect(out.path).toBe("/w/CTL-845/.respond-implement.json");
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0].data) as Record<string, unknown>;
    expect(parsed.ticket).toBe("CTL-845");
    expect(parsed.phase).toBe("implement");
    expect(parsed.response).toBe("unblocked: dep merged");
    expect(parsed.respondedAt).toBe("2026-06-09T00:00:00.000Z");
  });

  it("a non-string response is coerced to an empty string (never undefined in the record)", () => {
    const writes: string[] = [];
    recordResponse(
      { ticket: "CTL-845", phase: "implement", response: undefined },
      { workersDir: "/w", write: (_p: string, d: string) => writes.push(d), mkdir: () => undefined },
    );
    expect((JSON.parse(writes[0]) as { response: unknown }).response).toBe("");
  });

  it("a failed write is swallowed (path:null), never throws", () => {
    const out = recordResponse(
      { ticket: "CTL-845", phase: "implement", response: "x" },
      {
        workersDir: "/w",
        write: () => {
          throw new Error("EACCES");
        },
        mkdir: () => undefined,
      },
    );
    expect(out.path).toBeNull();
  });
});

describe("buildResumeEvent — the daemon's resume trigger shape", () => {
  it("is a canonical linear.comment.created event the daemon's parseCommentCreatedEvent reads", () => {
    const ev = buildResumeEvent({ ticket: "CTL-845", response: "go", now: new Date("2026-06-09T00:00:00Z") });
    expect(ev.attributes["event.name"]).toBe("linear.comment.created");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-845");
    // The operator's note IS the comment body (the durable recorded response).
    expect(ev.body.payload.ticket).toBe("CTL-845");
    expect(ev.body.payload.body).toBe("go");
    // Null author → the daemon's self-echo guard is fail-open (not the bot).
    expect(ev.body.payload.authorId).toBeNull();
    expect(ev.body.payload.source).toBe("orch-monitor/respond");
  });

  it("coerces a non-string response to an empty comment body", () => {
    const ev = buildResumeEvent({ ticket: "CTL-845", response: null });
    expect(ev.body.payload.body).toBe("");
  });
});

describe("emitResumeEvent — append to the unified event log", () => {
  it("appends ONE JSONL line to the resolved monthly log path", () => {
    const appended: { path: string; data: string }[] = [];
    const out = emitResumeEvent(
      { ticket: "CTL-845", response: "go" },
      {
        append: (path: string, data: string) => appended.push({ path, data }),
        pathFor: () => "/events/2026-06.jsonl",
        mkdir: () => undefined,
        now: new Date("2026-06-09T00:00:00Z"),
      },
    );
    expect(out.path).toBe("/events/2026-06.jsonl");
    expect(appended).toHaveLength(1);
    expect(appended[0].path).toBe("/events/2026-06.jsonl");
    expect(appended[0].data.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(appended[0].data) as { attributes: Record<string, string> };
    expect(parsed.attributes["event.name"]).toBe("linear.comment.created");
  });
});

describe("eventLogPath — UTC monthly path (matches the daemon tailer)", () => {
  it("honors CATALYST_DIR and uses UTC year-month", () => {
    const p = eventLogPath({ env: { CATALYST_DIR: "/cat" }, now: new Date("2026-06-09T00:00:00Z") });
    expect(p).toBe("/cat/events/2026-06.jsonl");
  });

  it("zero-pads single-digit months", () => {
    const p = eventLogPath({ env: { CATALYST_DIR: "/cat" }, now: new Date("2026-01-15T00:00:00Z") });
    expect(p).toBe("/cat/events/2026-01.jsonl");
  });
});
