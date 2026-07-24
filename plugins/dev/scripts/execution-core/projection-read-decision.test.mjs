// projection-read-decision.test.mjs — CTL-1489: the off/shadow/enforce seam.
// Run: cd plugins/dev/scripts/execution-core && bun test projection-read-decision.test.mjs

import { describe, test, expect } from "bun:test";
import {
  pickReader,
  buildProjectionDriftEvent,
  emitProjectionDrift,
} from "./projection-read-decision.mjs";

describe("pickReader", () => {
  test("off → always the local value, no diff/emit", () => {
    let emitted = 0;
    const v = pickReader("off", {
      local: "L",
      projection: "P",
      ticket: "CTL-1",
      emit: () => emitted++,
    });
    expect(v).toBe("L");
    expect(emitted).toBe(0);
  });

  test("shadow → local value, emits exactly one drift on mismatch", () => {
    const emitted = [];
    const v = pickReader("shadow", {
      local: "L",
      projection: "P",
      ticket: "CTL-1",
      emit: (t) => emitted.push(t),
    });
    expect(v).toBe("L");
    expect(emitted).toEqual(["CTL-1"]);
  });

  test("shadow → no emit when local and projection agree", () => {
    const emitted = [];
    const v = pickReader("shadow", {
      local: { a: 1 },
      projection: { a: 1 },
      ticket: "CTL-1",
      emit: (t) => emitted.push(t),
    });
    expect(v).toEqual({ a: 1 });
    expect(emitted).toEqual([]);
  });

  test("enforce → projection value when the projection has a row", () => {
    const v = pickReader("enforce", { local: "L", projection: "P", projectionPresent: true });
    expect(v).toBe("P");
  });

  test("enforce → falls back to local only when the projection has NO row", () => {
    const v = pickReader("enforce", { local: "L", projection: null, projectionPresent: false });
    expect(v).toBe("L");
  });

  test("enforce → present-but-null projection still governs (never falls back the reverse way)", () => {
    // A ticket whose projection row exists but resolves to null (e.g. not-held)
    // must NOT fall back to a stale local value.
    const v = pickReader("enforce", { local: "STALE", projection: null, projectionPresent: true });
    expect(v).toBe(null);
  });

  test("shadow drift emit is best-effort — a throwing emit never changes the decision", () => {
    const v = pickReader("shadow", {
      local: "L",
      projection: "P",
      ticket: "CTL-1",
      emit: () => {
        throw new Error("boom");
      },
    });
    expect(v).toBe("L");
  });
});

describe("projection.read.drift event", () => {
  test("buildProjectionDriftEvent is a broker-self-ingest-safe INFO envelope", () => {
    const ev = JSON.parse(buildProjectionDriftEvent({ ticket: "CTL-1", source: "reclaim" }));
    expect(ev.attributes["event.name"]).toBe("projection.read.drift.CTL-1");
    expect(ev.severityText).toBe("INFO");
    expect(ev.body.payload.ticket).toBe("CTL-1");
    expect(ev.body.payload.source).toBe("reclaim");
    // name must not be broker-protected (filter.*/broker.*/session.heartbeat).
    const name = ev.attributes["event.name"];
    expect(name.startsWith("filter.")).toBe(false);
    expect(name.startsWith("broker.")).toBe(false);
  });

  test("emitProjectionDrift appends via the injected seam and returns true", () => {
    let captured;
    const ok = emitProjectionDrift({ ticket: "CTL-1", source: "x", append: (l) => (captured = l) });
    expect(ok).toBe(true);
    expect(JSON.parse(captured).attributes["event.name"]).toBe("projection.read.drift.CTL-1");
  });
});
