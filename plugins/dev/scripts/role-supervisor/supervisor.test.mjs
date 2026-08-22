// supervisor.test.mjs — CTL-1994. Drives the whole restart ladder with a fake
// session runner and a scratch CATALYST_DIR, so no real SDK call, no network,
// and no touching the operator's real ~/catalyst.
//
// The point of the fake is that the outage behaviour is testable BEFORE an
// outage. On 2026-08-18 the answer to "what happens when the provider returns
// 529?" was "a human notices, eventually" — these cases are that answer,
// written down.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseRole, buildResumePrompt, buildIdleReentryPrompt } from "./supervisor.mjs";
import { writeManifest, readHeartbeat, readCounters, acquireLease, releaseLease, readLease } from "./state.mjs";
import { roleFiles } from "./paths.mjs";

let passes = 0, failures = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  PASS: ${name}`); passes++; }
  catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failures++; }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "role-supervisor-test-"));
  // A scratch CATALYST_DIR, never the real one.
  const env = { CATALYST_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: "test-oat" };
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedRole(env, role, manifest = {}) {
  mkdirSync(roleFiles(role, env).dir, { recursive: true });
  writeManifest(role, { role, scope: "P13", skill: "catalyst-dev:steward", cwd: "/tmp", activity: {}, ...manifest }, env);
}

const noSleep = async () => {};

console.log("1. the happy path stops when the scope is quiet");
await t("a clean exit with no work in flight stops, and does not loop", async () => {
  const s = scratch();
  seedRole(s.env, "steward-quiet", { activity: {} });
  let calls = 0;
  const r = await superviseRole("steward-quiet", {
    env: s.env, sleep: noSleep, log: () => {},
    runSession: async () => { calls++; return { exitCode: 0, sessionId: "sess-1" }; },
  });
  assert.equal(calls, 1);
  assert.match(r.stopped, /quiet/);
  s.cleanup();
});

console.log("2. the 529 that killed seven lanes");
await t("an overloaded session RESUMES the same session and never re-pastes the brief", async () => {
  const s = scratch();
  seedRole(s.env, "steward-529", { activity: { inFlightTickets: 2 } });
  const prompts = [];
  let calls = 0;
  await superviseRole("steward-529", {
    env: s.env, sleep: noSleep, log: () => {}, maxIterations: 3,
    runSession: async ({ prompt, resumeSessionId }) => {
      prompts.push({ prompt, resumeSessionId });
      calls++;
      return { exitCode: 1, overloaded: true, sessionId: "sess-529" };
    },
  });
  assert.equal(calls, 3);
  // The first call boots with the brief; every later call is a re-entry that
  // carries the session id — NOT the brief again.
  assert.equal(prompts[0].resumeSessionId, null);
  assert.equal(prompts[1].resumeSessionId, "sess-529");
  assert.equal(prompts[2].resumeSessionId, "sess-529");
  s.cleanup();
});

console.log("3. print mode's failure: stopping while the scope is active");
await t("a clean exit with work in flight is re-entered, not left down", async () => {
  const s = scratch();
  seedRole(s.env, "steward-idle", { activity: { inFlightTickets: 1 } });
  let calls = 0;
  await superviseRole("steward-idle", {
    env: s.env, sleep: noSleep, log: () => {}, maxIterations: 2,
    runSession: async () => { calls++; return { exitCode: 0, sessionId: "sess-idle" }; },
  });
  assert.equal(calls, 2);
  const c = readCounters("steward-idle", s.env);
  assert.equal(c.reentries.length >= 1, true, "the re-entry should be counted, so the 3/hour cap can bite");
  s.cleanup();
});

console.log("4. storm caps");
await t("a restart storm stops and pages rather than looping forever", async () => {
  const s = scratch();
  seedRole(s.env, "steward-storm", { activity: { inFlightTickets: 1 } });
  let calls = 0;
  const r = await superviseRole("steward-storm", {
    env: s.env, sleep: noSleep, log: () => {}, maxIterations: 50,
    runSession: async () => { calls++; return { exitCode: 3 }; },
  });
  // 5 restarts allowed in an hour, then it stops — it must NOT run 50 times.
  assert.equal(calls <= 6, true, `expected the cap to bite; ran ${calls} sessions`);
  assert.match(r.stopped, /cap|restarts/);
  s.cleanup();
});

console.log("5. a thrown error is a crash, not an escape hatch");
await t("runSession throwing is classified, not propagated", async () => {
  const s = scratch();
  seedRole(s.env, "steward-throw", { activity: {} });
  let calls = 0;
  const r = await superviseRole("steward-throw", {
    env: s.env, sleep: noSleep, log: () => {}, maxIterations: 10,
    runSession: async () => { calls++; throw new Error("kaboom"); },
  });
  assert.equal(calls > 1, true, "a crash must be retried, not swallowed as a clean stop");
  assert.match(r.stopped, /cap|restarts/);
  s.cleanup();
});

console.log("6. auth — refuse loudly rather than meter silently");
await t("an ANTHROPIC_API_KEY in the env refuses to start the role", async () => {
  const s = scratch();
  seedRole(s.env, "steward-auth", {});
  await assert.rejects(
    () => superviseRole("steward-auth", { env: { ...s.env, ANTHROPIC_API_KEY: "sk-x" }, runSession: async () => ({ exitCode: 0 }) }),
    /ANTHROPIC_API_KEY/,
  );
  s.cleanup();
});

console.log("7. the lease — one live process per role");
await t("a second supervisor refuses while a live pid holds the lease", async () => {
  const s = scratch();
  seedRole(s.env, "steward-lease", {});
  // process.ppid is a REAL, live pid that is not ours — so the supervisor's own
  // liveness probe (which is the production one, not a fake) genuinely sees a
  // live holder. Seeding a made-up pid would be taken as a stale lease, which
  // is correct behaviour and would prove nothing.
  const first = acquireLease("steward-lease", { pid: process.ppid }, s.env);
  assert.equal(first.ok, true);
  await assert.rejects(
    () => superviseRole("steward-lease", { env: s.env, runSession: async () => ({ exitCode: 0 }) }),
    /already held/,
  );
  s.cleanup();
});
await t("a STALE lease is takeable — a kill -9 must not lock the role out forever", async () => {
  const s = scratch();
  seedRole(s.env, "steward-stale", {});
  acquireLease("steward-stale", { pid: 999999, isAlive: () => false }, s.env);
  const r = await superviseRole("steward-stale", {
    env: s.env, sleep: noSleep, log: () => {},
    runSession: async () => ({ exitCode: 0 }),
  });
  assert.ok(r.stopped);
  s.cleanup();
});
await t("the lease is released when the role stops", async () => {
  const s = scratch();
  seedRole(s.env, "steward-release", {});
  await superviseRole("steward-release", { env: s.env, sleep: noSleep, log: () => {}, runSession: async () => ({ exitCode: 0 }) });
  assert.equal(readLease("steward-release", s.env), null);
  s.cleanup();
});

console.log("8. the heartbeat is written, and carries what it needs to");
await t("a heartbeat exists after a run and names the pid and state", async () => {
  const s = scratch();
  seedRole(s.env, "steward-hb", {});
  await superviseRole("steward-hb", { env: s.env, sleep: noSleep, log: () => {}, runSession: async () => ({ exitCode: 0, sessionId: "sess-hb" }) });
  const hb = readHeartbeat("steward-hb", s.env);
  assert.equal(hb.role, "steward-hb");
  assert.equal(hb.pid, process.pid);
  assert.equal(typeof hb.ts, "number");
  assert.equal(hb.state, "stopped");
  s.cleanup();
});

await t("the heartbeat is REFRESHED while a long session runs, so a live role is not read as silent", async () => {
  const s = scratch();
  seedRole(s.env, "steward-live", { activity: {} });
  let bootTs = null, midTs = null, midState = null;
  await superviseRole("steward-live", {
    env: s.env, sleep: noSleep, log: () => {},
    // Refresh far faster than the real 5-minute cadence so the test stays quick.
    livenessRefreshMs: 5,
    runSession: async () => {
      bootTs = readHeartbeat("steward-live", s.env).ts; // the boundary (pre-session) beat
      await new Promise((r) => setTimeout(r, 60));       // a "long" (>refresh) session
      const hb = readHeartbeat("steward-live", s.env);
      midTs = hb.ts;
      midState = hb.state;
      return { exitCode: 0, sessionId: "sess-live" };
    },
  });
  assert.equal(midState, "running", "the in-session refresh keeps the state 'running'");
  assert.equal(midTs > bootTs, true, "the in-session heartbeat must be newer than the boundary one");
  s.cleanup();
});
await t("livenessRefreshMs:0 disables the in-session refresh (the boundary beat is the only one)", async () => {
  const s = scratch();
  seedRole(s.env, "steward-norefresh", { activity: {} });
  let bootTs = null, midTs = null;
  await superviseRole("steward-norefresh", {
    env: s.env, sleep: noSleep, log: () => {}, livenessRefreshMs: 0,
    runSession: async () => {
      bootTs = readHeartbeat("steward-norefresh", s.env).ts;
      await new Promise((r) => setTimeout(r, 30));
      midTs = readHeartbeat("steward-norefresh", s.env).ts;
      return { exitCode: 0, sessionId: "sess-nr" };
    },
  });
  assert.equal(midTs, bootTs, "with refresh disabled the heartbeat does not advance mid-session");
  s.cleanup();
});

console.log("9. the resume prompt tells the role it was restarted");
await t("a restarted role is told to state what it resumed from", () => {
  const p = buildResumePrompt({ role: "steward", scope: "P13", skill: "catalyst-dev:steward" }, { resumedFrom: "handoff.md", reason: "529" });
  assert.match(p, /RESTARTED/);
  assert.match(p, /resumed from/);
  assert.match(p, /replica wins/);
});
await t("a first boot is NOT told it was restarted", () => {
  const p = buildResumePrompt({ role: "steward", scope: "P13", skill: "catalyst-dev:steward" }, {});
  assert.doesNotMatch(p, /RESTARTED/);
});
await t("the idle re-entry does not ask the role to start over", () => {
  const p = buildIdleReentryPrompt();
  assert.match(p, /do not start over/);
});

// ── CTL-2095: manifest re-read after session ─────────────────────────────────
console.log("10. manifest re-read: the supervisor honours a mid-session complete()");
await t("a steward that marks itself complete mid-session is stopped, not re-entered", async () => {
  const s = scratch();
  // Scope starts active.
  seedRole(s.env, "steward-complete", { activity: { inFlightTickets: 1 } });
  let calls = 0;
  const r = await superviseRole("steward-complete", {
    env: s.env, sleep: noSleep, log: () => {},
    runSession: async () => {
      calls++;
      // Simulate the steward calling `role-supervisor complete` during its turn.
      const { writeActivity, markComplete } = await import("./state.mjs");
      markComplete("steward-complete", s.env);
      return { exitCode: 0, sessionId: "sess-complete" };
    },
  });
  // The supervisor re-reads the manifest post-session, sees scope_active:false,
  // and decides "stop" — not "idle-reenter".
  assert.equal(calls, 1, "should run exactly one session and then stop");
  assert.match(r.stopped, /quiet|scope/, `expected a quiet-scope stop reason, got '${r.stopped}'`);
  s.cleanup();
});

await t("control: scope still active after session → idle-reenter, not stop", async () => {
  const s = scratch();
  seedRole(s.env, "steward-reenter", { activity: { inFlightTickets: 1 } });
  let calls = 0;
  await superviseRole("steward-reenter", {
    env: s.env, sleep: noSleep, log: () => {}, maxIterations: 2,
    runSession: async () => {
      calls++;
      // The steward does NOT call complete — scope remains active.
      return { exitCode: 0, sessionId: "sess-active" };
    },
  });
  // Should have re-entered (run more than once) because the scope stayed active.
  assert.equal(calls, 2, "should re-enter while scope remains active");
  s.cleanup();
});

console.log(`\nsupervisor.test.mjs: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
