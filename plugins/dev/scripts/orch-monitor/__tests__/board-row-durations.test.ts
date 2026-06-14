// board-row-durations.test.ts — CTL-901 (HOME3): the read-model must SURFACE the
// per-row duration anchors the calm inbox renders. The honest "how long" line
// (HOME3 scenario 4) hinges on the BoardTicket carrying:
//   • heldSince         — the durable applied-at of the held labels (BFF11 /
//     CTL-923 projected it into ticket_state; linear-cache-reader surfaces it as
//     linfo[id].heldSince). The "how long has it been waiting on you" anchor.
//   • currentPhaseSince — the current phase's startedAt (deriveCurrentPhase
//     already reads it; the board assembly now forwards it instead of dropping
//     it). The "how long has it been running / in its current state" anchor.
//
// assembleBoard() itself is not unit-testable (WORKERS_DIR is a homedir const and
// it shells out to `claude agents`), so — exactly like board-held-indicator.test
// and board-phase-drift.test — this pins the wiring by STATIC source analysis:
//   1. the live + queued BoardTicket builders both stamp the two fields,
//   2. they are sourced from the DURABLE caches (linfo.heldSince / the surfaced
//      phase startedAt), never fabricated,
//   3. the .d.mts wire contract and the UI types both declare them.
// PLUS the pure deriveCurrentPhase already exposes startedAt (the data the
// assembly forwards), pinned directly.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { deriveCurrentPhase, PHASE_ORDER } from "../lib/board-data.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

const boardDataSrc = read("lib/board-data.mjs");
const boardDataDts = read("lib/board-data.d.mts");
const uiTypesSrc = read("ui/src/board/types.ts");

describe("board read-model surfaces the per-row duration anchors (CTL-901)", () => {
  test("the live BoardTicket builder forwards the current phase startedAt", () => {
    // The assembly reads `cur = deriveCurrentPhase(...)` and now forwards its
    // startedAt as currentPhaseSince (it used to drop it).
    expect(boardDataSrc).toContain("currentPhaseSince: cur.startedAt ?? null");
  });

  test("the live BoardTicket builder sources heldSince from the durable cache (never fabricated)", () => {
    // heldSince comes from linfo (linear-cache-reader → ticket_state.held_since,
    // BFF11). null when the durable cache has no stamp — honest, not invented.
    expect(boardDataSrc).toContain("heldSince: linfo[id]?.heldSince ?? null");
  });

  test("the queued (Todo-column) BoardTicket also carries the two anchors honestly", () => {
    // A queued ticket has no worker dir / phase signal → currentPhaseSince is
    // null; its held duration comes from the durable ticket_state heldSince.
    expect(boardDataSrc).toContain("heldSince: li.heldSince ?? null");
    expect(boardDataSrc).toContain("currentPhaseSince: null");
  });

  test("the .d.mts wire contract declares heldSince + currentPhaseSince", () => {
    expect(boardDataDts).toContain("heldSince: string | null");
    expect(boardDataDts).toContain("currentPhaseSince: string | null");
  });

  test("the UI BoardTicket type mirrors the two anchors", () => {
    expect(uiTypesSrc).toContain("heldSince?: string | null");
    expect(uiTypesSrc).toContain("currentPhaseSince?: string | null");
  });
});

describe("deriveCurrentPhase exposes the startedAt the assembly forwards (CTL-901)", () => {
  test("a running phase carries its startedAt (the running-row anchor)", () => {
    const sigs = PHASE_ORDER.map(() => null) as ({ status: string; startedAt?: string } | null)[];
    sigs[PHASE_ORDER.indexOf("implement")] = {
      status: "running",
      startedAt: "2026-06-09T09:56:00Z",
    };
    // earlier phases done so implement is the surfaced current phase
    sigs[PHASE_ORDER.indexOf("triage")] = { status: "done" };
    const cur = deriveCurrentPhase(sigs);
    expect(cur.phase).toBe("implement");
    expect(cur.startedAt).toBe("2026-06-09T09:56:00Z");
  });
});
