// sdk-run-phase-agent.test.mjs — CTL-1365b. Fully OFFLINE: every test injects a
// fake runQuery (no real @anthropic-ai/claude-agent-sdk, no network) and a fake
// spawn for the shared pre-launch (no real phase-agent-dispatch / git / claude).
//
// Run: cd plugins/dev/scripts/execution-core && bun test sdk-run-phase-agent.test.mjs

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sdkRunPhaseAgent,
  assertSdkAuth,
  resolveSdkBootExecutor,
  buildSdkEnv,
  buildQueryOptions,
  resolveMaxParallel,
  Semaphore,
  scrubSecrets,
  defaultEmitBackstop,
  flipSignalDoneOnSuccess,
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

  // CTL-1367 P2-H: resize behavior.
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  test("setMax GROW wakes parked waiters into the new slots (up to newMax-active)", async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire(); // active=1 (at cap)
    let w2 = false, w3 = false;
    const p2 = sem.acquire().then((r) => { w2 = true; return r; }); // parks
    const p3 = sem.acquire().then((r) => { w3 = true; return r; }); // parks
    await flush();
    expect(w2).toBe(false);
    expect(w3).toBe(false);
    sem.setMax(3); // grow: active 1, wake the 2 parked waiters into the 2 new slots
    await flush();
    expect(w2).toBe(true);
    expect(w3).toBe(true);
    expect(sem.active).toBe(3); // exactly the raised cap — never exceeds it
    r1(); (await p2)(); (await p3)();
  });

  test("setMax SHRINK withholds released slots — drains to the new cap, never hands them to waiters above it", async () => {
    const sem = new Semaphore(3);
    const r1 = await sem.acquire(); // active=1
    const r2 = await sem.acquire(); // active=2
    const r3 = await sem.acquire(); // active=3 (at cap)
    let w4 = false;
    const p4 = sem.acquire().then((r) => { w4 = true; return r; }); // parks
    await flush();
    expect(w4).toBe(false);

    sem.setMax(1); // shrink: active 3 is now ABOVE the new cap of 1
    // Each release while active > max DRAINS (active--) and WITHHOLDS the slot.
    r1();
    await flush();
    expect(w4).toBe(false); // withheld — active 2 still > 1
    expect(sem.active).toBe(2);
    r2();
    await flush();
    expect(w4).toBe(false); // withheld — active 1
    expect(sem.active).toBe(1);
    // Now at the cap: the next release transfers the slot to the parked waiter
    // (active stays exactly at the new cap — the exceed-max invariant holds).
    r3();
    await flush();
    expect(w4).toBe(true);
    expect(sem.active).toBe(1);
    (await p4)();
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

// ── Per-phase turn-count telemetry (CTL-1396 item B) ──────────────────────────

describe("sdkRunPhaseAgent — execution-core.sdk.phase-turns telemetry", () => {
  const phaseTurns = (events) =>
    events.filter(([name]) => name === "execution-core.sdk.phase-turns").map(([, p]) => p);

  test("success → emits phase-turns with the SDK's num_turns, phase, subtype, and turnCap", async () => {
    const { spawn } = spawnReturningSpec();
    const events = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ result: "great", num_turns: 7 })]),
      emitEvent: (name, payload) => events.push([name, payload]),
      emitBackstop: () => {},
    });
    expect(r.code).toBe(0);
    const turns = phaseTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].num_turns).toBe(7);
    expect(turns[0].phase).toBe("implement");
    expect(turns[0].ticket).toBe("CTL-100");
    expect(turns[0].subtype).toBe("success");
  });

  test("error_max_turns → emits phase-turns carrying the turns-at-exhaustion", async () => {
    const { spawn } = spawnReturningSpec();
    const events = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ subtype: "error_max_turns", is_error: true, num_turns: 200 })]),
      emitEvent: (name, payload) => events.push([name, payload]),
      emitBackstop: () => {},
    });
    expect(r.code).toBe(1);
    const turns = phaseTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].num_turns).toBe(200);
    expect(turns[0].subtype).toBe("error_max_turns");
    expect(turns[0].phase).toBe("implement");
  });

  test("turnCap reflects the spec's cap (200) by default and an explicit override when given", async () => {
    const { spawn } = spawnReturningSpec();
    const ev1 = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ num_turns: 3 })]),
      emitEvent: (name, payload) => ev1.push([name, payload]),
      emitBackstop: () => {},
    });
    expect(phaseTurns(ev1)[0].turnCap).toBe(200);

    const ev2 = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, turnCap: 999,
      runQuery: fakeQuery([resultMsg({ num_turns: 3 })]),
      emitEvent: (name, payload) => ev2.push([name, payload]),
      emitBackstop: () => {},
    });
    expect(phaseTurns(ev2)[0].turnCap).toBe(999);
  });

  test("an absent num_turns does NOT throw and emits num_turns: null", async () => {
    const { spawn } = spawnReturningSpec();
    const events = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      // resultMsg has no num_turns field at all (older SDK terminal result).
      runQuery: fakeQuery([resultMsg({ result: "ok" })]),
      emitEvent: (name, payload) => events.push([name, payload]),
      emitBackstop: () => {},
    });
    expect(r.code).toBe(0);
    const turns = phaseTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].num_turns).toBeNull();
  });

  test("a non-numeric num_turns is coerced to null (never NaN / never throws)", async () => {
    const { spawn } = spawnReturningSpec();
    const events = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ num_turns: "lots" })]),
      emitEvent: (name, payload) => events.push([name, payload]),
      emitBackstop: () => {},
    });
    expect(r.code).toBe(0);
    expect(phaseTurns(events)[0].num_turns).toBeNull();
  });

  test("the phase-turns name passes the broker namespace contract (not a protected/phase.* space)", async () => {
    const { spawn } = spawnReturningSpec();
    const events = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg({ num_turns: 5 })]),
      emitEvent: (name, payload) => events.push([name, payload]),
      emitBackstop: () => {},
    });
    const [name] = events.find(([n]) => n === "execution-core.sdk.phase-turns");
    expect(name).toBe("execution-core.sdk.phase-turns");
    expect(name.startsWith("filter.")).toBe(false);
    expect(name.startsWith("broker.daemon")).toBe(false);
    expect(name).not.toBe("session.heartbeat");
    // The phase routing pattern requires a literal `phase.` prefix — this name has none.
    expect(name.startsWith("phase.")).toBe(false);
  });
});

// ── CTL-1406: session.context emit (dashboard panels 50/51) ───────────────────

describe("sdkRunPhaseAgent — CTL-1406 context-window emit", () => {
  const withUsage = (over = {}) =>
    resultMsg({
      num_turns: 4,
      usage: {
        iterations: [{ input_tokens: 100000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 0 }],
      },
      modelUsage: { "claude-opus-4-8": { contextWindow: 1000000 } },
      ...over,
    });

  test("emits context % (used/contextWindow) + turn when the SDK result carries usage + modelUsage", async () => {
    const { spawn } = spawnReturningSpec({ spec: makeSpec() });
    const ctx = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH,
      spawn,
      runQuery: fakeQuery([withUsage()]),
      emitContextEvent: (p) => ctx.push(p),
    });
    expect(ctx.length).toBe(1);
    // (100000 + 50000 + 0) / 1000000 = 15%
    expect(ctx[0].pct).toBe(15);
    expect(ctx[0].turn).toBe(4);
    expect(ctx[0].tokens).toBe(150000);
    expect(ctx[0].max).toBe(1000000);
    expect(ctx[0].ticket).toBe("CTL-100");
  });

  test("caps the percentage at 100 when used tokens exceed the window", async () => {
    const { spawn } = spawnReturningSpec({ spec: makeSpec() });
    const ctx = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH,
      spawn,
      runQuery: fakeQuery([withUsage({ usage: { iterations: [{ input_tokens: 2000000 }] } })]),
      emitContextEvent: (p) => ctx.push(p),
    });
    expect(ctx[0].pct).toBe(100);
  });

  test("picks the dominant (max-input) model's context window in a mixed-model result (Codex P2)", async () => {
    const { spawn } = spawnReturningSpec({ spec: makeSpec() });
    const ctx = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH,
      spawn,
      runQuery: fakeQuery([
        resultMsg({
          num_turns: 3,
          usage: { iterations: [{ input_tokens: 500000 }] },
          modelUsage: {
            "claude-haiku-helper": { inputTokens: 200, contextWindow: 200000 },
            "claude-opus-4-8": { inputTokens: 480000, contextWindow: 1000000 },
          },
        }),
      ]),
      emitContextEvent: (p) => ctx.push(p),
    });
    // dominant model = opus (1M); 500000/1_000_000 = 50% — NOT divided by the 200k helper (→100%)
    expect(ctx[0].pct).toBe(50);
    expect(ctx[0].max).toBe(1000000);
  });

  test("includes the final turn's output_tokens in the context fill (Codex P2)", async () => {
    const { spawn } = spawnReturningSpec({ spec: makeSpec() });
    const ctx = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH,
      spawn,
      runQuery: fakeQuery([
        resultMsg({
          num_turns: 2,
          usage: { iterations: [{ input_tokens: 100000, output_tokens: 100000 }] },
          modelUsage: { "claude-opus-4-8": { inputTokens: 100000, contextWindow: 1000000 } },
        }),
      ]),
      emitContextEvent: (p) => ctx.push(p),
    });
    // (100000 input + 100000 output) / 1_000_000 = 20%
    expect(ctx[0].pct).toBe(20);
    expect(ctx[0].tokens).toBe(200000);
  });

  test("does NOT emit when the result lacks usage/modelUsage (older SDK / no data)", async () => {
    const { spawn } = spawnReturningSpec({ spec: makeSpec() });
    const ctx = [];
    await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH,
      spawn,
      runQuery: fakeQuery([resultMsg({ num_turns: 2 })]), // no usage/modelUsage
      emitContextEvent: (p) => ctx.push(p),
    });
    expect(ctx.length).toBe(0);
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

  // CTL-1367 P1-B: a prelaunch SIGKILLed/timed-out AFTER writing status:"dispatched"
  // but BEFORE printing the spec returns !ok yet leaves a RUNNABLE signal behind. The
  // synchronous consumer would verify only that signal (dispatched → runnable) and
  // record the phase as launched forever. The launch verb flips the still-in-flight
  // signal to "stalled" so the consumer's verify demotes it to a dispatch failure.
  test("CTL-1367 P1-B: a prelaunch that dies before the spec flips a dispatched signal to stalled", async () => {
    const orchDir = mkdtempSync(join(tmpdir(), "sdk-p1b-"));
    const wdir = join(orchDir, "workers", "CTL-100");
    mkdirSync(wdir, { recursive: true });
    const signalFile = join(wdir, "phase-implement.json");
    writeFileSync(signalFile, JSON.stringify({ status: "dispatched", bg_job_id: null, ticket: "CTL-100", phase: "implement" }));
    const sink = {};
    // The prelaunch wrote the dispatched signal (above), then died: SIGKILL, no spec.
    const spawn = (bin) => {
      if (bin.endsWith("phase-agent-dispatch")) {
        return { status: null, signal: "SIGKILL", stdout: "", stderr: "killed", error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) };
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    const r = await sdkRunPhaseAgent(
      { orchDir, ticket: "CTL-100", phase: "implement", worktreePath: "/wt" },
      { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()], sink) },
    );
    expect(r.code).not.toBe(0); // surfaced as a dispatch failure
    expect(sink.calls ?? 0).toBe(0); // query never ran
    // P1-B: the runnable signal was flipped to stalled so it can't strand "dispatched".
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("stalled");
    rmSync(orchDir, { recursive: true, force: true });
  });

  test("CTL-1367 P1-B: a clean pre-claim failure (no signal on disk) does not fabricate one", async () => {
    const orchDir = mkdtempSync(join(tmpdir(), "sdk-p1b2-"));
    mkdirSync(join(orchDir, "workers", "CTL-100"), { recursive: true });
    const signalFile = join(orchDir, "workers", "CTL-100", "phase-implement.json");
    const spawn = (bin) =>
      bin.endsWith("phase-agent-dispatch")
        ? { status: 1, stdout: "", stderr: "no claim", error: null } // failed before any signal write
        : { status: 0, stdout: "", stderr: "", error: null };
    const r = await sdkRunPhaseAgent(
      { orchDir, ticket: "CTL-100", phase: "implement", worktreePath: "/wt" },
      { ...GOOD_AUTH, spawn, runQuery: fakeQuery([resultMsg()]) },
    );
    expect(r.code).not.toBe(0);
    expect(existsSync(signalFile)).toBe(false); // no signal fabricated
    rmSync(orchDir, { recursive: true, force: true });
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
    // Two overloads fire execution-core.sdk.overloaded; the recovered terminal
    // result then fires one execution-core.sdk.phase-turns (CTL-1396 item B). No
    // other event types appear.
    expect(events.filter(([n]) => n === "execution-core.sdk.overloaded")).toHaveLength(2);
    expect(events.filter(([n]) => n === "execution-core.sdk.phase-turns")).toHaveLength(1);
    expect(
      events.every(([n]) =>
        n === "execution-core.sdk.overloaded" || n === "execution-core.sdk.phase-turns",
      ),
    ).toBe(true);
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

  // CTL-1367 nit (P3): a GROW eagerly wakes parked waiters into the newly-created
  // slots (FIFO) WITHOUT waiting for the held slot to release — bounded so active
  // never exceeds the raised cap.
  test("setMax GROW wakes parked waiters immediately into the new slots", async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire(); // holds the only slot (active=1)
    const acquired = [];
    const p2 = sem.acquire().then((r) => { acquired.push("p2"); return r; });
    const p3 = sem.acquire().then((r) => { acquired.push("p3"); return r; });
    await Promise.resolve();
    expect(acquired).toEqual([]); // both parked behind the single slot
    sem.setMax(3); // grow → 2 free slots → wake BOTH parked waiters (FIFO), held slot untouched
    const r2 = await p2;
    const r3 = await p3;
    expect(acquired).toEqual(["p2", "p3"]); // woken in FIFO order, before r1 released
    expect(sem.active).toBe(3); // 3 held: r1 + the two woken waiters — never exceeds the cap
    r1(); r2(); r3();
    expect(sem.active).toBe(0); // every slot drains cleanly
  });

  test("setMax GROW never wakes more waiters than the new cap allows", async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire(); // active=1
    const ps = [sem.acquire(), sem.acquire(), sem.acquire()]; // 3 parked
    await Promise.resolve();
    sem.setMax(2); // only ONE new slot → wake exactly one waiter
    expect(sem.active).toBe(2); // r1 + one woken — capped at 2
    const r2 = await ps[0];
    r1(); r2();
    // The two still-parked waiters drain as slots free.
    const r3 = await ps[1];
    const r4 = await ps[2];
    r3(); r4();
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

// ── CTL-1410 Phase A: SDK success-branch signal flip ──────────────────────────
// mapResult subtype==="success" returns backstop:null — historically the ONE
// abstaining branch (the skill was solely responsible for its own flip). With the
// event-only phases migrated onto the wrapper, this in-process net flips a
// still-in-flight (dispatched|running) signal to done so occupancy releases and
// deriveAdvancement sees a terminal status even if a skill skipped its wrapper
// call. It must NEVER clobber a terminal status, resurrect a parked hold, nor
// act on a stale generation (superseded worker).

describe("flipSignalDoneOnSuccess — CTL-1410 Phase A truth table", () => {
  const flipCase = (startStatus) => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-flip-"));
    const signalFile = join(dir, "phase-triage.json");
    writeFileSync(signalFile, JSON.stringify({ status: startStatus, ticket: "CTL-1", phase: "triage" }));
    flipSignalDoneOnSuccess(signalFile);
    const after = JSON.parse(readFileSync(signalFile, "utf8"));
    rmSync(dir, { recursive: true, force: true });
    return after;
  };

  test("dispatched (in-flight) → done + completedAt, no attentionReason", () => {
    const after = flipCase("dispatched");
    expect(after.status).toBe("done");
    expect(typeof after.completedAt).toBe("string");
    expect("attentionReason" in after).toBe(false);
    expect("failureReason" in after).toBe(false);
  });

  test("running (in-flight) → done", () => {
    expect(flipCase("running").status).toBe("done");
  });

  test("needs-input (parked) is NEVER resurrected to done", () => {
    const after = flipCase("needs-input");
    expect(after.status).toBe("needs-input");
    expect("completedAt" in after).toBe(false);
  });

  for (const terminal of ["done", "failed", "stalled", "skipped", "turn-cap-exhausted"]) {
    test(`already-terminal '${terminal}' is not clobbered`, () => {
      const after = flipCase(terminal);
      expect(after.status).toBe(terminal);
      expect("completedAt" in after).toBe(false);
    });
  }

  test("missing / empty / null signalFile never throws", () => {
    expect(() => {
      flipSignalDoneOnSuccess("/nonexistent/dir/sig.json");
      flipSignalDoneOnSuccess("");
      flipSignalDoneOnSuccess(null);
    }).not.toThrow();
  });

  // CTL-736 generation fence (adversarial-review catch): a stale superseded
  // worker's late success must NOT flip the newer dispatch's in-flight signal.
  const fenceCase = (mine, sigGen) => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-fence-"));
    const signalFile = join(dir, "phase-implement.json");
    const sig = { status: "dispatched", ticket: "CTL-1", phase: "implement" };
    if (sigGen !== undefined) sig.generation = sigGen;
    writeFileSync(signalFile, JSON.stringify(sig));
    flipSignalDoneOnSuccess(signalFile, mine);
    const after = JSON.parse(readFileSync(signalFile, "utf8"));
    rmSync(dir, { recursive: true, force: true });
    return after.status;
  };

  test("stale generation (mine < signal) bows out — signal stays in-flight", () => {
    expect(fenceCase(5, 6)).toBe("dispatched");
  });

  test("current generation (mine == signal) flips", () => {
    expect(fenceCase(6, 6)).toBe("done");
  });

  test("newer generation (mine > signal) flips (fail-open, matches isCurrentGeneration)", () => {
    expect(fenceCase(7, 6)).toBe("done");
  });

  test("missing own generation fails open (legacy/unfenced dispatch) — flips", () => {
    expect(fenceCase(undefined, 6)).toBe("done");
  });

  test("missing signal generation fails open — flips", () => {
    expect(fenceCase(5, undefined)).toBe("done");
  });

  test("non-numeric generations fail open — flips", () => {
    expect(fenceCase("garbage", "alsogarbage")).toBe("done");
  });
});

describe("sdkRunPhaseAgent — CTL-1410 Phase A (success flips in-flight signal to done)", () => {
  test("success + signal still 'dispatched' → flipped to done (the safety net)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-flip-e2e-"));
    const signalFile = join(dir, "phase-triage.json");
    const spec = makeSpec({ signalFile });
    const { spawn } = spawnReturningSpec({ spec, signalFile });
    const backstops = [];
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn,
      runQuery: fakeQuery([resultMsg()]),
      emitBackstop: (e) => backstops.push(e),
    });
    expect(r.code).toBe(0);
    expect(backstops).toHaveLength(0);
    const after = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(after.status).toBe("done");
    expect(typeof after.completedAt).toBe("string");
    expect("attentionReason" in after).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("success + skill already flipped (done) → untouched (primary path wins)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-flip-e2e-"));
    const signalFile = join(dir, "phase-triage.json");
    const spec = makeSpec({ signalFile });
    // Prelaunch writes dispatched; the fake query simulates the skill's own
    // wrapper flip (status done + its own completedAt) before resolving success.
    const { spawn } = spawnReturningSpec({ spec, signalFile });
    const skillFlip = () => (async function* () {
      writeFileSync(signalFile, JSON.stringify({ status: "done", completedAt: "2026-07-01T00:00:00Z", ticket: "CTL-100" }));
      yield resultMsg();
    })();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: skillFlip });
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(after.status).toBe("done");
    expect(after.completedAt).toBe("2026-07-01T00:00:00Z"); // NOT overwritten
    rmSync(dir, { recursive: true, force: true });
  });

  test("success + parked (needs-input) → NOT flipped (in-flight-only precondition)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-flip-e2e-"));
    const signalFile = join(dir, "phase-triage.json");
    const spec = makeSpec({ signalFile });
    const { spawn } = spawnReturningSpec({ spec, signalFile });
    const parkThenSucceed = () => (async function* () {
      writeFileSync(signalFile, JSON.stringify({ status: "needs-input", parkedFrom: "triage", ticket: "CTL-100" }));
      yield resultMsg();
    })();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: parkThenSucceed });
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(after.status).toBe("needs-input");
    rmSync(dir, { recursive: true, force: true });
  });

  test("stale-generation success (superseded worker) does NOT flip the newer dispatch's signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-flip-e2e-"));
    const signalFile = join(dir, "phase-triage.json");
    // This run carries generation 1; a newer dispatch has since claimed the
    // signal at generation 2 (preempt→re-dispatch / revive supersede). The stale
    // run's clean success must bow out exactly like the wrapper's fence does.
    const spec = makeSpec({ signalFile, generation: 1 });
    const { spawn } = spawnReturningSpec({ spec, signalFile });
    const supersede = () => (async function* () {
      writeFileSync(signalFile, JSON.stringify({ status: "dispatched", generation: 2, ticket: "CTL-100" }));
      yield resultMsg();
    })();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery: supersede });
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(after.status).toBe("dispatched"); // the gen-2 worker still owns it
    expect(after.generation).toBe(2);
    expect("completedAt" in after).toBe(false);
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

  // CTL-1367 P2-E: a SIGKILL/OOM-terminated emit returns status:null + a non-null
  // `signal`. The OLD predicate keyed only on `typeof status === "number"`, so this
  // looked like success and SILENTLY DROPPED the terminal event. It must fall back.
  test("CTL-1367 P2-E: a signal-killed emit (status:null + signal set) falls back", () => {
    const appends = [];
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-4", status: "failed", reason: "oom", orchDir: "/ec", signalFile: null },
      { spawn: () => ({ status: null, signal: "SIGKILL", error: null }), writeSignalStalled: () => {}, appendEventLog: (e) => appends.push(e) },
    );
    expect(appends).toHaveLength(1);
    expect(appends[0]).toMatchObject({ phase: "implement", ticket: "CTL-4", status: "failed" });
  });

  test("CTL-1367 P2-E: a non-number/undefined status also falls back", () => {
    const appends = [];
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-5", status: "failed", reason: "x", orchDir: "/ec", signalFile: null },
      { spawn: () => ({ /* no status, no error, no signal */ }), writeSignalStalled: () => {}, appendEventLog: (e) => appends.push(e) },
    );
    expect(appends).toHaveLength(1);
  });
});

// ── CTL-1367 P2-F: the backstop signal status MATCHES its terminal event ──────
describe("defaultEmitBackstop — CTL-1367 P2-F (turn-cap-exhausted signal status)", () => {
  const seed = (status) => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-p2f-"));
    const signalFile = join(dir, "phase-implement.json");
    writeFileSync(signalFile, JSON.stringify({ status, ticket: "CTL-1", phase: "implement" }));
    return { dir, signalFile };
  };

  test("a turn-cap-exhausted backstop writes signal status 'turn-cap-exhausted' (NOT 'stalled')", () => {
    const { dir, signalFile } = seed("running");
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-1", status: "turn-cap-exhausted", reason: "sdk-error-max-turns", orchDir: "/ec", signalFile },
      { spawn: () => ({ status: 0, error: null }), appendEventLog: () => {} },
    );
    const sig = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(sig.status).toBe("turn-cap-exhausted");
    expect(sig.phaseTimestamps["turn-cap-exhausted"]).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed backstop STILL writes signal status 'stalled'", () => {
    const { dir, signalFile } = seed("running");
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-1", status: "failed", reason: "sdk-threw", orchDir: "/ec", signalFile },
      { spawn: () => ({ status: 0, error: null }), appendEventLog: () => {} },
    );
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("stalled");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the P3 terminal-clobber guard still applies to a turn-cap write (a 'done' success is preserved)", () => {
    const { dir, signalFile } = seed("done");
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-1", status: "turn-cap-exhausted", reason: "x", orchDir: "/ec", signalFile },
      { spawn: () => ({ status: 0, error: null }), appendEventLog: () => {} },
    );
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("done"); // never clobbered
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── CTL-1367 P3: the backstop must NEVER clobber a TERMINAL success ────────────
// defaultWriteSignalStalled (exercised via the real default inside defaultEmitBackstop)
// flips a still-in-flight (dispatched/running) signal to "stalled", but refuses to
// overwrite a done/complete success the phase skill already wrote — otherwise the
// backstop would falsely strand a phase that actually finished.
describe("defaultEmitBackstop → defaultWriteSignalStalled terminal-status guard (CTL-1367 P3)", () => {
  const seedSignal = (status) => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-p3-"));
    const signalFile = join(dir, "phase-implement.json");
    writeFileSync(signalFile, JSON.stringify({ status, ticket: "CTL-1", phase: "implement" }));
    return { dir, signalFile };
  };
  // Real defaultWriteSignalStalled (NOT injected); inject only spawn (no real emit
  // binary) + a noop appendEventLog so nothing touches the real event log.
  const emit = (signalFile) =>
    defaultEmitBackstop(
      { phase: "implement", ticket: "CTL-1", status: "failed", reason: "sdk-threw", orchDir: "/ec", signalFile },
      { spawn: () => ({ status: 0, error: null }), appendEventLog: () => {} },
    );

  test("a non-terminal 'running' signal IS flipped to stalled (the rescue path)", () => {
    const { dir, signalFile } = seedSignal("running");
    emit(signalFile);
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("stalled");
    rmSync(dir, { recursive: true, force: true });
  });
  test("a non-terminal 'dispatched' signal IS flipped to stalled", () => {
    const { dir, signalFile } = seedSignal("dispatched");
    emit(signalFile);
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("stalled");
    rmSync(dir, { recursive: true, force: true });
  });
  test("a terminal 'done' success is NOT clobbered to stalled", () => {
    const { dir, signalFile } = seedSignal("done");
    emit(signalFile);
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("done"); // preserved
    rmSync(dir, { recursive: true, force: true });
  });
  test("'complete' / 'completed' success synonyms are preserved too", () => {
    for (const st of ["complete", "completed"]) {
      const { dir, signalFile } = seedSignal(st);
      emit(signalFile);
      expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe(st);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── CTL-1367 item 9 + P3: resolveSdkBootExecutor (daemon-boot auth gate + event) ─
describe("resolveSdkBootExecutor (CTL-1367 item 9 + P3 observability)", () => {
  test("executor != sdk → pure pass-through (no auth check, no event)", () => {
    const events = [];
    let authChecked = false;
    const out = resolveSdkBootExecutor("bg", {
      assertAuth: () => { authChecked = true; return { ok: false, reason: "should-not-run" }; },
      emitEvent: (e) => events.push(e),
    });
    expect(out).toEqual({ executor: "bg", fellBack: false, reason: null });
    expect(authChecked).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("executor=sdk + good auth → stays sdk, NO warn, NO event", () => {
    const events = [];
    const warns = [];
    const out = resolveSdkBootExecutor("sdk", {
      env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      oauthToken: "tok",
      emitEvent: (e) => events.push(e),
      log: { warn: (...a) => warns.push(a) },
    });
    expect(out).toEqual({ executor: "sdk", fellBack: false, reason: null });
    expect(events).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  test("executor=sdk + missing OAuth token → falls back to bg, WARNs, emits execution-core.executor.bg-fallback", () => {
    const events = [];
    const warns = [];
    const out = resolveSdkBootExecutor("sdk", {
      env: {}, // no CLAUDE_CODE_OAUTH_TOKEN
      oauthToken: undefined,
      emitEvent: (e) => events.push(e),
      log: { warn: (...a) => warns.push(a) },
    });
    expect(out.executor).toBe("bg");
    expect(out.fellBack).toBe(true);
    expect(out.reason).toMatch(/OAUTH_TOKEN is missing/);
    expect(warns).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]["event.name"]).toBe("execution-core.executor.bg-fallback");
    expect(events[0].payload).toMatchObject({ requested: "sdk", effective: "bg" });
    expect(events[0].payload.reason).toMatch(/OAUTH_TOKEN is missing/);
  });

  test("executor=sdk + ANTHROPIC_API_KEY set → falls back to bg + emits (would silently meter)", () => {
    const events = [];
    const out = resolveSdkBootExecutor("sdk", {
      env: { ANTHROPIC_API_KEY: "sk-zzz", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      oauthToken: "tok",
      emitEvent: (e) => events.push(e),
    });
    expect(out.executor).toBe("bg");
    expect(events[0]["event.name"]).toBe("execution-core.executor.bg-fallback");
    expect(events[0].payload.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("a throwing emitEvent never breaks boot (best-effort) — still returns bg", () => {
    let out;
    expect(() => {
      out = resolveSdkBootExecutor("sdk", {
        env: {},
        oauthToken: undefined,
        emitEvent: () => { throw new Error("log write boom"); },
      });
    }).not.toThrow();
    expect(out.executor).toBe("bg");
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

// ── CTL-1410 Phase B: in-process worker-registry wiring ───────────────────────
// The registry is the SDK-native liveness source of truth (sdk-worker-registry.mjs).
// The runner must register exactly once per real launch (after the spec resolves,
// before the query loop), swap the abort controller per retry, heartbeat on
// streamed messages, and deregister on EVERY exit path — while the three
// pre-launch early-returns never register at all.

describe("sdkRunPhaseAgent — CTL-1410 Phase B (worker registry wiring)", () => {
  const fakeRegistry = () => {
    const state = { registered: [], handles: [] };
    const registerWorker = (entry) => {
      state.registered.push(entry);
      const h = {
        controllers: [],
        touches: 0,
        deregistered: 0,
        setAbortController(ac) {
          h.controllers.push(ac);
        },
        touch() {
          h.touches += 1;
        },
        deregister() {
          h.deregistered += 1;
        },
      };
      state.handles.push(h);
      return h;
    };
    return { registerWorker, state };
  };

  test("registers after spec resolve, before the query; wires the AC; touches per message; deregisters on success", async () => {
    const { spawn } = spawnReturningSpec();
    const { registerWorker, state } = fakeRegistry();
    let registeredAtQuery = -1;
    const sink = {};
    const runQuery = ({ prompt, options }) => {
      registeredAtQuery = state.registered.length;
      sink.options = options;
      return (async function* () {
        yield { type: "assistant", message: {} };
        yield resultMsg();
      })();
    };
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, runQuery, registerWorker });
    expect(r.code).toBe(0);
    expect(state.registered).toHaveLength(1);
    expect(registeredAtQuery).toBe(1); // registered BEFORE the query launched
    expect(state.registered[0]).toMatchObject({
      ticket: "CTL-100",
      phase: "implement",
      worktreePath: "/wt/CTL-100",
      generation: 1,
      orchDir: "/ec",
    });
    const h = state.handles[0];
    expect(h.controllers).toHaveLength(1);
    expect(h.controllers[0]).toBe(sink.options.abortController); // the SAME ac query() got
    expect(h.touches).toBe(2); // one per streamed message
    expect(h.deregistered).toBe(1);
  });

  test("deregisters when the query throws (generic sdk-threw path)", async () => {
    const { spawn } = spawnReturningSpec();
    const { registerWorker, state } = fakeRegistry();
    const runQuery = () =>
      (async function* () {
        throw new Error("boom");
      })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, registerWorker,
      emitBackstop: () => {},
    });
    expect(r.code).toBe(1);
    expect(state.handles[0].deregistered).toBe(1);
  });

  test("deregisters when the overload backoff exhausts", async () => {
    const { spawn } = spawnReturningSpec();
    const { registerWorker, state } = fakeRegistry();
    const runQuery = () =>
      (async function* () {
        yield resultMsg({ subtype: "error", is_error: true, api_error_status: 529 });
      })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, registerWorker,
      sleep: () => Promise.resolve(),
      backoff: { baseMs: 1, capMs: 2 },
      maxRetries: 1,
      emitEvent: () => {},
      emitBackstop: () => {},
    });
    expect(r.code).toBe(1);
    expect(state.registered).toHaveLength(1); // register once, NOT per retry
    expect(state.handles[0].deregistered).toBe(1);
  });

  test("swaps the abort controller on every retry (distinct AC per attempt)", async () => {
    const { spawn } = spawnReturningSpec();
    const { registerWorker, state } = fakeRegistry();
    let attempt = 0;
    const runQuery = () =>
      (async function* () {
        attempt += 1;
        if (attempt === 1) {
          yield resultMsg({ subtype: "error", is_error: true, api_error_status: 429 });
        } else {
          yield resultMsg();
        }
      })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, registerWorker,
      sleep: () => Promise.resolve(),
      backoff: { baseMs: 1, capMs: 2 },
      emitEvent: () => {},
    });
    expect(r.code).toBe(0);
    const h = state.handles[0];
    expect(h.controllers).toHaveLength(2);
    expect(h.controllers[0]).not.toBe(h.controllers[1]);
    expect(h.deregistered).toBe(1);
  });

  test("auth-guard early return never registers", async () => {
    const { registerWorker, state } = fakeRegistry();
    const r = await sdkRunPhaseAgent(ARGS, {
      env: { ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "t" },
      oauthToken: "t",
      registerWorker,
      emitEvent: () => {},
    });
    expect(r.code).toBe(1);
    expect(state.registered).toHaveLength(0);
  });

  test("idempotent prelaunch never registers", async () => {
    const spec = makeSpec({ status: "claim-lost", idempotent: true });
    const { spawn } = spawnReturningSpec({ spec });
    const { registerWorker, state } = fakeRegistry();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, registerWorker });
    expect(r.code).toBe(0);
    expect(state.registered).toHaveLength(0);
  });

  test("failed prelaunch never registers", async () => {
    const { spawn } = spawnReturningSpec({ code: 1 });
    const { registerWorker, state } = fakeRegistry();
    const r = await sdkRunPhaseAgent(ARGS, { ...GOOD_AUTH, spawn, registerWorker });
    expect(r.code).toBe(1);
    expect(state.registered).toHaveLength(0);
  });
});

// ── CTL-1422: session capture + worker.session.* lifecycle events ─────────────
// The init message's session_id is the warm-resume key: it must reach the
// registry (durable projection) and the unified event log (fleet view) the
// moment it is known. stopped fires on every post-capture exit path.

describe("sdkRunPhaseAgent — CTL-1422 (session capture + lifecycle events)", () => {
  const sessionRegistry = () => {
    const state = { handles: [] };
    const registerWorker = () => {
      const h = { sessionIds: [], deregistered: 0 };
      h.setAbortController = () => {};
      h.touch = () => {};
      h.setSessionId = (id) => h.sessionIds.push(id);
      h.deregister = () => { h.deregistered += 1; };
      state.handles.push(h);
      return h;
    };
    return { registerWorker, state };
  };
  const initMsg = { type: "system", subtype: "init", session_id: "sess-abc" };

  test("captures session_id from the init message → registry + started/stopped events", async () => {
    const { spawn } = spawnReturningSpec();
    const { registerWorker, state } = sessionRegistry();
    const events = [];
    const runQuery = fakeQuery([initMsg, resultMsg()]);
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, registerWorker,
      emitEvent: (n, p) => events.push([n, p]),
    });
    expect(r.code).toBe(0);
    expect(state.handles[0].sessionIds).toEqual(["sess-abc"]);
    const started = events.filter(([n]) => n === "worker.session.started");
    expect(started).toHaveLength(1);
    expect(started[0][1]).toMatchObject({
      ticket: "CTL-100", phase: "implement", session_id: "sess-abc", generation: 1,
    });
    const stopped = events.filter(([n]) => n === "worker.session.stopped");
    expect(stopped).toHaveLength(1);
    expect(stopped[0][1]).toMatchObject({ ticket: "CTL-100", session_id: "sess-abc" });
  });

  test("a resume dispatch emits worker.session.resumed instead of started", async () => {
    const spec = makeSpec({ resumeSession: "sess-prev" });
    const { spawn } = spawnReturningSpec({ spec });
    const { registerWorker } = sessionRegistry();
    const events = [];
    const runQuery = fakeQuery([{ ...initMsg, session_id: "sess-prev" }, resultMsg()]);
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, registerWorker,
      emitEvent: (n, p) => events.push([n, p]),
    });
    expect(r.code).toBe(0);
    expect(events.filter(([n]) => n === "worker.session.resumed")).toHaveLength(1);
    expect(events.filter(([n]) => n === "worker.session.started")).toHaveLength(0);
  });

  test("no init message → no session events, no registry call, no crash", async () => {
    const { spawn } = spawnReturningSpec();
    const { registerWorker, state } = sessionRegistry();
    const events = [];
    const runQuery = fakeQuery([resultMsg()]);
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, registerWorker,
      emitEvent: (n, p) => events.push([n, p]),
    });
    expect(r.code).toBe(0);
    expect(state.handles[0].sessionIds).toEqual([]);
    expect(events.filter(([n]) => String(n).startsWith("worker.session."))).toHaveLength(0);
  });

  test("stopped still fires when the query throws AFTER the init message", async () => {
    const { spawn } = spawnReturningSpec();
    const { registerWorker, state } = sessionRegistry();
    const events = [];
    const runQuery = () =>
      (async function* () {
        yield initMsg;
        throw new Error("boom");
      })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery, registerWorker,
      emitEvent: (n, p) => events.push([n, p]),
      emitBackstop: () => {},
    });
    expect(r.code).toBe(1);
    expect(state.handles[0].sessionIds).toEqual(["sess-abc"]);
    expect(events.filter(([n]) => n === "worker.session.stopped")).toHaveLength(1);
  });

  test("Phase B fakes without setSessionId do not crash (optional-chained)", async () => {
    const { spawn } = spawnReturningSpec();
    const legacyHandle = { setAbortController: () => {}, touch: () => {}, deregister: () => {} };
    const runQuery = fakeQuery([initMsg, resultMsg()]);
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery,
      registerWorker: () => legacyHandle,
      emitEvent: () => {},
    });
    expect(r.code).toBe(0);
  });
});

describe("sdkRunPhaseAgent — CTL-1422 session change across retries", () => {
  test("an overload retry with a NEW session closes the old one (stopped) before starting the new", async () => {
    const { spawn } = spawnReturningSpec();
    const events = [];
    let attempt = 0;
    const runQuery = () =>
      (async function* () {
        attempt += 1;
        yield { type: "system", subtype: "init", session_id: `sess-${attempt}` };
        if (attempt === 1) {
          yield resultMsg({ subtype: "error", is_error: true, api_error_status: 529 });
        } else {
          yield resultMsg();
        }
      })();
    const r = await sdkRunPhaseAgent(ARGS, {
      ...GOOD_AUTH, spawn, runQuery,
      registerWorker: () => ({ setAbortController() {}, touch() {}, setSessionId() {}, deregister() {} }),
      sleep: () => Promise.resolve(),
      backoff: { baseMs: 1, capMs: 2 },
      emitEvent: (n, p) => events.push([n, p]),
    });
    expect(r.code).toBe(0);
    const lifecycle = events
      .filter(([n]) => String(n).startsWith("worker.session."))
      .map(([n, p]) => `${n.split(".").pop()}:${p.session_id}`);
    expect(lifecycle).toEqual([
      "started:sess-1",
      "stopped:sess-1", // closed when the retry re-keyed the session
      "started:sess-2",
      "stopped:sess-2", // the finally close
    ]);
  });
});
