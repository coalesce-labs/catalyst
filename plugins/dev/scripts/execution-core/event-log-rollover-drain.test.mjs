// event-log-rollover-drain.test.mjs — CTL-1216 Phase 3.
//
// The ticket's second acceptance criterion is that the log "rolls over WITHOUT
// DROPPING EVENTS". Before this, every long-lived tail abandoned its file the
// moment the resolved path changed — losing the old file's unread tail, and (for
// the two readers that seeded at the new file's current size) the new file's
// head as well.
//
// These tests pin the drain primitive itself. The per-reader wiring is covered
// by each reader's own suite.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  drainAndSwitch,
  DEFAULT_DRAIN_MAX_BYTES,
  tornLineCount,
  resetTornLineCount,
} from "./event-tail.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "ctl1216-drain-"));
}

describe("drainAndSwitch", () => {
  test("drains the old file's remaining tail — the bytes written after the last poll", () => {
    const dir = scratch();
    try {
      const fileA = join(dir, "2026-W33.jsonl");
      writeFileSync(fileA, "a1\na2\n");
      const readSoFar = statSync(fileA).size; // the reader consumed a1,a2
      appendFileSync(fileA, "a3\n"); // written AFTER the last poll — lost today

      const got = [];
      const res = drainAndSwitch({ oldPath: fileA, oldOffset: readSoFar, onLines: (l) => got.push(...l) });

      expect(got).toEqual(["a3"]);
      expect(res.lines).toBe(1);
      expect(res.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a leftover fragment from the previous poll is completed, not dropped", () => {
    const dir = scratch();
    try {
      const fileA = join(dir, "a.jsonl");
      // The reader stopped mid-line last poll and held "{\"x\":1" back.
      writeFileSync(fileA, '"rest"}\nnext\n');
      const got = [];
      drainAndSwitch({ oldPath: fileA, oldOffset: 0, leftover: '{"x":1,', onLines: (l) => got.push(...l) });
      expect(got).toEqual(['{"x":1,"rest"}', "next"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the trailing fragment is DISCARDED and is not counted as a torn line", () => {
    // This is the last read of this file — a partial line here will never be
    // completed by a later append. CTL-1809: an in-flight write is a healthy
    // writer, and a torn-line counter that counts healthy writes is not one.
    const dir = scratch();
    try {
      const fileA = join(dir, "a.jsonl");
      writeFileSync(fileA, '{"ts":"x","name":"ok"}\n{"ts":"y","na');
      resetTornLineCount();
      const got = [];
      const res = drainAndSwitch({ oldPath: fileA, oldOffset: 0, onLines: (l) => got.push(...l) });
      expect(got).toEqual(['{"ts":"x","name":"ok"}']);
      expect(res.lines).toBe(1);
      expect(tornLineCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the drain is BOUNDED and reports that it truncated", () => {
    const dir = scratch();
    try {
      const fileA = join(dir, "a.jsonl");
      writeFileSync(fileA, "x".repeat(1000) + "\n");
      const res = drainAndSwitch({ oldPath: fileA, oldOffset: 0, maxBytes: 100, onLines: () => {} });
      expect(res.drained).toBe(100);
      // ⛔ The report is the point. A drain that reads less without SAYING so is
      // a silent gap — indistinguishable from a file that had nothing left.
      expect(res.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("truncated:false is reachable (positive control — it is not hardcoded true)", () => {
    const dir = scratch();
    try {
      const fileA = join(dir, "a.jsonl");
      writeFileSync(fileA, "short\n");
      expect(drainAndSwitch({ oldPath: fileA, oldOffset: 0, maxBytes: 100, onLines: () => {} }).truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing or unreadable old file drains nothing and never throws", () => {
    // A reader must always be able to complete its switch.
    expect(drainAndSwitch({ oldPath: "/nope/nope.jsonl", oldOffset: 0, onLines: () => {} }))
      .toEqual({ drained: 0, lines: 0, truncated: false });
    expect(drainAndSwitch({ oldPath: null, oldOffset: 0, onLines: () => {} }))
      .toEqual({ drained: 0, lines: 0, truncated: false });
  });

  test("nothing new since the last poll is a no-op, not an error", () => {
    const dir = scratch();
    try {
      const fileA = join(dir, "a.jsonl");
      writeFileSync(fileA, "a1\n");
      const res = drainAndSwitch({ oldPath: fileA, oldOffset: statSync(fileA).size, onLines: () => {} });
      expect(res).toEqual({ drained: 0, lines: 0, truncated: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a multi-byte character straddling the byte cap is not corrupted", () => {
    const dir = scratch();
    try {
      const fileA = join(dir, "a.jsonl");
      // "é" is 2 bytes; cut the read so the cap lands between them.
      writeFileSync(fileA, "café\n");
      const full = statSync(fileA).size;
      const res = drainAndSwitch({ oldPath: fileA, oldOffset: 0, maxBytes: full - 2, onLines: () => {} });
      expect(res.truncated).toBe(true);
      // No complete line survives the cut, and critically no replacement char
      // was emitted mid-line.
      expect(res.lines).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the default cap is a real number, not undefined", () => {
    expect(DEFAULT_DRAIN_MAX_BYTES).toBeGreaterThan(0);
  });
});
