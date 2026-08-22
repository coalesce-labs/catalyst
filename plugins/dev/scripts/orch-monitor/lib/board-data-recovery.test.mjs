// board-data-recovery.test.mjs — CTL-1220: loadRecoveryOutcomes parses the
// unified event log's recovery.* events into per-ticket {autoFixed,triaged,
// recoveredAt} flags. CTL-2141 deleted the emit side (recovery-reasoning.mjs
// / recovery-emit.mjs) along with the whole recovery-pass judgment layer, so
// nothing produces recovery.fixed/recovery.would-fix events going forward —
// this reader is now permanently fed an empty stream in production. Kept
// (not deleted) because loadRecoveryOutcomes/foldRecoveryOutcomes are still
// live, wired into assembleBoard's per-3s recompute; only the local fixture
// builder below (a minimal stand-in for the deleted buildRecoveryEnvelope,
// scoped to just the fields foldRecoveryOutcomes actually reads) changed.
//
//   cd plugins/dev/scripts/orch-monitor && bun test lib/board-data-recovery.test.mjs

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRecoveryOutcomes } from "./board-data.mjs";

// Minimal stand-in for the deleted recovery-reasoning.mjs::buildRecoveryEnvelope —
// only the shape foldRecoveryOutcomes (board-data.mjs) actually reads:
// attributes["event.name"], attributes["event.label"] (+ its body.payload.ticket
// fallback), and ts.
function buildRecoveryEnvelope({ type, ticket = null }, { now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    ts,
    attributes: {
      "event.name": type,
      "event.label": ticket,
    },
    body: { payload: { ticket } },
  };
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function writeLog(lines) {
  const dir = mkdtempSync(join(tmpdir(), "rec-out-"));
  dirs.push(dir);
  const p = join(dir, "2026-06.jsonl");
  writeFileSync(
    p,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return p;
}

describe("CTL-1220: loadRecoveryOutcomes", () => {
  it("maps recovery.fixed → autoFixed:true + recoveredAt:ts", () => {
    const p = writeLog([
      buildRecoveryEnvelope(
        { type: "recovery.fixed", ticket: "CTL-100", fix_class: "x", reason: "r", details: {} },
        { now: () => "2026-06-16T01:00:00Z" },
      ),
    ]);
    const map = loadRecoveryOutcomes(p);
    expect(map.get("CTL-100")).toEqual({
      autoFixed: true,
      triaged: false,
      recoveredAt: "2026-06-16T01:00:00Z",
    });
  });

  it("maps recovery.would-fix → triaged:true (shadow)", () => {
    const p = writeLog([
      buildRecoveryEnvelope({ type: "recovery.would-fix", ticket: "CTL-200" }),
    ]);
    const map = loadRecoveryOutcomes(p);
    expect(map.get("CTL-200").triaged).toBe(true);
    expect(map.get("CTL-200").autoFixed).toBe(false);
  });

  it("ignores recovery.escalated and recovery.would-escalate", () => {
    const p = writeLog([
      buildRecoveryEnvelope({ type: "recovery.escalated", ticket: "CTL-300", reason: "r" }),
      buildRecoveryEnvelope({ type: "recovery.would-escalate", ticket: "CTL-301", reason: "r" }),
    ]);
    const map = loadRecoveryOutcomes(p);
    expect(map.get("CTL-300")).toBeUndefined();
    expect(map.get("CTL-301")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("keys on attributes['event.label'] (the CTL id)", () => {
    const p = writeLog([
      buildRecoveryEnvelope({ type: "recovery.fixed", ticket: "CTL-400" }),
    ]);
    const map = loadRecoveryOutcomes(p);
    expect(map.has("CTL-400")).toBe(true);
  });

  it("falls back to body.payload.ticket when event.label is absent", () => {
    // Hand-craft an envelope missing the event.label attribute.
    const env = buildRecoveryEnvelope({ type: "recovery.fixed", ticket: "CTL-500" });
    delete env.attributes["event.label"];
    const p = writeLog([env]);
    const map = loadRecoveryOutcomes(p);
    expect(map.has("CTL-500")).toBe(true);
  });

  it("fails open (empty Map) on ENOENT", () => {
    const map = loadRecoveryOutcomes(join(tmpdir(), "definitely-not-a-file-xyz.jsonl"));
    expect(map.size).toBe(0);
  });

  it("skips torn / malformed lines without throwing", () => {
    const p = writeLog([
      "{ not valid json",
      buildRecoveryEnvelope({ type: "recovery.fixed", ticket: "CTL-600" }),
      "",
      "another torn line }",
    ]);
    const map = loadRecoveryOutcomes(p);
    expect(map.get("CTL-600").autoFixed).toBe(true);
    expect(map.size).toBe(1);
  });

  it("last-write-wins: would-fix then fixed → both flags accrue per ticket", () => {
    const p = writeLog([
      buildRecoveryEnvelope({ type: "recovery.would-fix", ticket: "CTL-700" }),
      buildRecoveryEnvelope(
        { type: "recovery.fixed", ticket: "CTL-700" },
        { now: () => "2026-06-16T02:00:00Z" },
      ),
    ]);
    const map = loadRecoveryOutcomes(p);
    expect(map.get("CTL-700")).toEqual({
      autoFixed: true,
      triaged: true,
      recoveredAt: "2026-06-16T02:00:00Z",
    });
  });

  it("ignores unrelated event names", () => {
    const p = writeLog([
      { attributes: { "event.name": "account.ratelimit.sampled", "event.label": "CTL-800" } },
      buildRecoveryEnvelope({ type: "recovery.fixed", ticket: "CTL-801" }),
    ]);
    const map = loadRecoveryOutcomes(p);
    expect(map.has("CTL-800")).toBe(false);
    expect(map.has("CTL-801")).toBe(true);
  });
});
