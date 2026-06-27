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
