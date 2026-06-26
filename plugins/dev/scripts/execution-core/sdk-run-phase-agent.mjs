// sdk-run-phase-agent.mjs — the `executor=sdk` launch verb (CTL-1365b).
//
// Same SIGNATURE and RETURN SHAPE as dispatch.mjs:defaultRunPhaseAgent
//   ({ orchDir, ticket, phase, worktreePath, resumeSession, handoffPath,
//      attempt, clusterGeneration }) → { code, stdout, stderr, signal }
// — so it is drop-in beside the `--bg` path. `signal` is always null for the SDK
// (there is no killed-subprocess signal to surface), kept for shape parity so the
// scheduler reads ONE consistent result shape regardless of executor.
//
// ── How it REUSES the Stage-A shared pre-launch ─────────────────────────────
// The adversarial review (plan §"MUST-FIX" #1) established that the executor seam
// is the LAUNCH VERB, not the whole dispatch path: phase-agent-dispatch — NOT the
// phase skill — writes the initial status:"dispatched" signal AND the
// CATALYST_GENERATION fencing token (the skill template requires the signal to
// PRE-EXIST and only flips dispatched→running), runs the CTL-736 atomic
// single-flight claim, and performs the CTL-667/707 dispatch-time rebase. A raw
// query() would skip all of that and the skill would abort "signal file missing".
//
// So sdkRunPhaseAgent does NOT call query() directly. It runs the SAME
// phase-agent-dispatch script in `--launch-mode prelaunch-only` (Stage A seam),
// which performs the IDENTICAL pre-launch (claim + fenced "dispatched" signal +
// generation token + rebase + prompt/env/settings composition) and then, instead
// of spawning `claude --bg`, prints the resolved launch spec as one JSON line and
// exits 0. sdkRunPhaseAgent parses that spec and replaces ONLY the launch verb:
// it drives the phase skill through an in-process Agent SDK query() with the
// spec's worktreePath (cwd), prompt (the /catalyst-dev:phase-* slash command), and
// env (the composed CATALYST_* + fencing token + OTEL attrs). Everything upstream
// of the launch is byte-identical to the bg path (proven by phase-agent-dispatch
// test 70's prelaunch↔dry-run↔bg parity).
//
// ── The 3 worker contracts ──────────────────────────────────────────────────
//  1. Terminal event   phase.<name>.(complete|failed|turn-cap-exhausted|skipped).<ticket>
//     The phase SKILL emits this itself (it runs the identical phase body the bg
//     worker runs). sdkRunPhaseAgent adds a BACKSTOP emit — mirroring
//     phase-agent-dispatch's mark_launch_failed — for abnormal terminations
//     (error/cancel/interrupt/throw/no-result/turn-cap) where the skill never
//     reached its own emit, via phase-agent-emit-complete --no-signal-update.
//  2. Signal files + CATALYST_GENERATION fencing — written by the shared
//     pre-launch (status:"dispatched" + generation); the skill flips
//     dispatched→running→done/stalled. sdkRunPhaseAgent never writes them.
//  3. Phase prompt + CATALYST_* env — carried as the spec's prompt + plain env
//     (options.env). Because the SDK child inherits env normally, this collapses
//     the CTL-760/777 `--settings` env-bridge the bg path needs (that bridge only
//     existed because `claude --bg` is an RPC to a frozen-env daemon).
//
// ── Auth (plan §1c) ─────────────────────────────────────────────────────────
// Subscription auth ONLY: the env handed to query() always deletes
// ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN (rungs 2-3 outrank the OAuth token and
// silently METER in headless mode) and sets CLAUDE_CODE_OAUTH_TOKEN. We never pass
// `--bare` / an API-key-reading settingSource. A dispatch-time assertion refuses
// to run (no claim, no signal) when ANTHROPIC_API_KEY is set or the OAuth token is
// missing — failing loud instead of silently metering.
//
// ── Concurrency + backoff (plan §1e) ────────────────────────────────────────
// The SDK has no built-in concurrency cap and mislabels 529 overloaded_error with
// no backoff. The daemon owns both: a process-wide semaphore sized from
// orchestration.maxParallel caps concurrent query() calls; 429/529 trigger bounded
// exponential backoff + jitter, emitting execution-core.sdk.overloaded for HUD
// backpressure, and on exhaustion return a failed result + a backstop failed event
// (never a silent drop).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// phase-agent-dispatch + phase-agent-emit-complete sit one directory up.
const PHASE_AGENT_DISPATCH_BIN = fileURLToPath(
  new URL("../phase-agent-dispatch", import.meta.url),
);
const EMIT_COMPLETE_BIN = fileURLToPath(
  new URL("../phase-agent-emit-complete", import.meta.url),
);

// ── Async semaphore ─────────────────────────────────────────────────────────
// A minimal counting semaphore: acquire() resolves when a slot is free, the
// returned release() frees it. Sized from maxParallel so the daemon never has
// more than N concurrent in-process query() calls (the SDK cap the runtime omits).
// This sits BELOW the existing HRW/admission gate (which decides WHICH tickets
// run) — it caps concurrent query() calls only, so the two never double-count: a
// ticket admitted by HRW simply waits here for a query slot, it is not re-gated.
export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number.isFinite(max) ? Math.floor(max) : 1);
    this._active = 0;
    this._waiters = [];
  }
  get active() {
    return this._active;
  }
  async acquire() {
    if (this._active < this.max) {
      this._active += 1;
      return () => this._release();
    }
    await new Promise((resolve) => this._waiters.push(resolve));
    this._active += 1;
    return () => this._release();
  }
  _release() {
    this._active -= 1;
    const next = this._waiters.shift();
    if (next) next();
  }
}

// One process-wide semaphore, lazily created at the configured size. The daemon
// is a single process, so a module-level singleton is the right scope for the
// fleet-wide concurrency cap. Tests inject their own Semaphore.
let _sharedSemaphore = null;
function sharedSemaphore(maxParallel) {
  if (_sharedSemaphore && _sharedSemaphore.max === maxParallel) return _sharedSemaphore;
  _sharedSemaphore = new Semaphore(maxParallel);
  return _sharedSemaphore;
}

// resolveMaxParallel — the concurrency cap. CATALYST_SDK_MAX_PARALLEL overrides
// (test/tuning) then the generic CATALYST_MAX_PARALLEL, else the same default 3 the
// scheduler uses. Never returns < 1.
export function resolveMaxParallel(env = process.env) {
  const raw = env.CATALYST_SDK_MAX_PARALLEL ?? env.CATALYST_MAX_PARALLEL;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

// ── Auth guard (plan §1c) ───────────────────────────────────────────────────
// assertSdkAuth — refuse to dispatch under sdk when the env would silently meter.
// Returns { ok, reason }. `ok:false` means: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)
// is set in the ambient env (rungs 2-3 would override the subscription token), OR
// the OAuth token is missing (nothing to authenticate the subscription). Pure;
// never throws. Exported so the daemon boot assertion (plan §1c) can reuse it.
export function assertSdkAuth({ env = process.env, oauthToken } = {}) {
  if (env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      reason:
        "ANTHROPIC_API_KEY is set — refusing to dispatch under executor=sdk (would silently meter; unset it and authenticate via CLAUDE_CODE_OAUTH_TOKEN)",
    };
  }
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return {
      ok: false,
      reason:
        "ANTHROPIC_AUTH_TOKEN is set — refusing to dispatch under executor=sdk (overrides the subscription OAuth token)",
    };
  }
  if (!oauthToken) {
    return {
      ok: false,
      reason:
        "CLAUDE_CODE_OAUTH_TOKEN is missing — refusing to dispatch under executor=sdk (run `claude setup-token`)",
    };
  }
  return { ok: true, reason: null };
}

// ── Default seams (overridable for tests; default = real) ───────────────────

// defaultRunQuery — lazily import the Agent SDK so the module loads (and its tests
// run) WITHOUT the SDK installed. Returns an async iterable of streamed messages.
// Tests inject a fake async-iterable and never touch the real SDK / network.
function defaultRunQuery({ prompt, options }) {
  return (async function* () {
    // Non-literal specifier so bun build's static resolution check (CI import
    // graph) skips it — literal dynamic imports are still statically resolved
    // even when lazy (same trap as vite + bun:sqlite, PR #1561). The SDK is an
    // optionalDependency, loaded only at runtime where the executor=sdk path runs.
    const sdkPkg = ["@anthropic-ai", "claude-agent-sdk"].join("/");
    const { query } = await import(sdkPkg);
    for await (const m of query({ prompt, options })) yield m;
  })();
}

// defaultEmitEvent — observability events (execution-core.sdk.overloaded /
// execution-core.auth.misconfigured). These are non-phase, non-routed events, so
// the default is a dependency-free best-effort stderr line; the daemon injects a
// real unified-event-log writer at the dispatch seam. Never throws.
function defaultEmitEvent(name, payload) {
  try {
    process.stderr.write(
      `[sdk-run-phase-agent] ${name} ${JSON.stringify(payload ?? {})}\n`,
    );
  } catch {
    /* best-effort */
  }
}

// defaultEmitBackstop — emit the canonical terminal event as a BACKSTOP, mirroring
// phase-agent-dispatch:mark_launch_failed (phase-agent-emit-complete with
// --no-signal-update so the skill/pre-launch keeps ownership of the signal file).
// Best-effort; never throws.
function defaultEmitBackstop({ phase, ticket, status, reason, orchDir }, { spawn = spawnSync } = {}) {
  try {
    const args = [
      "--phase", phase,
      "--ticket", ticket,
      "--status", status,
      "--orch-dir", orchDir,
      "--orch-id", ticket,
      "--no-signal-update",
    ];
    if (reason) args.push("--reason", reason);
    spawn(EMIT_COMPLETE_BIN, args, { encoding: "utf8" });
  } catch {
    /* best-effort */
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Overloaded (429/529) detection ──────────────────────────────────────────
const OVERLOADED_STATUSES = new Set([429, 529]);

function statusOf(x) {
  // Tolerate a few shapes the SDK / underlying API surface uses.
  return (
    x?.api_error_status ??
    x?.status ??
    x?.statusCode ??
    x?.error?.status ??
    null
  );
}

// isOverloadedResult — a terminal result that is a 429/529 overload, or an
// overloaded_error subtype.
function isOverloadedResult(result) {
  if (!result) return false;
  const s = statusOf(result);
  if (OVERLOADED_STATUSES.has(Number(s))) return true;
  const t = result.error?.type ?? result.error_type;
  return t === "overloaded_error";
}

// isOverloadedError — a thrown error that is a 429/529 overload.
function isOverloadedError(err) {
  if (!err) return false;
  const s = statusOf(err);
  if (OVERLOADED_STATUSES.has(Number(s))) return true;
  const t = err?.error?.type ?? err?.type;
  if (t === "overloaded_error") return true;
  return /\b(429|529|overloaded)\b/i.test(String(err?.message ?? ""));
}

// backoffMs — exponential backoff (base·2^i) capped, plus full jitter. `random`
// is injectable so the backoff test is deterministic.
function backoffMs(i, { baseMs = 1000, capMs = 30000, random = Math.random } = {}) {
  const ceil = Math.min(capMs, baseMs * 2 ** i);
  return Math.floor(ceil * (0.5 + 0.5 * random())); // 50%-100% of the ceiling
}

// ── The run loop ────────────────────────────────────────────────────────────

// runPrelaunch — invoke phase-agent-dispatch in prelaunch-only mode (the Stage-A
// shared pre-launch) and return the parsed launch spec. Builds the SAME arg array
// + env as dispatch.mjs:defaultRunPhaseAgent (so the pre-launch behaves
// identically) plus `--launch-mode prelaunch-only`. Returns
// { ok, spec, code, stderr }.
function runPrelaunch(
  { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
  { spawn = spawnSync } = {},
) {
  const args = [
    "--phase", phase,
    "--ticket", ticket,
    "--orch-dir", orchDir,
    "--orch-id", ticket,
    "--launch-mode", "prelaunch-only",
  ];
  if (resumeSession) args.push("--resume-session", resumeSession);
  if (attempt != null) args.push("--attempt", String(attempt));
  const extraEnv = {};
  if (handoffPath) extraEnv.CATALYST_HANDOFF_PATH = handoffPath;
  if (clusterGeneration != null) extraEnv.CATALYST_CLUSTER_GENERATION = String(clusterGeneration);
  const env = {
    ...process.env,
    CATALYST_ORCHESTRATOR_DIR: orchDir,
    CATALYST_ORCHESTRATOR_ID: ticket,
    CATALYST_PHASE: phase,
    CATALYST_TICKET: ticket,
    CATALYST_EXECUTION_CORE: "1",
    ...extraEnv,
  };
  delete env.CATALYST_RECREATE_ATTEMPTED; // per-dispatch marker (mirror dispatch.mjs)
  const res = spawn(PHASE_AGENT_DISPATCH_BIN, args, {
    cwd: worktreePath,
    encoding: "utf8",
    env,
  });
  const code = res.error ? 127 : (res.status ?? 0);
  const stderr = res.error
    ? (res.stderr && res.stderr.length ? res.stderr : res.error.message)
    : (res.stderr ?? "");
  // The spec is the last JSON object line printed on stdout.
  let spec = null;
  const lines = String(res.stdout ?? "").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === "object") {
        spec = obj;
        break;
      }
    } catch {
      /* not a JSON line */
    }
  }
  const ok = code === 0 && spec != null && spec.status === "prelaunch-ready";
  return { ok, spec, code, stderr };
}

// buildSdkEnv — the env handed to query(), built from the shared-pre-launch spec's
// composed env array (KEY=VALUE strings: CATALYST_* + CATALYST_GENERATION fencing
// token + OTEL attrs) layered over process.env, with the auth guards applied. This
// is plain env (Contract 3) — it REPLACES the CTL-760/777 --settings bridge.
export function buildSdkEnv(specEnv, { base = process.env, oauthToken } = {}) {
  const env = { ...base };
  for (const kv of specEnv ?? []) {
    const idx = String(kv).indexOf("=");
    if (idx <= 0) continue;
    env[kv.slice(0, idx)] = kv.slice(idx + 1);
  }
  // AUTH GUARD: subscription only. Rungs 2-3 outrank the OAuth token + silently
  // meter in headless mode — always strip them; set the OAuth token.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  delete env.CATALYST_RECREATE_ATTEMPTED;
  return env;
}

// buildQueryOptions — the query() options. `--bare` is NEVER set; settingSources is
// always ["user","project"] (NEVER [] — that hides the plugin phase skills).
export function buildQueryOptions(spec, env, { turnCap } = {}) {
  const options = {
    cwd: spec.worktreePath,
    env, // plain env — replaces the CTL-760/777 --settings bridge
    executable: "bun", // #266: avoid "Bun is not defined" under a Node spawn
    settingSources: ["user", "project"], // REQUIRED so plugin phase skills resolve
    permissionMode: "bypassPermissions", // unattended; skills self-gate via frontmatter
    systemPrompt: { type: "preset", preset: "claude_code" }, // keep CLI behavior
  };
  if (turnCap != null) options.maxTurns = turnCap; // → error_max_turns → turn-cap-exhausted
  if (spec.resumeSession) options.resume = spec.resumeSession; // cwd === worktreePath (set above)
  return options;
}

// mapResult — terminal SDK result → { code, stdout, stderr, signal } + the backstop
// emit decision. subtype "success" → code 0, NO backstop (the skill emitted
// complete). error_max_turns → turn-cap-exhausted backstop. anything else (error /
// cancelled / interrupted / no result) → failed backstop.
function mapResult(result) {
  if (!result) {
    return {
      result: { code: 1, stdout: "", stderr: "sdk: query ended with no terminal result", signal: null },
      backstop: { status: "failed", reason: "sdk-no-result" },
    };
  }
  if (result.subtype === "success" && !result.is_error) {
    return {
      result: { code: 0, stdout: result.result ?? "", stderr: "", signal: null },
      backstop: null,
    };
  }
  if (result.subtype === "error_max_turns") {
    return {
      result: { code: 1, stdout: result.result ?? "", stderr: "sdk: max turns exhausted", signal: null },
      backstop: { status: "turn-cap-exhausted", reason: "sdk-error-max-turns" },
    };
  }
  return {
    result: { code: 1, stdout: result.result ?? "", stderr: `sdk: ${result.subtype ?? "error"}`, signal: null },
    backstop: { status: "failed", reason: `sdk-${result.subtype ?? "error"}` },
  };
}

// sdkRunPhaseAgent — the executor=sdk launch verb. async (the in-process query loop
// awaits the SDK stream), returns the defaultRunPhaseAgent shape.
export async function sdkRunPhaseAgent(
  { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
  {
    runQuery = defaultRunQuery,
    oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN,
    turnCap,
    env: authEnv = process.env, // the AMBIENT env the auth guard inspects
    spawn = spawnSync, // for the prelaunch + backstop emit
    semaphore, // injectable; defaults to the process-wide shared one
    maxParallel = resolveMaxParallel(),
    emitEvent = defaultEmitEvent,
    emitBackstop = defaultEmitBackstop,
    sleep = defaultSleep,
    random = Math.random,
    maxRetries = 5, // bound the 429/529 backoff
    backoff = {}, // { baseMs, capMs } overrides for tests
  } = {},
) {
  // ── AUTH GUARD: refuse BEFORE any side effect (no claim, no signal) ───────
  const auth = assertSdkAuth({ env: authEnv, oauthToken });
  if (!auth.ok) {
    emitEvent("execution-core.auth.misconfigured", { ticket, phase, reason: auth.reason });
    return { code: 1, stdout: "", stderr: auth.reason, signal: null };
  }

  // ── SHARED PRE-LAUNCH (claim + fenced "dispatched" signal + generation +
  //    rebase + prompt/env composition) via phase-agent-dispatch prelaunch-only ─
  const pre = runPrelaunch(
    { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
    { spawn },
  );
  if (!pre.ok) {
    // The pre-launch already owns its own failure event (mark_launch_failed) on a
    // claim/launch failure; surface its code/stderr without a duplicate backstop.
    return {
      code: pre.code || 1,
      stdout: "",
      stderr: pre.stderr || "sdk: shared pre-launch failed (no launch spec)",
      signal: null,
    };
  }
  const spec = pre.spec;

  const env = buildSdkEnv(spec.env, { base: authEnv, oauthToken });
  const options = buildQueryOptions(spec, env, { turnCap });

  // ── LAUNCH VERB: the in-process query() loop, under the concurrency cap ───
  const sem = semaphore ?? sharedSemaphore(maxParallel);
  const release = await sem.acquire();
  try {
    let lastOverload = null;
    for (let i = 0; i <= maxRetries; i++) {
      const ac = new AbortController();
      let result = null;
      let thrown = null;
      try {
        const q = runQuery({ prompt: spec.prompt, options: { ...options, abortController: ac } });
        for await (const m of q) {
          if (m?.type === "result") result = m; // exactly one terminal
        }
      } catch (err) {
        thrown = err;
      }

      // 429/529 → bounded backoff + retry.
      const overloaded = thrown ? isOverloadedError(thrown) : isOverloadedResult(result);
      if (overloaded) {
        lastOverload = thrown ?? result;
        if (i < maxRetries) {
          const delay = backoffMs(i, { ...backoff, random });
          emitEvent("execution-core.sdk.overloaded", {
            ticket, phase, attempt: i, delayMs: delay, status: statusOf(lastOverload),
          });
          await sleep(delay);
          continue;
        }
        // Exhausted: failed result + backstop failed event (never a silent drop).
        emitEvent("execution-core.sdk.overloaded", {
          ticket, phase, attempt: i, exhausted: true, status: statusOf(lastOverload),
        });
        emitBackstop({ phase, ticket, status: "failed", reason: "sdk-overloaded-exhausted", orchDir }, { spawn });
        return {
          code: 1,
          stdout: "",
          stderr: `sdk: overloaded (429/529) after ${maxRetries + 1} attempts`,
          signal: null,
        };
      }

      // A non-overloaded thrown error → failed (with backstop).
      if (thrown) {
        emitBackstop({ phase, ticket, status: "failed", reason: "sdk-threw", orchDir }, { spawn });
        return { code: 1, stdout: "", stderr: String(thrown?.message ?? thrown), signal: null };
      }

      // Terminal result → map + (conditional) backstop emit.
      const { result: mapped, backstop } = mapResult(result);
      if (backstop) {
        emitBackstop({ phase, ticket, status: backstop.status, reason: backstop.reason, orchDir }, { spawn });
      }
      return mapped;
    }
    // Unreachable (the loop always returns), but keep a defined shape.
    return { code: 1, stdout: "", stderr: "sdk: retry loop exhausted", signal: null };
  } finally {
    release();
  }
}
