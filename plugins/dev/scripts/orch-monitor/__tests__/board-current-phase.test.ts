import { test, expect } from "bun:test";
import { deriveCurrentPhase, PHASE_ORDER } from "../lib/board-data.mjs";

type Sig = {
  status: string;
  model?: string | null;
  startedAt?: string;
  updatedAt?: string;
} | null;

const sigs = () => PHASE_ORDER.map(() => null) as Sig[];
const idx = (phase: string) => PHASE_ORDER.indexOf(phase);

// ── THE BUG (CTL-745) ──────────────────────────────────────────────────────
test("verify done + no downstream signals → stays at verify, NOT synthetic done", () => {
  const s = sigs();
  s[idx("verify")] = { status: "done", startedAt: "2026-06-03T08:00:00Z", updatedAt: "2026-06-03T08:05:00Z" };
  const cur = deriveCurrentPhase(s);
  expect(cur.phase).toBe("verify");
  expect(cur.status).toBe("done");
});

test("implement done + verify absent → stays at implement (mid-pipeline gap)", () => {
  const s = sigs();
  s[idx("triage")] = { status: "done" };
  s[idx("research")] = { status: "done" };
  s[idx("plan")] = { status: "done" };
  s[idx("implement")] = { status: "done", startedAt: "2026-06-03T08:00:00Z" };
  expect(deriveCurrentPhase(s).phase).toBe("implement");
});

// ── GENUINE COMPLETION ─────────────────────────────────────────────────────
test("final phase (monitor-deploy) terminal → synthetic done", () => {
  const s = sigs();
  for (const p of PHASE_ORDER) s[idx(p)] = { status: "done" };
  const cur = deriveCurrentPhase(s);
  expect(cur.phase).toBe("done");
  expect(cur.status).toBe("done");
});

test("monitor-deploy skipped (final phase, terminal) → still done", () => {
  const s = sigs();
  for (const p of PHASE_ORDER) s[idx(p)] = { status: "done" };
  s[idx("monitor-deploy")] = { status: "skipped" };
  expect(deriveCurrentPhase(s).phase).toBe("done");
});

// ── NON-TERMINAL (RUNNING) ─────────────────────────────────────────────────
test("running phase returns immediately with its real status", () => {
  const s = sigs();
  s[idx("triage")] = { status: "done" };
  s[idx("research")] = { status: "running", startedAt: "2026-06-03T08:00:00Z" };
  const cur = deriveCurrentPhase(s);
  expect(cur.phase).toBe("research");
  expect(cur.status).toBe("running");
});

// ── FAILED / STALLED SURFACE AT THEIR OWN PHASE ────────────────────────────
test("failed mid-pipeline phase surfaces at that phase (not done)", () => {
  const s = sigs();
  s[idx("triage")] = { status: "done" };
  s[idx("implement")] = { status: "failed", startedAt: "2026-06-03T08:00:00Z" };
  const cur = deriveCurrentPhase(s);
  expect(cur.phase).toBe("implement");
  expect(cur.status).toBe("failed");
});

test("stalled phase surfaces at that phase", () => {
  const s = sigs();
  s[idx("verify")] = { status: "stalled" };
  expect(deriveCurrentPhase(s)).toMatchObject({ phase: "verify", status: "stalled" });
});

// ── DEGENERATE: NO SIGNALS AT ALL ──────────────────────────────────────────
test("no phase signal files at all → first column, never Done", () => {
  const cur = deriveCurrentPhase(sigs());
  expect(cur.phase).toBe(PHASE_ORDER[0]); // "triage" → maps to Research, not Done
  expect(cur.status).not.toBe("done");
});

// ── METADATA PASSED THROUGH ────────────────────────────────────────────────
test("carries model/startedAt/updatedAt from the surfaced phase", () => {
  const s = sigs();
  s[idx("verify")] = { status: "done", model: "opus", startedAt: "2026-06-03T08:00:00Z", updatedAt: "2026-06-03T08:05:00Z" };
  const cur = deriveCurrentPhase(s);
  expect(cur.model).toBe("opus");
  expect(cur.startedAt).toBe("2026-06-03T08:00:00Z");
  expect(cur.updatedAt).toBe("2026-06-03T08:05:00Z");
});
