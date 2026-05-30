// board-client.test.ts — units for the board transport's PURE logic (CTL-733
// PR-2b). The transports themselves (SharedWorker / EventSource / IndexedDB)
// need a browser, so — exactly like board-snapshot.test.ts tests the snapshot
// manager's pure logic with injected fakes — we test only the dependency-free
// helpers in ui/src/board/board-logic.ts: the reconnect backoff sequence and the
// monotonic snapshot gate that stops a late cache read clobbering a live frame.
import { describe, it, expect } from "bun:test";
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  nextBackoff,
  snapshotMs,
  createSnapshotGate,
} from "../ui/src/board/board-logic";

describe("board transport — backoff (CTL-733 PR-2b)", () => {
  it("doubles each step and caps at MAX_BACKOFF_MS", () => {
    const seq: number[] = [];
    let b = INITIAL_BACKOFF_MS;
    for (let i = 0; i < 8; i++) {
      seq.push(b);
      b = nextBackoff(b);
    }
    // 500 → 1000 → 2000 → 4000 → 8000 → 15000 (capped) → 15000 → 15000
    expect(seq).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(seq.every((v) => v <= MAX_BACKOFF_MS)).toBe(true);
  });

  it("honours a custom cap", () => {
    expect(nextBackoff(1000, 1500)).toBe(1500);
    expect(nextBackoff(400, 1500)).toBe(800);
  });

  it("never returns 0 from a 0 / negative current (avoids a hot reconnect loop)", () => {
    expect(nextBackoff(0)).toBe(2);
    expect(nextBackoff(-100)).toBe(2);
  });
});

describe("board transport — snapshotMs (CTL-733 PR-2b)", () => {
  it("parses a valid ISO generatedAt to epoch ms", () => {
    const iso = "2026-05-30T12:00:00.000Z";
    expect(snapshotMs({ generatedAt: iso })).toBe(Date.parse(iso));
  });

  it("returns 0 for missing / empty / invalid / null", () => {
    expect(snapshotMs(null)).toBe(0);
    expect(snapshotMs(undefined)).toBe(0);
    expect(snapshotMs({})).toBe(0);
    expect(snapshotMs({ generatedAt: "" })).toBe(0);
    expect(snapshotMs({ generatedAt: "not-a-date" })).toBe(0);
  });
});

describe("board transport — createSnapshotGate (CTL-733 PR-2b)", () => {
  const at = (t: string) => ({ generatedAt: t });

  it("passes the first snapshot and any newer one", () => {
    const seen: string[] = [];
    const gate = createSnapshotGate<{ generatedAt: string }>((p) => seen.push(p.generatedAt));
    gate(at("2026-05-30T12:00:00Z"));
    gate(at("2026-05-30T12:00:05Z"));
    expect(seen).toEqual(["2026-05-30T12:00:00Z", "2026-05-30T12:00:05Z"]);
  });

  it("drops an OLDER snapshot — a late cache read can't clobber a live frame", () => {
    const seen: string[] = [];
    const gate = createSnapshotGate<{ generatedAt: string }>((p) => seen.push(p.generatedAt));
    gate(at("2026-05-30T12:00:05Z")); // live frame lands first
    gate(at("2026-05-30T12:00:00Z")); // stale cache arrives late → must be dropped
    expect(seen).toEqual(["2026-05-30T12:00:05Z"]);
  });

  it("passes an equal timestamp (idempotent refresh)", () => {
    const seen: string[] = [];
    const gate = createSnapshotGate<{ generatedAt: string }>((p) => seen.push(p.generatedAt));
    gate(at("2026-05-30T12:00:00Z"));
    gate(at("2026-05-30T12:00:00Z"));
    expect(seen.length).toBe(2);
  });
});
