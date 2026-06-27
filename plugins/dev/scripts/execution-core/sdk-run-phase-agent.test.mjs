// sdk-run-phase-agent.test.mjs — CTL-1365b. Fully OFFLINE: every test injects a
// fake runQuery (no real @anthropic-ai/claude-agent-sdk, no network) and a fake
// spawn for the shared pre-launch (no real phase-agent-dispatch / git / claude).
//
// Run: cd plugins/dev/scripts/execution-core && bun test sdk-run-phase-agent.test.mjs

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sdkRunPhaseAgent,
  assertSdkAuth,
  buildSdkEnv,
  buildQueryOptions,
  resolveMaxParallel,
  Semaphore,
  scrubSecrets,
  defaultEmitBackstop,
} from "./sdk-run-phase-agent.mjs";

// ── Fakes ───────────────────────────────────────────────────────────────────

// makeSpec — a canonical prelaunch-only launch spec (the shape phase-agent-dispatch
// emits in --launch-mode prelaunch-only).
const makeSpec = (over = {}) => ({
  ticket: "CTL-100",
  phase: "implement",
  model: "opus",
  turnCap: 200,
  bg_job_id: null,
  prompt: "/catalyst-dev:phase-implement CTL-100 --orch-dir /ec",
  signalFile: "/ec/workers/CTL-100/phase-implement.json",
  sessionName: "CTL-100 implement",
  attempt: 1,
  worktreePath: "/wt/CTL-100",
  generation: 1,
  resumeSession: null,
  pluginDirs: [],
  env: [
    "CATALYST_ORCHESTRATOR_DIR=/ec",
    "CATALYST_ORCHESTRATOR_ID=CTL-100",
    "CATALYST_PHASE=implement",
    "CATALYST_TICKET=CTL-100",
    "CATALYST_GENERATION=1",
    "CATALYST_CLUSTER_GENERATION=",
    "OTEL_RESOURCE_ATTRIBUTES=linear.key=CTL-100,task.type=phase-implement",
  ],
  settings: {},
  status: "prelaunch-ready",
  launchMode: "prelaunch-only",
  dryRun: false,
  ...over,
});

// spawnReturningSpec — a fake spawnSync for the prelaunch that records its calls,
// optionally writes a signal file (to prove the claim+signal precede query), and
// prints the given spec on stdout. `onPrelaunch` lets a test observe filesystem
// state at prelaunch time.
function spawnReturningSpec({ spec = makeSpec(), code = 0, signalFile, onPrelaunch } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    // Only the prelaunch (phase-agent-dispatch) writes a signal; the backstop
    // emit (phase-agent-emit-complete) is recorded but writes nothing.
    if (bin.endsWith("phase-agent-dispatch")) {
      if (signalFile) {
        writeFileSync(signalFile, JSON.stringify({ status: "dispatched", generation: spec.generation, bg_job_id: null }));
      }
      if (onPrelaunch) onPrelaunch();
      return { status: code, stdout: `${JSON.stringify(spec)}\n`, stderr: "", error: null };
    }
    return { status: 0, stdout: "", stderr: "", error: null };
  };
  return { spawn, calls };
}

// fakeQuery — an async-iterable factory yielding the given messages. Records the
// prompt + options it was called with.
function fakeQuery(messages, sink) {
  return ({ prompt, options }) => {
    if (sink) {
      sink.prompt = prompt;
      sink.options = options;
      sink.calls = (sink.calls ?? 0) + 1;
    }
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

const resultMsg = (over = {}) => ({ type: "result", subtype: "success", is_error: false, result: "done", ...over });

const ARGS = { orchDir: "/ec", ticket: "CTL-100", phase: "implement", worktreePath: "/wt/CTL-100" };
const GOOD_AUTH = { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, oauthToken: "tok" };

// ── assertSdkAuth ─────────────────────────────────────────────────────────────

describe("assertSdkAuth", () => {
  test("ok when only CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    expect(assertSdkAuth({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, oauthToken: "t" }).ok).toBe(true);
  });
  test("refuses when ANTHROPIC_API_KEY is set (would silently meter)", () => {
    const r = assertSdkAuth({ env: { ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "t" }, oauthToken: "t" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ANTHROPIC_API_KEY");
  });
  test("refuses when ANTHROPIC_AUTH_TOKEN is set", () => {
    const r = assertSdkAuth({ env: { ANTHROPIC_AUTH_TOKEN: "x", CLAUDE_CODE_OAUTH_TOKEN: "t" }, oauthToken: "t" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ANTHROPIC_AUTH_TOKEN");
  });
  test("refuses when the OAuth token is missing", () => {
    const r = assertSdkAuth({ env: {}, oauthToken: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

// ── buildSdkEnv (auth guards + plain env) ─────────────────────────────────────

describe("buildSdkEnv", () => {
  test("merges the spec env array over the base and applies the auth guards", () => {
    const env = buildSdkEnv(makeSpec().env, {
      base: { ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "x", PATH: "/bin" },
      oauthToken: "tok",
    });
    // CATALYST_* + fencing token + OTEL attrs all present (plain env, Contract 3).
    expect(env.CATALYST_ORCHESTRATOR_DIR).toBe("/ec");
    expect(env.CATALYST_PHASE).toBe("implement");
    expect(env.CATALYST_GENERATION).toBe("1");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain("linear.key=CTL-100");
    // Auth guards: API key + auth token stripped, OAuth token set.
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    // Base env preserved.
    expect(env.PATH).toBe("/bin");
  });
});

// ── buildQueryOptions (never --bare, settingSources never []) ─────────────────

describe("buildQueryOptions", () => {
  test("settingSources is ['user','project'] and --bare is never set", () => {
    const o = buildQueryOptions(makeSpec(), { CLAUDE_CODE_OAUTH_TOKEN: "t" }, { turnCap: 50 });
    expect(o.settingSources).toEqual(["user", "project"]);
    expect(o.settingSources).not.toEqual([]);
    expect("bare" in o).toBe(false);
    expect(o.cwd).toBe("/wt/CTL-100");
    expect(o.executable).toBe("bun");
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.maxTurns).toBe(50);
  });
  test("resume is passed iff resumeSession is set, with cwd === worktreePath", () => {
    expect("resume" in buildQueryOptions(makeSpec(), {}, {})).toBe(false);
    const o = buildQueryOptions(makeSpec({ resumeSession: "sess-abc" }), {}, {});
    expect(o.resume).toBe("sess-abc");
    expect(o.cwd).toBe("/wt/CTL-100");
  });
});

// ── resolveMaxParallel + Semaphore ────────────────────────────────────────────

describe("resolveMaxParallel", () => {
  test("CATALYST_SDK_MAX_PARALLEL > CATALYST_MAX_PARALLEL > default 3", () => {
    expect(resolveMaxParallel({})).toBe(3);
    expect(resolveMaxParallel({ CATALYST_MAX_PARALLEL: "5" })).toBe(5);
    expect(resolveMaxParallel({ CATALYST_MAX_PARALLEL: "5", CATALYST_SDK_MAX_PARALLEL: "2" })).toBe(2);
    expect(resolveMaxParallel({ CATALYST_SDK_MAX_PARALLEL: "0" })).toBe(3); // floor
  });
});

describe("Semaphore", () => {
  test("never lets active exceed max", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

// ── sdkRunPhaseAgent: the three contracts + reuse of the shared pre-launch ────

describe("sdkRunPhaseAgent — shared pre-launch reuse", () => {
  let dir;
  test("runs phase-agent-dispatch in prelaunch-only mode, and the claim+signal+generation exist BEFORE query()", async () => {
    dir = mkdtempSync(join(tmpdir(), "sdk-pre-"));
    const signalFile = join(dir, "phase-implement.json");
    let signalExistedAtQuery = false;
    const { spawn, calls } = spawnReturningSpec({ signalFile });
    const sink = {};
    const runQuery = ({ prompt, options }) => {
      // Prove the shared pre-launch ran (signal written) BEFORE the launch verb.
      signalExistedAtQuery = existsSync(signalFile);
      sink.prompt = prompt;
      sink.options = options;
      return (async function* () { yield resultMsg(); })();
    };
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, runQuery, spawn });
    expect(r.code).toBe(0);
    // The pre-launch was the prelaunch-only invocation of phase-agent-dispatch.
    const pre = calls.find((c) => c.bin.endsWith("phase-agent-dispatch"));
    expect(pre).toBeTruthy();
    expect(pre.args).toContain("--launch-mode");
    expect(pre.args[pre.args.indexOf("--launch-mode") + 1]).toBe("prelaunch-only");
    expect(pre.args).toEqual(expect.arrayContaining(["--phase", "implement", "--ticket", "CTL-100", "--orch-dir", "/ec"]));
    // cwd of the pre-launch is the worktree.
    expect(pre.opts.cwd).toBe("/wt/CTL-100");
    // Contract 2 ordering: signal (status:dispatched + generation) preceded query().
    expect(signalExistedAtQuery).toBe(true);
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("dispatched");
    // Contract 3: the query() prompt is the phase slash command from the spec.
    expect(sink.prompt).toBe("/catalyst-dev:phase-implement CTL-100 --orch-dir /ec");
    rmSync(dir, { recursive: true, force: true });
  });

  test("return shape matches defaultRunPhaseAgent ({code,stdout,stderr,signal}); signal is null", async () => {
    const { spawn } = spawnReturningSpec();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg({ result: "ok" })]) });
    expect(Object.keys(r).sort()).toEqual(["code", "signal", "stderr", "stdout"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("ok");
    expect(r.signal).toBeNull();
  });

  test("env handed to query() has NO ANTHROPIC_API_KEY and HAS CLAUDE_CODE_OAUTH_TOKEN; never --bare", async () => {
    const { spawn } = spawnReturningSpec();
    const sink = {};
    await sdkRunPhaseAgent(ARGS, {
      env: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      oauthToken: "tok",
      spawn,
      runQuery: fakeQuery([resultMsg()], sink),
    });
    expect("ANTHROPIC_API_KEY" in sink.options.env).toBe(false);
    expect("ANTHROPIC_AUTH_TOKEN" in sink.options.env).toBe(false);
    expect(sink.options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(sink.options.settingSources).toEqual(["user", "project"]);
    expect("bare" in sink.options).toBe(false);
  });
});

// ── Auth refusal: no claim, no query ──────────────────────────────────────────

describe("sdkRunPhaseAgent — auth guard refuses", () => {
  test("refuses (no pre-launch, no query) when ANTHROPIC_API_KEY is set", async () => {
    const { spawn, calls } = spawnReturningSpec();
    const sink = {};
    const events = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      env: { ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "t" },
      oauthToken: "t",
      spawn,
      runQuery: fakeQuery([resultMsg()], sink),
      emitEvent: (name, payload) => events.push([name, payload]),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY");
    expect(calls.length).toBe(0); // never even ran the pre-launch
    expect(sink.calls ?? 0).toBe(0); // never called query()
    expect(events[0][0]).toBe("execution-core.auth.misconfigured");
  });

  test("refuses when the OAuth token is missing", async () => {
    const { spawn, calls } = spawnReturningSpec();
    const r = await sdkRunPhaseAgent(ARGS, {
      env: {},
      oauthToken: undefined,
      spawn,
      runQuery: fakeQuery([resultMsg()]),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(calls.length).toBe(0);
  });
});

// ── Terminal result mapping + backstop emits (Contract 1) ─────────────────────

describe("sdkRunPhaseAgent — result mapping + backstop", () => {
  test("success → code 0, NO backstop (the skill emitted complete itself)", async () => {
    const { spawn } = spawnReturningSpec();
    const backstops = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ result: "great" })]),
      emitBackstop: (e) => backstops.push(e),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("great");
    expect(backstops.length).toBe(0);
  });

  test("error_max_turns → failed result + turn-cap-exhausted backstop", async () => {
    const { spawn } = spawnReturningSpec();
    const backstops = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ subtype: "error_max_turns", is_error: true })]),
      emitBackstop: (e) => backstops.push(e),
    });
    expect(r.code).toBe(1);
    expect(backstops).toHaveLength(1);
    expect(backstops[0].status).toBe("turn-cap-exhausted");
    expect(backstops[0].phase).toBe("implement");
    expect(backstops[0].ticket).toBe("CTL-100");
  });

  test("error subtype → failed result + failed backstop", async () => {
    const { spawn } = spawnReturningSpec();
    const backstops = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ subtype: "error_during_execution", is_error: true })]),
      emitBackstop: (e) => backstops.push(e),
    });
    expect(r.code).toBe(1);
    expect(backstops[0].status).toBe("failed");
  });

  test("a thrown error → failed result + failed backstop", async () => {
    const { spawn } = spawnReturningSpec();
    const backstops = [];
    const runQuery = () => (async function* () { throw new Error("boom"); })();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery, emitBackstop: (e) => backstops.push(e) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("boom");
    expect(backstops[0].status).toBe("failed");
  });

  test("no terminal result → failed result + failed backstop", async () => {
    const { spawn } = spawnReturningSpec();
    const backstops = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([{ type: "system", subtype: "init", session_id: "s1" }]),
      emitBackstop: (e) => backstops.push(e),
    });
    expect(r.code).toBe(1);
    expect(backstops[0].status).toBe("failed");
  });
});

// ── Pre-launch failure surfaces (no query) ────────────────────────────────────

describe("sdkRunPhaseAgent — shared pre-launch failure", () => {
  test("a non-zero / stalled pre-launch returns failed WITHOUT running query()", async () => {
    const spec = makeSpec({ status: "stalled" });
    const { spawn } = spawnReturningSpec({ spec, code: 1 });
    const sink = {};
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()], sink) });
    expect(r.code).toBe(1);
    expect(sink.calls ?? 0).toBe(0); // launch verb never ran — pre-launch owns the failure
  });
});

// ── 429/529 backoff + retry (Contract: never a silent drop) ───────────────────

describe("sdkRunPhaseAgent — 429/529 backoff", () => {
  test("a 529 overload retries with backoff then succeeds; no backstop on success", async () => {
    const { spawn } = spawnReturningSpec();
    let attempt = 0;
    const sleeps = [];
    const events = [];
    const backstops = [];
    const runQuery = () =>
      (async function* () {
        attempt += 1;
        if (attempt < 3) {
          yield resultMsg({ subtype: "error", is_error: true, api_error_status: 529 });
        } else {
          yield resultMsg({ result: "recovered" });
        }
      })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      random: () => 1, // deterministic full-ceiling jitter
      backoff: { baseMs: 10, capMs: 1000 },
      emitEvent: (n, p) => events.push([n, p]),
      emitBackstop: (e) => backstops.push(e),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("recovered");
    expect(attempt).toBe(3); // 2 overloads + 1 success
    expect(sleeps.length).toBe(2); // backed off twice
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]); // exponential
    expect(events.every(([n]) => n === "execution-core.sdk.overloaded")).toBe(true);
    expect(backstops.length).toBe(0); // success → no backstop
  });

  test("a 429 thrown error retries", async () => {
    const { spawn } = spawnReturningSpec();
    let attempt = 0;
    const runQuery = () =>
      (async function* () {
        attempt += 1;
        if (attempt < 2) {
          const err = new Error("rate limited");
          err.status = 429;
          throw err;
        }
        yield resultMsg({ result: "ok" });
      })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery,
      sleep: () => Promise.resolve(),
      backoff: { baseMs: 1, capMs: 2 },
    });
    expect(r.code).toBe(0);
    expect(attempt).toBe(2);
  });

  test("backoff exhaustion → failed result + overloaded event + failed backstop", async () => {
    const { spawn } = spawnReturningSpec();
    const events = [];
    const backstops = [];
    const runQuery = () =>
      (async function* () { yield resultMsg({ subtype: "error", is_error: true, api_error_status: 529 }); })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery,
      sleep: () => Promise.resolve(),
      maxRetries: 2,
      backoff: { baseMs: 1, capMs: 2 },
      emitEvent: (n, p) => events.push([n, p]),
      emitBackstop: (e) => backstops.push(e),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("overloaded");
    expect(events.some(([, p]) => p.exhausted)).toBe(true);
    expect(backstops[0].status).toBe("failed");
    expect(backstops[0].reason).toBe("sdk-overloaded-exhausted");
  });

  test("a 200 success does NOT retry", async () => {
    const { spawn } = spawnReturningSpec();
    let attempt = 0;
    const runQuery = () => (async function* () { attempt += 1; yield resultMsg(); })();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery, sleep: () => Promise.resolve() });
    expect(r.code).toBe(0);
    expect(attempt).toBe(1);
  });
});

// ── Concurrency cap around query() ────────────────────────────────────────────

describe("sdkRunPhaseAgent — concurrency cap", () => {
  test("the injected semaphore caps concurrent query() calls", async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    const runQuery = () =>
      (async function* () {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        yield resultMsg();
      })();
    const run = () => {
      const { spawn } = spawnReturningSpec();
      return sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery, semaphore: sem });
    };
    const results = await Promise.all(Array.from({ length: 6 }, run));
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

// ── CTL-1367 item 10: Semaphore hand-off + re-size invariants ─────────────────

describe("Semaphore — CTL-1367 item 10 (hand-off + re-size)", () => {
  test("stress: under heavy contention active never exceeds max (no decrement→increment gap)", async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await sem.acquire();
      active += 1;
      peak = Math.max(peak, active);
      // Yield across several microtasks to widen any release/acquire race window.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 50 }, task));
    expect(peak).toBe(3); // saturates exactly at the cap, never above
    expect(sem.active).toBe(0); // fully drained — every slot released
  });

  test("setMax(n) re-sizes IN PLACE and does NOT abandon parked waiters", async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire(); // holds the only slot
    let secondAcquired = false;
    const p2 = sem.acquire().then((r) => {
      secondAcquired = true;
      return r;
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false); // parked behind the held slot
    // Raise the cap IN PLACE on the SAME instance — the parked waiter (a promise
    // from this instance) must still resolve when a slot frees (the old
    // re-create-on-resize bug abandoned it forever).
    sem.setMax(2);
    release1(); // free the held slot → hand it to the parked waiter
    const release2 = await p2; // resolves (NOT abandoned)
    expect(secondAcquired).toBe(true);
    release2();
    expect(sem.active).toBe(0);
  });

  test("a released slot is HANDED to the next waiter (active count constant across the handoff)", async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    expect(sem.active).toBe(1);
    const pending = sem.acquire(); // parks
    await Promise.resolve();
    expect(sem.active).toBe(1); // still 1 — the waiter is parked, not counted twice
    r1(); // hand the slot to the waiter — active stays 1 (holder swapped)
    const r2 = await pending;
    expect(sem.active).toBe(1);
    r2();
    expect(sem.active).toBe(0);
  });
});

// ── CTL-1367 item 10 (coverage): slot released on ALL error paths (no deadlock) ─

describe("sdkRunPhaseAgent — semaphore released on every terminal path", () => {
  // After each failing run the cap-1 semaphore must be free, or a follow-up
  // dispatch would deadlock. We run a failing dispatch, then prove a subsequent
  // dispatch through the SAME semaphore still acquires + completes.
  async function runWith(sem, runQuery, extra = {}) {
    const { spawn } = spawnReturningSpec();
    return sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, semaphore: sem,
      sleep: () => Promise.resolve(), backoff: { baseMs: 1, capMs: 2 }, maxRetries: 1,
      emitBackstop: () => {}, ...extra,
    });
  }
  test("throw path frees the slot", async () => {
    const sem = new Semaphore(1);
    await runWith(sem, () => (async function* () { throw new Error("boom"); })());
    expect(sem.active).toBe(0);
    const r = await runWith(sem, fakeQuery([resultMsg({ result: "after" })]));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("after");
    expect(sem.active).toBe(0);
  });
  test("failed-result path frees the slot", async () => {
    const sem = new Semaphore(1);
    await runWith(sem, fakeQuery([resultMsg({ subtype: "error_during_execution", is_error: true })]));
    expect(sem.active).toBe(0);
    const r = await runWith(sem, fakeQuery([resultMsg()]));
    expect(r.code).toBe(0);
    expect(sem.active).toBe(0);
  });
  test("overload-exhausted path frees the slot", async () => {
    const sem = new Semaphore(1);
    await runWith(sem, () => (async function* () {
      yield resultMsg({ subtype: "error", is_error: true, api_error_status: 529 });
    })());
    expect(sem.active).toBe(0);
    const r = await runWith(sem, fakeQuery([resultMsg()]));
    expect(r.code).toBe(0);
    expect(sem.active).toBe(0);
  });
  test("no-result path frees the slot", async () => {
    const sem = new Semaphore(1);
    await runWith(sem, fakeQuery([{ type: "system", subtype: "init" }]));
    expect(sem.active).toBe(0);
    const r = await runWith(sem, fakeQuery([resultMsg()]));
    expect(r.code).toBe(0);
    expect(sem.active).toBe(0);
  });
});

// ── CTL-1367 item 11: secret scrubbing ────────────────────────────────────────

describe("scrubSecrets (CTL-1367 item 11)", () => {
  test("redacts literal secrets passed in", () => {
    const out = scrubSecrets("token is sk-ant-supersecretvalue123 done", ["sk-ant-supersecretvalue123"]);
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain("[redacted]");
  });
  test("redacts token-shaped substrings without a literal", () => {
    expect(scrubSecrets("oops sk-ant-abcd1234efgh5678 leaked")).toContain("[redacted-token]");
    expect(scrubSecrets("lin_oauth_abcdef123456 here")).toContain("[redacted-token]");
    expect(scrubSecrets("ANTHROPIC_API_KEY=sk-zzzzzzzz set")).toContain("ANTHROPIC_API_KEY=[redacted]");
  });
  test("leaves ordinary text untouched and tolerates non-strings", () => {
    expect(scrubSecrets("a normal error message")).toBe("a normal error message");
    expect(scrubSecrets(undefined)).toBeUndefined();
    expect(scrubSecrets("")).toBe("");
  });
  test("sdkRunPhaseAgent scrubs the OAuth token out of a thrown-error stderr", async () => {
    const { spawn } = spawnReturningSpec();
    const runQuery = () => (async function* () { throw new Error("auth failed for CLAUDE_CODE_OAUTH_TOKEN=topsecrettoken9"); })();
    const r = await sdkRunPhaseAgent(ARGS, {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "topsecrettoken9" }, oauthToken: "topsecrettoken9",
      spawn, runQuery, emitBackstop: () => {},
    });
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("topsecrettoken9");
    expect(r.stderr).toContain("[redacted]");
  });
});

// ── CTL-1367 item 6/7/8/13: buildQueryOptions correctness ─────────────────────

describe("buildQueryOptions — CTL-1367 items 6/7/8/13", () => {
  test("maxTurns falls back to spec.turnCap when no explicit override (item 6)", () => {
    const o = buildQueryOptions(makeSpec({ turnCap: 200 }), {}, {}); // no turnCap option
    expect(o.maxTurns).toBe(200);
  });
  test("explicit turnCap option still wins over spec.turnCap (item 6)", () => {
    const o = buildQueryOptions(makeSpec({ turnCap: 200 }), {}, { turnCap: 7 });
    expect(o.maxTurns).toBe(7);
  });
  test("model is pinned from spec.model (item 7)", () => {
    expect(buildQueryOptions(makeSpec({ model: "opus" }), {}, {}).model).toBe("opus");
    expect("model" in buildQueryOptions(makeSpec({ model: "" }), {}, {})).toBe(false);
  });
  test("plugins map spec.pluginDirs → {type:'local',path} (item 8)", () => {
    const o = buildQueryOptions(makeSpec({ pluginDirs: ["/a/plug", "/b/plug"] }), {}, {});
    expect(o.plugins).toEqual([
      { type: "local", path: "/a/plug" },
      { type: "local", path: "/b/plug" },
    ]);
    expect("plugins" in buildQueryOptions(makeSpec({ pluginDirs: [] }), {}, {})).toBe(false);
  });
  test("allowDangerouslySkipPermissions is set alongside bypassPermissions (item 13)", () => {
    const o = buildQueryOptions(makeSpec(), {}, {});
    expect(o.permissionMode).toBe("bypassPermissions");
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });
});

// ── CTL-1367 item 8: buildSdkEnv layers settings.env (telemetry) ──────────────

describe("buildSdkEnv — CTL-1367 item 8 (settings.env telemetry)", () => {
  test("layers spec.settings.env so OTEL_/telemetry keys reach the worker", () => {
    const env = buildSdkEnv(makeSpec().env, {
      base: { PATH: "/bin" },
      oauthToken: "tok",
      settingsEnv: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4317", CLAUDE_CODE_ENABLE_TELEMETRY: "1" },
    });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://otel:4317");
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
  });
  test("the spec.env array wins over settings.env on overlap (post-composition value)", () => {
    const env = buildSdkEnv(["OTEL_RESOURCE_ATTRIBUTES=fromArray"], {
      base: {},
      oauthToken: "tok",
      settingsEnv: { OTEL_RESOURCE_ATTRIBUTES: "fromSettings" },
    });
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("fromArray");
  });
  test("sdkRunPhaseAgent forwards settings.env into the query() env end-to-end", async () => {
    const spec = makeSpec({ settings: { env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4317" } } });
    const { spawn } = spawnReturningSpec({ spec });
    const sink = {};
    await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()], sink) });
    expect(sink.options.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(sink.options.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://x:4317");
  });
});

// ── CTL-1367 item 18: idempotent prelaunch exits are no-ops, not failures ──────

describe("sdkRunPhaseAgent — CTL-1367 item 18 (idempotent prelaunch)", () => {
  test("a claim-lost prelaunch returns code 0 and NEVER runs query()", async () => {
    const spec = makeSpec({ status: "claim-lost", idempotent: true });
    const { spawn } = spawnReturningSpec({ spec });
    const sink = {};
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()], sink) });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(sink.calls ?? 0).toBe(0); // no query — the winner owns the phase
  });
  test("an existing dispatched/running signal (idempotent) returns code 0, no query", async () => {
    const spec = makeSpec({ status: "running", idempotent: true });
    const { spawn } = spawnReturningSpec({ spec });
    const sink = {};
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()], sink) });
    expect(r.code).toBe(0);
    expect(sink.calls ?? 0).toBe(0);
  });
});

// ── CTL-1367 item 14: yielded error result mapped before the generic throw ────

describe("sdkRunPhaseAgent — CTL-1367 item 14 (result-before-throw)", () => {
  test("error_max_turns yielded THEN the iterator raises → turn-cap-exhausted (not sdk-threw)", async () => {
    const { spawn } = spawnReturningSpec();
    const backstops = [];
    // A single-message query that yields the terminal error result, then throws on
    // the NEXT iteration (iterator cleanup) — the captured result is the real outcome.
    const runQuery = () => (async function* () {
      yield resultMsg({ subtype: "error_max_turns", is_error: true });
      throw new Error("generator cleanup raised");
    })();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery, emitBackstop: (e) => backstops.push(e) });
    expect(r.code).toBe(1);
    expect(backstops).toHaveLength(1);
    expect(backstops[0].status).toBe("turn-cap-exhausted"); // NOT "failed"/sdk-threw
  });
});

// ── CTL-1367 item 4: backstop flips the signal to stalled ─────────────────────

describe("sdkRunPhaseAgent — CTL-1367 item 4 (backstop → stalled signal)", () => {
  test("an abnormal termination flips the prelaunch signal from dispatched → stalled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-stall-"));
    const signalFile = join(dir, "phase-implement.json");
    // The prelaunch writes a dispatched signal at this path; the spec.signalFile
    // carries it so the backstop knows which file to flip.
    const spec = makeSpec({ signalFile });
    const { spawn } = spawnReturningSpec({ spec, signalFile });
    const runQuery = () => (async function* () { throw new Error("worker died"); })();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery });
    expect(r.code).toBe(1);
    const after = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(after.status).toBe("stalled");
    expect(after.attentionReason).toBe("sdk-threw"); // NOT failureReason (revive retries)
    expect("failureReason" in after).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── CTL-1367 item 5: backstop checks its emit + falls back to event-log append ─

describe("defaultEmitBackstop — CTL-1367 item 5 (no silent drop)", () => {
  test("a failing emit binary falls back to a direct event-log append", () => {
    const appends = [];
    const stalls = [];
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-1", status: "failed", reason: "sdk-threw", orchDir: "/ec", signalFile: "/ec/s.json" },
      {
        spawn: () => ({ status: 1, error: null }), // emit exits non-zero
        writeSignalStalled: (f, r) => stalls.push([f, r]),
        appendEventLog: (e) => appends.push(e),
      },
    );
    expect(stalls).toEqual([["/ec/s.json", "sdk-threw"]]);
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ phase: "implement", ticket: "CTL-1", status: "failed" });
  });
  test("a spawn ENOENT (binary missing) also triggers the fallback append", () => {
    const appends = [];
    defaultEmitBackstop(
      { phase: "verify", ticket: "CTL-2", status: "turn-cap-exhausted", reason: "x", orchDir: "/ec", signalFile: null },
      {
        spawn: () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }),
        writeSignalStalled: () => {},
        appendEventLog: (e) => appends.push(e),
      },
    );
    expect(appends).toHaveLength(1);
  });
  test("a successful emit does NOT fall back", () => {
    const appends = [];
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-3", status: "failed", reason: "x", orchDir: "/ec", signalFile: null },
      { spawn: () => ({ status: 0, error: null }), writeSignalStalled: () => {}, appendEventLog: (e) => appends.push(e) },
    );
    expect(appends).toHaveLength(0);
  });
});

// ── CTL-1367 item 12: runPrelaunch bounds the spawn with the dispatch timeout ──

describe("sdkRunPhaseAgent — CTL-1367 item 12 (prelaunch timeout)", () => {
  test("the prelaunch spawn carries a timeout + SIGKILL (mirrors the bg dispatcher)", async () => {
    const calls = [];
    const spawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: `${JSON.stringify(makeSpec())}\n`, stderr: "", error: null };
    };
    await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()]) });
    const pre = calls.find((c) => c.bin.endsWith("phase-agent-dispatch"));
    expect(typeof pre.opts.timeout).toBe("number");
    expect(pre.opts.timeout).toBeGreaterThan(0);
    expect(pre.opts.killSignal).toBe("SIGKILL");
  });
  test("a spawn ETIMEDOUT/ENOENT error surfaces as a failed dispatch (no query)", async () => {
    const sink = {};
    const spawn = () => ({ error: Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" });
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()], sink) });
    expect(r.code).toBe(127);
    expect(sink.calls ?? 0).toBe(0);
  });
});

// ── CTL-1367 item 15: runPrelaunch noisy-stdout / structural spec recovery ─────

describe("sdkRunPhaseAgent — CTL-1367 item 15 (structural spec recovery)", () => {
  test("a trailing non-spec JSON log line does NOT get mis-selected as the spec", async () => {
    const spec = makeSpec();
    const spawn = (bin) => {
      if (bin.endsWith("phase-agent-dispatch")) {
        // The real spec, then a trailing JSON log line that is valid JSON but is
        // NOT a launch spec (no ticket/phase/status shape).
        const out = `${JSON.stringify(spec)}\n${JSON.stringify({ level: "info", msg: "post-dispatch log" })}\n`;
        return { status: 0, stdout: out, stderr: "", error: null };
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const sink = {};
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg({ result: "ok" })], sink) });
    expect(r.code).toBe(0); // the real spec was recovered despite the trailing line
    expect(sink.prompt).toBe(spec.prompt);
  });
  test("noisy stdout with NO valid spec line → failed dispatch, no query", async () => {
    const sink = {};
    const spawn = (bin) => {
      if (bin.endsWith("phase-agent-dispatch")) {
        return { status: 0, stdout: "just a log line\nanother one\n", stderr: "", error: null };
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()], sink) });
    expect(r.code).toBe(1);
    expect(sink.calls ?? 0).toBe(0);
  });
});

// ── CTL-1367: overload-shape table (every shape the SDK / API surfaces) ───────

describe("sdkRunPhaseAgent — overload shape table", () => {
  const shapes = [
    ["api_error_status:429 (result)", { subtype: "error", is_error: true, api_error_status: 429 }, "result"],
    ["status:529 (result)", { subtype: "error", is_error: true, status: 529 }, "result"],
    ["statusCode:429 (result)", { subtype: "error", is_error: true, statusCode: 429 }, "result"],
    ["error.status:529 (result)", { subtype: "error", is_error: true, error: { status: 529 } }, "result"],
    ["overloaded_error type (result)", { subtype: "error", is_error: true, error: { type: "overloaded_error" } }, "result"],
  ];
  for (const [name, over, kind] of shapes) {
    test(`${name} retries then succeeds`, async () => {
      const { spawn } = spawnReturningSpec();
      let attempt = 0;
      const runQuery = () => (async function* () {
        attempt += 1;
        if (attempt < 2) yield resultMsg(over);
        else yield resultMsg({ result: "recovered" });
      })();
      const r = await sdkRunPhaseAgent(ARGS, {
        ...GOOD_AUTH, spawn, runQuery,
        sleep: () => Promise.resolve(), backoff: { baseMs: 1, capMs: 2 },
      });
      expect(r.code).toBe(0);
      expect(attempt).toBe(2);
      void kind;
    });
  }
  test("a 429 thrown as err.status retries; a 529 in a thrown message retries", async () => {
    for (const mk of [
      () => { const e = new Error("x"); e.status = 429; return e; },
      () => new Error("server returned 529 overloaded"),
    ]) {
      const { spawn } = spawnReturningSpec();
      let attempt = 0;
      const runQuery = () => (async function* () {
        attempt += 1;
        if (attempt < 2) throw mk();
        yield resultMsg();
      })();
      const r = await sdkRunPhaseAgent(ARGS, {
        ...GOOD_AUTH, spawn, runQuery, sleep: () => Promise.resolve(), backoff: { baseMs: 1, capMs: 2 },
      });
      expect(r.code).toBe(0);
      expect(attempt).toBe(2);
    }
  });
});
