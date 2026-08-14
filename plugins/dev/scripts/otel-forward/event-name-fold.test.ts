// event-name-fold.test.ts — CTL-1834 per-call-site coverage for OTEL-FORWARD.
//
// Run: cd plugins/dev/scripts/otel-forward && bun test event-name-fold.test.ts
// (this package's CI step is a globbed `bun test`, so a new file here needs no
// workflow edit — see "otel-forward tests" in execution-core-tests.yml.)
//
// ONE folded site: `describeUnknownShape` in index.ts. It was the repo's only
// CORRECT three-key reader — hand-rolled, on the drop path, while the shared
// boundary read two. It now delegates.
//
// NOT folded, deliberately: `shouldForward` in lib/tail.ts. That is a SHAPE
// predicate ("can the OTLP pipeline map this line?"), not a name resolver, and one
// of its three accept-arms — a pino operational record `{level, msg}` — has no
// event name in any of the three keys, so a name-based accept predicate would drop
// the entire pino stream that several CTL-1502/1818 alarms depend on. Its
// behaviour is pinned below so a future "unify these" refactor fails here first.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeUnknownShape } from "./index.ts";
import { createTailer } from "./lib/tail.ts";

describe("describeUnknownShape delegates to the boundary (CTL-1834)", () => {
  test("a v3-shaped line is NAMED", () => {
    // The reachable case: both callers sit behind shouldForward having REJECTED
    // the line, so it has no `attributes` and no string `event` — only the v3 arm
    // can fire. This is exactly the 1,006-line phase.rescue.* population.
    expect(describeUnknownShape(JSON.stringify({ ts: "t", name: "phase.rescue.escalated.CTC-310" }))).toBe(
      "phase.rescue.escalated.CTC-310",
    );
  });

  test("positive control: v1 and v2 still resolve (unchanged behaviour)", () => {
    expect(describeUnknownShape(JSON.stringify({ event: "agent.checkin" }))).toBe("agent.checkin");
    expect(describeUnknownShape(JSON.stringify({ attributes: { "event.name": "x.y" } }))).toBe("x.y");
  });

  test("a nameless object still falls back to a bounded key list", () => {
    const out = describeUnknownShape(JSON.stringify({ ts: "t", level: 30, msg: "pino" }));
    expect(out).toStartWith("(no name; keys:");
  });

  test("an unparseable line still falls back to a bounded raw prefix, no throw", () => {
    expect(describeUnknownShape("{not json")).toStartWith("(unparseable:");
  });

  test("an EMPTY name is not treated as a name", () => {
    // The 10 measured lines carrying attributes["event.name"] === "". They must
    // reach the key-list fallback, not report an empty identity.
    expect(describeUnknownShape(JSON.stringify({ attributes: { "event.name": "" } }))).toStartWith(
      "(no name; keys:",
    );
  });
});

describe("shouldForward stays a SHAPE predicate, not a name resolver (CTL-1834)", () => {
  // Pinned so a future "fold everything onto getEventName" pass fails here first.
  // shouldForward is internal to createTailer, so it is driven the way the rest of
  // tail.test.ts drives it: a real file + drain(), reading the accept/reject verdict
  // off onLine vs onUnrecognized.
  async function classify(obj: unknown): Promise<"accepted" | "rejected"> {
    const dir = mkdtempSync(join(tmpdir(), "ctl1834-of-"));
    try {
      const file = join(dir, "2026-08.jsonl");
      writeFileSync(file, JSON.stringify(obj) + "\n");
      let verdict: "accepted" | "rejected" = "rejected";
      const ac = new AbortController();
      const tailer = createTailer({
        filePath: file,
        offset: 0,
        onLine: () => {
          verdict = "accepted";
        },
        onUnrecognized: () => {
          verdict = "rejected";
        },
        signal: ac.signal,
        pollMs: 10,
      });
      await tailer.drain();
      ac.abort();
      return verdict;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a pino record is ACCEPTED and has no event name at all", async () => {
    expect(await classify({ level: 30, msg: "hello", time: 1 })).toBe("accepted");
    // The reason folding is not expressible: the boundary returns "" for it.
    expect(describeUnknownShape(JSON.stringify({ level: 30, msg: "hello" }))).toStartWith(
      "(no name; keys:",
    );
  });

  test("a v3-only line is still REJECTED — the OTLP mapper needs attributes", async () => {
    expect(await classify({ ts: "t", name: "phase.rescue.escalated.CTC-310" })).toBe("rejected");
  });

  test("v1 and v2 lines are still accepted", async () => {
    expect(await classify({ ts: "t", event: "agent.checkin" })).toBe("accepted");
    expect(await classify({ ts: "t", attributes: { "event.name": "x.y" } })).toBe("accepted");
  });
});
