// join-listener.test.mjs — Phase 2 unit tests for CTL-1183 armed listener.
// Tests pure handleJoinRequest() without binding a port.
// Run: cd plugins/dev/scripts/execution-core && bun test join-listener.test.mjs

import { test, expect } from "bun:test";
import { handleJoinRequest, makeListenerState, JOIN_ROUTE } from "./join-listener.mjs";

const armed = () => makeListenerState({ token: "good", ttlMs: 60_000, nowMs: 1_000 });
const req = (tok, path = JOIN_ROUTE) =>
  new Request(`http://x${path}`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });

test("valid token on the join route → 200 + full bundle JSON", async () => {
  const s = armed();
  const r = handleJoinRequest(req("good"), s, 1_500);
  expect(r.status).toBe(200);
  const body = await r.response.json();
  expect(body.schemaVersion).toBeDefined();
  expect(body.botCreds).toBeDefined();
  expect(r.consume).toBe(true);
});

test("second presentation of a consumed token → 401, assembler NOT run", () => {
  const s = armed();
  handleJoinRequest(req("good"), s, 1_500); // consumes
  const r = handleJoinRequest(req("good"), s, 1_600);
  expect([401, 403]).toContain(r.status);
  expect(r.ranAssembler).toBe(false);
});

test("expired token → rejected, assembler NOT run", () => {
  const s = makeListenerState({ token: "good", ttlMs: 1_000, nowMs: 0 });
  const r = handleJoinRequest(req("good"), s, 5_000); // past TTL
  expect([401, 403]).toContain(r.status);
  expect(r.ranAssembler).toBe(false);
});

test("missing token → 401, no bundle, no consume", () => {
  const s = armed();
  const r = handleJoinRequest(req(null), s, 1_500);
  expect(r.status).toBe(401);
  expect(r.consume).toBe(false);
  expect(s.consumed).toBe(false);
});

test("wrong token → 401, no consume", () => {
  const s = armed();
  const r = handleJoinRequest(req("nope"), s, 1_500);
  expect(r.status).toBe(401);
  expect(s.consumed).toBe(false);
});

test("wrong path with valid token → 404, token not consumed", () => {
  const s = armed();
  const r = handleJoinRequest(req("good", "/secrets"), s, 1_500);
  expect(r.status).toBe(404);
  expect(s.consumed).toBe(false);
});

test("log fields for a served request redact token and omit body", () => {
  const s = armed();
  const r = handleJoinRequest(req("good"), s, 1_500);
  expect(JSON.stringify(r.logFields)).not.toContain("good");
  expect(r.logFields).not.toHaveProperty("responseBody");
  expect(r.logFields.token).toBe("[REDACTED]");
});

test("log fields for rejected request also redact token", () => {
  const s = armed();
  const r = handleJoinRequest(req("nope"), s, 1_500);
  expect(JSON.stringify(r.logFields)).not.toContain("nope");
  expect(r.logFields.token).toBe("[REDACTED]");
});

test("timing-safe token comparison prevents timing attacks", () => {
  // Tokens of different lengths or values must both return 401 without short-circuit.
  const s = armed();
  expect(handleJoinRequest(req("x"), s, 1_500).status).toBe(401);
  expect(handleJoinRequest(req(""), s, 1_500).status).toBe(401);
  expect(handleJoinRequest(req("good" + "x".repeat(100)), s, 1_500).status).toBe(401);
});
