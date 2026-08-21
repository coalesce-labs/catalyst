// codex-run-phase-agent.test.mjs — CTL-1457. Mostly OFFLINE: the unit tests inject
// a fake `spawnChild` (an EventEmitter child with Readable stdout/stderr) so the
// JSONL parse / usage / classification / abort paths are deterministic without a
// real `codex` binary; ONE test drives the DEFAULT real spawnChild against a bash
// stub (the stdin-hang + real-child-parse regression). Inherits test-setup.mjs.
//
// Run: cd plugins/dev/scripts/execution-core && bun test codex-run-phase-agent.test.mjs

import { describe, test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  assertCodexAuth,
  buildCodexArgs,
  buildCodexEnv,
  buildCodexPrompt,
  codexRunPhaseAgent,
  ensureCodexSkills,
  resolveCodexBootEligibility,
} from "./codex-run-phase-agent.mjs";
import { Semaphore } from "./sdk-run-phase-agent.mjs";

// ── Fakes ─────────────────────────────────────────────────────────────────────

const tick = () => new Promise((r) => setImmediate(r));

// makeFakeChild — an EventEmitter that mimics a node child process: Readable
// stdout/stderr + a .kill(sig) that RECORDS the signal and emits 'close' (so an
// abort resolves the spawnAndParse promise deterministically).
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = [];
  child.kill = (sig = "SIGTERM") => {
    child.killed.push(sig);
    child.emit("close", null, sig);
    return true;
  };
  return child;
}

// makeSigtermIgnoringChild — a fake child that IGNORES SIGTERM (records it but does
// NOT close) and only closes on SIGKILL. Drives the T3 abort→escalation regression:
// the runner must keep the SIGKILL timer alive past the AbortError and settle only
// after the child actually closes.
function makeSigtermIgnoringChild() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = [];
  child.kill = (sig = "SIGTERM") => {
    child.killed.push(sig);
    if (sig === "SIGKILL") child.emit("close", null, sig); // only SIGKILL actually terminates
    return true;
  };
  return child;
}

// autoChild — a fake child that, once the runner has attached its listeners,
// pushes the given JSONL lines then closes with exitCode/signal. Deferred via
// setImmediate so the 'data'/'close' listeners attach before the stream flows.
function autoChild(lines = [], exitCode = 0, signal = null) {
  const c = makeFakeChild();
  setImmediate(() => {
    for (const l of lines) c.stdout.push(l.endsWith("\n") ? l : `${l}\n`);
    c.stdout.push(null);
    setImmediate(() => c.emit("close", exitCode, signal));
  });
  return c;
}

// fakeRegistry — records register/setAbortController/touch/setSessionId/deregister.
function fakeRegistry() {
  const state = { registered: [], handles: [] };
  const registerWorker = (entry) => {
    state.registered.push(entry);
    const h = {
      controllers: [],
      sessionIds: [],
      touches: 0,
      deregistered: 0,
      setAbortController(ac) {
        h.controllers.push(ac);
      },
      setSessionId(id) {
        h.sessionIds.push(id);
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
}

const makeCodexSpec = (over = {}) => ({
  ticket: "CTL-100",
  phase: "implement",
  model: "gpt-5",
  turnCap: 200,
  prompt: "/catalyst-dev:phase-implement CTL-100 --orch-dir /ec",
  signalFile: "/ec/workers/CTL-100/phase-implement.json",
  worktreePath: "/wt/CTL-100",
  generation: 1,
  resumeSession: null,
  pluginDirs: ["/checkout/plugins/dev"],
  env: ["CATALYST_TICKET=CTL-100", "CATALYST_PHASE=implement", "CATALYST_GENERATION=1"],
  status: "prelaunch-ready",
  ...over,
});

const ARGS = { orchDir: "/ec", ticket: "CTL-100", phase: "implement", worktreePath: "/wt/CTL-100" };

const CFG = { codexHome: "/codex-home", bin: "codex", model: "gpt-5", writableRoots: ["/root"], pluginRoot: null };

const OK_AUTH = () => ({ ok: true, reason: null });

// A runner-opts factory for the spawn/classification/abort tests: injects a
// passing auth + a ready prelaunch spec + a fake registry + a fresh semaphore.
function runnerOpts({ spec = makeCodexSpec(), over = {} } = {}) {
  const reg = fakeRegistry();
  return {
    opts: {
      codexCfg: CFG,
      assertAuth: OK_AUTH,
      runPrelaunchFn: () => ({ ok: true, idempotent: false, spec, code: 0, stderr: "" }),
      prepareWorktree: () => {},
      registerWorker: reg.registerWorker,
      emitEvent: () => {},
      semaphore: new Semaphore(4),
      sleep: () => Promise.resolve(),
      ...over,
    },
    reg,
    spec,
  };
}

// ── Real captured 0.144.1 fixtures (from the protocol reference §E1) ───────────
const E1_LINES = [
  '{"type":"thread.started","thread_id":"019f5cd0-a4ee-7722-a22f-a7bd424b5689"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OTEL-PROBE-2"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14847,"cached_input_tokens":9984,"output_tokens":11,"reasoning_output_tokens":0}}',
];
const E1_THREAD = "019f5cd0-a4ee-7722-a22f-a7bd424b5689";
const E1_USAGE = { input_tokens: 14847, cached_input_tokens: 9984, output_tokens: 11, reasoning_output_tokens: 0 };
const AUTH_ERR =
  '{"type":"error","message":"Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."}';
const RATE_ERR =
  '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits. Try again later."}';

// ── assertCodexAuth ─────────────────────────────────────────────────────────

describe("assertCodexAuth", () => {
  test("ok when <codexHome>/auth.json exists and parses with a tokens key", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "irrelevant" }, OPENAI_API_KEY: null }));
    const r = assertCodexAuth({ codexHome: home, env: {} });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  test("ok when CODEX_API_KEY is set — logs LOUDLY (metered mode) and NEVER logs the token value", () => {
    const logged = [];
    const r = assertCodexAuth({
      codexHome: "/nope",
      env: { CODEX_API_KEY: "sk-supersecret-codex-value-999" },
      log: { warn: (...a) => logged.push(a.map(String).join(" ")) },
    });
    expect(r.ok).toBe(true);
    expect(logged.length).toBe(1); // loud
    const joined = logged.join("\n");
    expect(joined.toLowerCase()).toContain("metered");
    expect(joined).not.toContain("sk-supersecret-codex-value-999"); // no token value
  });

  test("fails with an actionable, token-free message when neither source is present", () => {
    const r = assertCodexAuth({ codexHome: "/home/worker/codex", env: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("codex login");
    expect(r.reason).toContain("/home/worker/codex/auth.json");
    expect(r.reason).not.toContain("sk-"); // never surfaces a token shape
  });

  test("a tokens-less auth.json is NOT accepted (falls through to fail)", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home2-"));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ notTokens: 1 }));
    const r = assertCodexAuth({ codexHome: home, env: {} });
    expect(r.ok).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

// ── resolveCodexBootEligibility (daemon-boot gate, mirrors resolveSdkBootExecutor) ─

describe("resolveCodexBootEligibility", () => {
  test("NO phase routes to codex → eligible:true, no auth/binary checks, no event", () => {
    const events = [];
    let authChecked = false;
    let binChecked = false;
    const out = resolveCodexBootEligibility(
      { triage: "bg", implement: "sdk" },
      {
        codexCfg: CFG,
        assertAuth: () => { authChecked = true; return { ok: false, reason: "should-not-run" }; },
        checkBinary: () => { binChecked = true; return true; },
        emitEvent: (e) => events.push(e),
      },
    );
    expect(out).toEqual({ eligible: true, reason: null });
    expect(authChecked).toBe(false);
    expect(binChecked).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("an empty / missing routing map → eligible:true (pure no-op)", () => {
    expect(resolveCodexBootEligibility({}, { codexCfg: CFG })).toEqual({ eligible: true, reason: null });
    expect(resolveCodexBootEligibility(undefined, { codexCfg: CFG })).toEqual({ eligible: true, reason: null });
  });

  test("codex routed + auth ok + binary ok → eligible:true", () => {
    const events = [];
    const out = resolveCodexBootEligibility(
      { triage: "codex-exec" },
      { codexCfg: CFG, assertAuth: OK_AUTH, checkBinary: () => true, emitEvent: (e) => events.push(e) },
    );
    expect(out).toEqual({ eligible: true, reason: null });
    expect(events).toHaveLength(0);
  });

  test("codex routed + auth MISSING → eligible:false, WARNs, emits execution-core.executor.codex-fallback", () => {
    const events = [];
    const warns = [];
    const out = resolveCodexBootEligibility(
      { triage: "codex-exec" },
      {
        codexCfg: CFG,
        assertAuth: () => ({ ok: false, reason: "codex auth missing — run codex login" }),
        checkBinary: () => true, // auth fails first — binary never consulted
        emitEvent: (e) => events.push(e),
        log: { warn: (...a) => warns.push(a) },
      },
    );
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/codex auth missing/);
    expect(warns).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]["event.name"]).toBe("execution-core.executor.codex-fallback");
    expect(events[0].payload).toMatchObject({ requested: "codex-exec", effective: "bg" });
    expect(events[0].payload.reason).toMatch(/codex auth missing/);
  });

  test("codex routed + auth ok but binary NOT runnable → eligible:false + codex-fallback event", () => {
    const events = [];
    const out = resolveCodexBootEligibility(
      { triage: "codex-exec" },
      { codexCfg: CFG, assertAuth: OK_AUTH, checkBinary: () => false, emitEvent: (e) => events.push(e) },
    );
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/not runnable/);
    expect(events[0]["event.name"]).toBe("execution-core.executor.codex-fallback");
  });

  test("a compound alias value is recognized case-insensitively; a throwing emitEvent never breaks boot", () => {
    const out = resolveCodexBootEligibility(
      { triage: "CODEX-EXEC" }, // case-insensitive match
      {
        codexCfg: CFG,
        assertAuth: () => ({ ok: false, reason: "nope" }),
        checkBinary: () => true,
        emitEvent: () => { throw new Error("event write boom"); },
      },
    );
    expect(out.eligible).toBe(false); // still returns, best-effort emit swallowed
  });

  // finding 1: a NODE-LEVEL codex boot executor (bootExecutor === "codex-exec") arms
  // the gate even with an EMPTY per-phase map — a codex node routes every phase to
  // codex, so its auth/binary must be checked at boot.
  test("bootExecutor codex-exec + EMPTY map + failing auth → eligible:false + codex-fallback effective:'bg'", () => {
    const events = [];
    const out = resolveCodexBootEligibility(
      {}, // no per-phase route — the node-level codex boot executor is what arms the gate
      {
        codexCfg: CFG,
        assertAuth: () => ({ ok: false, reason: "codex auth missing — run codex login" }),
        checkBinary: () => true,
        emitEvent: (e) => events.push(e),
        bootExecutor: "codex-exec",
      },
    );
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/codex auth missing/);
    expect(events).toHaveLength(1);
    expect(events[0]["event.name"]).toBe("execution-core.executor.codex-fallback");
    // finding 5: a node-level codex node degrades to "bg", never back to codex-exec.
    expect(events[0].payload.effective).toBe("bg");
  });

  // finding 5: for a NON-codex boot executor with a per-phase codex route, the event's
  // `effective` reports the REAL boot executor (e.g. "sdk"), not a literal "bg".
  test("codex-fallback effective reflects a non-bg boot executor (bootExecutor:'sdk')", () => {
    const events = [];
    const out = resolveCodexBootEligibility(
      { triage: "codex-exec" },
      {
        codexCfg: CFG,
        assertAuth: () => ({ ok: false, reason: "codex auth missing" }),
        checkBinary: () => true,
        emitEvent: (e) => events.push(e),
        bootExecutor: "sdk",
      },
    );
    expect(out.eligible).toBe(false);
    expect(events[0]["event.name"]).toBe("execution-core.executor.codex-fallback");
    expect(events[0].payload.effective).toBe("sdk");
  });

  // A codex-exec boot node whose auth+binary are BOTH ok → eligible:true, no fallback.
  test("bootExecutor codex-exec + auth ok + binary ok (empty map) → eligible:true, no event", () => {
    const events = [];
    const out = resolveCodexBootEligibility(
      {},
      {
        codexCfg: CFG,
        assertAuth: OK_AUTH,
        checkBinary: () => true,
        emitEvent: (e) => events.push(e),
        bootExecutor: "codex-exec",
      },
    );
    expect(out).toEqual({ eligible: true, reason: null });
    expect(events).toHaveLength(0);
  });
});

// ── buildCodexArgs ──────────────────────────────────────────────────────────

describe("buildCodexArgs", () => {
  test("emits the exact codex exec argv: workable_roots JSON (spaces safe), network_access, -m, prompt last", () => {
    const spec = makeCodexSpec();
    const cfg = { ...CFG, model: "gpt-5", writableRoots: ["/space dir/a", "/root"] };
    const args = buildCodexArgs(spec, cfg, { orchDir: "/ec", worktreePath: "/no-such-wt" });
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--sandbox", "workspace-write"]);
    // writable_roots is a valid JSON string-array (a path WITH SPACES survives).
    const firstC = args.indexOf("-c");
    const wrArg = args[firstC + 1];
    expect(wrArg.startsWith("sandbox_workspace_write.writable_roots=")).toBe(true);
    const rootsJson = wrArg.slice("sandbox_workspace_write.writable_roots=".length);
    expect(JSON.parse(rootsJson)).toEqual(["/space dir/a", "/root", "/ec"]); // configured ∪ orchDir, de-duped
    // network_access=true present.
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    // -m present only when cfg.model set, immediately before the prompt.
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5");
    // prompt is the LAST positional.
    expect(args[args.length - 1]).toBe(buildCodexPrompt(spec));
  });

  test("omits -m when cfg.model is null (never invents a model id)", () => {
    const spec = makeCodexSpec();
    const args = buildCodexArgs(spec, { ...CFG, model: null }, { orchDir: "/ec", worktreePath: "/no" });
    expect(args).not.toContain("-m");
    expect(args[args.length - 1]).toBe(buildCodexPrompt(spec));
  });

  // CTL-1457 (T6): a resume dispatch (spec.resumeSession set) builds the `exec resume
  // <id>` subcommand form so codex continues the interrupted thread; it still carries
  // --json + sandbox + writable_roots + network + model, and the prompt stays last.
  test("resumeSession set → argv starts with ['exec','resume','<id>'] and keeps --json + sandbox flags", () => {
    const spec = makeCodexSpec({ resumeSession: "019f5cd0-a4ee-7722-a22f-a7bd424b5689" });
    const args = buildCodexArgs(spec, { ...CFG, model: "gpt-5" }, { orchDir: "/ec", worktreePath: "/no" });
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "019f5cd0-a4ee-7722-a22f-a7bd424b5689"]);
    // the (global) options still ride after the resume subcommand.
    expect(args).toContain("--json");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args.some((a) => typeof a === "string" && a.startsWith("sandbox_workspace_write.writable_roots="))).toBe(true);
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5");
    expect(args[args.length - 1]).toBe(buildCodexPrompt(spec)); // prompt still last positional
  });

  test("resumeSession absent → the fresh `exec --json …` form is unchanged (starts with 'exec','--json')", () => {
    const spec = makeCodexSpec({ resumeSession: null });
    const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath: "/no" });
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).not.toContain("resume");
  });

  // CTL-1457 follow-up: for a LINKED worktree (every real ticket worktree), the
  // actual git-dir (HEAD/index/index.lock) and git-common-dir (object db + refs)
  // live OUTSIDE the worktree tree entirely — `git commit` there was refused with
  // a permission error because neither was ever in writable_roots. Uses a real
  // `git worktree add` (not just `git init`) so `--absolute-git-dir` genuinely
  // resolves outside `wt`, exercising the actual bug scenario.
  test("linked worktree → writable_roots includes the real --absolute-git-dir and --git-common-dir (both live outside the worktree tree)", () => {
    const main = mkdtempSync(join(tmpdir(), "codex-main-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.invalid",
    };
    Bun.spawnSync(["git", "init", "-b", "main"], { cwd: main });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: main, env });
    // `git worktree add` requires the target path not to already exist yet, so
    // mkdtemp-then-remove just to mint a unique path (mirrors the mkdtemp pattern
    // used elsewhere in this file for real-git fixtures).
    const wt = mkdtempSync(join(tmpdir(), "codex-linked-wt-"));
    rmSync(wt, { recursive: true, force: true });
    Bun.spawnSync(["git", "worktree", "add", "-b", "feature", wt], { cwd: main });

    const spec = makeCodexSpec();
    const args = buildCodexArgs(spec, { ...CFG, writableRoots: [] }, { orchDir: "/ec", worktreePath: wt });
    const firstC = args.indexOf("-c");
    const roots = JSON.parse(args[firstC + 1].slice("sandbox_workspace_write.writable_roots=".length));

    const gitDir = Bun.spawnSync(["git", "-C", wt, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" })
      .stdout.toString()
      .trim();
    const commonDir = Bun.spawnSync(
      ["git", "-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    )
      .stdout.toString()
      .trim();

    expect(gitDir.startsWith(wt)).toBe(false); // proves it's genuinely OUTSIDE the worktree tree
    expect(roots).toContain(gitDir);
    expect(roots).toContain(commonDir);

    Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: main });
    rmSync(main, { recursive: true, force: true });
  });
});

// ── buildCodexArgs: thoughts/ symlink resolution into writable_roots ─────────
//
// The REAL on-disk convention (lib/provision-thoughts.sh) is NOT "thoughts is a
// symlink" — it's "thoughts is a real directory whose immediate entries (global,
// shared) are themselves symlinks pointing OUTSIDE the worktree." A prior version
// of resolveThoughtsRoot only ever `realpathSync`'d the `thoughts` directory
// itself, which — since `thoughts` isn't a symlink in this shape — just returned
// the unchanged worktree-local path and never added the actual external target
// at all. Confirmed live 2026-08-03: this silently broke every research/plan
// artifact write for codex-exec-routed phases across 4+ real tickets
// (COP-3/COP-5/CQD-5/CQD-7), each failing with a "thoughts/shared symlink target
// outside writable roots" sandbox denial.
describe("buildCodexArgs — thoughts/ symlink resolution into writable_roots", () => {
  function extractWritableRoots(args) {
    const idx = args.indexOf("-c");
    for (let i = idx; i < args.length; i += 2) {
      const flag = args[i + 1];
      if (typeof flag === "string" && flag.startsWith("sandbox_workspace_write.writable_roots=")) {
        return JSON.parse(flag.slice("sandbox_workspace_write.writable_roots=".length));
      }
    }
    throw new Error("writable_roots flag not found in args");
  }

  function makeWorktreeWithThoughts(build) {
    // realpathSync the temp root immediately: macOS's /tmp (and /var) are
    // themselves symlinks into /private/..., so anything resolveThoughtsRoots
    // resolves via realpathSync comes back CANONICALIZED — comparing against
    // an un-canonicalized `root` would spuriously fail on macOS specifically.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-thoughts-")));
    const worktreePath = join(root, "wt", "CTL-100");
    mkdirSync(worktreePath, { recursive: true });
    const external = join(root, "external-thoughts-repo");
    mkdirSync(external, { recursive: true });
    build({ root, worktreePath, external });
    return { root, worktreePath, external };
  }

  test("REAL on-disk shape: thoughts/ is a real dir; its shared + global entries are symlinks — both real targets land in writable_roots", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ root, worktreePath, external }) => {
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      const sharedTarget = join(external, "repos", "coppa", "shared");
      const globalTarget = join(external, "global");
      mkdirSync(sharedTarget, { recursive: true });
      mkdirSync(globalTarget, { recursive: true });
      symlinkSync(sharedTarget, join(thoughtsDir, "shared"));
      symlinkSync(globalTarget, join(thoughtsDir, "global"));
      // A REAL (non-symlink) subdirectory alongside the symlinks — must be ignored.
      mkdirSync(join(thoughtsDir, "searchable"), { recursive: true });
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo", "repos", "coppa", "shared"));
      expect(roots).toContain(join(root, "external-thoughts-repo", "global"));
      // The worktree-local thoughts/ path itself is not a useful ADDITIONAL root
      // (it's already inside the worktree) and must not be added redundantly.
      expect(roots).not.toContain(join(worktreePath, "thoughts"));
      expect(roots).not.toContain(join(worktreePath, "thoughts", "searchable"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("LEGACY shape preserved: thoughts itself IS a direct symlink — still resolves to its target", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      symlinkSync(external, join(worktreePath, "thoughts"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("thoughts/ has no symlinked entries at all (real subdirs only) — adds nothing, does not throw", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath }) => {
      mkdirSync(join(worktreePath, "thoughts", "searchable"), { recursive: true });
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no thoughts/ directory at all under the worktree — adds nothing, does not throw", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(() => {});
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a BROKEN symlink inside thoughts/ (dangling target) is skipped, not thrown", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      symlinkSync(join(external, "does-not-exist"), join(thoughtsDir, "shared"));
    });
    try {
      const spec = makeCodexSpec();
      // Must not throw despite the dangling symlink.
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 2026-08-07 hardening (round-2 review, PR #3082): a prior codex turn already
  // has write access to its OWN worktree (including thoughts/), so it can plant
  // an arbitrary symlink there for free. These tests prove that planted symlink
  // can't turn into a FUTURE dispatch's filesystem-wide writable_roots grant.

  test("an UNPROVISIONED symlink name under thoughts/ (e.g. thoughts/root -> /) is never resolved into writable_roots", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath }) => {
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      // Not "shared" or "global" — an attacker/compromised-turn-planted name.
      symlinkSync("/", join(thoughtsDir, "root"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
      expect(roots).not.toContain("/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a PROVISIONED entry (thoughts/shared) resolving to a dangerously shallow target (/) is excluded, not granted", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath }) => {
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      symlinkSync("/", join(thoughtsDir, "shared"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
      expect(roots).not.toContain("/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("LEGACY shape: thoughts itself symlinked straight to / is excluded, not granted", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath }) => {
      symlinkSync("/", join(worktreePath, "thoughts"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
      expect(roots).not.toContain("/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 2026-08-07 P1 follow-up (Codex round-3, PR #3082): a bare segment-count
  // floor alone is insufficient — an attacker-chosen target with 2+ segments
  // (e.g. `/home/alice`) still passes a length-only check while granting
  // write access to an unrelated directory. Once a worktree declares
  // `.catalyst/config.json` → `catalyst.thoughts.directory`, resolution must
  // be validated against THAT configured repository, not shape alone.
  function writeThoughtsDirectoryConfig(worktreePath, directory) {
    mkdirSync(join(worktreePath, ".catalyst"), { recursive: true });
    writeFileSync(
      join(worktreePath, ".catalyst", "config.json"),
      JSON.stringify({ catalyst: { thoughts: { directory } } }),
    );
  }

  test("SECURITY (configured regime): thoughts/shared -> /home/alice (2 segments, matches the OLD floor) is rejected once a thoughts directory is configured and doesn't match", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      // Attacker-chosen, unrelated, but structurally "sane" (2-segment) target.
      symlinkSync("/private", join(thoughtsDir, "shared"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
      expect(roots).not.toContain("/private");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured regime: a MATCHING thoughts/shared (…/repos/<directory>/shared) is accepted, and thoughts/global is validated against the SAME derived anchor", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      const sharedTarget = join(external, "repos", "coppa", "shared");
      const globalTarget = join(external, "global");
      mkdirSync(sharedTarget, { recursive: true });
      mkdirSync(globalTarget, { recursive: true });
      symlinkSync(sharedTarget, join(thoughtsDir, "shared"));
      symlinkSync(globalTarget, join(thoughtsDir, "global"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo", "repos", "coppa", "shared"));
      expect(roots).toContain(join(root, "external-thoughts-repo", "global"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured regime: thoughts/global pointed OUTSIDE the validated shared anchor (a sibling repo, not nested under THOUGHTS_REPO) is rejected even though shared itself is legitimate", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ root, worktreePath, external }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      const sharedTarget = join(external, "repos", "coppa", "shared");
      mkdirSync(sharedTarget, { recursive: true });
      symlinkSync(sharedTarget, join(thoughtsDir, "shared"));
      // `global` re-pointed at a structurally-sane directory that is NOT
      // nested under the shared-derived THOUGHTS_REPO anchor (`external`) —
      // a sibling directory under `root` instead.
      const rogueGlobal = join(root, "unrelated-sibling-dir");
      mkdirSync(rogueGlobal, { recursive: true });
      symlinkSync(rogueGlobal, join(thoughtsDir, "global"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo", "repos", "coppa", "shared"));
      expect(roots).not.toContain(join(root, "unrelated-sibling-dir"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured regime: a DECLARED-but-mismatched directory rejects shared outright even though it resolves elsewhere on-disk", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      writeThoughtsDirectoryConfig(worktreePath, "wrong-project");
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      const sharedTarget = join(external, "repos", "coppa", "shared");
      mkdirSync(sharedTarget, { recursive: true });
      symlinkSync(sharedTarget, join(thoughtsDir, "shared"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 2026-08-07 P1 follow-up round 2 (Codex round-4, PR #3082): the LEGACY
  // direct-symlink shape (`thoughts` itself is a symlink) returned before the
  // configured-directory check entirely, so it still accepted an
  // attacker-chosen 2-segment target (e.g. `thoughts -> /home/alice`) even in
  // a worktree with a declared thoughts directory.
  test("SECURITY (configured regime, LEGACY shape): thoughts -> /home/alice is rejected once a thoughts directory is configured, even though it passes the old bare structural floor", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      symlinkSync("/private", join(worktreePath, "thoughts"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toEqual([...CFG.writableRoots, "/ec"]);
      expect(roots).not.toContain("/private");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured regime, LEGACY shape: a target matching the declared directory's /repos/<dir>/ segment is accepted", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      const legacyTarget = join(external, "repos", "coppa", "shared");
      mkdirSync(legacyTarget, { recursive: true });
      symlinkSync(legacyTarget, join(worktreePath, "thoughts"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo", "repos", "coppa", "shared"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // 2026-08-07 P1 follow-up round 2 (Codex round-4, PR #3082): "nested under
  // the anchor" was too permissive — `thoughts/global` re-pointed at the
  // anchor ITSELF (the whole THOUGHTS_REPO, every project under repos/) used
  // to pass. `global` must resolve to the EXACT `<THOUGHTS_REPO>/global`
  // target lib/provision-thoughts.sh / worktree-thoughts-init.sh provision,
  // not merely something under that root.
  test("SECURITY (configured regime): thoughts/global re-pointed at the THOUGHTS_REPO anchor itself (not the exact global/ subdir) is rejected", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      const sharedTarget = join(external, "repos", "coppa", "shared");
      mkdirSync(sharedTarget, { recursive: true });
      symlinkSync(sharedTarget, join(thoughtsDir, "shared"));
      // `global` re-pointed at the anchor root ITSELF — grants the whole
      // THOUGHTS_REPO (every project under repos/), not just global/.
      symlinkSync(external, join(thoughtsDir, "global"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo", "repos", "coppa", "shared"));
      expect(roots).not.toContain(join(root, "external-thoughts-repo"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SECURITY (configured regime): thoughts/global pointed at a DESCENDANT of the anchor (not the exact global/ subdir) is rejected", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      const sharedTarget = join(external, "repos", "coppa", "shared");
      mkdirSync(sharedTarget, { recursive: true });
      symlinkSync(sharedTarget, join(thoughtsDir, "shared"));
      // `global` re-pointed at ANOTHER project's shared dir under the SAME
      // anchor — nested under THOUGHTS_REPO, but not the exact global/ path.
      const otherProjectShared = join(external, "repos", "other-project", "shared");
      mkdirSync(otherProjectShared, { recursive: true });
      symlinkSync(otherProjectShared, join(thoughtsDir, "global"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo", "repos", "coppa", "shared"));
      expect(roots).not.toContain(
        join(root, "external-thoughts-repo", "repos", "other-project", "shared"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configured regime: thoughts/global resolving to the EXACT <anchor>/global target is accepted", () => {
    const { root, worktreePath } = makeWorktreeWithThoughts(({ worktreePath, external }) => {
      writeThoughtsDirectoryConfig(worktreePath, "coppa");
      const thoughtsDir = join(worktreePath, "thoughts");
      mkdirSync(thoughtsDir, { recursive: true });
      const sharedTarget = join(external, "repos", "coppa", "shared");
      const globalTarget = join(external, "global");
      mkdirSync(sharedTarget, { recursive: true });
      mkdirSync(globalTarget, { recursive: true });
      symlinkSync(sharedTarget, join(thoughtsDir, "shared"));
      symlinkSync(globalTarget, join(thoughtsDir, "global"));
    });
    try {
      const spec = makeCodexSpec();
      const args = buildCodexArgs(spec, CFG, { orchDir: "/ec", worktreePath });
      const roots = extractWritableRoots(args);
      expect(roots).toContain(join(root, "external-thoughts-repo", "global"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── buildCodexEnv ───────────────────────────────────────────────────────────

describe("buildCodexEnv", () => {
  test("sets CODEX_HOME/CLAUDE_PLUGIN_ROOT/CATALYST_EXECUTOR_ID; deletes all three Claude-auth vars; preserves CATALYST_*", () => {
    const spec = makeCodexSpec({
      pluginDirs: ["/checkout/plugins/dev"],
      env: [
        "CATALYST_TICKET=CTL-100",
        "CATALYST_PHASE=implement",
        "ANTHROPIC_API_KEY=sk-x",
        "ANTHROPIC_AUTH_TOKEN=y",
        "CLAUDE_CODE_OAUTH_TOKEN=tok",
      ],
    });
    const env = buildCodexEnv(spec, { ...CFG, codexHome: "/home/codex" });
    expect(env.CODEX_HOME).toBe("/home/codex");
    expect(env.CLAUDE_PLUGIN_ROOT).toBe("/checkout/plugins/dev");
    expect(env.CATALYST_EXECUTOR_ID).toBe("codex-exec");
    // The KEY divergence from buildSdkEnv — CLAUDE_CODE_OAUTH_TOKEN is stripped too.
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
    // CATALYST_* from the spec env preserved.
    expect(env.CATALYST_TICKET).toBe("CTL-100");
    expect(env.CATALYST_PHASE).toBe("implement");
  });

  test("falls back to pluginDirs[0] for CLAUDE_PLUGIN_ROOT when no leaf is the dev plugin", () => {
    const env = buildCodexEnv(makeCodexSpec({ pluginDirs: ["/some/other-plugin"] }), CFG);
    expect(env.CLAUDE_PLUGIN_ROOT).toBe("/some/other-plugin");
  });

  // CTL-1457 (T4): cfg.pluginRoot (the resolved codex.pluginRoot override) wins over
  // spec.pluginDirs for CLAUDE_PLUGIN_ROOT — even when pluginDirs is empty/stale.
  test("cfg.pluginRoot overrides spec.pluginDirs for CLAUDE_PLUGIN_ROOT, even with empty pluginDirs", () => {
    const env = buildCodexEnv(makeCodexSpec({ pluginDirs: [] }), { ...CFG, pluginRoot: "/override/plugins/dev" });
    expect(env.CLAUDE_PLUGIN_ROOT).toBe("/override/plugins/dev");
  });

  // CTL-1457 (N3): auth.json / ChatGPT-plan mode (NO CODEX_API_KEY) — strip the OpenAI
  // API key + provider overrides so the child can never silently run metered / against a
  // wrong endpoint with none of the LOUD CODEX_API_KEY warning.
  test("N3: auth.json mode (no CODEX_API_KEY) — OPENAI_API_KEY + provider overrides deleted from the child env", () => {
    const spec = makeCodexSpec({
      env: [
        "OPENAI_API_KEY=sk-openai-leak",
        "OPENAI_BASE_URL=https://proxy.example/v1",
        "OPENAI_API_BASE=https://proxy.example",
        "OPENAI_ORG=org-x",
        "OPENAI_ORGANIZATION=org-y",
        "CATALYST_TICKET=CTL-100",
      ],
    });
    const env = buildCodexEnv(spec, CFG); // CFG has no CODEX_API_KEY
    expect("OPENAI_API_KEY" in env).toBe(false);
    expect("OPENAI_BASE_URL" in env).toBe(false);
    expect("OPENAI_API_BASE" in env).toBe(false);
    expect("OPENAI_ORG" in env).toBe(false);
    expect("OPENAI_ORGANIZATION" in env).toBe(false);
    // CATALYST_* untouched — only the OpenAI vendor/provider vars are stripped.
    expect(env.CATALYST_TICKET).toBe("CTL-100");
  });

  // CTL-1457 (N3): metered API-key mode (CODEX_API_KEY set) — the operator opted into the
  // API path, so the OpenAI provider env is LEFT intact.
  test("N3: CODEX_API_KEY mode — OpenAI provider env is left intact", () => {
    const spec = makeCodexSpec({
      env: [
        "CODEX_API_KEY=sk-codex-metered",
        "OPENAI_API_KEY=sk-openai-intended",
        "OPENAI_BASE_URL=https://api.openai.com/v1",
      ],
    });
    const env = buildCodexEnv(spec, CFG);
    expect(env.OPENAI_API_KEY).toBe("sk-openai-intended");
    expect(env.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });
});

// ── buildCodexPrompt (snapshot-by-assertion) ──────────────────────────────────

describe("buildCodexPrompt", () => {
  test("renders the skill invocation + argument tail + harness shim", () => {
    const out = buildCodexPrompt(
      makeCodexSpec({ prompt: "/catalyst-dev:phase-triage CTL-123 --orch-dir /x --orch-id CTL-123" }),
    );
    expect(out).toContain("Use the `phase-triage` skill (catalyst-dev plugin). Arguments: CTL-123 --orch-dir /x --orch-id CTL-123.");
    // Harness shim: skip /goal, skip claude stop, must finish with phase-agent-emit-complete.
    expect(out).toContain("`## /goal`");
    expect(out.toLowerCase()).toContain("skip");
    expect(out).toContain("claude stop");
    expect(out).toContain("phase-agent-emit-complete");
  });

  test("falls back to the raw prompt + shim when parsing fails", () => {
    const out = buildCodexPrompt(makeCodexSpec({ prompt: "not a slash command" }));
    expect(out).toContain("not a slash command");
    expect(out).toContain("phase-agent-emit-complete");
  });
});

// ── ensureCodexSkills ─────────────────────────────────────────────────────────

describe("ensureCodexSkills", () => {
  test("symlinks .agents/skills to the dev skills dir and git-excludes .agents/", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-"));
    const devDir = join(checkout, "plugins", "dev");
    const skillsDir = join(devDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    // A real git worktree so `git rev-parse --git-path info/exclude` resolves.
    Bun.spawnSync(["git", "init"], { cwd: wt });

    ensureCodexSkills(wt, { pluginDirs: [devDir] });

    const link = join(wt, ".agents", "skills");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(skillsDir);
    const exclude = readFileSync(join(wt, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".agents/");

    // Idempotent: a second call does not throw and the link survives.
    ensureCodexSkills(wt, { pluginDirs: [devDir] });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // The exclude pattern is not duplicated.
    const exclude2 = readFileSync(join(wt, ".git", "info", "exclude"), "utf8");
    expect(exclude2.split("\n").filter((l) => l.trim() === ".agents/").length).toBe(1);

    rmSync(wt, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  test("best-effort: never throws when pluginDirs is empty or worktree is missing", () => {
    expect(() => ensureCodexSkills("/no/such/wt", { pluginDirs: [] })).not.toThrow();
    expect(() => ensureCodexSkills(undefined, {})).not.toThrow();
  });

  // CTL-1457 (T7): a PRE-EXISTING FOREIGN symlink at .agents/skills (pointing at
  // something other than our skills source) is NEVER touched — this is the
  // top-level symlink check, unchanged by the CTL-1530 merge-aware work below
  // (that only applies when the existing entry is a REAL directory).
  test("pre-existing FOREIGN symlink at .agents/skills → left untouched; warns once; no merge attempted", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-foreign-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-foreign-"));
    const devDir = join(checkout, "plugins", "dev");
    mkdirSync(join(devDir, "skills"), { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "codex-elsewhere-"));
    mkdirSync(join(wt, ".agents"), { recursive: true });
    const foreignLink = join(wt, ".agents", "skills");
    Bun.spawnSync(["ln", "-s", elsewhere, foreignLink]);
    const warns = [];

    ensureCodexSkills(wt, { pluginDirs: [devDir], log: { warn: (...a) => warns.push(a) } });

    expect(lstatSync(foreignLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(foreignLink)).toBe(elsewhere); // untouched
    expect(warns.length).toBe(1); // loud skip

    rmSync(wt, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  // CTL-1530 (threads dLZ + dLh + dLX): a PRE-EXISTING REAL .agents/skills
  // directory (e.g. a dual-harness-migrated project) is NEVER touched and NEVER
  // git-excluded — the prior in-tree per-entry MERGE approach shared
  // .git/info/exclude across linked worktrees (dLZ), masked project-owned phase-*
  // skills, and (narrowed to phase-* only) broke the phase wrappers' transitive
  // skill deps (dLh). Instead the FULL dev-plugin skills set is registered
  // machine-locally under <codexHome>/skills/, entirely outside the project
  // worktree/repo — so the migrate-dual-harness trackability audit sees nothing
  // new either (dLX).
  test("REAL project dir → untouched, no exclude written, CODEX_HOME/skills populated with the FULL dev-plugin skill set", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-realdir-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-realdir-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-realdir-"));
    const devDir = join(checkout, "plugins", "dev");
    const skillsSrc = join(devDir, "skills");
    mkdirSync(join(skillsSrc, "phase-triage"), { recursive: true });
    mkdirSync(join(skillsSrc, "phase-plan"), { recursive: true });
    mkdirSync(join(skillsSrc, "create-plan"), { recursive: true }); // a non-phase transitive dep (dLh)
    Bun.spawnSync(["git", "init"], { cwd: wt });

    // A REAL, project-owned .agents/skills dir with its own unrelated skill.
    const realSkills = join(wt, ".agents", "skills");
    mkdirSync(join(realSkills, "my-project-skill"), { recursive: true });
    writeFileSync(join(realSkills, "my-project-skill", "SKILL.md"), "project-owned — do not touch");

    ensureCodexSkills(wt, { pluginDirs: [devDir], codexHome });

    // The real directory itself is preserved (never replaced by a symlink) and
    // gets NO new entries — the project's own entry is untouched.
    expect(lstatSync(realSkills).isSymbolicLink()).toBe(false);
    expect(lstatSync(realSkills).isDirectory()).toBe(true);
    expect(readFileSync(join(realSkills, "my-project-skill", "SKILL.md"), "utf8")).toContain("do not touch");
    expect(() => lstatSync(join(realSkills, "phase-triage"))).toThrow(); // nothing added in-tree

    // No git exclude written by us at all — the real dir is never touched, so
    // nothing needs hiding from `git status` (only git's own default template
    // comments may be present from `git init`).
    const exclude = readFileSync(join(wt, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain(".agents");

    // The FULL dev-plugin skill set (phase-* AND its non-phase transitive deps,
    // closing dLh) was registered machine-locally under CODEX_HOME/skills.
    const homeSkills = join(codexHome, "skills");
    const triageLink = join(homeSkills, "phase-triage");
    const planLink = join(homeSkills, "phase-plan");
    const createPlanLink = join(homeSkills, "create-plan");
    expect(lstatSync(triageLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(triageLink)).toBe(join(skillsSrc, "phase-triage"));
    expect(lstatSync(planLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(planLink)).toBe(join(skillsSrc, "phase-plan"));
    expect(lstatSync(createPlanLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(createPlanLink)).toBe(join(skillsSrc, "create-plan"));

    rmSync(wt, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  // CTL-1530: re-running the CODEX_HOME registration over an already-registered
  // real dir is an idempotent no-op — our own per-entry symlinks are recognized
  // and never duplicated or re-created.
  test("CODEX_HOME registration is idempotent on a second run: links unchanged, real dir still untouched, no throw", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-realdir-idem-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-realdir-idem-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-realdir-idem-"));
    const devDir = join(checkout, "plugins", "dev");
    const skillsSrc = join(devDir, "skills");
    mkdirSync(join(skillsSrc, "phase-triage"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });
    const realSkills = join(wt, ".agents", "skills");
    mkdirSync(realSkills, { recursive: true });

    ensureCodexSkills(wt, { pluginDirs: [devDir], codexHome });
    const link = join(codexHome, "skills", "phase-triage");
    expect(readlinkSync(link)).toBe(join(skillsSrc, "phase-triage"));

    expect(() => ensureCodexSkills(wt, { pluginDirs: [devDir], codexHome })).not.toThrow();
    expect(lstatSync(realSkills).isSymbolicLink()).toBe(false); // still the real dir, untouched
    expect(readlinkSync(link)).toBe(join(skillsSrc, "phase-triage"));

    rmSync(wt, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  // CTL-1530: a real project dir with NO codexHome configured is a best-effort,
  // loud no-op — never a throw, and the real dir is still left untouched.
  test("REAL project dir + no codexHome configured → warns and skips registration; never throws; real dir untouched", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-realdir-nohome-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-realdir-nohome-"));
    const devDir = join(checkout, "plugins", "dev");
    const skillsSrc = join(devDir, "skills");
    mkdirSync(join(skillsSrc, "phase-triage"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });
    const realSkills = join(wt, ".agents", "skills");
    mkdirSync(realSkills, { recursive: true });
    const warns = [];

    expect(() =>
      ensureCodexSkills(wt, { pluginDirs: [devDir], log: { warn: (...a) => warns.push(a) } }),
    ).not.toThrow();
    expect(lstatSync(realSkills).isDirectory()).toBe(true);
    expect(warns.length).toBeGreaterThan(0);

    rmSync(wt, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  // CTL-1457 (T7): a pre-existing OUR symlink (→ our target) is an idempotent no-op.
  test("pre-existing OUR symlink → idempotent no-op (link preserved, no throw)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-ours-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-ours-"));
    const devDir = join(checkout, "plugins", "dev");
    const skillsDir = join(devDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    ensureCodexSkills(wt, { pluginDirs: [devDir] }); // creates OUR symlink
    const link = join(wt, ".agents", "skills");
    expect(readlinkSync(link)).toBe(skillsDir);
    // Second call over OUR symlink → no-op, link unchanged.
    ensureCodexSkills(wt, { pluginDirs: [devDir] });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(skillsDir);

    rmSync(wt, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  // CTL-1457 (T4): ensureCodexSkills targets cfg.pluginRoot's skills dir (before pluginDirs).
  test("pluginRoot overrides pluginDirs for the skills symlink source (T4)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-proot-"));
    const overrideDev = mkdtempSync(join(tmpdir(), "codex-override-dev-"));
    mkdirSync(join(overrideDev, "skills"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    // Empty pluginDirs but a pluginRoot override → the link points at the override skills.
    ensureCodexSkills(wt, { pluginDirs: [], pluginRoot: overrideDev });
    const link = join(wt, ".agents", "skills");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(overrideDev, "skills"));

    rmSync(wt, { recursive: true, force: true });
    rmSync(overrideDev, { recursive: true, force: true });
  });

  // CTL-1530 (thread pJD): a top-level symlink this runner ACTUALLY created
  // against an OLD checkout path is PROVEN runner-owned by the link registry
  // (<codexHome>/codex-exec-links.json), even though the prefix no longer
  // matches the currently configured source. It must be refreshed, not
  // permanently skipped as foreign — otherwise, once the old checkout is
  // removed, the link dangles forever and codex can never discover the phase
  // skills. Seeded via a REAL first call (establishing genuine registry proof,
  // not a hand-crafted `ln -s`) so this exercises the exact production path.
  test("STALE runner-owned top-level symlink (old checkout root), PROVEN by the registry, is refreshed to the current source", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-stale-top-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-stale-top-"));
    const oldCheckout = mkdtempSync(join(tmpdir(), "codex-old-checkout-"));
    const newCheckout = mkdtempSync(join(tmpdir(), "codex-new-checkout-"));
    const oldDevDir = join(oldCheckout, "plugins", "dev");
    const oldSkills = join(oldDevDir, "skills");
    const newDevDir = join(newCheckout, "plugins", "dev");
    const newSkills = join(newDevDir, "skills");
    mkdirSync(oldSkills, { recursive: true });
    mkdirSync(newSkills, { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    // An earlier dispatch actually ran against the OLD checkout — this is the
    // real write path, so the registry now holds genuine proof.
    ensureCodexSkills(wt, { pluginDirs: [oldDevDir], codexHome });
    const link = join(wt, ".agents", "skills");
    expect(readlinkSync(link)).toBe(oldSkills);
    // The old checkout is gone — the link now dangles.
    rmSync(oldCheckout, { recursive: true, force: true });

    ensureCodexSkills(wt, { pluginDirs: [newDevDir], codexHome });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(newSkills); // refreshed to the CURRENT source

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(newCheckout, { recursive: true, force: true });
  });

  // CTL-1530 (thread pJD — the actual repro): a project-authored top-level link
  // that LOOKS exactly like something this runner would write (absolute, ends in
  // `plugins/dev/skills`, even home-rooted — e.g.
  // `.agents/skills -> ~/src/catalyst/plugins/dev/skills`, a reasonable vendored
  // checkout convention) but that THIS runner never created — no registry entry
  // proves it — must be preserved untouched, never repointed. The old
  // shape-only heuristic (home-rooted + suffix match) wrongly classified this
  // exact case as runner-owned; the registry-proof model fixes it.
  test("project-authored link that LOOKS runner-shaped (home-rooted, suffix-matching) but has NO registry entry is preserved untouched + warned (pJD repro)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-pjd-repro-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-pjd-repro-"));
    Bun.spawnSync(["git", "init"], { cwd: wt });
    mkdirSync(join(wt, ".agents"), { recursive: true });
    const link = join(wt, ".agents", "skills");
    // A project's OWN vendored-checkout link — this runner never wrote it, and
    // no registry entry says otherwise.
    const projectTarget = join(tmpdir(), "codex-pjd-vendor-", "src", "catalyst", "plugins", "dev", "skills");
    mkdirSync(projectTarget, { recursive: true });
    Bun.spawnSync(["ln", "-s", projectTarget, link]);
    const warns = [];

    ensureCodexSkills(wt, {
      pluginDirs: ["/some/other/checkout/plugins/dev"],
      codexHome,
      log: { warn: (...a) => warns.push(a) },
    });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(projectTarget); // untouched — never repointed
    expect(warns.length).toBe(1); // loud skip, exactly like any other foreign link

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(dirname(projectTarget), { recursive: true, force: true });
  });

  // CTL-1530 (thread zc0 — the pJD repro extended): a project-authored link
  // that already points at the CURRENT configured source is the idempotent
  // no-op branch (`target === skillsSrc`), NOT the registry check — but the OLD
  // code self-healed a registry entry for it anyway ("adopting" a link this
  // runner never created). Prove the fix: register nothing on that no-op, so a
  // LATER pluginRoot change finds no proof and leaves the (now-mismatched)
  // project link untouched + warned, rather than repointing it.
  test("project-authored top-level link pointing at the CURRENT source is never adopted into the registry; a later root change preserves it + warns (zc0)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-zc0-top-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-zc0-top-"));
    const checkoutA = mkdtempSync(join(tmpdir(), "codex-checkout-zc0-a-"));
    const checkoutB = mkdtempSync(join(tmpdir(), "codex-checkout-zc0-b-"));
    const devDirA = join(checkoutA, "plugins", "dev");
    const devDirB = join(checkoutB, "plugins", "dev");
    const skillsA = join(devDirA, "skills");
    mkdirSync(skillsA, { recursive: true });
    mkdirSync(join(devDirB, "skills"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });
    mkdirSync(join(wt, ".agents"), { recursive: true });
    const link = join(wt, ".agents", "skills");
    // A project independently authored this link — it happens to already
    // point at what would be the current source under devDirA. This runner
    // never created it (no ensureCodexSkills call has happened yet).
    Bun.spawnSync(["ln", "-s", skillsA, link]);

    // First call: pluginDirs matches the link's existing target exactly, so
    // this hits the idempotent-no-op branch — must NOT register anything.
    ensureCodexSkills(wt, { pluginDirs: [devDirA], codexHome });
    expect(readlinkSync(link)).toBe(skillsA); // untouched, still correct

    // Second call: the configured root changes. With no registry proof for
    // this link, it must be preserved + warned — never repointed.
    const warns = [];
    ensureCodexSkills(wt, { pluginDirs: [devDirB], codexHome, log: { warn: (...a) => warns.push(a) } });

    expect(readlinkSync(link)).toBe(skillsA); // STILL untouched — never adopted, never repointed
    expect(warns.length).toBe(1); // loud skip

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(checkoutA, { recursive: true, force: true });
    rmSync(checkoutB, { recursive: true, force: true });
  });

  // CTL-1530 (thread zc0): the SAME "never adopt a coincidental match" rule
  // applies to a per-entry link registered under CODEX_HOME/skills (a real
  // project-owned .agents/skills dir).
  test("project-authored per-entry CODEX_HOME/skills link pointing at the CURRENT source is never adopted; a later root change preserves it + warns (zc0)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-zc0-entry-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-zc0-entry-"));
    const checkoutA = mkdtempSync(join(tmpdir(), "codex-checkout-zc0-entry-a-"));
    const checkoutB = mkdtempSync(join(tmpdir(), "codex-checkout-zc0-entry-b-"));
    const devDirA = join(checkoutA, "plugins", "dev");
    const devDirB = join(checkoutB, "plugins", "dev");
    const skillsSrcA = join(devDirA, "skills");
    mkdirSync(join(skillsSrcA, "phase-triage"), { recursive: true });
    mkdirSync(join(devDirB, "skills", "phase-triage"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    const realSkills = join(wt, ".agents", "skills");
    mkdirSync(realSkills, { recursive: true }); // a REAL, project-owned dir
    const homeSkillsDir = join(codexHome, "skills");
    mkdirSync(homeSkillsDir, { recursive: true });
    const entryLink = join(homeSkillsDir, "phase-triage");
    // A pre-existing entry that happens to already match devDirA's source —
    // this runner never wrote it via symlinkSync.
    Bun.spawnSync(["ln", "-s", join(skillsSrcA, "phase-triage"), entryLink]);

    ensureCodexSkills(wt, { pluginDirs: [devDirA], codexHome });
    expect(readlinkSync(entryLink)).toBe(join(skillsSrcA, "phase-triage")); // untouched, still correct

    const warns = [];
    ensureCodexSkills(wt, { pluginDirs: [devDirB], codexHome, log: { warn: (...a) => warns.push(a) } });

    expect(readlinkSync(entryLink)).toBe(join(skillsSrcA, "phase-triage")); // STILL untouched
    expect(warns.length).toBeGreaterThan(0); // loud skip

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(checkoutA, { recursive: true, force: true });
    rmSync(checkoutB, { recursive: true, force: true });
  });

  // CTL-1530 (thread zdB): a refresh failure must leave the OLD, still-usable
  // link completely in place — never removed and then unable to be replaced.
  // Simulated by making the `.agents` directory unwritable so the atomic
  // refresh's temp-symlink creation fails immediately (before anything is
  // touched), which exercises the "leave dest untouched on failure" contract.
  test("refresh failure (unwritable dir) leaves the ORIGINAL top-level link untouched + warns, never discarded (zdB)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // Root bypasses the 0555 permission bits, so the forced EACCES never
      // fires and the refresh would (correctly) succeed — the contract under
      // test is unreachable as root. Skip rather than assert the wrong target.
      return;
    }
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-zdb-top-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-zdb-top-"));
    const oldCheckout = mkdtempSync(join(tmpdir(), "codex-old-checkout-zdb-"));
    const newCheckout = mkdtempSync(join(tmpdir(), "codex-new-checkout-zdb-"));
    const oldDevDir = join(oldCheckout, "plugins", "dev");
    const newDevDir = join(newCheckout, "plugins", "dev");
    mkdirSync(join(oldDevDir, "skills"), { recursive: true });
    mkdirSync(join(newDevDir, "skills"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    // Establish genuine registry proof for a link against the OLD checkout.
    ensureCodexSkills(wt, { pluginDirs: [oldDevDir], codexHome });
    const link = join(wt, ".agents", "skills");
    const originalTarget = readlinkSync(link);
    rmSync(oldCheckout, { recursive: true, force: true }); // dangles — now stale-refresh-eligible

    // Make .agents unwritable so the atomic refresh's temp-symlink creation
    // fails (EACCES) before `link` is ever touched.
    chmodSync(join(wt, ".agents"), 0o555);
    const warns = [];
    try {
      ensureCodexSkills(wt, {
        pluginDirs: [newDevDir],
        codexHome,
        log: { warn: (...a) => warns.push(a) },
      });
    } finally {
      chmodSync(join(wt, ".agents"), 0o755); // restore so cleanup can rmSync
    }

    expect(readlinkSync(link)).toBe(originalTarget); // the OLD link survives, untouched
    expect(warns.length).toBeGreaterThan(0); // the failure was logged, not swallowed silently

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(newCheckout, { recursive: true, force: true });
  });

  // CTL-1530 (thread zc_): writeLinkRegistry's tmp-file + renameSync must never
  // leave an orphaned `.codex-tmp-*` file behind after a successful write, and
  // the registry file itself must always be valid, complete JSON — never a
  // partial write a concurrent reader could observe.
  test("registry writes are atomic: no orphaned temp file, registry always valid JSON (zc_)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-zc-atomic-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-zc-atomic-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-zc-atomic-"));
    const devDir = join(checkout, "plugins", "dev");
    mkdirSync(join(devDir, "skills"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    ensureCodexSkills(wt, { pluginDirs: [devDir], codexHome });

    const entries = readdirSync(codexHome);
    expect(entries).toContain("codex-exec-links.json");
    expect(entries.some((e) => e.includes(".codex-tmp-"))).toBe(false); // no leftover temp file
    // The registry file is valid, complete JSON (never a partial write).
    expect(() => JSON.parse(readFileSync(join(codexHome, "codex-exec-links.json"), "utf8"))).not.toThrow();

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  // CTL-1530 (thread pJD): a corrupt/unparseable registry file must NEVER be
  // treated as "empty but trustworthy" — a link that WOULD otherwise be provably
  // ours (a genuine registry entry exists) is preserved, not refreshed, once the
  // registry file can no longer be parsed.
  test("corrupt link registry → preserved, never refreshed (fail-safe)", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-corrupt-registry-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-corrupt-registry-"));
    const oldCheckout = mkdtempSync(join(tmpdir(), "codex-old-checkout-corrupt-"));
    const newCheckout = mkdtempSync(join(tmpdir(), "codex-new-checkout-corrupt-"));
    const oldDevDir = join(oldCheckout, "plugins", "dev");
    const newDevDir = join(newCheckout, "plugins", "dev");
    mkdirSync(join(oldDevDir, "skills"), { recursive: true });
    mkdirSync(join(newDevDir, "skills"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    // Establish genuine proof, then corrupt the registry file that holds it.
    ensureCodexSkills(wt, { pluginDirs: [oldDevDir], codexHome });
    const link = join(wt, ".agents", "skills");
    const originalTarget = readlinkSync(link);
    rmSync(oldCheckout, { recursive: true, force: true });
    writeFileSync(join(codexHome, "codex-exec-links.json"), "{not valid json");

    ensureCodexSkills(wt, { pluginDirs: [newDevDir], codexHome });

    expect(readlinkSync(link)).toBe(originalTarget); // preserved — registry unreadable, no proof

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(newCheckout, { recursive: true, force: true });
  });

  // CTL-1530 (thread pJD): the SAME registry-proof contract applies to a
  // per-entry link this runner registers under CODEX_HOME/skills (the
  // machine-local registration target for a real, project-owned .agents/skills
  // dir). Seeded via a real first call so the registry holds genuine proof.
  test("STALE runner-owned per-entry symlink (old checkout root), PROVEN by the registry, inside CODEX_HOME/skills is refreshed; the real project dir stays untouched", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-stale-entry-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-dir-stale-entry-"));
    const oldCheckout = mkdtempSync(join(tmpdir(), "codex-old-checkout-entry-"));
    const newCheckout = mkdtempSync(join(tmpdir(), "codex-new-checkout-entry-"));
    const oldDevDir = join(oldCheckout, "plugins", "dev");
    const oldSkillsSrc = join(oldDevDir, "skills");
    const newDevDir = join(newCheckout, "plugins", "dev");
    const newSkillsSrc = join(newDevDir, "skills");
    mkdirSync(join(oldSkillsSrc, "phase-triage"), { recursive: true });
    mkdirSync(join(newSkillsSrc, "phase-triage"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    const realSkills = join(wt, ".agents", "skills");
    mkdirSync(realSkills, { recursive: true }); // a REAL, project-owned dir

    // An earlier dispatch actually registered against the OLD checkout.
    ensureCodexSkills(wt, { pluginDirs: [oldDevDir], codexHome });
    const entryLink = join(codexHome, "skills", "phase-triage");
    expect(readlinkSync(entryLink)).toBe(join(oldSkillsSrc, "phase-triage"));
    rmSync(oldCheckout, { recursive: true, force: true }); // old checkout gone — link now dangles

    ensureCodexSkills(wt, { pluginDirs: [newDevDir], codexHome });

    expect(lstatSync(entryLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(entryLink)).toBe(join(newSkillsSrc, "phase-triage")); // refreshed
    // The real project dir was never touched by the refresh.
    expect(lstatSync(realSkills).isSymbolicLink()).toBe(false);
    expect(lstatSync(realSkills).isDirectory()).toBe(true);

    rmSync(wt, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(newCheckout, { recursive: true, force: true });
  });

  // CTL-1530 (thread pJD): a CODEX_HOME/skills per-entry symlink with no
  // registry proof — whether a genuinely unrelated foreign link, or one that
  // merely LOOKS runner-shaped — is left untouched, warned, and never
  // refreshed; the real project dir is untouched either way.
  test("FOREIGN (or unproven) per-entry symlink inside CODEX_HOME/skills is left untouched + warned", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-foreign-entry-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-foreign-entry-"));
    const codexHome = mkdtempSync(join(tmpdir(), "codex-home-foreign-entry-"));
    const devDir = join(checkout, "plugins", "dev");
    const skillsSrc = join(devDir, "skills");
    mkdirSync(join(skillsSrc, "phase-triage"), { recursive: true });
    Bun.spawnSync(["git", "init"], { cwd: wt });

    const realSkills = join(wt, ".agents", "skills");
    mkdirSync(realSkills, { recursive: true }); // a REAL, project-owned dir
    const homeSkillsDir = join(codexHome, "skills");
    mkdirSync(homeSkillsDir, { recursive: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "codex-elsewhere-entry-"));
    const entryLink = join(homeSkillsDir, "phase-triage");
    Bun.spawnSync(["ln", "-s", elsewhere, entryLink]);
    const warns = [];

    ensureCodexSkills(wt, { pluginDirs: [devDir], codexHome, log: { warn: (...a) => warns.push(a) } });

    expect(readlinkSync(entryLink)).toBe(elsewhere); // untouched
    expect(warns.length).toBe(1); // loud per-entry skip
    expect(lstatSync(realSkills).isSymbolicLink()).toBe(false); // real dir untouched

    rmSync(wt, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

// ── codexRunPhaseAgent: auth guard ────────────────────────────────────────────

describe("codexRunPhaseAgent — auth guard refuses (no prelaunch, no spawn)", () => {
  test("a failing auth returns code 1 + emits execution-core.auth.misconfigured; never spawns", async () => {
    const events = [];
    let spawned = 0;
    let prelaunched = 0;
    const r = await codexRunPhaseAgent(ARGS, {
      codexCfg: CFG,
      assertAuth: () => ({ ok: false, reason: "codex auth missing — run codex login" }),
      runPrelaunchFn: () => {
        prelaunched += 1;
        return { ok: true, idempotent: false, spec: makeCodexSpec(), code: 0, stderr: "" };
      },
      spawnChild: () => {
        spawned += 1;
        return autoChild(E1_LINES, 0);
      },
      registerWorker: fakeRegistry().registerWorker,
      emitEvent: (name, payload) => events.push([name, payload]),
      prepareWorktree: () => {},
      semaphore: new Semaphore(2),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("codex auth missing");
    expect(prelaunched).toBe(0); // no claim
    expect(spawned).toBe(0); // no child
    expect(events[0][0]).toBe("execution-core.auth.misconfigured");
    expect(events[0][1]).toMatchObject({ executor: "codex-exec" });
  });
});

// ── codexRunPhaseAgent: spawn + parse (verbatim success fixture) ──────────────

describe("codexRunPhaseAgent — spawn contract (verbatim 0.144.1 success)", () => {
  test("parses thread.started + turn.completed → {code:0, usage, sessionId}; stdin is 'ignore'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-ok-"));
    const signalFile = join(dir, "phase-implement.json");
    writeFileSync(signalFile, JSON.stringify({ status: "dispatched", generation: 1 }));
    const spec = makeCodexSpec({ signalFile, worktreePath: dir });
    let recordedOpts = null;
    const events = [];
    const { opts, reg } = runnerOpts({
      spec,
      over: {
        spawnChild: (bin, args, o) => {
          recordedOpts = o;
          return autoChild(E1_LINES, 0);
        },
        emitEvent: (name, payload) => events.push([name, payload]),
      },
    });
    const r = await codexRunPhaseAgent(ARGS, opts);
    expect(r.code).toBe(0);
    expect(r.usage).toEqual(E1_USAGE);
    expect(r.sessionId).toBe(E1_THREAD);
    // Regression: stdin MUST be ignored (the </dev/null stdin-hang fix).
    expect(recordedOpts.stdio[0]).toBe("ignore");
    // thread.started announced a started session; deregistered on the way out.
    expect(events.map(([n]) => n)).toContain("worker.session.started");
    expect(events.find(([n]) => n === "execution-core.codex.phase-turns")[1].usage).toEqual(E1_USAGE);
    expect(reg.state.handles[0].deregistered).toBe(1);
    expect(reg.state.registered[0]).toMatchObject({ executor: "codex-exec", ticket: "CTL-100" });
    // CTL-1790: codex-exec shares the SDK's undeclared-exit handler, so a clean exit
    // whose skill never declared records ABANDONMENT here too — not a fabricated done.
    // This assertion is the executor-parity guard: fixing only the SDK path fails it.
    const sigAfter = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(sigAfter.status).not.toBe("done");
    expect(sigAfter.status).toBe("failed");
    expect(sigAfter.outcome).toBe("abandoned");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── codexRunPhaseAgent: failure classification ────────────────────────────────

describe("codexRunPhaseAgent — failure classification", () => {
  test("refresh_token_reused → auth-park + writeSignalStalled(signalFile,'codex-auth'); does NOT loop", async () => {
    const stalled = [];
    let spawned = 0;
    const spec = makeCodexSpec({ signalFile: "/tmp/whatever.json" });
    const { opts } = runnerOpts({
      spec,
      over: {
        spawnChild: () => {
          spawned += 1;
          return autoChild([AUTH_ERR], 1);
        },
        writeSignalStalled: (f, reason) => stalled.push([f, reason]),
      },
    });
    const r = await codexRunPhaseAgent(ARGS, opts);
    expect(r.classification).toBe("auth-park");
    expect(r.code).toBe(1);
    expect(spawned).toBe(1); // auth-park never retries
    expect(stalled).toEqual([["/tmp/whatever.json", "codex-auth"]]);
  });

  test("usage-limit → rate-park after a BOUNDED retry (≤ maxRateRetries); exhaustion invokes the terminal-signal backstop (T1)", async () => {
    const stalled = [];
    const marks = [];
    let spawned = 0;
    const { opts } = runnerOpts({
      over: {
        spawnChild: () => {
          spawned += 1;
          return autoChild([RATE_ERR], 1);
        },
        writeSignalStalled: (...a) => stalled.push(a),
        markLaunchFailed: (arg) => marks.push(arg),
        maxRateRetries: 2,
      },
    });
    const r = await codexRunPhaseAgent(ARGS, opts);
    expect(r.classification).toBe("rate-park");
    expect(r.code).toBe(1);
    expect(spawned).toBe(3); // 1 initial + 2 retries — bounded, no infinite loop
    // CTL-1457 (T1): on EXHAUSTION the terminal-signal backstop IS invoked so the phase
    // is not left dangling — recovery re-enters cool-down instead of treating the no-bg
    // signal as "unknown" forever. It uses markLaunchFailed with status:"failed" (a
    // TRANSIENT cool-down failure), NOT the sticky needs-human auth-park stalled write.
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      ticket: "CTL-100",
      phase: "implement",
      status: "failed",
      signalFile: "/ec/workers/CTL-100/phase-implement.json",
    });
    expect(marks[0].reason).toBe("codex-rate-park-exhausted");
    expect(stalled.length).toBe(0); // NOT the sticky auth-park stalled path
  });

  // CTL-1647: the rate-park EXHAUSTION backstop must declare itself RETRY-SAFE.
  // Without the flag the terminal it writes is indistinguishable from a genuine
  // dead end and the terminal sweep parks the ticket for a human — the same
  // defect as the sdk overloaded-exhausted backstop (41 of 79 false escalations
  // measured 2026-08-21). This drives the PRODUCTION call site: deleting
  // `retrySafe: true` from codex-run-phase-agent.mjs's rate-park branch fails here.
  test("CTL-1647: rate-park exhaustion marks the backstop retrySafe (production call site)", async () => {
    const marks = [];
    const { opts } = runnerOpts({
      over: {
        spawnChild: () => autoChild([RATE_ERR], 1),
        markLaunchFailed: (arg) => marks.push(arg),
        maxRateRetries: 1,
      },
    });
    const r = await codexRunPhaseAgent(ARGS, opts);
    expect(r.classification).toBe("rate-park");
    expect(marks).toHaveLength(1);
    expect(marks[0].reason).toBe("codex-rate-park-exhausted");
    expect(marks[0].retrySafe).toBe(true);
  });

  // POSITIVE CONTROL for the test above, driven through the SAME production
  // function: a genuine `codex-failed` terminal must NOT be retry-safe, so the
  // assertion above discriminates rather than passing vacuously. Needs a real
  // signal file because the failed branch gates on readSignalStatus (not injectable).
  test("CTL-1647 POSITIVE CONTROL: a genuine codex failure is NOT retrySafe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1647-codex-"));
    try {
      mkdirSync(join(dir, "workers", "CTL-100"), { recursive: true });
      writeFileSync(
        join(dir, "workers", "CTL-100", "phase-implement.json"),
        JSON.stringify({ ticket: "CTL-100", phase: "implement", status: "running" }),
      );
      const marks = [];
      const { opts } = runnerOpts({
        // the signal path lives on the prelaunch SPEC, not on ARGS.orchDir
        spec: makeCodexSpec({ signalFile: join(dir, "workers", "CTL-100", "phase-implement.json") }),
        over: {
          // exitCode 1 with no rate/auth marker → classification "failed"
          spawnChild: () => autoChild(['{"type":"error","message":"compiler exploded"}'], 1),
          markLaunchFailed: (arg) => marks.push(arg),
        },
      });
      const r = await codexRunPhaseAgent({ ...ARGS, orchDir: dir }, opts);
      expect(r.classification).toBe("failed");
      expect(marks).toHaveLength(1);
      expect(marks[0].reason).toBe("codex-failed");
      // The pre-fix shape: no retry-safe marker at all.
      expect(marks[0].retrySafe).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // D5: park is the stalled-signal + classification consumed by the daemon's
  // existing cool-down / needs-human machinery — there is NO `phase.<phase>.park`
  // canonical event. Assert neither the auth-park nor rate-park path emits one.
  test("neither auth-park nor rate-park emits a phase.*.park.* event (D5)", async () => {
    const isParkPhaseEvent = (n) => /^phase\..*\.park(\.|$)/.test(String(n));

    // auth-park
    const authEvents = [];
    const authRun = runnerOpts({
      spec: makeCodexSpec({ signalFile: "/tmp/whatever.json" }),
      over: {
        spawnChild: () => autoChild([AUTH_ERR], 1),
        writeSignalStalled: () => {},
        emitEvent: (name) => authEvents.push(name),
      },
    });
    const authRes = await codexRunPhaseAgent(ARGS, authRun.opts);
    expect(authRes.classification).toBe("auth-park");
    expect(authEvents.some(isParkPhaseEvent)).toBe(false);

    // rate-park
    const rateEvents = [];
    const rateRun = runnerOpts({
      over: {
        spawnChild: () => autoChild([RATE_ERR], 1),
        writeSignalStalled: () => {},
        markLaunchFailed: () => {}, // T1: absorb the exhaustion backstop (no real emit spawn)
        maxRateRetries: 1,
        emitEvent: (name) => rateEvents.push(name),
      },
    });
    const rateRes = await codexRunPhaseAgent(ARGS, rateRun.opts);
    expect(rateRes.classification).toBe("rate-park");
    expect(rateEvents.some(isParkPhaseEvent)).toBe(false);
  });

  // findings 2+3: a SUCCESSFUL run (exit 0, no turn.failed) is NEVER parked, even when
  // a NON-FATAL `error` notice carrying a rate-limit-shaped message ("high demand" /
  // "at capacity") arrived earlier and the run then recovered + completed the turn.
  // classifyCodexOutcome gates on the exit code FIRST, so this classifies SUCCESS,
  // does not re-spawn/retry, and does not write a stalled signal.
  test("a non-fatal 'high demand' error notice THEN turn.completed + exit 0 → SUCCESS (no retry, no park)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-succ-"));
    const signalFile = join(dir, "phase-implement.json");
    writeFileSync(signalFile, JSON.stringify({ status: "dispatched", generation: 1 }));
    const spec = makeCodexSpec({ signalFile, worktreePath: dir });
    let spawned = 0;
    const stalled = [];
    const events = [];
    const NON_FATAL_RATE =
      '{"type":"error","message":"The service is experiencing high demand right now. Retrying."}';
    const { opts } = runnerOpts({
      spec,
      over: {
        spawnChild: () => {
          spawned += 1;
          // a rate-shaped error NOTICE, THEN a real success turn, THEN a clean exit 0.
          return autoChild([NON_FATAL_RATE, ...E1_LINES], 0);
        },
        writeSignalStalled: (...a) => stalled.push(a),
        emitEvent: (name, payload) => events.push([name, payload]),
        maxRateRetries: 2,
      },
    });
    const r = await codexRunPhaseAgent(ARGS, opts);
    expect(r.code).toBe(0);
    expect(r.classification).toBe("success");
    expect(spawned).toBe(1); // NOT re-spawned/retried as a rate-park
    expect(stalled).toHaveLength(0); // never written a stalled signal
    // CTL-1790: an undeclared clean exit is abandonment on the codex path too.
    const sigAfter2 = JSON.parse(readFileSync(signalFile, "utf8"));
    expect(sigAfter2.status).toBe("failed");
    expect(sigAfter2.outcome).toBe("abandoned");
    // success telemetry, not a rate-park event.
    expect(events.map(([n]) => n)).toContain("execution-core.codex.phase-turns");
    expect(events.map(([n]) => n)).not.toContain("execution-core.codex.rate-park");
    rmSync(dir, { recursive: true, force: true });
  });

  test("generic non-zero exit with a still-'dispatched' signal → markLaunchFailed invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-fail-"));
    const signalFile = join(dir, "phase-implement.json");
    writeFileSync(signalFile, JSON.stringify({ status: "dispatched", generation: 1 }));
    const marks = [];
    const spec = makeCodexSpec({ signalFile, worktreePath: dir });
    const { opts } = runnerOpts({
      spec,
      over: {
        spawnChild: () => autoChild([], 1), // exit 1, no error message → generic failure
        markLaunchFailed: (arg) => marks.push(arg),
      },
    });
    const r = await codexRunPhaseAgent(ARGS, opts);
    expect(r.classification).toBe("failed");
    expect(r.code).toBe(1);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ ticket: "CTL-100", phase: "implement", status: "failed", signalFile });
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── codexRunPhaseAgent: abort ─────────────────────────────────────────────────

describe("codexRunPhaseAgent — abort", () => {
  test("AbortController fired mid-stream → child.kill('SIGTERM'), resolves aborted:true", async () => {
    const child = makeFakeChild();
    let spawned = false;
    const { opts, reg } = runnerOpts({
      over: {
        spawnChild: () => {
          spawned = true;
          return child;
        },
        semaphore: new Semaphore(2),
      },
    });
    const p = codexRunPhaseAgent(ARGS, opts);
    while (!spawned) await tick();
    // A message arrives, then the controller is aborted mid-stream.
    child.stdout.push(`{"type":"thread.started","thread_id":"tid-abort"}\n`);
    await tick();
    const ac = reg.state.handles[0].controllers[0];
    expect(ac).toBeTruthy();
    ac.abort();
    const r = await p;
    expect(child.killed).toContain("SIGTERM");
    expect(r.aborted).toBe(true);
    expect(reg.state.handles[0].deregistered).toBe(1); // slot released on the abort path
  });

  // CTL-1457 (T3): a child that IGNORES SIGTERM must still be escalated to SIGKILL, and
  // the runner must settle (deregister + release the slot) ONLY after the child closes —
  // never on the AbortError alone, which would clear the escalation timer and leak a live
  // subprocess.
  test("child ignores SIGTERM → runner escalates to SIGKILL and settles only after close", async () => {
    const child = makeSigtermIgnoringChild();
    let spawned = false;
    const { opts, reg } = runnerOpts({
      over: {
        spawnChild: () => {
          spawned = true;
          return child;
        },
        killGraceMs: 5, // tiny grace so the escalation fires fast in-test
        semaphore: new Semaphore(2),
      },
    });
    const p = codexRunPhaseAgent(ARGS, opts);
    while (!spawned) await tick();
    child.stdout.push(`{"type":"thread.started","thread_id":"tid-ignore"}\n`);
    await tick();
    const ac = reg.state.handles[0].controllers[0];
    expect(ac).toBeTruthy();
    ac.abort(); // → onAbort: SIGTERM (ignored) + schedules the SIGKILL escalation timer
    // Simulate node's spawn({signal}) behavior: an AbortError 'error' event arrives on the
    // child BEFORE it exits. The OLD handler settled on this (clearing the escalation timer),
    // leaking a live child; the fix must IGNORE it and let 'close' settle instead.
    child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    await tick();
    expect(child.killed).toContain("SIGTERM");
    const r = await p; // resolves only once the killGrace timer escalates to SIGKILL → close
    expect(child.killed).toContain("SIGKILL"); // escalation survived the AbortError and fired
    expect(r.aborted).toBe(true);
    expect(reg.state.handles[0].deregistered).toBe(1); // slot released only after the real close
  });
});

// ── codexRunPhaseAgent: idempotent prelaunch ──────────────────────────────────

describe("codexRunPhaseAgent — idempotent prelaunch is a no-op success", () => {
  test("an idempotent prelaunch returns code 0 and never spawns", async () => {
    let spawned = 0;
    const r = await codexRunPhaseAgent(ARGS, {
      codexCfg: CFG,
      assertAuth: OK_AUTH,
      runPrelaunchFn: () => ({ ok: false, idempotent: true, spec: makeCodexSpec({ status: "running" }), code: 0, stderr: "" }),
      spawnChild: () => {
        spawned += 1;
        return autoChild(E1_LINES, 0);
      },
      registerWorker: fakeRegistry().registerWorker,
      prepareWorktree: () => {},
      emitEvent: () => {},
      semaphore: new Semaphore(2),
    });
    expect(r.code).toBe(0);
    expect(spawned).toBe(0);
  });
});

// ── codexRunPhaseAgent: prelaunch failure ─────────────────────────────────────

describe("codexRunPhaseAgent — shared pre-launch failure", () => {
  test("a non-ok prelaunch flips the signal stalled and returns failed WITHOUT spawning", async () => {
    const stalled = [];
    let spawned = 0;
    const r = await codexRunPhaseAgent(ARGS, {
      codexCfg: CFG,
      assertAuth: OK_AUTH,
      runPrelaunchFn: () => ({ ok: false, idempotent: false, spec: null, code: 1, stderr: "no claim" }),
      writeSignalStalled: (f, reason) => stalled.push([f, reason]),
      spawnChild: () => {
        spawned += 1;
        return autoChild(E1_LINES, 0);
      },
      registerWorker: fakeRegistry().registerWorker,
      prepareWorktree: () => {},
      emitEvent: () => {},
      semaphore: new Semaphore(2),
    });
    expect(r.code).toBe(1);
    expect(spawned).toBe(0);
    expect(stalled).toHaveLength(1);
    expect(stalled[0][1]).toBe("codex-prelaunch-failed");
  });
});

// ── codexRunPhaseAgent: configPath threads Layer-1 codex.codexHome to runtime ──

describe("codexRunPhaseAgent — configPath resolves the runtime codexConfig (finding 4)", () => {
  test("a Layer-1 catalyst.orchestration.codex.codexHome (via configPath) is the home the runtime auth guard checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cfgpath-"));
    const configPath = join(dir, "config.json");
    const l1Home = join(dir, "layer1-codex-home");
    writeFileSync(
      configPath,
      JSON.stringify({ catalyst: { orchestration: { codex: { codexHome: l1Home } } } }),
    );
    let seenHome = null;
    let spawned = 0;
    let prelaunched = 0;
    const r = await codexRunPhaseAgent(ARGS, {
      // NO codexCfg — force cfg = codexConfig({ configPath, env }) to resolve the Layer-1
      // home. env:{} so no ambient CATALYST_CODEX_HOME overrides the Layer-1 value.
      configPath,
      env: {},
      assertAuth: ({ codexHome }) => {
        seenHome = codexHome;
        return { ok: false, reason: "stop-here" }; // short-circuit before prelaunch/spawn
      },
      runPrelaunchFn: () => {
        prelaunched += 1;
        return { ok: true, idempotent: false, spec: makeCodexSpec(), code: 0, stderr: "" };
      },
      spawnChild: () => {
        spawned += 1;
        return autoChild(E1_LINES, 0);
      },
      registerWorker: fakeRegistry().registerWorker,
      emitEvent: () => {},
      prepareWorktree: () => {},
      semaphore: new Semaphore(2),
    });
    expect(r.code).toBe(1);
    expect(seenHome).toBe(l1Home); // the Layer-1 codexHome reached the runtime auth guard
    expect(prelaunched).toBe(0); // auth refused before any side effect
    expect(spawned).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── REAL child: default spawnChild against a bash stub (stdin-hang regression) ─

describe("codexRunPhaseAgent — real child through the DEFAULT spawnChild", () => {
  test("a bash stub emitting the verbatim fixture parses end-to-end and does NOT hang on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-real-"));
    const stub = join(dir, "codex-stub.sh");
    const signalFile = join(dir, "phase-implement.json");
    writeFileSync(signalFile, JSON.stringify({ status: "dispatched", generation: 1 }));
    // Print the fixture to stdout and exit 0. If the runner left stdin open the
    // child would block on `read`; stdio[0]='ignore' closes it — this proves it.
    writeFileSync(
      stub,
      [
        "#!/usr/bin/env bash",
        "cat <<'JSONL'",
        ...E1_LINES,
        "JSONL",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);
    const spec = makeCodexSpec({ signalFile, worktreePath: dir, pluginDirs: [] });
    const reg = fakeRegistry();
    const r = await codexRunPhaseAgent(ARGS, {
      codexCfg: { ...CFG, bin: stub, model: null },
      assertAuth: OK_AUTH, // avoid needing a real codex login
      runPrelaunchFn: () => ({ ok: true, idempotent: false, spec, code: 0, stderr: "" }),
      prepareWorktree: () => {},
      registerWorker: reg.registerWorker,
      emitEvent: () => {},
      semaphore: new Semaphore(2),
      // DEFAULT spawnChild (real node:child_process.spawn) — not injected.
    });
    expect(r.code).toBe(0);
    expect(r.usage).toEqual(E1_USAGE);
    expect(r.sessionId).toBe(E1_THREAD);
    rmSync(dir, { recursive: true, force: true });
  }, 15000);
});
