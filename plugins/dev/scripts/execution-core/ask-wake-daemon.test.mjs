// ask-wake-daemon.test.mjs — CTL-2157. The WIRING half: handleCommentWake must
// wake the agent(s) parked on the tickets an ask BLOCKS, not only an agent parked
// on the ticket that was commented.
//
// The pure resolver is ask-wake.test.mjs.
// Run: bun test plugins/dev/scripts/execution-core/ask-wake-daemon.test.mjs
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommentWake } from "./daemon.mjs";

const orchDirOf = () => mkdtempSync(join(tmpdir(), "ctl-2157-orch-"));

const writeSignal = (orch, ticket, phase, data) => {
  const workerDir = join(orch, "workers", ticket);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...data }));
};

const markerPath = (orch, ticket) =>
  join(orch, "workers", ticket, ".linear-label-needs-human.applied");

// The ask fan-out the daemon would get from the replica. Injected so these tests
// never touch ~/catalyst/catalyst-replica.db.
const asks = (map) => (ticket) => map[ticket] ?? [];

describe("CTL-2157 — a human comment on an ASK wakes the work it blocks", () => {
  test("re-dispatches the agent parked on the BLOCKED ticket, not just the commented one", async () => {
    const orch = orchDirOf();
    // The work ticket is parked; the ASK ticket has no worker dir of its own —
    // which is the normal shape, and the shape the old wake path dropped.
    writeSignal(orch, "CTC-841", "implement", {
      status: "needs-input",
      parkedFrom: "implement",
      handoffPath: "/tmp/handoff.md",
    });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-2132", body: "Option B — go ahead", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({ "CTL-2132": ["CTC-841"] }),
        dispatch: (dir, ticket, phase, opts) => {
          dispatched.push({ ticket, phase, opts });
          return { code: 0 };
        },
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ticket).toBe("CTC-841");
    expect(dispatched[0].phase).toBe("implement");
    expect(dispatched[0].opts.handoffPath).toBe("/tmp/handoff.md");
  });

  test("clears the STALL on a blocked ticket parked with status=needs-human", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTC-841", "research", { status: "needs-human" });
    const cleared = [];
    await handleCommentWake(
      { ticket: "CTL-2132", body: "answered", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({ "CTL-2132": ["CTC-841"] }),
        dispatch: () => ({ code: 0 }),
        removeLabel: async () => ({ removed: true, wrote: true }),
        clearStall: ({ ticket, phase }) => {
          cleared.push({ ticket, phase });
          return true;
        },
      }
    );
    expect(cleared).toContainEqual({ ticket: "CTC-841", phase: "research" });
  });

  test("clears the blocked ticket's park LABELS — the answer landed on the ask", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTC-841", "implement", { status: "needs-input", parkedFrom: "implement" });
    const removed = [];
    await handleCommentWake(
      { ticket: "CTL-2132", body: "answered", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({ "CTL-2132": ["CTC-841"] }),
        dispatch: () => ({ code: 0 }),
        removeLabel: async (ticket, label) => {
          removed.push({ ticket, label });
          return { removed: true, wrote: true };
        },
      }
    );
    expect(removed).toContainEqual({ ticket: "CTC-841", label: "needs-human" });
  });

  test("wakes EVERY ticket the ask blocks (one ask, N parked agents)", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTC-841", "implement", { status: "needs-input", parkedFrom: "implement" });
    writeSignal(orch, "CTC-842", "research", { status: "needs-input", parkedFrom: "research" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-2132", body: "answered", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({ "CTL-2132": ["CTC-841", "CTC-842"] }),
        dispatch: (dir, ticket, phase) => {
          dispatched.push({ ticket, phase });
          return { code: 0 };
        },
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(dispatched).toContainEqual({ ticket: "CTC-841", phase: "implement" });
    expect(dispatched).toContainEqual({ ticket: "CTC-842", phase: "research" });
  });

  test("the commented ticket is STILL woken when it is itself the parked work ticket", async () => {
    // Regression guard for the pre-existing CTL-549 path — the fan-out is additive.
    const orch = orchDirOf();
    writeSignal(orch, "CTL-1", "implement", { status: "needs-input", parkedFrom: "implement" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-1", body: "the answer", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({}),
        dispatch: (dir, ticket, phase) => {
          dispatched.push({ ticket, phase });
          return { code: 0 };
        },
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(dispatched).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
  });

  // ─── blast radius ───────────────────────────────────────────────────────────
  // The daemon receives EVERY workspace linear.comment.created.

  test("NEGATIVE CONTROL: the bot's own comment on the ask fans out to NOTHING", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTC-841", "implement", { status: "needs-input", parkedFrom: "implement" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-2132", body: "**Options:** …", authorId: "bot-uuid" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({ "CTL-2132": ["CTC-841"] }),
        dispatch: (dir, ticket) => dispatched.push(ticket),
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(dispatched).toEqual([]);
  });

  test("NEGATIVE CONTROL: no positive human provenance ⇒ no fan-out (self-wake guard)", async () => {
    // botUserId unset is a SUPPORTED fail-open config: "not a known bot" does not
    // imply "a human". The agent posts the ask body as the app actor, and that
    // webhook would otherwise re-dispatch every ticket the ask blocks — CTL-756's
    // self-wake bug, one indirection further out.
    const orch = orchDirOf();
    writeSignal(orch, "CTC-841", "implement", { status: "needs-input", parkedFrom: "implement" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-2132", body: "**Options:** …", authorId: "someone" },
      {
        orchDir: orch,
        botUserId: undefined,
        isManagedTicket: () => true,
        resolveAskBlocks: asks({ "CTL-2132": ["CTC-841"] }),
        dispatch: (dir, ticket) => dispatched.push(ticket),
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(dispatched).toEqual([]);
  });

  test("a ticket the resolver reports no blocks for behaves exactly as before", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTC-841", "implement", { status: "needs-input", parkedFrom: "implement" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-500", body: "some unrelated workspace comment", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({}),
        dispatch: (dir, ticket) => dispatched.push(ticket),
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(dispatched).toEqual([]);
  });

  test("a throwing resolver never breaks the wake (fail-open, single-ticket)", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTL-1", "implement", { status: "needs-input", parkedFrom: "implement" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-1", body: "answer", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: () => {
          throw new Error("replica exploded");
        },
        dispatch: (dir, ticket) => dispatched.push(ticket),
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(dispatched).toEqual(["CTL-1"]);
  });

  test("an UNMANAGED blocked ticket is never mutated in Linear", async () => {
    const orch = orchDirOf();
    const dispatched = [];
    const removed = [];
    await handleCommentWake(
      { ticket: "CTL-2132", body: "answered", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: (t) => t === "CTL-2132", // the ask is ours; the blocked ticket is not
        resolveAskBlocks: asks({ "CTL-2132": ["ZZZ-9"] }),
        dispatch: (dir, ticket) => dispatched.push(ticket),
        removeLabel: async (ticket, label) => {
          removed.push({ ticket, label });
          return { removed: true, wrote: true };
        },
      }
    );
    expect(removed.some((r) => r.ticket === "ZZZ-9")).toBe(false);
    expect(dispatched).toEqual([]);
  });
});

// ⛔ THE AUDIT'S SILENT REGRESSION (plan-audit Claim C). The clear-first block's
// marker half — which deletes workers/<T>/.linear-label-needs-human.applied, the
// marker boot-resume.mjs:493-498 reads to SUPPRESS auto-resume of a chronically
// failing ticket — used to be gated on the RESULT of removeLabel(needs-human).
// When the label write is deleted (a later phase of this epic), that gate goes
// false forever and a human reply silently stops clearing the marker. Re-keyed
// onto the same authorization the clear itself runs under: human provenance +
// managed ticket.
describe("CTL-2157 — the boot-resume marker clears on AUTHORIZATION, not on the label write", () => {
  test("marker is deleted even when the needs-human label write THROWS", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTL-1", "implement", { status: "needs-human" });
    writeFileSync(markerPath(orch, "CTL-1"), "applied");
    expect(existsSync(markerPath(orch, "CTL-1"))).toBe(true); // positive control
    await handleCommentWake(
      { ticket: "CTL-1", body: "answered", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({}),
        dispatch: () => ({ code: 0 }),
        removeLabel: async () => {
          throw new Error("Linear 503");
        },
      }
    );
    expect(existsSync(markerPath(orch, "CTL-1"))).toBe(false);
  });

  test("marker is deleted on a blocked ticket woken through its ASK", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTC-841", "implement", { status: "needs-human" });
    writeFileSync(markerPath(orch, "CTC-841"), "applied");
    await handleCommentWake(
      { ticket: "CTL-2132", body: "answered", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => true,
        resolveAskBlocks: asks({ "CTL-2132": ["CTC-841"] }),
        dispatch: () => ({ code: 0 }),
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(existsSync(markerPath(orch, "CTC-841"))).toBe(false);
  });

  test("NEGATIVE CONTROL: an UNAUTHORIZED comment leaves the marker alone", async () => {
    const orch = orchDirOf();
    writeSignal(orch, "CTL-1", "implement", { status: "needs-human" });
    writeFileSync(markerPath(orch, "CTL-1"), "applied");
    await handleCommentWake(
      { ticket: "CTL-1", body: "answered", authorId: "human-1" },
      {
        orchDir: orch,
        botUserId: "bot-uuid",
        isManagedTicket: () => false, // not ours
        resolveAskBlocks: asks({}),
        dispatch: () => ({ code: 0 }),
        removeLabel: async () => ({ removed: true, wrote: true }),
      }
    );
    expect(existsSync(markerPath(orch, "CTL-1"))).toBe(true);
  });
});
