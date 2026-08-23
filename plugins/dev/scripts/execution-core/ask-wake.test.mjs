// ask-wake.test.mjs — CTL-2157. Unit tests for the PURE ask→work fan-out
// resolver. The daemon wiring (handleCommentWake) is ask-wake-daemon.test.mjs.
//
// Run: bun test plugins/dev/scripts/execution-core/ask-wake.test.mjs
import { describe, test, expect } from "bun:test";
import {
  ASK_LABEL_NAMES,
  parseBlocksFromBody,
  isAskDetail,
  blocksFromRelations,
  resolveAskWakeTargets,
} from "./ask-wake.mjs";
import { ASK_LABEL_NAMES as ASK_LABEL_NAMES_CLI } from "../ask.mjs";

const askDetail = (extra = {}) => ({
  title: "ASK: pick one",
  description: null,
  labels: [{ name: "catalyst-ask" }, { name: "ask/decision" }],
  relations: { blockedBy: [], blocks: [], related: [], duplicateOf: [] },
  ...extra,
});

describe("parseBlocksFromBody — the ask body's own record of what it holds up", () => {
  test("the canonical buildAskBody line", () => {
    // ask.mjs buildAskBody: `Blocks: CTC-841` (measured on CTL-2132).
    expect(parseBlocksFromBody("**Why:** x\n\nBlocks: CTC-841")).toEqual(["CTC-841"]);
  });

  test("markdown-linked ids, deduped against the id repeated inside the URL", () => {
    // Measured on CTC-694, whose stored body is
    // `Blocks: [CTC-689](https://linear.app/coalesce-labs/issue/CTC-689)`.
    expect(
      parseBlocksFromBody(
        "**Why:** x\n\nBlocks: [CTC-689](https://linear.app/coalesce-labs/issue/CTC-689)"
      )
    ).toEqual(["CTC-689"]);
  });

  test("several ids on one line", () => {
    expect(parseBlocksFromBody("Blocks: CTL-1, CTL-2, CTL-3")).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
  });

  test("bold header with a bulleted list under it", () => {
    expect(parseBlocksFromBody("**Blocks:**\n- CTL-10\n- CTL-11\n\nnext section")).toEqual([
      "CTL-10",
      "CTL-11",
    ]);
  });

  test("no-colon form: `Blocks [CTC-598](…)`", () => {
    // Measured on CTC-601 — a human-authored ask.
    expect(
      parseBlocksFromBody(
        "**Decision needed**\n\nBlocks [CTC-598](https://linear.app/coalesce-labs/issue/CTC-598). I can build any of these."
      )
    ).toEqual(["CTC-598"]);
  });

  // ⛔ NEGATIVE CONTROLS. These MUST fire: a false positive here dispatches an
  // agent onto a ticket nobody asked about.
  test("prose that merely contains the word blocks does NOT declare a relation", () => {
    expect(parseBlocksFromBody("This blocks the release for CTL-123 until Friday.")).toEqual([]);
  });

  test("a line starting with `Blocks` but not naming an id first is prose, not a declaration", () => {
    expect(parseBlocksFromBody("Blocks the release until CTL-123 lands.")).toEqual([]);
  });

  test("no Blocks line at all", () => {
    expect(parseBlocksFromBody("**Why:** x\n\n**Options:**\n- a\n- b")).toEqual([]);
  });

  test("a non-string / empty body", () => {
    expect(parseBlocksFromBody(null)).toEqual([]);
    expect(parseBlocksFromBody("")).toEqual([]);
  });
});

describe("isAskDetail — only an ASK fans out", () => {
  test("catalyst-ask", () => {
    expect(isAskDetail({ labels: [{ name: "catalyst-ask" }] })).toBe(true);
  });
  test("ask/decision", () => {
    expect(isAskDetail({ labels: [{ name: "ask/decision" }] })).toBe(true);
  });
  test("plain string labels are accepted too", () => {
    expect(isAskDetail({ labels: ["catalyst-ask"] })).toBe(true);
  });
  test("a work ticket is not an ask", () => {
    expect(isAskDetail({ labels: [{ name: "worker:mini" }] })).toBe(false);
  });
  test("unknown / unreadable detail fails CLOSED", () => {
    expect(isAskDetail(undefined)).toBe(false);
    expect(isAskDetail({})).toBe(false);
  });
});

describe("blocksFromRelations — the replica's `relations` table half", () => {
  test("forward blocks edges", () => {
    expect(
      blocksFromRelations({
        relations: { blocks: [{ identifier: "CTC-689" }, { identifier: "CTL-9" }] },
      })
    ).toEqual(["CTC-689", "CTL-9"]);
  });
  test("blockedBy is the OTHER direction and is never woken", () => {
    expect(
      blocksFromRelations({ relations: { blockedBy: [{ identifier: "CTL-7" }], blocks: [] } })
    ).toEqual([]);
  });
  test("garbage identifiers are dropped, not guessed", () => {
    expect(
      blocksFromRelations({ relations: { blocks: [{ identifier: "not a ticket" }, {}] } })
    ).toEqual([]);
  });
  test("no relation data at all", () => {
    expect(blocksFromRelations(undefined)).toEqual([]);
    expect(blocksFromRelations({ relations: null })).toEqual([]);
  });
});

describe("resolveAskWakeTargets — the union, and its blast radius", () => {
  test("relations and body agree → one target", () => {
    const r = resolveAskWakeTargets(
      "CTL-2132",
      askDetail({
        description: "**Why:** x\n\nBlocks: CTC-841",
        relations: {
          blockedBy: [],
          blocks: [{ identifier: "CTC-841" }],
          related: [],
          duplicateOf: [],
        },
      })
    );
    expect(r.isAsk).toBe(true);
    expect(r.blocked).toEqual(["CTC-841"]);
  });

  test("UNION: a relation linearis dropped is still recovered from the body", () => {
    // `--blocks` keeps only the LAST flag on some linearis versions (ask.mjs
    // missingBlocksFrom exists for exactly this), so the relation can be absent
    // while the body records the true intent.
    const r = resolveAskWakeTargets(
      "CTL-2132",
      askDetail({
        description: "Blocks: CTC-841, CTC-842",
        relations: {
          blockedBy: [],
          blocks: [{ identifier: "CTC-842" }],
          related: [],
          duplicateOf: [],
        },
      })
    );
    expect(r.blocked.sort()).toEqual(["CTC-841", "CTC-842"]);
  });

  test("UNION: a body a human edited is still recovered from the relation", () => {
    const r = resolveAskWakeTargets(
      "CTL-2132",
      askDetail({
        description: "(the operator rewrote this body and dropped the Blocks line)",
        relations: {
          blockedBy: [],
          blocks: [{ identifier: "CTC-841" }],
          related: [],
          duplicateOf: [],
        },
      })
    );
    expect(r.blocked).toEqual(["CTC-841"]);
  });

  test("the ask never wakes ITSELF (no self-dispatch loop)", () => {
    const r = resolveAskWakeTargets(
      "CTL-2132",
      askDetail({ description: "Blocks: CTL-2132, CTC-841" })
    );
    expect(r.blocked).toEqual(["CTC-841"]);
  });

  // ⛔ BLAST RADIUS. The daemon sees EVERY workspace comment. A work ticket whose
  // description happens to carry a Blocks line must not dispatch anything.
  test("a NON-ask ticket fans out to nothing, however it words its description", () => {
    const r = resolveAskWakeTargets("CTL-500", {
      labels: [{ name: "worker:mini" }],
      description: "Blocks: CTC-841",
      relations: {
        blockedBy: [],
        blocks: [{ identifier: "CTC-841" }],
        related: [],
        duplicateOf: [],
      },
    });
    expect(r.isAsk).toBe(false);
    expect(r.blocked).toEqual([]);
  });

  test("an unreadable ticket fans out to nothing (fail CLOSED)", () => {
    expect(resolveAskWakeTargets("CTL-2132", undefined)).toEqual({ isAsk: false, blocked: [] });
  });

  test("an ask that blocks nothing is not an error — it just wakes nobody", () => {
    const r = resolveAskWakeTargets("CTL-2132", askDetail({ description: "**Why:** x" }));
    expect(r).toEqual({ isAsk: true, blocked: [] });
  });
});

// ⛔ The label names are a SECOND copy of ask.mjs's list. daemon.mjs cannot import
// ask.mjs (that module self-executes on a `create`/`accept` argv[0] and exits 3),
// so the copy is deliberate — and pinned here, the way alert-emit's taxonomy is
// pinned to board-data's.
describe("ASK_LABEL_NAMES parity with the ask CLI (CTL-2157)", () => {
  test("the two lists are identical", () => {
    expect([...ASK_LABEL_NAMES]).toEqual([...ASK_LABEL_NAMES_CLI]);
  });
});
