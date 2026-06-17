// CTL-1257: loadRecoveryOutcomes — ring-routing parity + underflow fallback.
// loadRecoveryOutcomes runs INSIDE assembleBoard, so the old unconditional
// readFileSync of the ~190MB log fired on every 3s recompute. It now routes
// through the shared event-ring. These tests assert:
//   (a) the ring-routed fold === the legacy readFileSync fold on the same lines
//       (byte-identical result — the fix preserves what's extracted), and
//   (b) a not-yet-cold-filled ring (oldestTs()===null) falls back to the file
//       path (the underflow guard).

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRecoveryOutcomes } from "../lib/board-data.mjs";
import { createEventRing } from "../lib/event-ring";

function recoveryLine(name: string, ticket: string, ts: string) {
  return JSON.stringify({
    ts,
    id: "deadbeef",
    attributes: { "event.name": name, "event.label": ticket },
    body: { payload: { ticket } },
  });
}

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// Write a current-month event log under <catalystDir>/events/<YYYY-MM>.jsonl so a
// real ring cold-fills from it, AND return that same path for the legacy reader.
function setupLog(lines: string[]): { catalystDir: string; logPath: string } {
  tmp = mkdtempSync(join(tmpdir(), "ctl1257-rec-"));
  const eventsDir = join(tmp, "events");
  mkdirSync(eventsDir, { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  const logPath = join(eventsDir, `${month}.jsonl`);
  writeFileSync(logPath, lines.join("\n") + "\n");
  return { catalystDir: tmp, logPath };
}

describe("loadRecoveryOutcomes — ring routing parity", () => {
  it("ring-routed result === legacy readFileSync result on the same lines", () => {
    const lines = [
      recoveryLine("recovery.fixed", "CTL-100", "2026-06-17T10:00:00Z"),
      recoveryLine("recovery.would-fix", "CTL-200", "2026-06-17T10:05:00Z"),
      // a later fixed for the same ticket → last-write-wins recoveredAt
      recoveryLine("recovery.fixed", "CTL-100", "2026-06-17T11:00:00Z"),
      // an unrelated event the predicate must drop
      JSON.stringify({ ts: "2026-06-17T10:01:00Z", attributes: { "event.name": "phase.start", "event.label": "CTL-300" } }),
      // an escalation event — explicitly ignored by the fold
      recoveryLine("recovery.escalated", "CTL-400", "2026-06-17T10:02:00Z"),
    ];
    const { catalystDir, logPath } = setupLog(lines);

    // Legacy path (ring=null): full readFileSync fold.
    const legacy = loadRecoveryOutcomes(logPath, null);

    // Ring path: cold-fill a real ring from the same file, then route through it.
    const ring = createEventRing({ catalystDir });
    ring.start();
    try {
      expect(ring.oldestTs()).not.toBeNull(); // ring cold-filled
      const viaRing = loadRecoveryOutcomes(logPath, ring);

      // Byte-identical fold: same keys, same flags, same recoveredAt.
      expect([...viaRing.entries()].sort()).toEqual([...legacy.entries()].sort());
      // Spot-check the semantics survived the routing.
      expect(viaRing.get("CTL-100")).toEqual({ autoFixed: true, triaged: false, recoveredAt: "2026-06-17T11:00:00Z" });
      expect(viaRing.get("CTL-200")).toEqual({ autoFixed: false, triaged: true, recoveredAt: null });
      expect(viaRing.has("CTL-300")).toBe(false); // non-recovery dropped
      expect(viaRing.has("CTL-400")).toBe(false); // escalated ignored
    } finally {
      ring.stop();
    }
  });
});

describe("loadRecoveryOutcomes — underflow guard", () => {
  it("a not-yet-cold-filled ring (oldestTs()===null) falls back to the file path", () => {
    const lines = [recoveryLine("recovery.fixed", "CTL-999", "2026-06-17T09:00:00Z")];
    const { logPath, catalystDir } = setupLog(lines);

    // An un-started ring: empty, oldestTs() === null → guard must fall back to
    // the file read (which still has the data) rather than return an empty Map.
    const coldRing = createEventRing({ catalystDir });
    // NOTE: deliberately NOT calling .start() → ring is empty.
    expect(coldRing.oldestTs()).toBeNull();

    const result = loadRecoveryOutcomes(logPath, coldRing);
    expect(result.get("CTL-999")).toEqual({ autoFixed: true, triaged: false, recoveredAt: "2026-06-17T09:00:00Z" });
  });

  it("ENOENT log with a cold ring → empty Map, never throws", () => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1257-noent-"));
    const missing = join(tmp, "events", "nope.jsonl");
    const ring = createEventRing({ catalystDir: tmp }); // not started → oldestTs null
    expect(() => loadRecoveryOutcomes(missing, ring)).not.toThrow();
    expect(loadRecoveryOutcomes(missing, ring).size).toBe(0);
  });
});
