import { test, expect } from "bun:test";
import { buildPhaseSummary, PHASE_ORDER } from "../lib/board-data.mjs";

type Sig = { status: string; startedAt?: string; completedAt?: string } | null;

const NOW = Date.parse("2026-06-02T10:00:00Z");

test("terminal phase uses completedAt - startedAt for duration", () => {
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[0] = { status: "done", startedAt: "2026-06-02T09:28:09Z", completedAt: "2026-06-02T09:30:01Z" };
  const out = buildPhaseSummary(sigs, NOW);
  expect(out).toEqual([{
    phase: "triage", status: "done", durationMs: 112_000,
    startedAt: "2026-06-02T09:28:09Z", completedAt: "2026-06-02T09:30:01Z",
  }]);
});

test("running (non-terminal, no completedAt) phase measures now - startedAt", () => {
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[2] = { status: "running", startedAt: "2026-06-02T09:59:00Z" }; // plan
  const out = buildPhaseSummary(sigs, NOW);
  expect(out).toEqual([{
    phase: "plan", status: "running", durationMs: 60_000,
    startedAt: "2026-06-02T09:59:00Z", completedAt: null,
  }]);
});

test("terminal phase WITHOUT completedAt yields null duration (not now-based)", () => {
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[4] = { status: "failed", startedAt: "2026-06-02T09:00:00Z" }; // verify, terminal
  expect(buildPhaseSummary(sigs, NOW)).toEqual([{
    phase: "verify", status: "failed", durationMs: null,
    startedAt: "2026-06-02T09:00:00Z", completedAt: null,
  }]);
});

test("null slots and signals missing startedAt are dropped; order follows PHASE_ORDER", () => {
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[0] = { status: "done", startedAt: "2026-06-02T09:00:00Z", completedAt: "2026-06-02T09:01:00Z" };
  sigs[1] = { status: "done" };               // no startedAt → dropped
  sigs[3] = { status: "running", startedAt: "2026-06-02T09:59:30Z" }; // implement
  const out = buildPhaseSummary(sigs, NOW);
  expect(out.map((p: { phase: string }) => p.phase)).toEqual(["triage", "implement"]);
});

test("unparseable startedAt is dropped", () => {
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[0] = { status: "done", startedAt: "not-a-date", completedAt: "2026-06-02T09:01:00Z" };
  expect(buildPhaseSummary(sigs, NOW)).toEqual([]);
});

test("unparseable completedAt yields null duration (not a now-anchored value)", () => {
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[0] = { status: "done", startedAt: "2026-06-02T09:00:00Z", completedAt: "not-a-date" };
  expect(buildPhaseSummary(sigs, NOW)).toEqual([{
    phase: "triage", status: "done", durationMs: null,
    startedAt: "2026-06-02T09:00:00Z", completedAt: null,
  }]);
});

test("completedAt earlier than startedAt yields null duration but raw timestamps are preserved (CTL-754)", () => {
  // Clock skew / re-walk-rewritten completedAt before startedAt must not render
  // as a negative duration (which fmtDuration silently blanks, laundering
  // corrupt timing as a healthy phase). The raw timestamps are still surfaced
  // verbatim — only durationMs is sanitized.
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[0] = { status: "done", startedAt: "2026-06-02T09:30:00Z", completedAt: "2026-06-02T09:28:00Z" };
  expect(buildPhaseSummary(sigs, NOW)).toEqual([{
    phase: "triage", status: "done", durationMs: null,
    startedAt: "2026-06-02T09:30:00Z", completedAt: "2026-06-02T09:28:00Z",
  }]);
});

test("empty / all-null input yields empty array", () => {
  const empty: Sig[] = PHASE_ORDER.map(() => null);
  expect(buildPhaseSummary(empty, NOW)).toEqual([]);
  expect(buildPhaseSummary([], NOW)).toEqual([]);
});

test("startedAt and completedAt echoed verbatim from signal (raw string preservation)", () => {
  const sigs: Sig[] = PHASE_ORDER.map(() => null);
  sigs[1] = { status: "done", startedAt: "2026-06-02T08:00:00Z", completedAt: "2026-06-02T08:05:30Z" };
  const out = buildPhaseSummary(sigs, NOW);
  expect(out).toEqual([{
    phase: "research", status: "done", durationMs: 330_000,
    startedAt: "2026-06-02T08:00:00Z", completedAt: "2026-06-02T08:05:30Z",
  }]);
});
