// board-node-attribution.test.ts — CTL-922 (BFF10).
//
// Every BoardTicket / BoardWorker / BoardQueueItem must carry its owning
// `host:{name,id}` (+ team on the queue item) and the per-ticket/worker
// `generation`, so the node-aware surfaces (BOARD3 host swimlanes, SURF1 worker
// node group, SURF2 queue node column) bind to a real field, and the fence-aware
// web mutations (BFF8 stop, HOME5 unblock) can pass a real generation to
// isFenceCurrent without a live attachment fetch.
//
// host source precedence: the phase signal `host:{name,id}` (CTL-852,
// phase-agent-dispatch) first, then the durable fence projection owner_host
// (BFF11 broker projection). generation precedence: the durable fence projection
// generation first, then the phase signal generation.
//
// These exercise the PURE exported helpers (deriveHost / deriveGeneration /
// synthesizeQueuedTicket) — assembleBoard itself is not unit-testable (it reads
// a homedir const and shells out to `claude agents`), mirroring the established
// board-current-phase / board-phase-summary test approach.

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  deriveHost,
  deriveGeneration,
  synthesizeQueuedTicket,
  hostRefFromName,
  PHASE_ORDER,
} from "../lib/board-data.mjs";

type Sig = Record<string, unknown> | null;
const sigs = (): Sig[] => PHASE_ORDER.map(() => null);
const idx = (phase: string) => PHASE_ORDER.indexOf(phase);
const expectedId = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 16);

// ── Scenario: Board entities are node-attributed ────────────────────────────

test("deriveHost reads host:{name,id} from the active phase signal (CTL-852)", () => {
  const s = sigs();
  s[idx("implement")] = {
    status: "running",
    host: { name: "mac-mini", id: "abc123def456abcd" },
  };
  expect(deriveHost(s, {})).toEqual({ name: "mac-mini", id: "abc123def456abcd" });
});

test("deriveHost falls back to the fence projection owner_host when no signal host", () => {
  const s = sigs();
  s[idx("research")] = { status: "running" }; // no host on the signal
  const host = deriveHost(s, { ownerHost: "mac-mini" });
  // id derived as sha256(name)[:16] — the canonical host-id shape, identical to
  // the bash/mjs/ts primitives — so the fence fallback yields a full {name,id}.
  expect(host).toEqual({ name: "mac-mini", id: expectedId("mac-mini") });
});

test("deriveHost prefers the signal host even when the fence also carries owner_host", () => {
  const s = sigs();
  s[idx("verify")] = {
    status: "running",
    host: { name: "signal-host", id: "1111222233334444" },
  };
  expect(deriveHost(s, { ownerHost: "fence-host" })).toEqual({
    name: "signal-host",
    id: "1111222233334444",
  });
});

test("deriveHost is null when neither the signal nor the fence names a host", () => {
  const s = sigs();
  s[idx("triage")] = { status: "done" };
  expect(deriveHost(s, {})).toBeNull();
  expect(deriveHost(s, { ownerHost: null })).toBeNull();
});

test("deriveHost walks the same precedence as the current phase — newest non-terminal wins", () => {
  // A terminal earlier phase carries an OLD host; the active phase carries the
  // current host. The current (non-terminal) phase's host is the live owner.
  const s = sigs();
  s[idx("triage")] = { status: "done", host: { name: "old-host", id: "deadbeefdeadbeef" } };
  s[idx("implement")] = { status: "running", host: { name: "cur-host", id: "0000111122223333" } };
  expect(deriveHost(s, {})).toEqual({ name: "cur-host", id: "0000111122223333" });
});

test("hostRefFromName derives the canonical sha256(name)[:16] id; null/empty → null", () => {
  expect(hostRefFromName("mac-mini")).toEqual({
    name: "mac-mini",
    id: expectedId("mac-mini"),
  });
  expect(hostRefFromName(null)).toBeNull();
  expect(hostRefFromName("")).toBeNull();
});

// ── Scenario: Generation is available for fence-aware writes ─────────────────

test("deriveGeneration reads the durable fence projection generation first (BFF11)", () => {
  const s = sigs();
  s[idx("implement")] = { status: "running", generation: 2 };
  // fence projection wins — it is the durable cache the web mutation reads from,
  // never a live attachment fetch.
  expect(deriveGeneration(s, { generation: 5 })).toBe(5);
});

test("deriveGeneration falls back to the phase signal generation when fence absent", () => {
  const s = sigs();
  s[idx("implement")] = { status: "running", generation: 3 };
  expect(deriveGeneration(s, {})).toBe(3);
  expect(deriveGeneration(s, { generation: null })).toBe(3);
});

test("deriveGeneration is null when neither source carries it", () => {
  const s = sigs();
  s[idx("research")] = { status: "running" };
  expect(deriveGeneration(s, {})).toBeNull();
  expect(deriveGeneration([], {})).toBeNull();
});

test("deriveGeneration accepts a literal 0 generation (not coerced to null)", () => {
  expect(deriveGeneration([], { generation: 0 })).toBe(0);
  const s = sigs();
  s[idx("implement")] = { status: "running", generation: 0 };
  expect(deriveGeneration(s, {})).toBe(0);
});

// ── Scenario: Single-host is identity ────────────────────────────────────────
// One node ⇒ every entity resolves to that same host. There is no separate
// cluster code path: the helper that single-host hits is the SAME one a multi-
// host fleet hits — it simply yields the one host. Zero added chrome/latency.

test("single-host: every entity resolves to the one host with no extra branch", () => {
  const sTicket = sigs();
  sTicket[idx("implement")] = {
    status: "running",
    host: { name: "mac-mini", id: "abc123def456abcd" },
    generation: 1,
  };
  const sWorker = sigs();
  sWorker[idx("implement")] = {
    status: "running",
    host: { name: "mac-mini", id: "abc123def456abcd" },
    generation: 1,
  };
  // Same host object shape for ticket and worker derived from the same single node.
  expect(deriveHost(sTicket, {})).toEqual(deriveHost(sWorker, {}));
  expect(deriveHost(sTicket, {})).toEqual({ name: "mac-mini", id: "abc123def456abcd" });
});

// ── synthesizeQueuedTicket carries host + team + generation ──────────────────
// Queue cards have no worker dir / phase signal, so host/generation come purely
// from the durable fence projection (linfo). team is the prefix-derived team.

test("synthesizeQueuedTicket carries team and host (from fence projection) + generation", () => {
  const eligible = {
    id: "CTL-900",
    title: "Queued ticket",
    priority: 2,
    createdAt: "2026-06-07T00:00:00Z",
    state: "Todo",
    repo: "catalyst",
    team: "CTL",
  };
  const linfo = {
    "CTL-900": {
      priority: 2,
      labels: [],
      ownerHost: "mac-mini",
      generation: 4,
    },
  };
  const t = synthesizeQueuedTicket(eligible, linfo);
  expect(t.team).toBe("CTL");
  expect(t.host).toEqual({ name: "mac-mini", id: expectedId("mac-mini") });
  expect(t.generation).toBe(4);
});

test("synthesizeQueuedTicket: host null + generation null when the fence projection is empty", () => {
  const eligible = {
    id: "ADV-1",
    title: "queued",
    priority: 0,
    createdAt: "2026-06-07T00:00:00Z",
    state: "Todo",
    repo: "adva",
    team: "ADV",
  };
  const t = synthesizeQueuedTicket(eligible, {});
  expect(t.team).toBe("ADV");
  expect(t.host).toBeNull();
  expect(t.generation).toBeNull();
});
