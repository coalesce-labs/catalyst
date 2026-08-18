// agent-liveness.test.mjs — CTL-1994.
// Run: node plugins/dev/scripts/lib/agent-liveness.test.mjs
//
// The whole point of this module is that the restart policy is knowable BEFORE
// an outage rather than discovered during one, so every case below is a real
// failure shape from 2026-08-18 or a boundary that would silently change
// behaviour if it moved.
import assert from "node:assert/strict";
import {
  OVERLOADED_STATUSES, statusOf, isOverloadedResult, isOverloadedError, backoffMs,
  assertSdkAuth, classifyHeartbeat, LIVENESS, decideRestart, isScopeActive,
  classifyStatusDoc, RESTART_CAP_PER_HOUR,
} from "./agent-liveness.mjs";

let passes = 0, failures = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS: ${name}`); passes++; }
  catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failures++; }
}
const fixedRandom = () => 1; // full ceiling, so jitter never makes a test flaky

console.log("1. overload classification");
t("429 and 529 are the overload statuses", () => {
  assert.deepEqual([...OVERLOADED_STATUSES].sort(), [429, 529]);
});
t("statusOf reads every shape the SDK/API uses", () => {
  assert.equal(statusOf({ api_error_status: 529 }), 529);
  assert.equal(statusOf({ status: 429 }), 429);
  assert.equal(statusOf({ statusCode: 529 }), 529);
  assert.equal(statusOf({ error: { status: 429 } }), 429);
  assert.equal(statusOf({}), null);
  assert.equal(statusOf(null), null);
});
t("a 529 result is overloaded; a 500 result is not", () => {
  assert.equal(isOverloadedResult({ status: 529 }), true);
  assert.equal(isOverloadedResult({ error: { type: "overloaded_error" } }), true);
  assert.equal(isOverloadedResult({ status: 500 }), false);
  assert.equal(isOverloadedResult(null), false);
});
t("a thrown 529 is overloaded, including via the message fallback", () => {
  assert.equal(isOverloadedError({ status: 529 }), true);
  assert.equal(isOverloadedError(new Error("Overloaded")), true);
  assert.equal(isOverloadedError(new Error("API error 429")), true);
  assert.equal(isOverloadedError(new Error("boom")), false);
});
t("the message fallback respects word boundaries", () => {
  // Without \b, "1529 turns" would read as a 529 and back off for 15 minutes.
  assert.equal(isOverloadedError(new Error("stopped after 1529 turns")), false);
});

console.log("2. backoff");
t("backoff grows exponentially and then caps", () => {
  const o = { baseMs: 1000, capMs: 30000, random: fixedRandom };
  assert.equal(backoffMs(0, o), 1000);
  assert.equal(backoffMs(1, o), 2000);
  assert.equal(backoffMs(2, o), 4000);
  assert.equal(backoffMs(20, o), 30000); // capped, not 1000·2^20
});
t("jitter is bounded to 50%-100% of the ceiling", () => {
  const o = { baseMs: 1000, capMs: 30000 };
  // ceiling at i=3 is baseMs·2^3 = 8000
  assert.equal(backoffMs(3, { ...o, random: () => 0 }), 4000);
  assert.equal(backoffMs(3, { ...o, random: () => 1 }), 8000);
});

console.log("3. auth — refuse loudly rather than meter silently");
t("an API key refuses, because it outranks the OAuth token and bills", () => {
  const r = assertSdkAuth({ env: { ANTHROPIC_API_KEY: "sk-x" }, oauthToken: "oat" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /meter/);
});
t("an auth token refuses", () => {
  assert.equal(assertSdkAuth({ env: { ANTHROPIC_AUTH_TOKEN: "t" }, oauthToken: "oat" }).ok, false);
});
t("a missing OAuth token refuses", () => {
  assert.equal(assertSdkAuth({ env: {}, oauthToken: null }).ok, false);
});
t("a clean subscription env passes", () => {
  assert.deepEqual(assertSdkAuth({ env: {}, oauthToken: "oat" }), { ok: true, reason: null });
});

console.log("4. heartbeat — 'quiet' and 'dead' must be different states");
const now = 1_700_000_000_000;
t("a fresh heartbeat is live", () => {
  assert.equal(classifyHeartbeat({ ts: now - 60_000 }, { now }).state, LIVENESS.LIVE);
});
t("10 min is silent, 30 min is dead — boundaries inclusive", () => {
  assert.equal(classifyHeartbeat({ ts: now - 10 * 60_000 }, { now }).state, LIVENESS.SILENT);
  assert.equal(classifyHeartbeat({ ts: now - 30 * 60_000 }, { now }).state, LIVENESS.DEAD);
  assert.equal(classifyHeartbeat({ ts: now - (10 * 60_000 - 1) }, { now }).state, LIVENESS.LIVE);
});
t("a MISSING heartbeat is never LIVE", () => {
  // Defaulting absence to healthy is exactly how a dead role hides.
  assert.equal(classifyHeartbeat(null, { now }).state, LIVENESS.MISSING);
  assert.equal(classifyHeartbeat({}, { now }).state, LIVENESS.MISSING);
});
t("classify refuses to read the clock itself", () => {
  assert.throws(() => classifyHeartbeat({ ts: now }), /`now`/);
});

console.log("5. restart policy — the 2026-08-18 failure shapes");
t("a provider 529 resumes the SAME session and never re-pastes the brief", () => {
  const d = decideRestart({ exitCode: 1, overloaded: true, attempt: 0, random: fixedRandom });
  assert.equal(d.action, "resume");
  assert.equal(d.sameSession, true);
  assert.equal(d.waitMs, 60_000);
});
t("the overload ladder is 60s → 2m → 5m → 15m and then holds", () => {
  const w = (a) => decideRestart({ exitCode: 1, overloaded: true, attempt: a, random: fixedRandom }).waitMs;
  assert.deepEqual([w(0), w(1), w(2), w(3), w(9)], [60_000, 120_000, 300_000, 900_000, 900_000]);
});
t("a crash restarts from the handoff with a FRESH session", () => {
  const d = decideRestart({ exitCode: 9, attempt: 0, random: fixedRandom });
  assert.equal(d.action, "restart");
  assert.equal(d.sameSession, false);
});
t("a clean exit while the scope is active is re-entered, not left down", () => {
  // This is print mode's failure: the run ends the moment the agent waits.
  const d = decideRestart({ exitCode: 0, scopeActive: true });
  assert.equal(d.action, "idle-reenter");
});
t("a clean exit with a quiet scope stays down", () => {
  assert.equal(decideRestart({ exitCode: 0, scopeActive: false }).action, "stop");
});
t("idle re-entry is bounded — the 4th in an hour hands off instead", () => {
  const d = decideRestart({ exitCode: 0, scopeActive: true, reentriesLastHour: 3 });
  assert.equal(d.action, "restart");
  assert.match(d.reason, /handing off/);
});
t("a restart storm stops and pages instead of looping", () => {
  const d = decideRestart({ exitCode: 1, restartsLastHour: RESTART_CAP_PER_HOUR });
  assert.equal(d.action, "stop");
  assert.match(d.reason, /cap/);
});
t("quota exhaustion waits 15 min — no relaunch storm", () => {
  const d = decideRestart({ exitCode: 1, quotaExhausted: true });
  assert.equal(d.action, "restart");
  assert.equal(d.waitMs, 15 * 60_000);
});
t("an explicit stop outranks everything, including an active scope", () => {
  const d = decideRestart({ exitCode: 0, stopRequested: true, scopeActive: true, overloaded: true });
  assert.equal(d.action, "stop");
});
t("the restart cap outranks an overload — a storm is worse than a down role", () => {
  const d = decideRestart({ exitCode: 1, overloaded: true, restartsLastHour: 99 });
  assert.equal(d.action, "stop");
});
t("overload backoff is jittered, so N lanes that died together do not retry together", () => {
  const lo = decideRestart({ exitCode: 1, overloaded: true, attempt: 0, random: () => 0 }).waitMs;
  const hi = decideRestart({ exitCode: 1, overloaded: true, attempt: 0, random: () => 1 }).waitMs;
  assert.equal(lo, 30_000);
  assert.equal(hi, 60_000);
  assert.notEqual(lo, hi);
});

console.log("6. 'active' is computable, not a judgement call");
t("any one of the three signals makes a scope active", () => {
  assert.equal(isScopeActive({ inFlightTickets: 1 }), true);
  assert.equal(isScopeActive({ openAsksRaised: 1 }), true);
  assert.equal(isScopeActive({ humanCommentNewerThanLastReply: true }), true);
  assert.equal(isScopeActive({}), false);
});

console.log("7. status-doc cadence is computed from the doc, not remembered");
t("90 min due, 2 h stale, under 90 min current", () => {
  const c = (mins) => classifyStatusDoc({ updatedAtMs: now - mins * 60_000, now }).state;
  assert.equal(c(10), "current");
  assert.equal(c(90), "due");
  assert.equal(c(120), "stale");
});
t("a missing status doc is 'missing' and always due", () => {
  const r = classifyStatusDoc({ now });
  assert.equal(r.state, "missing");
  assert.equal(r.dueForUpdate, true);
});
t("a quiet scope relaxes to 24 h", () => {
  assert.equal(classifyStatusDoc({ updatedAtMs: now - 3 * 60 * 60_000, now, scopeActive: false }).state, "current");
  assert.equal(classifyStatusDoc({ updatedAtMs: now - 25 * 60 * 60_000, now, scopeActive: false }).state, "due");
});

console.log(`\nagent-liveness.test.mjs: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
