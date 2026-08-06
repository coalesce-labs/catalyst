// fence-event.test.mjs — CTL-863 Linear-free fence emitter.
// Run: cd plugins/dev/scripts/execution-core && bun test fence-event.test.mjs
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildFenceEvent,
  appendFenceEvent,
  emitFenceClaimed,
  emitFenceReleased,
} from "./fence-event.mjs";

const parse = (line) => JSON.parse(line.trimEnd());

describe("buildFenceEvent — envelope shape (spec §B)", () => {
  const det = {
    now: () => new Date("2026-07-03T10:00:00.000Z"),
    newId: () => "id00",
    newTrace: () => "trace0",
    newSpan: () => "span0",
  };

  test("fence.claimed carries the full payload + attributes", () => {
    const e = parse(
      buildFenceEvent(
        { ticket: "CTL-1", action: "claimed", owner_host: "mini", generation: 7, phase: "implement" },
        det,
      ),
    );
    expect(e.attributes["event.name"]).toBe("fence.claimed.CTL-1");
    expect(e.attributes["event.entity"]).toBe("fence");
    expect(e.attributes["event.action"]).toBe("claimed");
    expect(e.attributes["linear.issue.identifier"]).toBe("CTL-1");
    expect(e.attributes["catalyst.host.name"]).toBe("mini");
    expect(e.resource["service.name"]).toBe("catalyst.execution-core");
    expect(e.body.payload).toEqual({
      ticket: "CTL-1",
      owner_host: "mini",
      generation: 7,
      phase: "implement",
      claimed_at: "2026-07-03T10:00:00Z",
    });
  });

  test("claimed_at defaults to now when omitted", () => {
    const e = parse(buildFenceEvent({ ticket: "CTL-2", owner_host: "mini", generation: 1 }, det));
    expect(e.body.payload.claimed_at).toBe("2026-07-03T10:00:00Z");
  });

  test("fence.released clears owner/generation/phase/claimed_at (OQ-F)", () => {
    const e = parse(
      buildFenceEvent(
        { ticket: "CTL-3", action: "released", owner_host: "mini", generation: 9, phase: "pr" },
        det,
      ),
    );
    expect(e.attributes["event.name"]).toBe("fence.released.CTL-3");
    expect(e.attributes["catalyst.host.name"]).toBeNull();
    expect(e.body.payload).toEqual({
      ticket: "CTL-3",
      owner_host: null,
      generation: null,
      phase: null,
      claimed_at: null,
    });
  });

  test("missing ticket throws; invalid action throws", () => {
    expect(() => buildFenceEvent({ action: "claimed" })).toThrow();
    expect(() => buildFenceEvent({ ticket: "CTL-1", action: "bogus" })).toThrow();
  });
});

describe("appendFenceEvent — single JSONL line, injectable, never throws", () => {
  test("defaultAppend seam writes exactly one newline-terminated line", () => {
    const lines = [];
    const ok = appendFenceEvent({
      append: (l) => lines.push(l),
      ticket: "CTL-1",
      owner_host: "mini",
      generation: 2,
    });
    expect(ok).toBe(true);
    expect(lines.length).toBe(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(lines[0].trimEnd().split("\n").length).toBe(1);
  });

  test("an append error is swallowed and returns false (never crashes a tick)", () => {
    const ok = appendFenceEvent({
      append: () => { throw new Error("disk full"); },
      ticket: "CTL-1",
      owner_host: "mini",
      generation: 2,
    });
    expect(ok).toBe(false);
  });

  test("emitFenceClaimed / emitFenceReleased route to the right action", () => {
    const claimed = [];
    emitFenceClaimed({ ticket: "CTL-1", owner_host: "mini", generation: 3 }, { append: (l) => claimed.push(parse(l)) });
    expect(claimed[0].attributes["event.action"]).toBe("claimed");

    const released = [];
    emitFenceReleased({ ticket: "CTL-1" }, { append: (l) => released.push(parse(l)) });
    expect(released[0].attributes["event.action"]).toBe("released");
  });
});

describe("fence-event.mjs — HARD invariant: zero Linear / breaker coupling (finding 8, OQ-D)", () => {
  test("the source imports NO linear client and NO breaker", () => {
    const src = readFileSync(fileURLToPath(new URL("./fence-event.mjs", import.meta.url)), "utf8");
    const imports = src.match(/^import .*$/gm) ?? [];
    for (const line of imports) {
      expect(line.includes("linear-breaker")).toBe(false);
      expect(/linear-write|linear-transition|cluster-claim|cluster-heartbeat/.test(line)).toBe(false);
    }
    // no residual reference to the breaker SYMBOL anywhere (prose comments about
    // the invariant are fine; a code reference to the breaker object is not).
    expect(src.includes("linearBreaker")).toBe(false);
    expect(/breaker[?.]/.test(src)).toBe(false); // e.g. breaker?.isOpen()/breaker.recordRateLimited
  });
});
