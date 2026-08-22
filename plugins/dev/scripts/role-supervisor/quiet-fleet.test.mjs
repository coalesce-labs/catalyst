// quiet-fleet.test.mjs — CTL-2000. The quiet-fleet alarm's page decision is a
// pure scan: roles in, pages out, every read injected. A role going quiet must
// page the CONCIERGE (via the escalation router), never a human.
//
// Placed top-level in role-supervisor/ (not __tests__/) to match the existing
// supervisor.test.mjs convention and run-tests.sh's `../role-supervisor/*.test.mjs`
// glob — a test in a __tests__/ subdir would not be gated.
import { test, expect } from "bun:test";
import { quietFleetScan } from "./quiet-fleet.mjs";
import { LIVENESS } from "../lib/agent-liveness.mjs";

const now = 1_000_000_000_000;
const hb = (ageMs, extra = {}) => ({ ts: now - ageMs, scope: "s", pid: 1, ...extra });

test("a role silent for 12m raises exactly one page targeting the concierge", () => {
  const scan = quietFleetScan(["r"], { now, readHeartbeat: () => hb(12 * 60_000), scopeActive: () => true, priorPages: () => 0 });
  expect(scan.pages).toHaveLength(1);
  expect(scan.pages[0].liveness).toBe(LIVENESS.SILENT);
  expect(scan.pages[0].target).toBe("concierge");
});

test("a LIVE role raises no page", () => {
  const scan = quietFleetScan(["r"], { now, readHeartbeat: () => hb(60_000), scopeActive: () => true, priorPages: () => 0 });
  expect(scan.pages).toHaveLength(0);
});

test("a MISSING heartbeat while scope active raises a page (absence is not health)", () => {
  const scan = quietFleetScan(["r"], { now, readHeartbeat: () => null, scopeActive: () => true, priorPages: () => 0 });
  expect(scan.pages[0].liveness).toBe(LIVENESS.MISSING);
});

test("silent-but-scope-inactive raises no page", () => {
  const scan = quietFleetScan(["r"], { now, readHeartbeat: () => hb(12 * 60_000), scopeActive: () => false, priorPages: () => 0 });
  expect(scan.pages).toHaveLength(0);
});

test("edge-triggered: an already-latched role is not re-paged", () => {
  const scan = quietFleetScan(["r"], { now, readHeartbeat: () => hb(12 * 60_000), scopeActive: () => true, priorPages: () => 0, alreadyLatched: () => true });
  expect(scan.pages).toHaveLength(0);
});

// ── Additional coverage ──────────────────────────────────────────────────────

test("a DEAD role (>30m) raises a page targeting the concierge", () => {
  const scan = quietFleetScan(["r"], { now, readHeartbeat: () => hb(31 * 60_000), scopeActive: () => true, priorPages: () => 0 });
  expect(scan.pages).toHaveLength(1);
  expect(scan.pages[0].liveness).toBe(LIVENESS.DEAD);
  expect(scan.pages[0].target).toBe("concierge");
});

test("every page carries the instrument tag `instrument/quiet-fleet`", () => {
  const scan = quietFleetScan(["r"], { now, readHeartbeat: () => hb(12 * 60_000), scopeActive: () => true, priorPages: () => 0 });
  expect(scan.pages[0].tag).toBe("instrument/quiet-fleet");
});

test("multiple roles are scanned independently; only the unhealthy active one pages", () => {
  const beats = { live: hb(60_000), silent: hb(12 * 60_000), inactive: hb(40 * 60_000) };
  const scan = quietFleetScan(["live", "silent", "inactive"], {
    now,
    readHeartbeat: (r) => beats[r],
    scopeActive: (r) => r !== "inactive",
    priorPages: () => 0,
  });
  expect(scan.pages.map((p) => p.role)).toEqual(["silent"]);
});

test("checked_at echoes the injected clock (no clock is read internally)", () => {
  const scan = quietFleetScan([], { now, readHeartbeat: () => null, scopeActive: () => true, priorPages: () => 0 });
  expect(scan.checked_at).toBe(now);
  expect(scan.pages).toHaveLength(0);
});
