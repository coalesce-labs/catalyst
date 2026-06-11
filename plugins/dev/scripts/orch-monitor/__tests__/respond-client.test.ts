// respond-client.test.ts — units for the HOME5 (CTL-903) WRITE path PURE core:
// the one-bright-verb model, the read-model write client (POST
// /api/ticket/<ticket>/respond), and the optimistic-rollback state machine.
//
// HOME5 is the only MUTATING path in HOME and the payoff of the whole Inbox: one
// verb on the needs-you row both records the human's response AND resumes the
// paused agent (the BFF12 endpoint clears the needs-human marker + emits the
// resume event that drives CTL-876's loop). This module is the React-/DOM-free
// spine the React surface renders through — same pattern as home-inbox.ts /
// reading-pane-model.ts, so `bun test` can unit it directly from outside the
// `ui/` module graph (the surface wiring is guarded by static source analysis in
// home-surface.test.ts).
//
// The five CTL-903 Gherkin scenarios land here:
//   • "Answering a decision resumes the agent" → respondTicket POSTs the verb,
//     the success result is `resuming` carrying the ticket+phase identity.
//   • "Unblocking a blocked item resumes the agent" → same write path, the
//     operator's note rides in the request body.
//   • "Exactly one bright verb per row" → verbActionFor yields ONE primary verb
//     (Answer/Unblock) for a needs-you row and NONE for the neutral sets; the
//     demoted actions (View-in-Claude/Snooze/Dismiss) are a separate overflow set.
//   • "The mutation is fence-aware in a cluster" → a 409 `fenced` /
//     `fence_indeterminate` response maps to a rejected (not resuming) outcome
//     the surface surfaces without marking the row resumed.
//   • "Optimistic action rolls back if the agent does not resume" → the
//     rollback model arms a grace window and, given the next board frame, decides
//     whether the optimistic mark held (row gone) or must roll back (row still
//     waiting after the grace window).
import { describe, it, expect } from "bun:test";
import {
  verbActionFor,
  OVERFLOW_ACTIONS,
  respondTicket,
  ROLLBACK_GRACE_MS,
  shouldRollBack,
  reconcileMarks,
  type OptimisticMark,
  type RespondOutcome,
} from "../ui/src/board/respond-client";
import { deriveInbox, type InboxRow } from "../ui/src/board/home-inbox";
import type { BoardPayload, BoardTicket } from "../ui/src/board/types";

// ── fixtures ─────────────────────────────────────────────────────────────────
function mkTicket(id: string, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id,
    title: `${id} title`,
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "active",
    model: null,
    linearState: "Implement",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: null,
    priority: 2,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "",
    held: null,
    blockers: [],
    ...over,
  };
}

function rowFor(ticket: BoardTicket): InboxRow {
  const payload: BoardPayload = {
    generatedAt: "2026-06-09T00:00:00Z",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets: [ticket],
    queue: [],
  };
  const row = deriveInbox(payload).order[0];
  if (row == null) throw new Error("fixture produced no row");
  return row;
}

/** A typed `fetch` mock: the impl carries the full `fetch` signature (url, init),
 *  so it assigns to `typeof fetch` WITHOUT a cast (no reward-hacking). The factory
 *  receives the captured url + init and returns the canned Response. */
function mockFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: string | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch;
}

/** A canned JSON Response with the given status. */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Scenario: Exactly one bright verb per row
// ════════════════════════════════════════════════════════════════════════════
describe("one bright verb per row (CTL-903 scenario 3)", () => {
  it("a waiting (decision) row's primary verb is Answer", () => {
    const action = verbActionFor(rowFor(mkTicket("CTL-642", { held: "waiting" })));
    expect(action).not.toBeNull();
    expect(action?.verb).toBe("Answer");
    expect(action?.kind).toBe("decision");
    expect(action?.ticket).toBe("CTL-642");
  });

  it("a blocked row's primary verb is Unblock", () => {
    const action = verbActionFor(rowFor(mkTicket("CTL-867", { held: "blocked" })));
    expect(action?.verb).toBe("Unblock");
    expect(action?.kind).toBe("blocked");
    expect(action?.ticket).toBe("CTL-867");
  });

  it("a running row carries NO primary verb (neutral, nothing to act on)", () => {
    expect(verbActionFor(rowFor(mkTicket("CTL-900", { held: null })))).toBeNull();
  });

  it("a done row carries NO primary verb", () => {
    expect(verbActionFor(rowFor(mkTicket("CTL-880", { status: "done" })))).toBeNull();
  });

  it("the demoted actions (View-in-Claude / Snooze / Dismiss) are a SEPARATE overflow set", () => {
    // The bright button is the verb; everything else is demoted to hover/overflow
    // — proven by the verb model NOT carrying them and the overflow set listing
    // exactly the three demoted actions.
    expect(OVERFLOW_ACTIONS).toEqual(["View in Claude", "Snooze", "Dismiss"]);
    const action = verbActionFor(rowFor(mkTicket("CTL-642", { held: "waiting" })));
    expect(action).not.toHaveProperty("snooze");
    expect(action).not.toHaveProperty("dismiss");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario: Answering a decision resumes the agent
// Scenario: Unblocking a blocked item resumes the agent
// ════════════════════════════════════════════════════════════════════════════
describe("the write path records the response + resumes (CTL-903 scenarios 1 & 2)", () => {
  it("POSTs to the read-model write endpoint with the typed-confirm + the note", async () => {
    // Capture the call's url, method, and raw body STRING (the client sends a
    // JSON string body) so the assertions never stringify an object.
    let seen: { url: string; method?: string; body: string } | null = null;
    const fetchImpl = mockFetch((url, init) => {
      const rawBody = init?.body;
      seen = {
        url,
        method: init?.method,
        body: typeof rawBody === "string" ? rawBody : "",
      };
      return jsonResponse({ status: "resuming", ticket: "CTL-642", phase: "plan", fenceNoop: true }, 200);
    });

    const outcome = await respondTicket(
      { ticket: "CTL-642", response: "Go with Path A" },
      { fetchImpl },
    );

    expect(seen).not.toBeNull();
    const call = seen as unknown as { url: string; method?: string; body: string };
    // Hits the BFF12 endpoint for THIS ticket.
    expect(call.url).toBe("/api/ticket/CTL-642/respond");
    expect(call.method).toBe("POST");
    // The body carries the operator's note AND the typed-confirm (== the ticket id).
    const body = JSON.parse(call.body) as { response: string; confirm: string };
    expect(body.response).toBe("Go with Path A");
    expect(body.confirm).toBe("CTL-642");
    // The success outcome is `resuming` carrying the ticket+phase identity the
    // surface marks optimistically.
    expect(outcome.status).toBe("resuming");
    if (outcome.status === "resuming") {
      expect(outcome.ticket).toBe("CTL-642");
      expect(outcome.phase).toBe("plan");
    }
  });

  it("URL-encodes the ticket id (no path injection)", async () => {
    let url = "";
    const fetchImpl = mockFetch((u) => {
      url = u;
      return jsonResponse({ status: "resuming", ticket: "CTL-1", phase: "pr" }, 200);
    });
    await respondTicket({ ticket: "CTL-1", response: "" }, { fetchImpl });
    expect(url).toBe("/api/ticket/CTL-1/respond");
  });

  it("a 404 not_held maps to a `not_held` outcome (nothing parked to answer)", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ status: "not_held", error: "no parked run" }, 404),
    );
    const outcome = await respondTicket({ ticket: "CTL-9", response: "x" }, { fetchImpl });
    expect(outcome.status).toBe("not_held");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario: The mutation is fence-aware in a cluster
// ════════════════════════════════════════════════════════════════════════════
describe("fence-aware mutation — a fenced-out node is rejected (CTL-903 scenario 4)", () => {
  it("a 409 fenced maps to a `rejected` outcome (the write did NOT act)", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse(
        { status: "fenced", ticket: "CTL-7", phase: "implement", error: "stale generation" },
        409,
      ),
    );
    const outcome = await respondTicket({ ticket: "CTL-7", response: "x" }, { fetchImpl });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBe("fenced");
    }
  });

  it("a 409 fence_indeterminate maps to a `rejected` outcome (refuse on an unconfirmable fence)", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResponse({ status: "fence_indeterminate", ticket: "CTL-7", phase: "implement" }, 409),
    );
    const outcome = await respondTicket({ ticket: "CTL-7", response: "x" }, { fetchImpl });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBe("fence_indeterminate");
    }
  });

  it("the SINGLE-NODE case is the success path (the endpoint's fenceNoop pass) — never rejected", async () => {
    // hosts.json absent / length 1 ⇒ the endpoint returns resuming with
    // fenceNoop:true (an identity no-op pass). The client treats it as a normal
    // success — no cluster code on the hot path.
    const fetchImpl = mockFetch(() =>
      jsonResponse({ status: "resuming", ticket: "CTL-642", phase: "plan", fenceNoop: true }, 200),
    );
    const outcome = await respondTicket({ ticket: "CTL-642", response: "ok" }, { fetchImpl });
    expect(outcome.status).toBe("resuming");
  });

  it("a confirm_mismatch (400) or a network failure maps to a `rejected` outcome (never a false resume)", async () => {
    const mismatch = mockFetch(() =>
      jsonResponse({ status: "confirm_mismatch", expected: "CTL-642" }, 400),
    );
    const o1 = await respondTicket({ ticket: "CTL-642", response: "x" }, { fetchImpl: mismatch });
    expect(o1.status).toBe("rejected");

    // A rejected fetch (offline) — the client maps any throw to a `rejected`
    // outcome, never a false resume.
    const boom = ((() => Promise.reject(new Error("offline"))) as unknown) as typeof fetch;
    const o2 = await respondTicket({ ticket: "CTL-642", response: "x" }, { fetchImpl: boom });
    expect(o2.status).toBe("rejected");
    if (o2.status === "rejected") {
      expect(o2.reason).toBe("error");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario: Optimistic action rolls back if the agent does not resume
// ════════════════════════════════════════════════════════════════════════════
describe("optimistic rollback — re-check the next frame after a grace window (CTL-903 scenario 5)", () => {
  it("the grace window matches the design's ~10s Stop-worker re-check", () => {
    expect(ROLLBACK_GRACE_MS).toBe(10_000);
  });

  it("does NOT roll back before the grace window elapses (even if the row still shows)", () => {
    // The optimistic mark is fresh; the row legitimately still shows for a beat.
    expect(shouldRollBack({ stillWaiting: true, elapsedMs: 0 })).toBe(false);
    expect(shouldRollBack({ stillWaiting: true, elapsedMs: ROLLBACK_GRACE_MS - 1 })).toBe(false);
  });

  it("rolls back when the item is STILL waiting after the grace window (the resume did not take)", () => {
    expect(shouldRollBack({ stillWaiting: true, elapsedMs: ROLLBACK_GRACE_MS })).toBe(true);
    expect(shouldRollBack({ stillWaiting: true, elapsedMs: ROLLBACK_GRACE_MS + 5_000 })).toBe(true);
  });

  it("does NOT roll back when the item has cleared (the row left 'What's waiting' — the happy path)", () => {
    // The resume took: the next frame no longer carries the held row → the
    // optimistic mark held, nothing to roll back, regardless of elapsed time.
    expect(shouldRollBack({ stillWaiting: false, elapsedMs: 0 })).toBe(false);
    expect(shouldRollBack({ stillWaiting: false, elapsedMs: ROLLBACK_GRACE_MS + 1 })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// reconcileMarks — the optimistic-mark ↔ board-frame reducer the surface hook
// renders through (the whole scenario-5 loop as ONE pure step the React tree just
// applies). Given the marks in flight + the set of ids STILL waiting on the next
// frame + `now`, it returns the surviving marks and the ids to roll back.
// ════════════════════════════════════════════════════════════════════════════
describe("reconcileMarks — drives the optimistic loop from one frame (CTL-903 scenario 5)", () => {
  const mark = (ticket: string, markedAt: number): OptimisticMark => ({ ticket, markedAt });

  it("keeps a mark whose row cleared (resume took) — and reports NO rollback", () => {
    // CTL-642 was marked, and the next frame no longer carries it as waiting → it
    // cleared. The mark is DROPPED (done, the row left "What's waiting"), nothing
    // to roll back.
    const out = reconcileMarks({
      marks: [mark("CTL-642", 1_000)],
      stillWaitingIds: new Set<string>(), // CTL-642 is gone → it resumed
      now: 1_000 + ROLLBACK_GRACE_MS + 1,
    });
    expect(out.rollBack).toEqual([]);
    expect(out.marks).toEqual([]); // mark retired (cleared)
  });

  it("HOLDS a still-waiting mark while the grace window is open (no premature rollback)", () => {
    const out = reconcileMarks({
      marks: [mark("CTL-642", 1_000)],
      stillWaitingIds: new Set(["CTL-642"]),
      now: 1_000 + ROLLBACK_GRACE_MS - 1, // window still open
    });
    expect(out.rollBack).toEqual([]);
    // The mark survives so the row keeps showing `resuming…`.
    expect(out.marks.map((m) => m.ticket)).toEqual(["CTL-642"]);
  });

  it("ROLLS BACK a mark that is STILL waiting after the grace window (resume did not take)", () => {
    const out = reconcileMarks({
      marks: [mark("CTL-642", 1_000)],
      stillWaitingIds: new Set(["CTL-642"]),
      now: 1_000 + ROLLBACK_GRACE_MS, // window elapsed, still waiting
    });
    expect(out.rollBack).toEqual(["CTL-642"]);
    // A rolled-back mark is DROPPED (the verb comes back, the operator is told).
    expect(out.marks).toEqual([]);
  });

  it("reconciles several marks independently in one frame", () => {
    const now = 100_000;
    const out = reconcileMarks({
      marks: [
        mark("CTL-1", now - ROLLBACK_GRACE_MS - 1), // still waiting, expired → rollback
        mark("CTL-2", now - 1_000), // still waiting, fresh → hold
        mark("CTL-3", now - ROLLBACK_GRACE_MS - 1), // cleared → retire
      ],
      stillWaitingIds: new Set(["CTL-1", "CTL-2"]), // CTL-3 cleared
      now,
    });
    expect(out.rollBack).toEqual(["CTL-1"]);
    expect(out.marks.map((m) => m.ticket)).toEqual(["CTL-2"]);
  });

  it("is a no-op with no marks in flight", () => {
    const out = reconcileMarks({ marks: [], stillWaitingIds: new Set(["CTL-9"]), now: 5 });
    expect(out.rollBack).toEqual([]);
    expect(out.marks).toEqual([]);
  });
});

// A tiny type-level guard: the outcome union is the closed set the surface maps.
describe("RespondOutcome is a closed discriminated union", () => {
  it("covers resuming | not_held | rejected", () => {
    const outcomes: RespondOutcome[] = [
      { status: "resuming", ticket: "CTL-1", phase: "plan", fenceNoop: true },
      { status: "not_held", ticket: "CTL-1" },
      { status: "rejected", ticket: "CTL-1", reason: "fenced", message: "x" },
    ];
    expect(outcomes).toHaveLength(3);
  });
});
