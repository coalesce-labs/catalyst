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
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // CTL-1457 (T7): a PRE-EXISTING real .agents/skills directory (the project's/user's own
  // Codex skills) is NEVER clobbered — the runner must not `rm -r` a path it does not own.
  test("pre-existing real .agents/skills dir → NOT clobbered; a warning is logged; no symlink created", () => {
    const wt = mkdtempSync(join(tmpdir(), "codex-wt-real-"));
    const checkout = mkdtempSync(join(tmpdir(), "codex-checkout-real-"));
    const devDir = join(checkout, "plugins", "dev");
    mkdirSync(join(devDir, "skills"), { recursive: true });
    // A REAL .agents/skills dir with a sentinel file the runner must preserve.
    const realSkills = join(wt, ".agents", "skills");
    mkdirSync(realSkills, { recursive: true });
    const sentinel = join(realSkills, "SENTINEL.md");
    writeFileSync(sentinel, "user-owned skill — do not delete");
    const warns = [];

    ensureCodexSkills(wt, { pluginDirs: [devDir], log: { warn: (...a) => warns.push(a) } });

    // The sentinel survives and .agents/skills is still a real dir (NOT replaced by a symlink).
    expect(lstatSync(sentinel).isFile()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toContain("do not delete");
    expect(lstatSync(realSkills).isSymbolicLink()).toBe(false);
    expect(warns.length).toBe(1); // loud skip

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
    // Success backstop flipped the still-dispatched signal to done.
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("done");
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
    // flipSignalDoneOnSuccess flipped the still-dispatched signal to done.
    expect(JSON.parse(readFileSync(signalFile, "utf8")).status).toBe("done");
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
