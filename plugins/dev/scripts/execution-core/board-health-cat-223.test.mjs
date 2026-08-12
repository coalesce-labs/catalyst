import { expect, test } from "bun:test";
import { deriveRing, computeDispatchOffenders } from "./board-health.mjs";

test("dispatch ring attributes successful dispatches per ticket", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  const ring = deriveRing([
    { ts: "2026-08-11T11:59:00Z", type: "phase.dispatch.requested.CAT-216" },
    { ts: "2026-08-11T11:59:30Z", type: "phase.dispatch.launched.CAT-216" },
    { ts: "2026-08-11T11:59:45Z", type: "phase.dispatch.failed.CAT-223" },
  ], now, "");
  expect(ring.dispatchAttributionSeen).toBe(true);
  expect(ring.dispatchTsByTicket.get("CAT-216")).toBe(Date.parse("2026-08-11T11:59:30Z"));
  expect(ring.dispatchTsByTicket.has("CAT-223")).toBe(false);
  expect(ring.recentDispatchTs).toBe(Date.parse("2026-08-11T11:59:30Z"));
});

test("per-ticket evidence identifies only stale undispatched tickets", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  const result = computeDispatchOffenders({
    owned: [
      { id: "CAT-223", updatedAt: "2026-08-11T10:00:00Z" },
      { id: "CAT-224", updatedAt: "2026-08-11T11:59:00Z" },
      { id: "CAT-225" },
    ],
    dispatchTsByTicket: new Map([["CAT-216", now - 1000]]),
    now,
    stallMs: 10 * 60_000,
  });
  expect(result).toEqual({ offenders: ["CAT-223"], unknownAge: 1 });
});
